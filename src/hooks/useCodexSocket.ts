import { useCallback, useEffect, useRef, useState } from 'react';
import { timelineNotificationMeta, withTimelineNotificationMeta } from '../lib/timeline';
import type { CodexRunOptions } from '../types/ui';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth-error';

export interface AppServerHealth {
  connected: boolean;
  dead: boolean;
  error: string | null;
  readyzUrl: string | null;
  url: string | null;
}

interface ServerHello {
  type: 'server/hello';
  hostname: string;
  startCwd: string | null;
  notificationStreamId?: string | null;
  appServerHealth?: AppServerHealth;
  state: {
    activeThreadId: string | null;
    activeThreadPath: string | null;
    activeTurnId: string | null;
    activeCwd: string | null;
    model: string | null;
    effort: string | null;
    mode: string | null;
    sandbox: string | null;
    theme: 'dark' | 'light';
    queue: Array<{ id: string; text: string; createdAt: number; options?: Partial<CodexRunOptions> }>;
  };
  requests?: unknown[];
}

type ServerMessage =
  | ServerHello
  | { type: 'rpc/result'; id: number; result: unknown }
  | { type: 'rpc/error'; id: number; error: string }
  | { type: 'codex/notification'; streamId?: string; seq?: number; message: unknown }
  | { type: 'codex/request'; message: unknown }
  | { type: 'codex/requestResolved'; requestId: number | string }
  | { type: 'auth/error' };

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_RETAINED_NOTIFICATIONS = 5000;
const NOTIFICATION_FLUSH_DELAY_MS = 125;

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws`;
}

function stripTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;

  url.searchParams.delete('token');
  const search = url.searchParams.toString();
  window.history.replaceState(null, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
}

function parseServerMessage(data: string): ServerMessage | null {
  try {
    const message = JSON.parse(data) as Partial<ServerMessage>;
    return typeof message.type === 'string' ? (message as ServerMessage) : null;
  } catch {
    return null;
  }
}

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function requestIdOf(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const id = (request as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? requestKey(id) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function childRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return typeof child === 'string' ? child : null;
}

function stringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

function deltaNotificationInfo(notification: unknown): { delta: string; key: string; params: Record<string, unknown> } | null {
  if (!isRecord(notification) || notification.method !== 'item/agentMessage/delta') return null;
  const params = childRecord(notification, 'params');
  if (!params) return null;
  const delta = params.delta;
  if (typeof delta !== 'string') return null;
  const threadId = stringField(params, 'threadId') ?? stringField(params, 'thread_id') ?? stringPath(params, ['thread', 'id']) ?? '';
  const turnId = stringField(params, 'turnId') ?? stringField(params, 'turn_id') ?? stringPath(params, ['turn', 'id']) ?? '';
  const sourceId =
    stringField(params, 'id') ??
    stringField(params, 'itemId') ??
    stringField(params, 'item_id') ??
    stringField(params, 'messageId') ??
    stringField(params, 'message_id') ??
    null;
  if (!threadId && !turnId && !sourceId) return null;
  return { delta, key: `${threadId}\0${turnId}\0${sourceId}`, params };
}

function coalesceBufferedDeltaNotification(previous: unknown, next: unknown, source: { streamId?: string | null; seq?: number | null }): unknown | null {
  const previousInfo = deltaNotificationInfo(previous);
  const nextInfo = deltaNotificationInfo(next);
  if (!previousInfo || !nextInfo || previousInfo.key !== nextInfo.key) return null;
  const previousMeta = timelineNotificationMeta(previous);
  const combined = {
    ...(previous as Record<string, unknown>),
    params: {
      ...previousInfo.params,
      delta: `${previousInfo.delta}${nextInfo.delta}`,
    },
  };
  return withTimelineNotificationMeta(combined, {
    order: previousMeta?.order ?? 0,
    receivedAt: previousMeta?.receivedAt ?? Date.now(),
    streamId: source.streamId ?? previousMeta?.streamId ?? null,
    seq: source.seq ?? previousMeta?.seq ?? null,
  });
}

interface StoredNotificationReplayState {
  streamId: string | null;
  seq: number | null;
}

function notificationSeqStorageKey(): string {
  return `codex-web-ui:notificationReplay:${window.location.host}`;
}

function readStoredNotificationReplayState(): StoredNotificationReplayState {
  try {
    const value = window.localStorage.getItem(notificationSeqStorageKey());
    if (!value) return { streamId: null, seq: null };
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0) return { streamId: null, seq: parsed };
    if (typeof parsed !== 'object' || parsed === null) return { streamId: null, seq: null };
    const record = parsed as Record<string, unknown>;
    const streamId = typeof record.streamId === 'string' && record.streamId.trim() ? record.streamId : null;
    const seq = typeof record.seq === 'number' && Number.isFinite(record.seq) && record.seq >= 0 ? record.seq : null;
    return { streamId, seq };
  } catch {
    return { streamId: null, seq: null };
  }
}

function writeStoredNotificationReplayState(value: StoredNotificationReplayState): void {
  try {
    window.localStorage.setItem(notificationSeqStorageKey(), JSON.stringify(value));
  } catch {
    // Reconnect replay still works in-memory when storage is unavailable.
  }
}

export function useCodexSocket() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [hello, setHello] = useState<ServerHello | null>(null);
  const [notifications, setNotifications] = useState<unknown[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [requests, setRequests] = useState<unknown[]>([]);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [authRetryEpoch, setAuthRetryEpoch] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingRpc>());
  const notificationBufferRef = useRef<unknown[]>([]);
  const notificationFlushTimerRef = useRef<number | null>(null);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const reconnectTimerRef = useRef<number | null>(null);
  const hasConnectedRef = useRef(false);
  const storedReplayStateRef = useRef<StoredNotificationReplayState>(readStoredNotificationReplayState());
  const seenServerNotificationSeqsRef = useRef<Set<string>>(new Set());
  const nextNotificationOrderRef = useRef(0);

  const setTrackedConnectionState = useCallback((state: ConnectionState) => {
    connectionStateRef.current = state;
    setConnectionState(state);
  }, []);

  const rejectPending = useCallback((error: Error) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRef.current.clear();
  }, []);

  const flushNotifications = useCallback(() => {
    notificationFlushTimerRef.current = null;
    const buffered = notificationBufferRef.current;
    if (buffered.length === 0) return;
    notificationBufferRef.current = [];
    setNotificationCount((count) => count + buffered.length);
    setNotifications((items) => [...items, ...buffered].slice(-MAX_RETAINED_NOTIFICATIONS));
  }, []);

  const clearNotificationBuffer = useCallback(() => {
    notificationBufferRef.current = [];
    if (notificationFlushTimerRef.current !== null) {
      window.clearTimeout(notificationFlushTimerRef.current);
      notificationFlushTimerRef.current = null;
    }
  }, []);

  const queueNotification = useCallback(
    (message: unknown, source: { streamId?: string | null; seq?: number | null } = {}) => {
      const order = (nextNotificationOrderRef.current += 1);
      const notification = withTimelineNotificationMeta(message, {
        order,
        receivedAt: Date.now(),
        streamId: source.streamId ?? null,
        seq: source.seq ?? null,
      });
      const lastIndex = notificationBufferRef.current.length - 1;
      if (lastIndex >= 0) {
        const combined = coalesceBufferedDeltaNotification(notificationBufferRef.current[lastIndex], message, source);
        if (combined) {
          notificationBufferRef.current[lastIndex] = combined;
          if (notificationFlushTimerRef.current !== null) return;
          notificationFlushTimerRef.current = window.setTimeout(flushNotifications, NOTIFICATION_FLUSH_DELAY_MS);
          return;
        }
      }
      notificationBufferRef.current.push(notification);
      if (notificationFlushTimerRef.current !== null) return;
      notificationFlushTimerRef.current = window.setTimeout(flushNotifications, NOTIFICATION_FLUSH_DELAY_MS);
    },
    [flushNotifications],
  );

  const rememberNotificationStream = useCallback((streamId: string | null | undefined) => {
    if (typeof streamId !== 'string' || !streamId.trim()) return;
    const current = storedReplayStateRef.current;
    if (current.streamId === streamId) return;
    storedReplayStateRef.current = { streamId, seq: null };
    writeStoredNotificationReplayState(storedReplayStateRef.current);
  }, []);

  const rememberNotificationSeq = useCallback((streamId: string | null | undefined, seq: number | undefined): boolean => {
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return true;
    const normalizedStreamId = typeof streamId === 'string' && streamId.trim() ? streamId : storedReplayStateRef.current.streamId;
    const key = `${normalizedStreamId ?? ''}\0${seq}`;
    const seen = seenServerNotificationSeqsRef.current;
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > MAX_RETAINED_NOTIFICATIONS) {
      const oldest = seen.values().next().value;
      if (typeof oldest !== 'string') break;
      seen.delete(oldest);
    }
    const current = storedReplayStateRef.current;
    if (normalizedStreamId !== current.streamId || current.seq === null || seq > current.seq) {
      storedReplayStateRef.current = { streamId: normalizedStreamId ?? null, seq };
      writeStoredNotificationReplayState(storedReplayStateRef.current);
    }
    return true;
  }, []);

  const submitToken = useCallback(
    async (token: string) => {
      const trimmed = token.trim();
      if (!trimmed) throw new Error('Token is required');

      const response = await fetch(`/api/auth?token=${encodeURIComponent(trimmed)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Invalid token');

      stripTokenFromUrl();
      setTrackedConnectionState('connecting');
      setAuthRetryEpoch((value) => value + 1);
    },
    [setTrackedConnectionState],
  );

  useEffect(() => {
    let stopped = false;
    let retry = 250;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current === null) return;
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, retry);
      retry = Math.min(5_000, retry * 1.6);
    };

    const connect = async () => {
      if (stopped) return;

      setTrackedConnectionState('connecting');

      let auth: Response;
      try {
        auth = await fetch(`/api/auth${window.location.search}`, { credentials: 'same-origin' });
      } catch {
        if (stopped) return;
        setTrackedConnectionState('disconnected');
        scheduleReconnect();
        return;
      }

      if (stopped || connectionStateRef.current === 'auth-error') return;

      if (!auth.ok) {
        setTrackedConnectionState('auth-error');
        rejectPending(new Error('authentication failed'));
        return;
      }

      stripTokenFromUrl();

      const ws = new WebSocket(getWebSocketUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (stopped) return;
        retry = 250;
        if (hasConnectedRef.current) {
          flushNotifications();
          setReconnectEpoch((value) => value + 1);
        }
        hasConnectedRef.current = true;
        setTrackedConnectionState('connected');
        const replayState = storedReplayStateRef.current;
        ws.send(
          JSON.stringify({
            type: 'client/hello',
            params: {
              lastNotificationStreamId: replayState.streamId,
              lastNotificationSeq: replayState.seq,
            },
          }),
        );
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = parseServerMessage(event.data);
        if (!message) return;

        if (message.type === 'server/hello') {
          rememberNotificationStream(message.notificationStreamId);
          setHello(message);
          setRequests(message.requests ?? []);
        } else if (message.type === 'auth/error') {
          setTrackedConnectionState('auth-error');
          rejectPending(new Error('authentication failed'));
          ws.close();
        } else if (message.type === 'codex/notification') {
          if (!rememberNotificationSeq(message.streamId, message.seq)) return;
          queueNotification(message.message, { streamId: message.streamId ?? null, seq: message.seq ?? null });
        } else if (message.type === 'codex/request') {
          setRequests((items) => [...items.slice(-49), message.message]);
        } else if (message.type === 'codex/requestResolved') {
          setRequests((items) => items.filter((item) => requestIdOf(item) !== requestKey(message.requestId)));
        } else if (message.type === 'rpc/result' || message.type === 'rpc/error') {
          const pending = pendingRef.current.get(message.id);
          if (!pending) return;
          pendingRef.current.delete(message.id);
          window.clearTimeout(pending.timer);
          if (message.type === 'rpc/error') pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        flushNotifications();
        rejectPending(new Error('socket closed'));
        if (stopped || connectionStateRef.current === 'auth-error') return;
        setTrackedConnectionState('disconnected');
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    void connect();

    return () => {
      stopped = true;
      clearReconnectTimer();
      rejectPending(new Error('socket closed'));
      clearNotificationBuffer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [authRetryEpoch, clearNotificationBuffer, flushNotifications, queueNotification, rejectPending, rememberNotificationSeq, rememberNotificationStream, setTrackedConnectionState]);

  const rpc = useCallback(<T,>(method: string, params?: unknown, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = nextIdRef.current++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeoutMs);

      pendingRef.current.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      try {
        ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
      } catch (error) {
        window.clearTimeout(timer);
        pendingRef.current.delete(id);
        reject(error instanceof Error ? error : new Error('failed to send RPC request'));
      }
    });
  }, []);

  return { connectionState, hello, notifications, notificationCount, requests, reconnectEpoch, rpc, submitToken };
}
