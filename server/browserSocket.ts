import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isTokenValid, parseTokenFromCookie } from './auth.js';
import type { CodexAppServer } from './appServer.js';
import type { ServerConfig } from './config.js';
import type { HostStateStore } from './hostState.js';
import { logWarn } from './logger.js';

interface BrowserSocketDeps {
  config: ServerConfig;
  codex: CodexAppServer;
  stateStore: HostStateStore;
  token: string;
}

interface BrowserRequest {
  id?: unknown;
  type?: unknown;
  method?: unknown;
  params?: unknown;
}

interface SessionStartParams {
  cwd: string;
}

interface SessionResumeParams {
  threadId: string;
}

export interface BrowserSocketCleanup {
  close(): void;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function parseBrowserRequest(raw: Buffer | ArrayBuffer | Buffer[]): BrowserRequest | null {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as BrowserRequest) : null;
  } catch {
    return null;
  }
}

function authorized(deps: BrowserSocketDeps, queryToken: string | null, cookieHeader: string | undefined): boolean {
  if (deps.config.noAuth) return true;
  return isTokenValid(deps.token, queryToken) || isTokenValid(deps.token, parseTokenFromCookie(cookieHeader));
}

function closeClient(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING) {
    ws.terminate();
    return;
  }
  ws.close(1001, 'server shutting down');
  ws.terminate();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequiredString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  const value = params[key].trim();
  return value.length > 0 ? value : null;
}

function getStringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function extractThreadId(result: unknown): string | null {
  return (
    getStringPath(result, ['thread', 'id']) ??
    getStringPath(result, ['data', 'id']) ??
    getStringPath(result, ['id']) ??
    getStringPath(result, ['threadId'])
  );
}

function extractThreadCwd(result: unknown): string | null {
  return getStringPath(result, ['thread', 'cwd']) ?? getStringPath(result, ['data', 'cwd']) ?? getStringPath(result, ['cwd']);
}

function rememberCwd(cwds: string[], cwd: string): string[] {
  return [cwd, ...cwds.filter((item) => item !== cwd)].slice(0, 20);
}

function sanitizeThreadHistory(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeThreadHistory(item));
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(next.turns)) next.turns = [];

  for (const [key, child] of Object.entries(next)) {
    if (key !== 'turns') next[key] = sanitizeThreadHistory(child);
  }

  return next;
}

export function attachBrowserSocket(server: http.Server, deps: BrowserSocketDeps): BrowserSocketCleanup {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let closed = false;

  deps.codex.onNotification((message) => {
    for (const client of wss.clients) send(client, { type: 'codex/notification', message });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const client of wss.clients) closeClient(client);
    wss.close();
  };

  server.on('close', close);

  wss.on('error', (err) => {
    logWarn('Browser WebSocket server error', err);
  });

  wss.on('connection', (ws, req) => {
    ws.on('error', (err) => {
      logWarn('Browser WebSocket client error', err);
    });

    const url = new URL(req.url ?? '/ws', 'http://localhost');
    if (!authorized(deps, url.searchParams.get('token'), req.headers.cookie)) {
      send(ws, { type: 'auth/error' });
      ws.close(1008, 'unauthorized');
      return;
    }

    send(ws, {
      type: 'server/hello',
      hostname: deps.config.hostname,
      state: deps.stateStore.read(),
    });

    ws.on('message', async (raw) => {
      const request = parseBrowserRequest(raw);
      if (!request) return;

      if (request.type === 'client/hello') {
        send(ws, { type: 'server/hello', hostname: deps.config.hostname, state: deps.stateStore.read() });
        return;
      }

      if (
        request.type !== 'rpc' ||
        typeof request.method !== 'string' ||
        typeof request.id !== 'number' ||
        !Number.isFinite(request.id)
      ) {
        return;
      }

      try {
        if (request.method === 'webui/session/list') {
          const result = await deps.codex.request('thread/list', {
            limit: 50,
            cursor: null,
            sortDirection: 'desc',
            sortKey: 'updated_at',
          });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/session/start') {
          const cwd = getRequiredString(request.params, 'cwd');
          if (!cwd) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cwd is required' });
            return;
          }

          const params: SessionStartParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean } = {
            cwd,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
          };
          const result = await deps.codex.request('thread/start', params);
          const activeCwd = extractThreadCwd(result) ?? cwd;
          deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: extractThreadId(result),
            activeCwd,
            recentCwds: rememberCwd(state.recentCwds, activeCwd),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/session/resume') {
          const threadId = getRequiredString(request.params, 'threadId');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }

          const params: SessionResumeParams & { persistExtendedHistory: boolean } = {
            threadId,
            persistExtendedHistory: true,
          };
          const result = await deps.codex.request('thread/resume', params);
          const activeCwd = extractThreadCwd(result) ?? deps.stateStore.read().activeCwd;
          deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: threadId,
            activeCwd,
            recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: sanitizeThreadHistory(result) });
          return;
        }

        const result = await deps.codex.request(request.method, request.params);
        send(ws, { type: 'rpc/result', id: request.id, result });
      } catch (err) {
        send(ws, { type: 'rpc/error', id: request.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return { close };
}
