import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isTokenValid, parseTokenFromCookie } from './auth.js';
import type { CodexAppServer } from './appServer.js';
import { buildBangCommandParams, isInteractiveCommandBlocked } from './bangCommand.js';
import type { ServerConfig } from './config.js';
import { resolveExistingPathInsideRoot, resolveWritablePathInsideRoot } from './fileTransfer.js';
import type { HostStateStore } from './hostState.js';
import type { JsonRpcServerRequest } from './jsonRpc.js';
import { logWarn } from './logger.js';
import { enqueueMessage, removeQueuedMessage, shiftQueuedMessage, updateQueuedMessage } from './queue.js';
import type { HostRuntimeState, QueuedMessage } from './types.js';

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

interface TurnStartParams {
  threadId: string;
  text: string;
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function getRequiredString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  const value = params[key].trim();
  return value.length > 0 ? value : null;
}

function getString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  return params[key];
}

function getStringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function notificationThreadId(message: { params?: unknown }): string | null {
  return (
    getStringPath(message.params, ['threadId']) ??
    getStringPath(message.params, ['thread_id']) ??
    getStringPath(message.params, ['thread', 'id']) ??
    getStringPath(message.params, ['thread', 'threadId']) ??
    getStringPath(message.params, ['thread', 'thread_id']) ??
    getStringPath(message.params, ['turn', 'threadId']) ??
    getStringPath(message.params, ['turn', 'thread_id']) ??
    getStringPath(message.params, ['turn', 'thread', 'id'])
  );
}

function notificationTurnId(message: { params?: unknown }): string | null {
  return getStringPath(message.params, ['turnId']) ?? getStringPath(message.params, ['turn_id']) ?? getStringPath(message.params, ['turn', 'id']);
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

function extractTurnId(result: unknown): string | null {
  return getStringPath(result, ['turn', 'id']) ?? getStringPath(result, ['data', 'id']) ?? getStringPath(result, ['id']) ?? getStringPath(result, ['turnId']);
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

function approvalResponseForDecision(method: string, decision: unknown, params: unknown): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision };
  }

  if (method === 'mcpServer/elicitation/request') {
    if (decision !== 'decline' && decision !== 'cancel') {
      throw new Error('unsupported MCP elicitation decision');
    }
    return { action: decision, content: null, _meta: null };
  }

  if (method === 'item/tool/requestUserInput') {
    return { answers: decision };
  }

  if (method === 'item/tool/call') {
    return decision;
  }

  if (method === 'item/permissions/requestApproval') {
    if (decision !== 'accept' && decision !== 'decline') {
      throw new Error('unsupported permissions approval decision');
    }
    return { permissions: decision === 'accept' && isRecord(params) ? params.permissions : {}, scope: 'session' };
  }

  throw new Error(`unsupported approval request method: ${method}`);
}

function approvalRespondParams(params: unknown): { requestId: number | string; decision: unknown; method: string | null } | string {
  if (!isRecord(params)) return 'approval response params are required';
  const { requestId, method } = params;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return 'requestId is required';
  if (!hasOwn(params, 'decision')) return 'decision is required';
  return { requestId, decision: params.decision, method: typeof method === 'string' ? method : null };
}

function activeWorkspaceRoot(deps: BrowserSocketDeps): string {
  const activeCwd = deps.stateStore.read().activeCwd;
  if (!activeCwd) throw new Error('no active cwd');
  return activeCwd;
}

async function resolveReadableRpcPath(deps: BrowserSocketDeps, filePath: string): Promise<string> {
  return resolveExistingPathInsideRoot(activeWorkspaceRoot(deps), filePath);
}

async function resolveWritableRpcPath(deps: BrowserSocketDeps, filePath: string): Promise<string> {
  return resolveWritablePathInsideRoot(activeWorkspaceRoot(deps), filePath);
}

function turnListParams(params: unknown): { threadId: string; cursor: unknown; limit: number; sortDirection: string } | string {
  if (!isRecord(params)) return 'thread list params are required';
  const threadId = getRequiredString(params, 'threadId');
  if (!threadId) return 'threadId is required';

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 50;
  const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc';
  return {
    threadId,
    cursor: typeof params.cursor === 'string' ? params.cursor : null,
    limit,
    sortDirection,
  };
}

function extractResolvedRequestId(message: { method: string; params?: unknown }): number | string | null {
  if (!/request.*resolved|serverRequest.*resolved/i.test(message.method)) return null;
  if (!isRecord(message.params)) return null;
  const requestId = message.params.requestId ?? message.params.request_id ?? message.params.id;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}

export function attachBrowserSocket(server: http.Server, deps: BrowserSocketDeps): BrowserSocketCleanup {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let closed = false;
  let queuedStartInFlight: { threadId: string; queuedMessage: QueuedMessage } | null = null;
  const pendingServerRequests = new Map<string, JsonRpcServerRequest>();

  const broadcastHello = (state: HostRuntimeState = deps.stateStore.read()) => {
    for (const client of wss.clients) {
      sendHello(client, state);
    }
  };

  const sendHello = (client: WebSocket, state: HostRuntimeState = deps.stateStore.read()) => {
    send(client, {
      type: 'server/hello',
      hostname: deps.config.hostname,
      state,
      requests: Array.from(pendingServerRequests.values()),
    });
  };

  const broadcastRequestResolved = (requestId: number | string) => {
    for (const client of wss.clients) {
      send(client, { type: 'codex/requestResolved', requestId });
    }
  };

  const startTurn = async ({ threadId, text }: TurnStartParams) => {
    return deps.codex.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  };

  const handleTurnCompleted = async (message: { params?: unknown }) => {
    if (queuedStartInFlight) return;

    const completedThreadId = notificationThreadId(message);
    const completedTurnId = notificationTurnId(message);
    const current = deps.stateStore.read();

    if (completedThreadId && current.activeThreadId && completedThreadId !== current.activeThreadId) return;
    if (completedTurnId && current.activeTurnId && completedTurnId !== current.activeTurnId) return;

    const claim: { threadId?: string; queuedMessage?: QueuedMessage } = {};

    const claimed = deps.stateStore.update((current) => {
      if (!current.activeThreadId) {
        return { ...current, activeTurnId: null };
      }

      const shifted = shiftQueuedMessage(current.queue);
      if (!shifted.next) {
        return { ...current, activeTurnId: null };
      }

      claim.threadId = current.activeThreadId;
      claim.queuedMessage = shifted.next;
      return { ...current, activeTurnId: null, queue: shifted.queue };
    });
    broadcastHello(claimed);

    const { threadId, queuedMessage } = claim;
    if (!threadId || !queuedMessage) {
      return;
    }

    queuedStartInFlight = { threadId, queuedMessage };

    try {
      const result = await startTurn({ threadId, text: queuedMessage.text });
      const next = deps.stateStore.update((current) => ({
        ...current,
        activeTurnId: current.activeThreadId === threadId ? extractTurnId(result) : current.activeTurnId,
      }));
      broadcastHello(next);
    } catch (error) {
      logWarn('Failed to start queued turn', error);
      const next = deps.stateStore.update((current) => ({
        ...current,
        activeTurnId: current.activeThreadId === threadId ? null : current.activeTurnId,
        queue: current.queue.some((message) => message.id === queuedMessage.id)
          ? current.queue
          : [queuedMessage, ...current.queue].slice(0, deps.config.queueLimit),
      }));
      broadcastHello(next);
    } finally {
      queuedStartInFlight = null;
    }
  };

  const unsubscribeNotification = deps.codex.onNotification((message) => {
    for (const client of wss.clients) send(client, { type: 'codex/notification', message });
    const resolvedRequestId = extractResolvedRequestId(message);
    if (resolvedRequestId !== null && pendingServerRequests.delete(requestKey(resolvedRequestId))) {
      broadcastRequestResolved(resolvedRequestId);
    }
    if (message.method === 'turn/completed') void handleTurnCompleted(message);
  });

  const unsubscribeServerRequest = deps.codex.onServerRequest((message) => {
    pendingServerRequests.set(requestKey(message.id), message);
    for (const client of wss.clients) send(client, { type: 'codex/request', message });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeNotification();
    unsubscribeServerRequest();
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

    sendHello(ws);

    ws.on('message', async (raw) => {
      const request = parseBrowserRequest(raw);
      if (!request) return;

      if (request.type === 'client/hello') {
        sendHello(ws);
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
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: extractThreadId(result),
            activeTurnId: null,
            activeCwd,
            recentCwds: rememberCwd(state.recentCwds, activeCwd),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
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
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: threadId,
            activeTurnId: null,
            activeCwd,
            recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: sanitizeThreadHistory(result) });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/queue/enqueue') {
          const text = getRequiredString(request.params, 'text');
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: enqueueMessage(current.queue, text, deps.config.queueLimit),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/bang/run') {
          const command = getRequiredString(request.params, 'command');
          if (!command) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'command is required' });
            return;
          }

          const state = deps.stateStore.read();
          if (state.activeTurnId) {
            throw new Error('! commands are disabled while Codex is working');
          }
          if (!state.activeCwd) {
            throw new Error('no active cwd');
          }
          if (isInteractiveCommandBlocked(command)) {
            throw new Error('interactive commands are not supported');
          }

          const result = await deps.codex.request(
            'command/exec',
            buildBangCommandParams(command, state.activeCwd, deps.config.commandTimeoutMs, deps.config.commandOutputBytes),
            deps.config.commandTimeoutMs + 2_000,
          );
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/approval/respond') {
          const params = approvalRespondParams(request.params);
          if (typeof params === 'string') {
            send(ws, { type: 'rpc/error', id: request.id, error: params });
            return;
          }

          const pendingRequest = pendingServerRequests.get(requestKey(params.requestId));
          if (!pendingRequest) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'approval request is no longer pending' });
            return;
          }
          const response = approvalResponseForDecision(pendingRequest.method, params.decision, pendingRequest.params);
          deps.codex.respond(pendingRequest.id, response);
          pendingServerRequests.delete(requestKey(params.requestId));
          send(ws, { type: 'rpc/result', id: request.id, result: { ok: true } });
          broadcastRequestResolved(pendingRequest.id);
          return;
        }

        if (request.method === 'webui/fs/readDirectory') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const resolvedPath = await resolveReadableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/readDirectory', { path: resolvedPath });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/readFile') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const resolvedPath = await resolveReadableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/readFile', { path: resolvedPath });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/writeFile') {
          const filePath = getRequiredString(request.params, 'path');
          const dataBase64 = getString(request.params, 'dataBase64');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }
          if (dataBase64 === null) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'dataBase64 is required' });
            return;
          }

          const resolvedPath = await resolveWritableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/writeFile', { path: resolvedPath, dataBase64 });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/createDirectory') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const resolvedPath = await resolveWritableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/createDirectory', { path: resolvedPath });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/createFile') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const resolvedPath = await resolveWritableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/writeFile', { path: resolvedPath, dataBase64: '' });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/getMetadata') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const resolvedPath = await resolveReadableRpcPath(deps, filePath);
          const result = await deps.codex.request('fs/getMetadata', { path: resolvedPath });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'thread/turns/list') {
          const params = turnListParams(request.params);
          if (typeof params === 'string') {
            send(ws, { type: 'rpc/error', id: request.id, error: params });
            return;
          }

          const result = await deps.codex.request('thread/turns/list', params);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/queue/remove') {
          const id = getRequiredString(request.params, 'id');
          if (!id) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'id is required' });
            return;
          }

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: removeQueuedMessage(current.queue, id),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/queue/update') {
          const id = getRequiredString(request.params, 'id');
          const text = getRequiredString(request.params, 'text');
          if (!id) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'id is required' });
            return;
          }
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: updateQueuedMessage(current.queue, id, text),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/turn/start') {
          const threadId = getRequiredString(request.params, 'threadId');
          const text = getRequiredString(request.params, 'text');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const result = await startTurn({ threadId, text });
          const state = deps.stateStore.update((current) => ({
            ...current,
            activeTurnId: current.activeThreadId === threadId ? extractTurnId(result) : current.activeTurnId,
          }));
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/turn/interrupt') {
          const state = deps.stateStore.read();
          if (!state.activeThreadId || !state.activeTurnId) {
            throw new Error('no active turn to interrupt');
          }

          const result = await deps.codex.request('turn/interrupt', {
            threadId: state.activeThreadId,
            turnId: state.activeTurnId,
          });
          const next = deps.stateStore.update((current) => ({ ...current, activeTurnId: null }));
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(next);
          return;
        }

        send(ws, { type: 'rpc/error', id: request.id, error: `unsupported RPC method: ${request.method}` });
      } catch (err) {
        send(ws, { type: 'rpc/error', id: request.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return { close };
}
