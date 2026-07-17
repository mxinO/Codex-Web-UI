import { useCallback, useEffect, useRef, useState } from 'react';
import { timelineNotificationMeta, withTimelineNotificationMeta } from '../lib/timeline';
import type { CodexRunOptions, ModelCapacityRetry, ThreadGoal } from '../types/ui';

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
    activeGoal: ThreadGoal | null;
    modelCapacityRetry: ModelCapacityRetry | null;
    theme: 'dark' | 'light';
    queue: Array<{ id: string; threadId?: string; text: string; createdAt: number; deliveryState?: 'maybeSent'; options?: Partial<CodexRunOptions> }>;
  };
  requests?: unknown[];
}

type ServerMessage =
  | ServerHello
  | { type: 'server/heartbeat'; sentAt: number }
  | { type: 'rpc/result'; id: number; result: unknown }
  | { type: 'rpc/error'; id: number; error: string }
  | { type: 'codex/notification'; streamId?: string; seq?: number; message: unknown }
  | { type: 'codex/replayGap'; streamId: string; requestedAfterSeq: number | null; firstAvailableSeq: number | null; latestSeq: number }
  | { type: 'codex/request'; message: unknown }
  | { type: 'codex/requestResolved'; requestId: number | string }
  | { type: 'auth/error' };

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_RETAINED_NOTIFICATIONS = 5000;
const NOTIFICATION_FLUSH_DELAY_MS = 125;
export const BROWSER_SOCKET_LIVENESS_TIMEOUT_MS = 45_000;
const TRANSIENT_AUTH_REJECTION_RETRIES = 3;
const AUTH_CHECK_TIMEOUT_MS = 10_000;
const UNRETAINED_OUTPUT_NOTIFICATION_METHODS = new Set([
  'command/exec/outputDelta',
  'process/outputDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
]);

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

function getWebSocketUrl(token: string | null = null) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function stripTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;

  url.searchParams.delete('token');
  const search = url.searchParams.toString();
  window.history.replaceState(null, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
}

function tokenFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get('token');
  return value && value.trim() ? value : null;
}

async function fetchAuth(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS);
  try {
    return await fetch(path, { credentials: 'same-origin', signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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

interface PendingReplayGap {
  epoch: number;
  streamId: string;
  latestSeq: number;
  postGapMaxSeq: number | null;
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

function latestReplayStateAfterNotifications(
  current: StoredNotificationReplayState,
  notifications: unknown[],
): StoredNotificationReplayState {
  let next = current;
  for (const notification of notifications) {
    const meta = timelineNotificationMeta(notification);
    if (!meta) continue;
    const seq = meta?.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) continue;
    const streamId = meta.streamId ?? next.streamId;
    if (streamId !== next.streamId || next.seq === null || seq > next.seq) {
      next = { streamId: streamId ?? null, seq };
    }
  }
  return next;
}

function replayStateAfterSequence(
  current: StoredNotificationReplayState,
  streamId: string | null | undefined,
  seq: number | null | undefined,
): StoredNotificationReplayState {
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return current;
  const normalizedStreamId = typeof streamId === 'string' && streamId.trim() ? streamId : current.streamId;
  if (normalizedStreamId !== current.streamId || current.seq === null || seq > current.seq) {
    return { streamId: normalizedStreamId ?? null, seq };
  }
  return current;
}

function shouldRetainNotification(message: unknown): boolean {
  return !isRecord(message) || typeof message.method !== 'string' || !UNRETAINED_OUTPUT_NOTIFICATION_METHODS.has(message.method);
}

export function useCodexSocket() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [hello, setHello] = useState<ServerHello | null>(null);
  const [notifications, setNotifications] = useState<unknown[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [requests, setRequests] = useState<unknown[]>([]);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [replayGapEpoch, setReplayGapEpoch] = useState(0);
  const [authRetryEpoch, setAuthRetryEpoch] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingRpc>());
  const notificationBufferRef = useRef<unknown[]>([]);
  const notificationFlushTimerRef = useRef<number | null>(null);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const reconnectTimerRef = useRef<number | null>(null);
  const hasConnectedRef = useRef(false);
  const authRejectionCountRef = useRef(0);
  const authTokenRef = useRef<string | null>(tokenFromUrl());
  const forceWebSocketTokenRef = useRef(false);
  const storedReplayStateRef = useRef<StoredNotificationReplayState>(readStoredNotificationReplayState());
  const pendingReplayStateRef = useRef<StoredNotificationReplayState | null>(null);
  const replayGapCounterRef = useRef(0);
  const pendingReplayGapRef = useRef<PendingReplayGap | null>(null);
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
    notificationBufferRef.current = [];
    const pendingReplayState = pendingReplayStateRef.current;
    pendingReplayStateRef.current = null;
    if (buffered.length === 0 && pendingReplayState === null) return;
    const nextReplayState = pendingReplayState ?? latestReplayStateAfterNotifications(storedReplayStateRef.current, buffered);
    if (nextReplayState.streamId !== storedReplayStateRef.current.streamId || nextReplayState.seq !== storedReplayStateRef.current.seq) {
      storedReplayStateRef.current = nextReplayState;
      writeStoredNotificationReplayState(nextReplayState);
    }
    if (buffered.length === 0) return;
    setNotificationCount((count) => count + buffered.length);
    setNotifications((items) => [...items, ...buffered].slice(-MAX_RETAINED_NOTIFICATIONS));
  }, []);

  const clearNotificationBuffer = useCallback(() => {
    notificationBufferRef.current = [];
    pendingReplayStateRef.current = null;
    if (notificationFlushTimerRef.current !== null) {
      window.clearTimeout(notificationFlushTimerRef.current);
      notificationFlushTimerRef.current = null;
    }
  }, []);

  const queueNotification = useCallback(
    (message: unknown, source: { streamId?: string | null; seq?: number | null } = {}) => {
      const pendingReplayState = replayStateAfterSequence(
        pendingReplayStateRef.current ?? storedReplayStateRef.current,
        source.streamId,
        source.seq,
      );
      pendingReplayStateRef.current = pendingReplayState;
      if (!shouldRetainNotification(message)) {
        if (notificationFlushTimerRef.current === null) {
          notificationFlushTimerRef.current = window.setTimeout(flushNotifications, NOTIFICATION_FLUSH_DELAY_MS);
        }
        return;
      }
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
    return true;
  }, []);

  const submitToken = useCallback(
    async (token: string) => {
      const trimmed = token.trim();
      if (!trimmed) throw new Error('Token is required');

      let response: Response;
      try {
        response = await fetchAuth(`/api/auth?token=${encodeURIComponent(trimmed)}`);
      } catch (error) {
        if (isAbortError(error)) throw new Error('Authentication request timed out');
        throw error;
      }
      if (!response.ok) throw new Error('Invalid token');

      authTokenRef.current = trimmed;
      forceWebSocketTokenRef.current = true;
      authRejectionCountRef.current = 0;
      stripTokenFromUrl();
      setTrackedConnectionState('connecting');
      setAuthRetryEpoch((value) => value + 1);
    },
    [setTrackedConnectionState],
  );

  useEffect(() => {
    let stopped = false;
    let retry = 250;
    let socketLivenessTimer: number | null = null;
    let socketLivenessOwner: WebSocket | null = null;
    let lastInboundAt = 0;

    const clearSocketLiveness = (owner?: WebSocket) => {
      if (owner && socketLivenessOwner !== owner) return;
      if (socketLivenessTimer !== null) window.clearTimeout(socketLivenessTimer);
      socketLivenessTimer = null;
      socketLivenessOwner = null;
    };

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

    const detachStaleSocket = (ws: WebSocket) => {
      if (stopped || wsRef.current !== ws) return;
      wsRef.current = null;
      clearSocketLiveness(ws);
      flushNotifications();
      rejectPending(new Error('socket heartbeat timed out'));
      setTrackedConnectionState('disconnected');
      ws.close();
      scheduleReconnect();
    };

    const checkSocketLiveness = (ws: WebSocket) => {
      if (stopped || wsRef.current !== ws || socketLivenessOwner !== ws) return;
      if (socketLivenessTimer !== null) window.clearTimeout(socketLivenessTimer);
      socketLivenessTimer = null;
      const remaining = BROWSER_SOCKET_LIVENESS_TIMEOUT_MS - (Date.now() - lastInboundAt);
      if (remaining > 0) {
        socketLivenessTimer = window.setTimeout(() => checkSocketLiveness(ws), remaining);
        return;
      }
      if (document.visibilityState === 'hidden') return;
      detachStaleSocket(ws);
    };

    const markSocketLive = (ws: WebSocket) => {
      if (stopped || wsRef.current !== ws) return;
      if (socketLivenessTimer !== null) window.clearTimeout(socketLivenessTimer);
      socketLivenessOwner = ws;
      lastInboundAt = Date.now();
      socketLivenessTimer = window.setTimeout(() => checkSocketLiveness(ws), BROWSER_SOCKET_LIVENESS_TIMEOUT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      checkSocketLiveness(ws);
    };

    const handleAuthRejected = (options: { schedule: boolean }) => {
      authRejectionCountRef.current += 1;
      if (hasConnectedRef.current && authRejectionCountRef.current <= TRANSIENT_AUTH_REJECTION_RETRIES) {
        setTrackedConnectionState('disconnected');
        if (options.schedule) scheduleReconnect();
        return false;
      }

      authTokenRef.current = null;
      forceWebSocketTokenRef.current = false;
      setTrackedConnectionState('auth-error');
      rejectPending(new Error('authentication failed'));
      return true;
    };

    const connect = async () => {
      if (stopped) return;

      setTrackedConnectionState('connecting');

      const urlToken = tokenFromUrl();
      if (urlToken) authTokenRef.current = urlToken;
      let authUsedToken = Boolean(urlToken);
      let auth: Response;
      try {
        auth = await fetchAuth(`/api/auth${window.location.search}`);
        if (!auth.ok && !urlToken) {
          const rememberedToken = authTokenRef.current;
          if (rememberedToken) {
            auth = await fetchAuth(`/api/auth?token=${encodeURIComponent(rememberedToken)}`);
            authUsedToken = true;
            if (!auth.ok) {
              authTokenRef.current = null;
              forceWebSocketTokenRef.current = false;
            }
          }
        }
      } catch {
        if (stopped) return;
        setTrackedConnectionState('disconnected');
        scheduleReconnect();
        return;
      }

      if (stopped || connectionStateRef.current === 'auth-error') return;

      if (!auth.ok) {
        handleAuthRejected({ schedule: true });
        return;
      }

      if (urlToken) authTokenRef.current = urlToken;
      authRejectionCountRef.current = 0;
      const websocketToken = authUsedToken || forceWebSocketTokenRef.current ? authTokenRef.current : null;
      stripTokenFromUrl();

      const ws = new WebSocket(getWebSocketUrl(websocketToken));
      wsRef.current = ws;

      ws.onopen = () => {
        if (stopped || wsRef.current !== ws) return;
        retry = 250;
        if (hasConnectedRef.current) {
          flushNotifications();
          setReconnectEpoch((value) => value + 1);
        }
        hasConnectedRef.current = true;
        setTrackedConnectionState('connected');
        markSocketLive(ws);
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
        if (stopped || wsRef.current !== ws) return;
        if (typeof event.data !== 'string') return;
        const message = parseServerMessage(event.data);
        if (!message) return;
        markSocketLive(ws);

        if (message.type === 'server/heartbeat') {
          return;
        } else if (message.type === 'server/hello') {
          forceWebSocketTokenRef.current = false;
          authRejectionCountRef.current = 0;
          rememberNotificationStream(message.notificationStreamId);
          setHello(message);
          setRequests(message.requests ?? []);
        } else if (message.type === 'auth/error') {
          forceWebSocketTokenRef.current = Boolean(authTokenRef.current);
          const terminal = handleAuthRejected({ schedule: false });
          ws.close();
          if (terminal) return;
        } else if (message.type === 'codex/notification') {
          const pendingGap = pendingReplayGapRef.current;
          if (
            pendingGap &&
            message.streamId === pendingGap.streamId &&
            typeof message.seq === 'number' &&
            Number.isFinite(message.seq)
          ) {
            pendingGap.postGapMaxSeq = Math.max(pendingGap.postGapMaxSeq ?? message.seq, message.seq);
          }
          if (!rememberNotificationSeq(message.streamId, message.seq)) return;
          queueNotification(message.message, { streamId: message.streamId ?? null, seq: message.seq ?? null });
        } else if (message.type === 'codex/replayGap') {
          const epoch = (replayGapCounterRef.current += 1);
          pendingReplayGapRef.current = {
            epoch,
            streamId: message.streamId,
            latestSeq: message.latestSeq,
            postGapMaxSeq: null,
          };
          setReplayGapEpoch(epoch);
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
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        clearSocketLiveness(ws);
        flushNotifications();
        rejectPending(new Error('socket closed'));
        if (stopped || connectionStateRef.current === 'auth-error') return;
        setTrackedConnectionState('disconnected');
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (stopped || wsRef.current !== ws) return;
        ws.close();
      };
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void connect();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearReconnectTimer();
      clearSocketLiveness();
      rejectPending(new Error('socket closed'));
      clearNotificationBuffer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [authRetryEpoch, clearNotificationBuffer, flushNotifications, queueNotification, rejectPending, rememberNotificationSeq, rememberNotificationStream, setTrackedConnectionState]);

  const acknowledgeReplayGap = useCallback((epoch: number) => {
    const gap = pendingReplayGapRef.current;
    if (!gap || gap.epoch !== epoch) return;
    flushNotifications();
    const nextReplayState = {
      streamId: gap.streamId,
      seq: Math.max(gap.latestSeq, gap.postGapMaxSeq ?? gap.latestSeq),
    };
    storedReplayStateRef.current = nextReplayState;
    pendingReplayStateRef.current = null;
    pendingReplayGapRef.current = null;
    writeStoredNotificationReplayState(nextReplayState);
  }, [flushNotifications]);

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

  return {
    connectionState,
    hello,
    notifications,
    notificationCount,
    requests,
    reconnectEpoch,
    replayGapEpoch,
    acknowledgeReplayGap,
    rpc,
    submitToken,
  };
}
