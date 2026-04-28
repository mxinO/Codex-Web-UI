import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth-error';

interface ServerHello {
  type: 'server/hello';
  hostname: string;
  state: {
    activeThreadId: string | null;
    activeTurnId: string | null;
    activeCwd: string | null;
    theme: 'dark' | 'light';
    queue: Array<{ id: string; text: string; createdAt: number }>;
  };
}

type ServerMessage =
  | ServerHello
  | { type: 'rpc/result'; id: number; result: unknown }
  | { type: 'rpc/error'; id: number; error: string }
  | { type: 'codex/notification'; message: unknown }
  | { type: 'codex/request'; message: unknown }
  | { type: 'codex/requestResolved'; requestId: number | string }
  | { type: 'auth/error' };

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

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

export function useCodexSocket() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [hello, setHello] = useState<ServerHello | null>(null);
  const [notifications, setNotifications] = useState<unknown[]>([]);
  const [requests, setRequests] = useState<unknown[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingRpc>());
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const reconnectTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    let stopped = false;
    let retry = 250;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current === null) return;
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };

    const scheduleReconnect = () => {
      if (stopped || connectionStateRef.current === 'auth-error') return;
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, retry);
      retry = Math.min(5_000, retry * 1.6);
    };

    const connect = async () => {
      if (stopped || connectionStateRef.current === 'auth-error') return;

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
        setTrackedConnectionState('connected');
        ws.send(JSON.stringify({ type: 'client/hello' }));
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = parseServerMessage(event.data);
        if (!message) return;

        if (message.type === 'server/hello') {
          setHello(message);
        } else if (message.type === 'auth/error') {
          setTrackedConnectionState('auth-error');
          rejectPending(new Error('authentication failed'));
          ws.close();
        } else if (message.type === 'codex/notification') {
          setNotifications((items) => [...items.slice(-199), message.message]);
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
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [rejectPending, setTrackedConnectionState]);

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

  return { connectionState, hello, notifications, requests, rpc };
}
