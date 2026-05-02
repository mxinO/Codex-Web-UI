import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachBrowserSocket } from '../../server/browserSocket.js';
import { HostStateStore } from '../../server/hostState.js';
import { FileEditStore, sessionFileEditDbPath } from '../../server/fileEditStore.js';
import type { CodexAppServer } from '../../server/appServer.js';
import type { ServerConfig } from '../../server/config.js';
import type { HostRuntimeState } from '../../server/types.js';

interface RpcMessage {
  type: string;
  id?: number;
  result?: unknown;
  error?: string;
  requestId?: number | string;
  requests?: unknown[];
}

const cleanups: Array<() => void> = [];
type NotificationHandler = Parameters<CodexAppServer['onNotification']>[0];
type ServerRequestHandler = Parameters<CodexAppServer['onServerRequest']>[0];

function makeConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    hostname: 'test-host',
    stateDir: '/tmp/codex-webui-test-state',
    noAuth: true,
    mock: true,
    queueLimit: 20,
    commandTimeoutMs: 30_000,
    commandOutputBytes: 256_000,
  };
}

type TestRequest = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
const TURN_START_RPC_TIMEOUT_MS = 10 * 60 * 1000;

async function makeHarness(request: TestRequest, options: { startCwd?: string; initialState?: Partial<HostRuntimeState> } = {}) {
  const server = http.createServer();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-webui-browser-socket-'));
  const stateStore = new HostStateStore(stateDir, 'test-host');
  if (options.initialState) stateStore.write({ ...stateStore.read(), ...options.initialState });
  let notificationHandler: NotificationHandler | null = null;
  let serverRequestHandler: ServerRequestHandler | null = null;
  let healthHandler: (() => void) | null = null;
  const respond = vi.fn<CodexAppServer['respond']>();
  const start = vi.fn<CodexAppServer['start']>().mockResolvedValue(undefined);
  const health = vi.fn<CodexAppServer['health']>().mockReturnValue({ connected: true, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' });
  const codex = {
    start,
    request,
    respond,
    health,
    getPid: vi.fn<CodexAppServer['getPid']>().mockReturnValue(null),
    getUrl: vi.fn<CodexAppServer['getUrl']>().mockReturnValue(null),
    onNotification: vi.fn((handler: NotificationHandler) => {
      notificationHandler = handler;
      return () => undefined;
    }),
    onServerRequest: vi.fn((handler: ServerRequestHandler) => {
      serverRequestHandler = handler;
      return () => undefined;
    }),
    onHealthChange: vi.fn((handler: () => void) => {
      healthHandler = handler;
      return () => undefined;
    }),
  } as unknown as CodexAppServer;
  const cleanup = attachBrowserSocket(server, { config: makeConfig(), codex, stateStore, token: 'token', startCwd: options.startCwd });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    cleanup.close();
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const hello = nextMessage(ws);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  cleanups.push(() => ws.close());

  const initialHello = await hello;
  const notify = (method: string, params?: unknown) => {
    notificationHandler?.({ jsonrpc: '2.0', method, params });
  };
  const notifyRaw = (message: Parameters<NotificationHandler>[0]) => {
    notificationHandler?.(message);
  };
  const requestFromServer = (message: Parameters<ServerRequestHandler>[0]) => {
    serverRequestHandler?.(message);
  };
  const emitHealthChange = () => {
    healthHandler?.();
  };

  return { ws, stateStore, notify, notifyRaw, requestFromServer, emitHealthChange, respond, start, health, port, initialHello };
}

function nextMessage(ws: WebSocket): Promise<RpcMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as RpcMessage));
  });
}

function nextMessages(ws: WebSocket, count: number): Promise<RpcMessage[]> {
  return new Promise((resolve) => {
    const messages: RpcMessage[] = [];
    const onMessage = (data: RawData) => {
      messages.push(JSON.parse(String(data)) as RpcMessage);
      if (messages.length === count) {
        ws.off('message', onMessage);
        resolve(messages);
      }
    };
    ws.on('message', onMessage);
  });
}

function nextRpcResponse(ws: WebSocket, id: number): Promise<RpcMessage> {
  return new Promise((resolve) => {
    const onMessage = (data: RawData) => {
      const message = JSON.parse(String(data)) as RpcMessage;
      if ((message.type === 'rpc/result' || message.type === 'rpc/error') && message.id === id) {
        ws.off('message', onMessage);
        resolve(message);
      }
    };
    ws.on('message', onMessage);
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForRequest(request: ReturnType<typeof vi.fn>): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (request.mock.calls.length > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('request was not called');
}

async function waitForRequestCalls(request: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (request.mock.calls.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`request was called ${request.mock.calls.length} times, expected ${count}`);
}

async function waitForActiveTurnCleared(stateStore: HostStateStore): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (stateStore.read().activeTurnId === null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`active turn was not cleared: ${stateStore.read().activeTurnId ?? '<null>'}`);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('attachBrowserSocket session RPCs', () => {
  it('lists sessions through the bounded webui RPC', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ data: [] });
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 1, method: 'webui/session/list' }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/list', {
      limit: 50,
      cursor: null,
      sortDirection: 'desc',
      sortKey: 'updated_at',
    });
    expect(response).toEqual({ type: 'rpc/result', id: 1, result: { data: [] } });
  });

  it('starts sessions and records host-local active cwd history', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ thread: { id: 'thread-1', cwd: '/normalized/project' } });
    const { ws, stateStore } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 2, method: 'webui/session/start', params: { cwd: ' /work/project ' } }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/work/project',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });
    expect(response).toEqual({ type: 'rpc/result', id: 2, result: { thread: { id: 'thread-1', cwd: '/normalized/project' } } });
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeCwd: '/normalized/project',
      recentCwds: ['/normalized/project'],
    });
  });

  it('forwards run options when starting sessions', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ thread: { id: 'thread-1', cwd: '/work/project' } });
    const { ws } = await makeHarness(request);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 20,
        method: 'webui/session/start',
        params: {
          cwd: '/work/project',
          options: { model: 'gpt-5.5', effort: 'high', mode: 'default', sandbox: 'workspace-write' },
        },
      }),
    );
    await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/work/project',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      config: { model_reasoning_effort: 'high' },
    });
  });

  it('records app-server runtime status when starting sessions', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({
      thread: { id: 'thread-1', cwd: '/work/project' },
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      sandbox: { type: 'workspaceWrite', writableRoots: ['/work/project'], readOnlyAccess: { type: 'fullAccess' }, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    });
    const { ws, stateStore } = await makeHarness(request);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 23,
        method: 'webui/session/start',
        params: { cwd: '/work/project', options: { model: 'gpt-5.5', effort: 'high', mode: 'plan' } },
      }),
    );
    await nextRpcResponse(ws, 23);

    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      model: 'gpt-5.5',
      effort: 'xhigh',
      mode: 'plan',
      sandbox: 'workspace-write',
    });
  });

  it('forwards effort-only options as session config overrides', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ thread: { id: 'thread-1', cwd: '/work/project' } });
    const { ws } = await makeHarness(request);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 22,
        method: 'webui/session/start',
        params: { cwd: '/work/project', options: { effort: 'minimal' } },
      }),
    );
    await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/work/project',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      config: { model_reasoning_effort: 'minimal' },
    });
  });

  it('resumes sessions without forwarding full thread history', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({
      thread: {
        id: 'thread-2',
        cwd: '/work/resumed',
        turns: [{ id: 'turn-1', items: [{ type: 'agentMessage', text: 'large history' }] }],
      },
    });
    const { ws, stateStore } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 3, method: 'webui/session/resume', params: { threadId: 'thread-2' } }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-2',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      excludeTurns: true,
    });
    expect(response).toEqual({
      type: 'rpc/result',
      id: 3,
      result: { thread: { id: 'thread-2', cwd: '/work/resumed', turns: [] } },
    });
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-2',
      activeCwd: '/work/resumed',
      recentCwds: ['/work/resumed'],
    });
  });

  it('uses the selected session path when resume omits it', async () => {
    const threadPath = '/home/user/.codex/sessions/2026/04/29/rollout-thread-2.jsonl';
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async (method) => {
      if (method === 'thread/list') {
        return { data: [{ id: 'thread-2', cwd: '/work/resumed', path: threadPath }] };
      }
      return { thread: { id: 'thread-2', cwd: '/work/resumed', turns: [] } };
    });
    const { ws, stateStore } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 30, method: 'webui/session/list' }));
    await nextRpcResponse(ws, 30);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 31,
        method: 'webui/session/resume',
        params: {
          threadId: 'thread-2',
          threadPath,
        },
      }),
    );
    await nextMessage(ws);

    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-2',
      activeThreadPath: threadPath,
    });
  });

  it('clears stale session paths when resume has no path', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({
      thread: { id: 'thread-2', cwd: '/work/resumed', turns: [] },
    });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.update((state) => ({ ...state, activeThreadPath: '/old/session/rollout-old.jsonl' }));

    ws.send(JSON.stringify({ type: 'rpc', id: 32, method: 'webui/session/resume', params: { threadId: 'thread-2' } }));
    await nextMessage(ws);

    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-2',
      activeThreadPath: null,
    });
  });

  it('forwards run options when resuming sessions', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ thread: { id: 'thread-2', cwd: '/work/resumed', turns: [] } });
    const { ws } = await makeHarness(request);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 21,
        method: 'webui/session/resume',
        params: {
          threadId: 'thread-2',
          options: { model: 'gpt-5.5', effort: 'xhigh', mode: 'plan', sandbox: 'danger-full-access' },
        },
      }),
    );
    await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-2',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      excludeTurns: true,
      model: 'gpt-5.5',
      sandbox: 'danger-full-access',
      config: { model_reasoning_effort: 'xhigh' },
    });
  });

  it('records app-server runtime status when resuming sessions', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({
      thread: { id: 'thread-2', cwd: '/work/resumed', turns: [] },
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      sandbox: { type: 'dangerFullAccess' },
    });
    const { ws, stateStore } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 24, method: 'webui/session/resume', params: { threadId: 'thread-2' } }));
    await nextRpcResponse(ws, 24);

    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-2',
      model: 'gpt-5.4',
      effort: 'medium',
      sandbox: 'danger-full-access',
    });
  });

  it('sends rpc errors for invalid session params', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 4, method: 'webui/session/resume', params: { threadId: '   ' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 4, error: 'threadId is required' });
  });

  it('starts manual thread compaction through app-server', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: '/work/project', path: '/sessions/thread-1.jsonl' } };
      if (method === 'thread/compact/start') return {};
      throw new Error(`unexpected method ${method}`);
    });
    const { ws, stateStore } = await makeHarness(request, {
      initialState: { activeThreadId: 'thread-1', activeCwd: '/work/project', activeThreadPath: '/sessions/thread-1.jsonl', activeTurnId: null },
    });

    ws.send(JSON.stringify({ type: 'rpc', id: 41, method: 'webui/thread/compact/start', params: { threadId: 'thread-1' } }));
    const response = await nextRpcResponse(ws, 41);

    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-1',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      excludeTurns: true,
    });
    expect(request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread-1' });
    expect(response).toEqual({ type: 'rpc/result', id: 41, result: {} });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'compact-pending:thread-1' });
  });

  it('does not start manual compaction while the active thread is running', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({});
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: 'turn-1' });

    ws.send(JSON.stringify({ type: 'rpc', id: 42, method: 'webui/thread/compact/start', params: { threadId: 'thread-1' } }));
    const response = await nextRpcResponse(ws, 42);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 42, error: 'cannot compact while Codex is working' });
  });

  it('clears active turn when app-server reports compaction completion', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({});
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-compact',
      activeThreadPath: join(sessionDir, 'thread-1.jsonl'),
    });

    notify('thread/compacted', { threadId: 'thread-1', turnId: 'turn-compact' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });

  it('replaces pending manual compaction state with the app-server turn id', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async (method) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: '/work/project', path: '/sessions/thread-1.jsonl' } };
      if (method === 'thread/compact/start') return {};
      throw new Error(`unexpected method ${method}`);
    });
    const { ws, stateStore, notify } = await makeHarness(request, {
      initialState: { activeThreadId: 'thread-1', activeCwd: '/work/project', activeThreadPath: '/sessions/thread-1.jsonl', activeTurnId: null },
    });

    ws.send(JSON.stringify({ type: 'rpc', id: 43, method: 'webui/thread/compact/start', params: { threadId: 'thread-1' } }));
    await nextRpcResponse(ws, 43);
    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-compact' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-compact' });
  });

  it('clears pending manual compaction state on completion even when completion has the final turn id', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({});
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'compact-pending:thread-1',
    });

    notify('thread/compacted', { threadId: 'thread-1', turnId: 'turn-compact' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });
});

describe('attachBrowserSocket app-server requests', () => {
  it('broadcasts app-server requests to browser clients', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer } = await makeHarness(request);

    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test' },
    });
    const message = await nextMessage(ws);

    expect(message).toEqual({
      type: 'codex/request',
      message: {
        jsonrpc: '2.0',
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      },
    });
  });

  it('replays pending app-server requests to reconnecting browser clients', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { port, requestFromServer } = await makeHarness(request);
    const pending = {
      jsonrpc: '2.0' as const,
      id: 'approval-replay',
      method: 'item/fileChange/requestApproval',
      params: { path: 'file.ts' },
    };

    requestFromServer(pending);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const hello = nextMessage(ws);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    cleanups.push(() => ws.close());

    expect(await hello).toMatchObject({
      type: 'server/hello',
      requests: [pending],
    });
  });

  it('broadcasts active turn state before forwarding turn started notifications', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, notify } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null });

    const messages = nextMessages(ws, 2);
    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-1' });

    expect(await messages).toEqual([
      expect.objectContaining({
        type: 'server/hello',
        state: expect.objectContaining({ activeThreadId: 'thread-1', activeTurnId: 'turn-1' }),
      }),
      {
        type: 'codex/notification',
        streamId: expect.any(String),
        seq: 1,
        message: { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      },
    ]);
  });

  it('replays bounded missed notifications after the browser reconnects', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { port, notify } = await makeHarness(request);

    notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'first' });
    notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'second' });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextMessage(ws);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    const helloMessage = await initialHello;
    cleanups.push(() => ws.close());

    const replay = nextMessages(ws, 2);
    const streamId = (helloMessage as { notificationStreamId?: string }).notificationStreamId;
    ws.send(JSON.stringify({ type: 'client/hello', params: { lastNotificationStreamId: streamId, lastNotificationSeq: 1 } }));

    expect(await replay).toEqual([
      expect.objectContaining({ type: 'server/hello' }),
      {
        type: 'codex/notification',
        streamId: expect.any(String),
        seq: 2,
        message: { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'second' } },
      },
    ]);
  });

  it('replays current-process notifications when the browser has an old stream id', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { port, notify } = await makeHarness(request);

    notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'first-after-restart' });
    notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'second-after-restart' });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextMessage(ws);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await initialHello;
    cleanups.push(() => ws.close());

    const replay = nextMessages(ws, 3);
    ws.send(JSON.stringify({ type: 'client/hello', params: { lastNotificationStreamId: 'old-stream', lastNotificationSeq: 100 } }));

    expect(await replay).toEqual([
      expect.objectContaining({ type: 'server/hello' }),
      {
        type: 'codex/notification',
        streamId: expect.any(String),
        seq: 1,
        message: { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'first-after-restart' } },
      },
      {
        type: 'codex/notification',
        streamId: expect.any(String),
        seq: 2,
        message: { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'second-after-restart' } },
      },
    ]);
  });

  it('maps command approval decisions into app-server responses', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test' },
    });
    await approvalBroadcast;

    const responses = nextMessages(ws, 2);
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 50,
        method: 'webui/approval/respond',
        params: {
          requestId: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          decision: 'accept',
          requestParams: { command: 'npm test' },
        },
      }),
    );
    const [response, resolved] = await responses;

    expect(respond).toHaveBeenCalledWith('approval-1', { decision: 'accept' });
    expect(response).toEqual({ type: 'rpc/result', id: 50, result: { ok: true } });
    expect(resolved).toEqual({ type: 'codex/requestResolved', requestId: 'approval-1' });
  });

  it('returns an RPC error for unsupported approval request methods', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 7,
      method: 'unknown/request',
      params: {},
    });
    await approvalBroadcast;

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 51,
        method: 'webui/approval/respond',
        params: {
          requestId: 7,
          method: 'unknown/request',
          decision: 'accept',
          requestParams: {},
        },
      }),
    );
    const response = await nextMessage(ws);

    expect(respond).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 51, error: 'unsupported approval request method: unknown/request' });
  });

  it('rejects duplicate approval responses after the pending request resolves', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-duplicate',
      method: 'item/fileChange/requestApproval',
      params: { file: 'src/App.tsx' },
    });
    await approvalBroadcast;

    const firstResponses = nextMessages(ws, 2);
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 52,
        method: 'webui/approval/respond',
        params: { requestId: 'approval-duplicate', decision: 'accept' },
      }),
    );
    expect(await firstResponses).toEqual([
      { type: 'rpc/result', id: 52, result: { ok: true } },
      { type: 'codex/requestResolved', requestId: 'approval-duplicate' },
    ]);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 53,
        method: 'webui/approval/respond',
        params: { requestId: 'approval-duplicate', decision: 'decline' },
      }),
    );
    const duplicateResponse = await nextMessage(ws);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(duplicateResponse).toEqual({ type: 'rpc/error', id: 53, error: 'approval request is no longer pending' });
  });

  it('snapshots files before file-change approval and builds click-time diffs', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const filePath = join(root, 'a.txt');
    writeFileSync(filePath, 'old\n');
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-snapshot',
      method: 'item/fileChange/requestApproval',
      params: { path: filePath },
    });
    await approvalBroadcast;

    writeFileSync(filePath, 'new\n');
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 57,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    const response = await nextRpcResponse(ws, 57);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 57,
      result: { path: filePath, before: 'old\n', after: 'new\n', source: 'snapshot' },
    });
  });

  it('persists file snapshots in the session DB across browser socket restarts', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'persisted.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'before restart\n');

    const first = await makeHarness(request);
    first.stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      activeThreadPath: threadPath,
    }));

    const approvalBroadcast = nextMessage(first.ws);
    first.requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-persisted-snapshot',
      method: 'item/fileChange/requestApproval',
      params: { path: filePath },
    });
    await approvalBroadcast;
    writeFileSync(filePath, 'after restart\n');

    const second = await makeHarness(request);
    second.stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      activeThreadPath: threadPath,
    }));

    second.ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 62,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    const response = await nextRpcResponse(second.ws, 62);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 62,
      result: { path: filePath, before: 'before restart\n', after: 'after restart\n', source: 'snapshot' },
    });
  });

  it('finalizes per-turn file diffs on turn completion even after active preview clicks', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer, notify } = await makeHarness(request);
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'finalized.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'before completion\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      activeThreadPath: threadPath,
    }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-finalize',
      method: 'item/fileChange/requestApproval',
      params: { path: filePath },
    });
    await approvalBroadcast;
    writeFileSync(filePath, 'middle preview\n');

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 620,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 620)).toEqual({
      type: 'rpc/result',
      id: 620,
      result: { path: filePath, before: 'before completion\n', after: 'middle preview\n', source: 'snapshot' },
    });

    writeFileSync(filePath, 'after completion\n');

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-1' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6300 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6300 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'after completion\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    writeFileSync(filePath, 'changed after turn\n');

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 63,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    const response = await nextRpcResponse(ws, 63);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 63,
      result: { path: filePath, before: 'before completion\n', after: 'after completion\n', source: 'stored' },
    });
  });

  it('uses patch apply notifications to build active tray diffs from the first edit in a turn', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'patch-notification.txt');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, path: threadPath } } as T;
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, notify } = await makeHarness(request);
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'title\n\nline one\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: null,
      activeThreadPath: threadPath,
    }));
    ws.send(JSON.stringify({ type: 'rpc', id: 66, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'edit' } }));
    expect(await nextRpcResponse(ws, 66)).toEqual({ type: 'rpc/result', id: 66, result: { turn: { id: 'turn-1' } } });

    writeFileSync(filePath, 'title changed\n\nline one\n');
    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'patch-1',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1,3 +1,3 @@\n-title\n+title changed\n \n line one\n',
        },
      },
    });

    writeFileSync(filePath, 'title changed\n\nline one\nline two\n');
    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'patch-2',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -3 +3,2 @@\n line one\n+line two\n',
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6700 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6700 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'title changed\n\nline one\nline two\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 67,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 67)).toEqual({
      type: 'rpc/result',
      id: 67,
      result: {
        path: filePath,
        before: 'title\n\nline one\n',
        after: 'title changed\n\nline one\nline two\n',
        source: 'stored',
      },
    });
  });

  it('waits for queued file-change captures before returning the active tray summary', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-summary-race.jsonl');
    const firstPath = join(root, 'first.txt');
    const secondPath = join(root, 'second.txt');
    writeFileSync(threadPath, '');
    writeFileSync(firstPath, 'first before\n');
    writeFileSync(secondPath, 'second before\n');
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, notifyRaw } = await makeHarness(request);
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      activeThreadPath: threadPath,
    }));
    notifyRaw({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turnId: 'turn-1' } });

    writeFileSync(firstPath, 'first after\n');
    writeFileSync(secondPath, 'second after\n');
    notifyRaw({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'fileChange',
          id: 'file-change-summary',
          status: 'completed',
          changes: [
            { path: firstPath, type: 'update', diff: '@@ -1 +1 @@\n-first before\n+first after\n' },
            { path: secondPath, type: 'update', diff: '@@ -1 +1 @@\n-second before\n+second after\n' },
          ],
        },
      },
    });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 671,
        method: 'webui/fileChange/summary',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1' },
      }),
    );

    expect(await nextRpcResponse(ws, 671)).toMatchObject({
      type: 'rpc/result',
      id: 671,
      result: {
        turnId: 'turn-1',
        files: [
          { path: firstPath, editCount: 1, hasDiff: true },
          { path: secondPath, editCount: 1, hasDiff: true },
        ],
      },
    });
  });

  it('marks task_started turns active before turn/start returns so patch diffs use the turn-start baseline', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'early-task-start.txt');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-1', cwd: root, path: threadPath } } as T);
      if (method === 'turn/start') return startPromise as Promise<T>;
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });
    const { ws, stateStore, notifyRaw } = await makeHarness(request);
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: null,
      activeThreadPath: threadPath,
    }));

    ws.send(JSON.stringify({ type: 'rpc', id: 680, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'edit' } }));
    await waitForRequestCalls(request, 2);

    notifyRaw({ jsonrpc: '2.0', method: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-early' } });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-early' });

    writeFileSync(filePath, 'alpha\nbeta changed\ngamma\n');
    notifyRaw({
      jsonrpc: '2.0',
      method: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        turn_id: 'turn-early',
        call_id: 'patch-early',
        changes: {
          [filePath]: {
            type: 'update',
            unified_diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta changed\n gamma\n',
          },
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6810 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-early', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6810 + attempt);
      const result = response.result as { source?: string; before?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.before === 'alpha\nbeta\ngamma\n' && result.after === 'alpha\nbeta changed\ngamma\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 681,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-early', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 681)).toEqual({
      type: 'rpc/result',
      id: 681,
      result: { path: filePath, before: 'alpha\nbeta\ngamma\n', after: 'alpha\nbeta changed\ngamma\n', source: 'stored' },
    });

    resolveStart({ turn: { id: 'turn-early' } });
    expect(await nextRpcResponse(ws, 680)).toEqual({ type: 'rpc/result', id: 680, result: { turn: { id: 'turn-early' } } });
  });

  it('captures structured fileChange notifications from raw app-server events', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-structured.jsonl');
    const filePath = join(root, 'structured-file-change.txt');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-structured', cwd: root, path: threadPath } } as T);
      if (method === 'turn/start') return startPromise as Promise<T>;
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });
    const { ws, stateStore, notifyRaw } = await makeHarness(request);
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-structured',
      activeTurnId: null,
      activeThreadPath: threadPath,
    }));

    ws.send(JSON.stringify({ type: 'rpc', id: 6820, method: 'webui/turn/start', params: { threadId: 'thread-structured', text: 'edit' } }));
    await waitForRequestCalls(request, 2);

    notifyRaw({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-structured',
        turn: { id: 'turn-structured', items: [], status: 'inProgress' },
      },
    });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-structured', activeTurnId: 'turn-structured' });

    writeFileSync(filePath, 'alpha\nbeta changed\ngamma\n');
    notifyRaw({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-structured',
        turnId: 'turn-structured',
        item: {
          type: 'fileChange',
          id: 'file-change-1',
          changes: [
            {
              path: filePath,
              kind: { type: 'update' },
              diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta changed\n gamma\n',
            },
          ],
          status: 'completed',
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6830 + attempt,
          method: 'webui/fileChange/diff',
          params: {
            threadId: 'thread-structured',
            threadPath,
            turnId: 'turn-structured',
            path: filePath,
            changes: [{ path: filePath }],
          },
        }),
      );
      const response = await nextRpcResponse(ws, 6830 + attempt);
      const result = response.result as { source?: string; before?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.before === 'alpha\nbeta\ngamma\n' && result.after === 'alpha\nbeta changed\ngamma\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 683,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-structured',
          threadPath,
          turnId: 'turn-structured',
          path: filePath,
          changes: [{ path: filePath }],
        },
      }),
    );
    expect(await nextRpcResponse(ws, 683)).toEqual({
      type: 'rpc/result',
      id: 683,
      result: { path: filePath, before: 'alpha\nbeta\ngamma\n', after: 'alpha\nbeta changed\ngamma\n', source: 'stored' },
    });

    resolveStart({ turn: { id: 'turn-structured' } });
    expect(await nextRpcResponse(ws, 6820)).toEqual({ type: 'rpc/result', id: 6820, result: { turn: { id: 'turn-structured' } } });
  });

  it('deduplicates mixed legacy and structured file-change notifications for the same edit', async () => {
    for (const order of ['legacy-first', 'structured-first'] as const) {
      const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
      const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
      cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const threadPath = join(sessionDir, `rollout-2026-04-29T00-00-00-thread-${order}.jsonl`);
      const filePath = join(root, 'mixed-events.txt');
      const request = vi.fn<CodexAppServer['request']>();
      const { ws, stateStore, notifyRaw } = await makeHarness(request);
      writeFileSync(threadPath, '');
      writeFileSync(filePath, 'alpha\nbeta\ngamma\n');
      stateStore.update((state) => ({
        ...state,
        activeCwd: root,
        activeThreadId: `thread-${order}`,
        activeTurnId: `turn-${order}`,
        activeThreadPath: threadPath,
      }));
      notifyRaw({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { threadId: `thread-${order}`, turn: { id: `turn-${order}`, items: [], status: 'inProgress' } },
      });

      const legacy = () =>
        notifyRaw({
          jsonrpc: '2.0',
          method: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            turn_id: `turn-${order}`,
            call_id: 'duplicate-edit',
            changes: {
              [filePath]: {
                type: 'update',
                unified_diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta changed\n gamma\n',
              },
            },
          },
        });
      const structured = () =>
        notifyRaw({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            threadId: `thread-${order}`,
            turnId: `turn-${order}`,
            item: {
              type: 'fileChange',
              id: 'duplicate-edit',
              changes: [
                {
                  path: filePath,
                  kind: { type: 'update' },
                  diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta changed\n gamma\n',
                },
              ],
              status: 'completed',
            },
          },
        });

      writeFileSync(filePath, 'alpha\nbeta changed\ngamma\n');
      if (order === 'legacy-first') {
        legacy();
        structured();
      } else {
        structured();
        legacy();
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        ws.send(
          JSON.stringify({
            type: 'rpc',
            id: 6840 + attempt,
            method: 'webui/fileChange/diff',
            params: { threadId: `thread-${order}`, threadPath, turnId: `turn-${order}`, path: filePath, changes: [{ path: filePath }] },
          }),
        );
        const response = await nextRpcResponse(ws, 6840 + attempt);
        const result = response.result as { source?: string; before?: string; after?: string } | undefined;
        if (result?.source === 'stored' && result.before === 'alpha\nbeta\ngamma\n' && result.after === 'alpha\nbeta changed\ngamma\n') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: order === 'legacy-first' ? 684 : 685,
          method: 'webui/fileChange/diff',
          params: { threadId: `thread-${order}`, threadPath, turnId: `turn-${order}`, path: filePath, changes: [{ path: filePath }] },
        }),
      );
      expect(await nextRpcResponse(ws, order === 'legacy-first' ? 684 : 685)).toEqual({
        type: 'rpc/result',
        id: order === 'legacy-first' ? 684 : 685,
        result: { path: filePath, before: 'alpha\nbeta\ngamma\n', after: 'alpha\nbeta changed\ngamma\n', source: 'stored' },
      });
    }
  });

  it('does not overwrite a persisted turn-start baseline with an incomplete patch sequence', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, notify } = await makeHarness(request);
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'patch-after-restart.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'middle\n');
    const store = new FileEditStore(sessionFileEditDbPath(threadPath));
    store.recordSnapshot({ turnId: 'turn-1', itemId: 'snapshot-1', path: filePath, before: 'turn start\n' });
    store.finalizeFile({ turnId: 'turn-1', path: filePath, after: 'middle\n' });
    store.close();
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      activeThreadPath: threadPath,
    }));

    writeFileSync(filePath, 'final\n');
    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'patch-after-restart',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-middle\n+final\n',
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6800 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6800 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'final\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 68,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 68)).toEqual({
      type: 'rpc/result',
      id: 68,
      result: { path: filePath, before: 'turn start\n', after: 'final\n', source: 'stored' },
    });
  });

  it('restores a snapshot baseline when patch notifications are not a valid ordered sequence', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'out-of-order-patches.txt');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, path: threadPath } } as T;
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, notify } = await makeHarness(request);
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'c\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: null,
      activeThreadPath: threadPath,
    }));
    ws.send(JSON.stringify({ type: 'rpc', id: 69, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'edit' } }));
    expect(await nextRpcResponse(ws, 69)).toEqual({ type: 'rpc/result', id: 69, result: { turn: { id: 'turn-1' } } });
    const store = new FileEditStore(sessionFileEditDbPath(threadPath));
    store.recordSnapshot({ turnId: 'turn-1', itemId: 'snapshot-1', path: filePath, before: 'a\n' });
    store.finalizeFile({ turnId: 'turn-1', path: filePath, after: 'b\n' });
    store.close();

    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'patch-2-first',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-b\n+c\n',
        },
      },
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6900 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6900 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'c\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'patch-1-late',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6950 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 6950 + attempt);
      const result = response.result as { source?: string; before?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.before === 'a\n' && result.after === 'c\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 70,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 70)).toEqual({
      type: 'rpc/result',
      id: 70,
      result: { path: filePath, before: 'a\n', after: 'c\n', source: 'stored' },
    });
  });

  it('captures late multi-patch notifications after turn completion', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-1.jsonl');
    const filePath = join(root, 'late-patch.txt');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, path: threadPath } } as T;
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, notify } = await makeHarness(request);
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'before\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeTurnId: null,
      activeThreadPath: threadPath,
    }));
    ws.send(JSON.stringify({ type: 'rpc', id: 71, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'edit' } }));
    expect(await nextRpcResponse(ws, 71)).toEqual({ type: 'rpc/result', id: 71, result: { turn: { id: 'turn-1' } } });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-1' });
    await flushPromises();
    writeFileSync(filePath, 'after\n');
    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'late-patch-1',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-before\n+middle\n',
        },
      },
    });
    notify('event_msg', {
      type: 'patch_apply_end',
      turn_id: 'turn-1',
      call_id: 'late-patch-2',
      changes: {
        [filePath]: {
          type: 'update',
          unified_diff: '@@ -1 +1 @@\n-middle\n+after\n',
        },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 7100 + attempt,
          method: 'webui/fileChange/diff',
          params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
        }),
      );
      const response = await nextRpcResponse(ws, 7100 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'after\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 72,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 72)).toEqual({
      type: 'rpc/result',
      id: 72,
      result: { path: filePath, before: 'before\n', after: 'after\n', source: 'stored' },
    });
  });

  it('finalizes a completed turn using its captured session path after switching sessions', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer, notify } = await makeHarness(request);
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const oldThreadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-old.jsonl');
    const newThreadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-new.jsonl');
    const filePath = join(root, 'finalized-after-switch.txt');
    writeFileSync(oldThreadPath, '');
    writeFileSync(newThreadPath, '');
    writeFileSync(filePath, 'before switch\n');
    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-old',
      activeTurnId: 'turn-old',
      activeThreadPath: oldThreadPath,
    }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-before-switch',
      method: 'item/fileChange/requestApproval',
      params: { path: filePath },
    });
    await approvalBroadcast;
    writeFileSync(filePath, 'after switch completion\n');
    stateStore.update((state) => ({
      ...state,
      activeThreadId: 'thread-new',
      activeTurnId: 'turn-new',
      activeThreadPath: newThreadPath,
    }));

    notify('turn/completed', { threadId: 'thread-old', turnId: 'turn-old' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'rpc',
          id: 6600 + attempt,
          method: 'webui/fileChange/diff',
          params: {
            threadId: 'thread-old',
            threadPath: oldThreadPath,
            turnId: 'turn-old',
            path: filePath,
            changes: [{ path: filePath }],
          },
        }),
      );
      const response = await nextRpcResponse(ws, 6600 + attempt);
      const result = response.result as { source?: string; after?: string } | undefined;
      if (result?.source === 'stored' && result.after === 'after switch completion\n') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    writeFileSync(filePath, 'changed after old completion\n');
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 66,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-old',
          threadPath: oldThreadPath,
          turnId: 'turn-old',
          path: filePath,
          changes: [{ path: filePath }],
        },
      }),
    );
    expect(await nextRpcResponse(ws, 66)).toEqual({
      type: 'rpc/result',
      id: 66,
      result: { path: filePath, before: 'before switch\n', after: 'after switch completion\n', source: 'stored' },
    });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-new', activeTurnId: 'turn-new', activeThreadPath: newThreadPath });
  });

  it('uses the requested session DB path for stored file diffs', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const oldThreadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-old.jsonl');
    const requestedThreadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-2.jsonl');
    const filePath = join(root, 'stored-from-requested-db.txt');
    writeFileSync(oldThreadPath, '');
    writeFileSync(requestedThreadPath, '');
    writeFileSync(filePath, 'current file content should not win\n');
    request.mockImplementation(async (method) => {
      if (method === 'thread/list') {
        return { data: [{ id: 'thread-2', cwd: '/work/requested', path: requestedThreadPath }] };
      }
      return { thread: { id: 'thread-2', cwd: '/work/requested', turns: [] } };
    });

    ws.send(JSON.stringify({ type: 'rpc', id: 639, method: 'webui/session/list' }));
    await nextRpcResponse(ws, 639);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 641,
        method: 'webui/session/resume',
        params: { threadId: 'thread-2', threadPath: requestedThreadPath },
      }),
    );
    await nextRpcResponse(ws, 641);

    stateStore.update((state) => ({
      ...state,
      activeCwd: root,
      activeThreadId: 'thread-old',
      activeTurnId: null,
      activeThreadPath: oldThreadPath,
    }));

    const oldStore = new FileEditStore(sessionFileEditDbPath(oldThreadPath));
    oldStore.recordSnapshot({ turnId: 'turn-2', itemId: 'edit-old', path: filePath, before: 'wrong active before\n' });
    oldStore.finalizeFile({ turnId: 'turn-2', path: filePath, after: 'wrong active after\n' });
    oldStore.close();

    const store = new FileEditStore(sessionFileEditDbPath(requestedThreadPath));
    store.recordSnapshot({ turnId: 'turn-2', itemId: 'edit-1', path: filePath, before: 'before from requested db\n' });
    store.finalizeFile({ turnId: 'turn-2', path: filePath, after: 'after from requested db\n' });
    store.close();

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 640,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          path: filePath,
          changes: [{ path: filePath }],
        },
      }),
    );
    expect(await nextRpcResponse(ws, 640)).toEqual({
      type: 'rpc/result',
      id: 640,
      result: { path: filePath, before: '', after: '', source: 'current' },
    });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 64,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-2',
          threadPath: requestedThreadPath,
          turnId: 'turn-2',
          path: filePath,
          changes: [{ path: filePath }],
        },
      }),
    );
    const response = await nextRpcResponse(ws, 64);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 64,
      result: { path: filePath, before: 'before from requested db\n', after: 'after from requested db\n', source: 'stored' },
    });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 650,
        method: 'webui/fileChange/summary',
        params: { turnId: 'turn-2' },
      }),
    );
    expect(await nextRpcResponse(ws, 650)).toEqual({
      type: 'rpc/result',
      id: 650,
      result: { turnId: 'turn-2', files: [] },
    });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 65,
        method: 'webui/fileChange/summary',
        params: { threadId: 'thread-2', threadPath: requestedThreadPath, turnId: 'turn-2' },
      }),
    );
    expect(await nextRpcResponse(ws, 65)).toMatchObject({
      type: 'rpc/result',
      id: 65,
      result: { turnId: 'turn-2', files: [{ path: filePath, editCount: 1, hasDiff: true }] },
    });
  });

  it('rejects diff file reads outside the active workspace even when cwd is supplied', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-webui-outside-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const outsidePath = join(outside, 'secret.txt');
    writeFileSync(outsidePath, 'outside secret\n');
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 67,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          cwd: outside,
          path: outsidePath,
          changes: [{ path: outsidePath }],
        },
      }),
    );
    const response = await nextRpcResponse(ws, 67);

    expect(response).toEqual({ type: 'rpc/error', id: 67, error: 'path is outside active workspace' });
  });

  it('does not create stores for unvalidated read-only session paths', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-webui-outside-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const unvalidatedThreadPath = join(outside, 'fake-session', 'rollout-thread.jsonl');
    const dbPath = sessionFileEditDbPath(unvalidatedThreadPath);
    const filePath = join(root, 'inside.txt');
    writeFileSync(filePath, 'inside\n');
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 68,
        method: 'webui/fileChange/summary',
        params: { threadId: 'thread-outside', threadPath: unvalidatedThreadPath, turnId: 'turn-outside' },
      }),
    );
    expect(await nextRpcResponse(ws, 68)).toEqual({
      type: 'rpc/result',
      id: 68,
      result: { turnId: 'turn-outside', files: [] },
    });
    expect(existsSync(dbPath)).toBe(false);

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 69,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-outside',
          threadPath: unvalidatedThreadPath,
          turnId: 'turn-outside',
          path: filePath,
          changes: [{ path: filePath }],
        },
      }),
    );
    expect(await nextRpcResponse(ws, 69)).toEqual({
      type: 'rpc/result',
      id: 69,
      result: { path: filePath, before: '', after: '', source: 'current' },
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('does not snapshot symlink targets outside the active workspace', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-webui-outside-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const outsidePath = join(outside, 'secret.txt');
    const linkPath = join(root, 'secret-link.txt');
    writeFileSync(outsidePath, 'outside secret\n');
    symlinkSync(outsidePath, linkPath);
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-symlink',
      method: 'item/fileChange/requestApproval',
      params: { path: linkPath },
    });
    await approvalBroadcast;

    rmSync(linkPath);
    writeFileSync(linkPath, 'inside file\n');

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 59,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', turnId: 'turn-1', path: linkPath, changes: [{ path: linkPath }] },
      }),
    );
    const response = await nextRpcResponse(ws, 59);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 59,
      result: { path: linkPath, before: '', after: 'inside file\n', source: 'current' },
    });
  });

  it('keeps the snapshot cache bounded within a single approval payload', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const paths = Array.from({ length: 55 }, (_, index) => join(root, `file-${index}.txt`));
    for (const filePath of paths) writeFileSync(filePath, `old ${filePath}\n`);
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-many-files',
      method: 'item/fileChange/requestApproval',
      params: { changes: paths.map((filePath) => ({ path: filePath })) },
    });
    await approvalBroadcast;

    writeFileSync(paths[54], 'new last file\n');
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 60,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', turnId: 'turn-1', path: paths[54], changes: [{ path: paths[54] }] },
      }),
    );
    const response = await nextRpcResponse(ws, 60);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 60,
      result: { path: paths[54], before: '', after: 'new last file\n', source: 'current' },
    });
  });

  it('uses snapshots for in-workspace symlink edits', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const targetPath = join(root, 'target.txt');
    const linkPath = join(root, 'target-link.txt');
    writeFileSync(targetPath, 'old target\n');
    symlinkSync(targetPath, linkPath);
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-symlink-inside',
      method: 'item/fileChange/requestApproval',
      params: { path: linkPath },
    });
    await approvalBroadcast;

    writeFileSync(targetPath, 'new target\n');
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 61,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', turnId: 'turn-1', path: linkPath, changes: [{ path: linkPath }] },
      }),
    );
    const response = await nextRpcResponse(ws, 61);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 61,
      result: { path: targetPath, before: 'old target\n', after: 'new target\n', source: 'snapshot' },
    });
  });

  it('reconstructs added-file diffs from grouped Codex file-change hunks when no snapshot exists', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const filePath = join(root, 'retry.txt');
    stateStore.update((state) => ({ ...state, activeCwd: root, activeThreadId: 'thread-1', activeTurnId: 'turn-1' }));

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 58,
        method: 'webui/fileChange/diff',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          path: filePath,
          changes: [
            { path: filePath, kind: { type: 'add' }, diff: 'File edit retry\n\nEdit 1: Initial file created.\n' },
            { path: filePath, kind: { type: 'update' }, diff: '@@ -3 +3,2 @@\n Edit 1: Initial file created.\n+Edit 2: Added a second line.\n' },
            { path: filePath, kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n-File edit retry\n+File edit retry - updated title\n \n' },
          ],
        },
      }),
    );
    const response = await nextRpcResponse(ws, 58);

    expect(response).toEqual({
      type: 'rpc/result',
      id: 58,
      result: {
        path: filePath,
        before: '',
        after: 'File edit retry - updated title\n\nEdit 1: Initial file created.\nEdit 2: Added a second line.\n',
        source: 'reconstructed',
      },
    });
  });

  it('uses the stored pending request when browser approval params are spoofed', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-spoof',
      method: 'item/permissions/requestApproval',
      params: { permissions: ['safe-permission'] },
    });
    await approvalBroadcast;

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 54,
        method: 'webui/approval/respond',
        params: {
          requestId: 'approval-spoof',
          method: 'item/commandExecution/requestApproval',
          decision: 'accept',
          requestParams: { permissions: ['spoofed-permission'] },
        },
      }),
    );
    const response = await nextMessage(ws);

    expect(respond).toHaveBeenCalledWith('approval-spoof', { permissions: ['safe-permission'], scope: 'session' });
    expect(response).toEqual({ type: 'rpc/result', id: 54, result: { ok: true } });
  });

  it('does not grant requested permissions when permission approval is declined', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'permission-decline',
      method: 'item/permissions/requestApproval',
      params: { permissions: ['network', 'filesystem'] },
    });
    await approvalBroadcast;

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 55,
        method: 'webui/approval/respond',
        params: { requestId: 'permission-decline', decision: 'decline' },
      }),
    );
    const response = await nextMessage(ws);

    expect(respond).toHaveBeenCalledWith('permission-decline', { permissions: {}, scope: 'session' });
    expect(response).toEqual({ type: 'rpc/result', id: 55, result: { ok: true } });
  });

  it('rejects unsafe MCP elicitation accept responses', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'mcp-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { message: 'Need a value' },
    });
    await approvalBroadcast;

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 56,
        method: 'webui/approval/respond',
        params: { requestId: 'mcp-elicitation', decision: 'accept' },
      }),
    );
    const response = await nextMessage(ws);

    expect(respond).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 56, error: 'unsupported MCP elicitation decision' });
  });

  it('keeps numeric and string pending request ids distinct', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, requestFromServer, respond } = await makeHarness(request);

    const numericBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { file: 'numeric-id.ts' },
    });
    await numericBroadcast;

    const stringBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: '1',
      method: 'item/permissions/requestApproval',
      params: { permissions: { filesystem: 'read' } },
    });
    await stringBroadcast;

    const firstResponses = nextMessages(ws, 2);
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 57,
        method: 'webui/approval/respond',
        params: { requestId: 1, decision: 'accept' },
      }),
    );
    expect(await firstResponses).toEqual([
      { type: 'rpc/result', id: 57, result: { ok: true } },
      { type: 'codex/requestResolved', requestId: 1 },
    ]);

    const secondResponses = nextMessages(ws, 2);
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 58,
        method: 'webui/approval/respond',
        params: { requestId: '1', decision: 'accept' },
      }),
    );
    expect(await secondResponses).toEqual([
      { type: 'rpc/result', id: 58, result: { ok: true } },
      { type: 'codex/requestResolved', requestId: '1' },
    ]);

    expect(respond).toHaveBeenNthCalledWith(1, 1, { decision: 'accept' });
    expect(respond).toHaveBeenNthCalledWith(2, '1', { permissions: { filesystem: 'read' }, scope: 'session' });
  });
});

describe('attachBrowserSocket bang command RPCs', () => {
  it('rejects bang commands while a turn is running', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeTurnId: 'turn-1', activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 20, method: 'webui/bang/run', params: { command: 'echo ok' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 20, error: '! commands are disabled while Codex is working' });
  });

  it('rejects bang commands with no active cwd', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeTurnId: null, activeCwd: null });

    ws.send(JSON.stringify({ type: 'rpc', id: 21, method: 'webui/bang/run', params: { command: 'echo ok' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 21, error: 'no active cwd' });
  });

  it('executes valid bang commands locally in the active cwd without calling Codex', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-bang-'));
    writeFileSync(join(workspace, 'marker.txt'), 'ok');
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeTurnId: null, activeCwd: workspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 22, method: 'webui/bang/run', params: { command: 'printf \"%s\" \"$PWD\" && printf \" \" && cat marker.txt' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      type: 'rpc/result',
      id: 22,
      result: { exitCode: 0, stdout: `${workspace} ok`, stderr: '', cwd: workspace, killed: false },
    });
  });

  it('rejects interactive bang commands before calling codex', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 23, method: 'webui/bang/run', params: { command: 'vim file.txt' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 23, error: 'interactive commands are not supported' });
  });
});

describe('attachBrowserSocket fs RPC wrappers', () => {
  it('announces the server start cwd for new sessions when no session is active', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const startCwd = mkdtempSync(join(tmpdir(), 'codex-webui-start-cwd-'));
    cleanups.push(() => rmSync(startCwd, { recursive: true, force: true }));
    const { port } = await makeHarness(request, { startCwd });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const hello = nextMessage(ws);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    cleanups.push(() => ws.close());

    expect(await hello).toMatchObject({
      type: 'server/hello',
      startCwd,
      state: { activeCwd: null },
    });
  });

  it('browses directories for new session cwd selection without requiring an active cwd', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-browse-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'README.md'), 'readme');
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    ws.send(JSON.stringify({ type: 'rpc', id: 29, method: 'webui/fs/browseDirectory', params: { path: workspace } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({
      type: 'rpc/result',
      id: 29,
      result: {
        path: workspace,
        parent: tmpdir(),
        truncated: false,
        entries: [{ name: 'src', path: join(workspace, 'src'), isDirectory: true }],
      },
    });
  });

  it('creates browsed directories for new session cwd selection without requiring an active cwd', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-browse-create-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const newDir = join(workspace, 'new-session');
    const { ws } = await makeHarness(request, { startCwd: workspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 291, method: 'webui/fs/createBrowseDirectory', params: { path: 'new-session' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(statSync(newDir).isDirectory()).toBe(true);
    expect(response).toEqual({
      type: 'rpc/result',
      id: 291,
      result: { path: newDir },
    });
  });

  it('includes symlinked directories when browsing new session cwd choices', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-browse-symlink-'));
    const target = join(workspace, 'target');
    mkdirSync(target);
    symlinkSync(target, join(workspace, 'linked-target'), 'dir');
    writeFileSync(join(workspace, 'linked-file-target'), 'file');
    symlinkSync(join(workspace, 'linked-file-target'), join(workspace, 'linked-file'), 'file');
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    ws.send(JSON.stringify({ type: 'rpc', id: 31, method: 'webui/fs/browseDirectory', params: { path: workspace } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({
      type: 'rpc/result',
      id: 31,
      result: {
        path: workspace,
        parent: tmpdir(),
        truncated: false,
        entries: [
          { name: 'linked-target', path: join(workspace, 'linked-target'), isDirectory: true },
          { name: 'target', path: target, isDirectory: true },
        ],
      },
    });
  });

  it('caps browsed directory entries for large folders', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-browse-large-'));
    for (let index = 0; index < 501; index += 1) {
      mkdirSync(join(workspace, `dir-${index}`));
    }
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    ws.send(JSON.stringify({ type: 'rpc', id: 30, method: 'webui/fs/browseDirectory', params: { path: workspace } }));
    const response = await nextMessage(ws);
    const result = response.result as { entries?: unknown[]; truncated?: boolean };

    expect(request).not.toHaveBeenCalled();
    expect(response.type).toBe('rpc/result');
    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('reads file explorer directories locally without app-server RPCs', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'README.md'), 'hello');
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 30, method: 'webui/fs/readDirectory', params: { path: ` ${workspace} ` } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response.type).toBe('rpc/result');
    expect(response.id).toBe(30);
    expect(response.result).toMatchObject({
      entries: [
        { fileName: 'src', name: 'src', isDirectory: true, isFile: false },
        { fileName: 'README.md', name: 'README.md', isDirectory: false, isFile: true },
      ],
    });
  });

  it('keeps file explorer paths under a symlinked active workspace root', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const realParent = mkdtempSync(join(tmpdir(), 'codex-webui-real-workspace-'));
    const linkParent = mkdtempSync(join(tmpdir(), 'codex-webui-linked-workspace-'));
    const workspace = join(realParent, 'workspace');
    const linkedWorkspace = join(linkParent, 'workspace-link');
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'README.md'), 'hello from symlink');
    symlinkSync(workspace, linkedWorkspace, 'dir');
    cleanups.push(() => rmSync(realParent, { recursive: true, force: true }));
    cleanups.push(() => rmSync(linkParent, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: linkedWorkspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 301, method: 'webui/fs/readDirectory', params: { path: linkedWorkspace } }));
    const listing = await nextRpcResponse(ws, 301);
    const entries = (listing.result as { entries: Array<{ fileName: string; path: string }> }).entries;
    const readmeEntry = entries.find((entry) => entry.fileName === 'README.md');

    expect(request).not.toHaveBeenCalled();
    expect(readmeEntry).toMatchObject({ path: join(linkedWorkspace, 'README.md') });

    ws.send(JSON.stringify({ type: 'rpc', id: 302, method: 'webui/fs/readFile', params: { path: readmeEntry?.path } }));
    expect(await nextRpcResponse(ws, 302)).toEqual({
      type: 'rpc/result',
      id: 302,
      result: { dataBase64: Buffer.from('hello from symlink').toString('base64') },
    });
  });

  it('creates files locally by writing empty base64 data', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });
    const filePath = join(workspace, 'new.txt');

    ws.send(JSON.stringify({ type: 'rpc', id: 31, method: 'webui/fs/createFile', params: { path: filePath } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(readFileSync(filePath, 'utf8')).toBe('');
    expect(response).toEqual({ type: 'rpc/result', id: 31, result: {} });
  });

  it('writes and reads files locally inside the active workspace', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });
    const filePath = join(workspace, 'note.txt');

    ws.send(JSON.stringify({ type: 'rpc', id: 35, method: 'webui/fs/writeFile', params: { path: filePath, dataBase64: Buffer.from('hello').toString('base64') } }));
    expect(await nextMessage(ws)).toEqual({ type: 'rpc/result', id: 35, result: {} });

    ws.send(JSON.stringify({ type: 'rpc', id: 36, method: 'webui/fs/readFile', params: { path: filePath } }));
    expect(await nextMessage(ws)).toEqual({ type: 'rpc/result', id: 36, result: { dataBase64: Buffer.from('hello').toString('base64') } });

    expect(request).not.toHaveBeenCalled();
  });

  it('rejects write file requests without string base64 data', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 32, method: 'webui/fs/writeFile', params: { path: '/work/project/file.txt', dataBase64: 42 } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 32, error: 'dataBase64 is required' });
  });

  it('rejects filesystem requests outside the active workspace', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-webui-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 33, method: 'webui/fs/readFile', params: { path: join(outside, 'secret.txt') } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 33, error: 'path is outside active workspace' });
  });

  it('rejects unsupported app-server passthrough methods', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 34, method: 'fs/readFile', params: { path: '/etc/passwd' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 34, error: 'unsupported RPC method: fs/readFile' });
  });
});

describe('attachBrowserSocket app-server lifecycle', () => {
  it('ensures the app-server is started before timeline RPCs after reconnect or refresh', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ data: [] });
    const { ws, start, health } = await makeHarness(request);
    health.mockReturnValue({ connected: false, dead: true, error: 'Codex app-server exited', readyzUrl: null, url: null });
    start.mockImplementationOnce(async () => {
      health.mockReturnValue({ connected: true, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' });
    });

    const messages = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: 'rpc', id: 40, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));
    const [hello, response] = await messages;

    expect(hello).toMatchObject({ type: 'server/hello', appServerHealth: { connected: true, dead: false, error: null } });
    expect(response).toEqual({ type: 'rpc/result', id: 40, result: { data: [] } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/resume', 'thread/turns/list']);
    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', {
      threadId: 'thread-1',
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      excludeTurns: true,
    });
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  });

  it('awaits an in-flight app-server startup before sending timeline RPCs', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ data: [] });
    const { ws, start, health } = await makeHarness(request);
    let resolveStart!: () => void;
    health.mockReturnValue({ connected: false, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' });
    start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStart = () => {
          health.mockReturnValue({ connected: true, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' });
          resolve();
        };
      }),
    );

    const response = nextRpcResponse(ws, 41);
    ws.send(JSON.stringify({ type: 'rpc', id: 41, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));
    await waitForRequest(start);

    expect(request).not.toHaveBeenCalled();

    resolveStart();

    expect(await response).toEqual({ type: 'rpc/result', id: 41, result: { data: [] } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/resume', 'thread/turns/list']);
  });

  it('broadcasts app-server runtime status after resuming a persisted active thread', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async (method: string) => {
      if (method === 'thread/resume') {
        return {
          thread: { id: 'thread-1', cwd: '/work/project' },
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          sandbox: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
        };
      }
      return { data: [] };
    });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1' });

    const messages = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: 'rpc', id: 410, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));
    const [hello, response] = await messages;

    expect(hello).toMatchObject({
      type: 'server/hello',
      state: {
        activeThreadId: 'thread-1',
        activeCwd: '/work/project',
        model: 'gpt-5.5',
        effort: 'high',
        sandbox: 'read-only',
      },
    });
    expect(response).toEqual({ type: 'rpc/result', id: 410, result: { data: [] } });
  });

  it('clears stale runtime status after an implicit resume omits app-server runtime fields', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async (method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: '/work/project' }, reasoningEffort: null };
      return { data: [] };
    });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      model: 'stale-model',
      effort: 'high',
      mode: 'plan',
      sandbox: 'danger-full-access',
    });

    const messages = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: 'rpc', id: 411, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));
    const [hello, response] = await messages;

    expect(hello).toMatchObject({
      type: 'server/hello',
      state: {
        activeThreadId: 'thread-1',
        activeCwd: '/work/project',
        model: null,
        effort: null,
        mode: null,
        sandbox: null,
      },
    });
    expect(response).toEqual({ type: 'rpc/result', id: 411, result: { data: [] } });
  });

  it('adds stored file summaries to terminal turn history responses', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-history.jsonl');
    const filePath = join(root, 'history-summary.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'after\n');
    const store = new FileEditStore(sessionFileEditDbPath(threadPath));
    store.recordSnapshot({ turnId: 'turn-1', itemId: 'approval-1', path: filePath, before: 'before\n' });
    store.finalizeFile({ turnId: 'turn-1', path: filePath, after: 'after\n' });
    store.close();

    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, path: threadPath } } as T;
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-1', status: 'interrupted', items: [], startedAt: 1, completedAt: 2 }],
        } as T;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 43, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));

    expect(await nextRpcResponse(ws, 43)).toEqual({
      type: 'rpc/result',
      id: 43,
      result: {
        data: [
          {
            id: 'turn-1',
            status: 'interrupted',
            startedAt: 1,
            completedAt: 2,
            items: [
              {
                type: 'webuiFileChangeSummary',
                id: 'webui-file-summary:turn-1',
                files: [{ path: filePath, editCount: 1, hasDiff: true, updatedAtMs: expect.any(Number) }],
              },
            ],
          },
        ],
      },
    });
  });

  it('clears stale active thread state when resume reports a missing rollout', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockRejectedValue(new Error('no rollout found for thread id thread-1'));
    const { ws, stateStore } = await makeHarness(request, {
      initialState: {
        activeThreadId: 'thread-1',
        activeThreadPath: '/tmp/missing-rollout.jsonl',
        activeTurnId: 'turn-1',
        activeCwd: '/tmp/workspace',
      },
    });

    const messages = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: 'rpc', id: 42, method: 'thread/turns/list', params: { threadId: 'thread-1' } }));
    const [hello, response] = await messages;

    expect(hello).toMatchObject({
      type: 'server/hello',
      state: {
        activeThreadId: null,
        activeThreadPath: null,
        activeTurnId: null,
        activeCwd: '/tmp/workspace',
      },
    });
    expect(response).toEqual({ type: 'rpc/error', id: 42, error: 'no rollout found for thread id thread-1' });
    expect(stateStore.read()).toMatchObject({
      activeThreadId: null,
      activeThreadPath: null,
      activeTurnId: null,
      activeCwd: '/tmp/workspace',
    });
  });

  it('broadcasts app-server health changes while browser clients are idle', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, health, emitHealthChange } = await makeHarness(request);
    health.mockReturnValue({ connected: false, dead: true, error: 'Codex app-server WebSocket closed', readyzUrl: null, url: null });

    const message = nextMessage(ws);
    emitHealthChange();

    expect(await message).toMatchObject({
      type: 'server/hello',
      appServerHealth: { connected: false, dead: true, error: 'Codex app-server WebSocket closed' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('resumes the active thread before starting a turn after app-server restart', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: '/work/project', path: '/sessions/thread-1.jsonl' } } as T;
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, start, health } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeCwd: '/work/project' });
    health.mockReturnValue({ connected: false, dead: true, error: 'Codex app-server exited', readyzUrl: null, url: null });
    start.mockImplementationOnce(async () => {
      health.mockReturnValue({ connected: true, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' });
    });

    const response = nextRpcResponse(ws, 42);
    ws.send(JSON.stringify({ type: 'rpc', id: 42, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));

    expect(await response).toEqual({ type: 'rpc/result', id: 42, result: { turn: { id: 'turn-1' } } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/resume', 'turn/start']);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
    expect(stateStore.read()).toMatchObject({ activeThreadPath: '/sessions/thread-1.jsonl', activeTurnId: 'turn-1' });
  });
});

describe('attachBrowserSocket queue and turn RPCs', () => {
  it('clears a persisted active turn when a fresh browser server attaches', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { initialHello, stateStore } = await makeHarness(request, {
      initialState: {
        activeThreadId: 'thread-1',
        activeThreadPath: '/sessions/thread-1.jsonl',
        activeTurnId: 'turn-stale',
        activeCwd: '/work/project',
        queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
      },
    });

    expect(initialHello).toMatchObject({
      type: 'server/hello',
      state: {
        activeThreadId: 'thread-1',
        activeThreadPath: '/sessions/thread-1.jsonl',
        activeTurnId: null,
        activeCwd: '/work/project',
        queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
      },
    });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });

  it('clears the active turn when the Codex app-server dies', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, emitHealthChange, health, requestFromServer } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: 'turn-1', activeCwd: '/work/project' });
    const pendingRequest = nextMessage(ws);
    requestFromServer({ jsonrpc: '2.0', id: 99, method: 'item/tool/call', params: {} });
    expect(await pendingRequest).toMatchObject({ type: 'codex/request' });
    health.mockReturnValue({ connected: false, dead: true, error: 'Codex app-server exited', readyzUrl: null, url: null });

    const hello = nextMessage(ws);
    emitHealthChange();

    expect(await hello).toMatchObject({
      type: 'server/hello',
      state: { activeThreadId: 'thread-1', activeTurnId: null },
      appServerHealth: { connected: false, dead: true },
      requests: [],
    });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });

  it('lets stop clear a stale active turn without starting a dead app-server', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, start, health } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: 'turn-stale', activeCwd: '/work/project' });
    health.mockReturnValue({ connected: false, dead: true, error: 'Codex app-server exited', readyzUrl: null, url: null });

    const response = nextRpcResponse(ws, 16);
    ws.send(JSON.stringify({ type: 'rpc', id: 16, method: 'webui/turn/interrupt' }));

    expect(await response).toEqual({
      type: 'rpc/result',
      id: 16,
      result: { ok: false, cleared: true, error: 'Codex app-server exited' },
    });
    expect(start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });

  it('finalizes the active file summary when a turn is stopped', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-stop.jsonl');
    const firstPath = join(root, 'stop-first.txt');
    const secondPath = join(root, 'stop-second.txt');
    writeFileSync(threadPath, '');
    writeFileSync(firstPath, 'first before stop\n');
    writeFileSync(secondPath, 'second before stop\n');
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, path: threadPath } } as T;
      if (method === 'turn/interrupt') return { ok: true } as T;
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, requestFromServer } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeThreadPath: threadPath,
      activeTurnId: 'turn-1',
    });

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-stop',
      method: 'item/fileChange/requestApproval',
      params: { changes: [{ path: firstPath }, { path: secondPath }] },
    });
    await approvalBroadcast;
    writeFileSync(firstPath, 'first after stop\n');
    writeFileSync(secondPath, 'second after stop\n');

    const stopResponse = nextRpcResponse(ws, 18);
    ws.send(JSON.stringify({ type: 'rpc', id: 18, method: 'webui/turn/interrupt' }));
    expect(await stopResponse).toEqual({ type: 'rpc/result', id: 18, result: { ok: true } });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 19,
        method: 'webui/fileChange/summary',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1' },
      }),
    );
    expect(await nextRpcResponse(ws, 19)).toMatchObject({
      type: 'rpc/result',
      id: 19,
      result: {
        turnId: 'turn-1',
        files: [
          { path: firstPath, editCount: 1, hasDiff: true },
          { path: secondPath, editCount: 1, hasDiff: true },
        ],
      },
    });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 20,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: firstPath, changes: [{ path: firstPath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 20)).toEqual({
      type: 'rpc/result',
      id: 20,
      result: { path: firstPath, before: 'first before stop\n', after: 'first after stop\n', source: 'stored' },
    });
  });

  it('finalizes file summaries when Codex reports an interrupted turn', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-interrupted.jsonl');
    const filePath = join(root, 'interrupted.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'before interrupted\n');
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore, requestFromServer, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeCwd: root,
      activeThreadId: 'thread-1',
      activeThreadPath: threadPath,
      activeTurnId: 'turn-1',
    });

    const approvalBroadcast = nextMessage(ws);
    requestFromServer({
      jsonrpc: '2.0',
      id: 'approval-interrupted',
      method: 'item/fileChange/requestApproval',
      params: { path: filePath },
    });
    await approvalBroadcast;
    writeFileSync(filePath, 'after interrupted\n');

    notifyRaw({ jsonrpc: '2.0', method: 'turn/interrupted', params: { threadId: 'thread-1', turnId: 'turn-1' } });
    await waitForActiveTurnCleared(stateStore);

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 21,
        method: 'webui/fileChange/diff',
        params: { threadId: 'thread-1', threadPath, turnId: 'turn-1', path: filePath, changes: [{ path: filePath }] },
      }),
    );
    expect(await nextRpcResponse(ws, 21)).toEqual({
      type: 'rpc/result',
      id: 21,
      result: { path: filePath, before: 'before interrupted\n', after: 'after interrupted\n', source: 'stored' },
    });
  });

  it('does not start a queued message when an interrupted notification races stop', async () => {
    let resolveInterrupt: (value: unknown) => void = () => undefined;
    const interruptPromise = new Promise<unknown>((resolve) => {
      resolveInterrupt = resolve;
    });
    const queued = { id: 'queued-1', text: 'queued prompt', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(async <T = unknown>(method: string) => {
      if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: '/work/project', path: '/sessions/thread-1.jsonl' } } as T;
      if (method === 'turn/interrupt') return interruptPromise as T;
      if (method === 'turn/start') throw new Error('queued turn must not auto-start after interrupt');
      throw new Error(`unexpected method: ${method}`);
    });
    const { ws, stateStore, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: '/sessions/thread-1.jsonl',
      activeTurnId: 'turn-1',
      activeCwd: '/work/project',
      queue: [queued],
    });

    const stopResponse = nextRpcResponse(ws, 31);
    ws.send(JSON.stringify({ type: 'rpc', id: 31, method: 'webui/turn/interrupt' }));
    await waitForRequestCalls(request, 2);
    expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' });

    notifyRaw({ jsonrpc: '2.0', method: 'turn/interrupted', params: { threadId: 'thread-1', turnId: 'turn-1' } });
    await waitForActiveTurnCleared(stateStore);
    resolveInterrupt({ ok: true });

    expect(await stopResponse).toEqual({ type: 'rpc/result', id: 31, result: { ok: true } });
    expect(request.mock.calls.map(([method]) => method)).not.toContain('turn/start');
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeTurnId: null,
      queue: [queued],
    });
  });

  it.each([
    ['turn/failed notification', { jsonrpc: '2.0', method: 'turn/failed', params: { threadId: 'thread-1', turnId: 'turn-1' } }],
    [
      'task_failed event',
      { jsonrpc: '2.0', method: 'event_msg', params: { threadId: 'thread-1', turnId: 'turn-1' }, payload: { type: 'task_failed' } },
    ],
    ['turn/interrupted notification', { jsonrpc: '2.0', method: 'turn/interrupted', params: { threadId: 'thread-1', turnId: 'turn-1' } }],
    [
      'task_interrupted event',
      { jsonrpc: '2.0', method: 'event_msg', params: { threadId: 'thread-1', turnId: 'turn-1' }, payload: { type: 'task_interrupted' } },
    ],
  ] satisfies Array<[string, Parameters<NotificationHandler>[0]]>)('treats %s as a queued-message barrier', async (_name, notification) => {
    const queued = { id: 'queued-1', text: 'queued prompt', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: '/sessions/thread-1.jsonl',
      activeTurnId: 'turn-1',
      activeCwd: '/work/project',
      queue: [queued],
    });

    notifyRaw(notification);
    await waitForActiveTurnCleared(stateStore);

    expect(request.mock.calls.map(([method]) => method)).not.toContain('turn/start');
    expect(stateStore.read().queue).toEqual([queued]);
  });

  it('does not let a stale unscoped terminal clear a newer active turn', async () => {
    const queued = { id: 'queued-1', text: 'queued prompt', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: '/sessions/thread-1.jsonl',
      activeTurnId: 'turn-new',
      activeCwd: '/work/project',
      queue: [queued],
    });

    notifyRaw({ jsonrpc: '2.0', method: 'event_msg', payload: { type: 'task_interrupted' } });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeTurnId: 'turn-new', queue: [queued] });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not let a stale unscoped terminal clear a pending queued start', async () => {
    const queued = { id: 'queued-1', text: 'queued prompt', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: '/sessions/thread-1.jsonl',
      activeTurnId: 'turn-start-pending:thread-1',
      activeCwd: '/work/project',
      queue: [queued],
    });

    notifyRaw({ jsonrpc: '2.0', method: 'event_msg', payload: { type: 'task_failed' } });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeTurnId: 'turn-start-pending:thread-1', queue: [queued] });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['turn/completed notification', { jsonrpc: '2.0', method: 'turn/completed' }],
    ['task_complete event', { jsonrpc: '2.0', method: 'event_msg', payload: { type: 'task_complete' } }],
  ] satisfies Array<[string, Parameters<NotificationHandler>[0]]>)('does not let an unscoped %s advance a newer active turn', async (_name, notification) => {
    const queued = { id: 'queued-1', text: 'queued prompt', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notifyRaw } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: '/sessions/thread-1.jsonl',
      activeTurnId: 'turn-new',
      activeCwd: '/work/project',
      queue: [queued],
    });

    notifyRaw(notification);
    await flushPromises();

    expect(request.mock.calls.map(([method]) => method)).not.toContain('turn/start');
    expect(stateStore.read()).toMatchObject({ activeTurnId: 'turn-new', queue: [queued] });
  });

  it('lets stop clear an active turn when the resumed thread is no longer known to Codex', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockRejectedValue(new Error('thread not found'));
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: 'turn-stale', activeCwd: '/work/project' });

    const response = nextRpcResponse(ws, 17);
    ws.send(JSON.stringify({ type: 'rpc', id: 17, method: 'webui/turn/interrupt' }));

    expect(await response).toEqual({
      type: 'rpc/result',
      id: 17,
      result: { ok: false, cleared: true, error: 'thread not found' },
    });
    expect(request).toHaveBeenCalledWith('thread/resume', { threadId: 'thread-1', experimentalRawEvents: true, persistExtendedHistory: true, excludeTurns: true });
    expect(stateStore.read()).toMatchObject({ activeThreadId: null, activeThreadPath: null, activeTurnId: null, activeCwd: '/work/project' });
  });

  it('enqueues, updates, and removes queued messages', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 10, method: 'webui/queue/enqueue', params: { text: ' first ' } }));
    const enqueueResponse = await nextMessage(ws);
    const queued = enqueueResponse.result as Array<{ id: string; text: string; createdAt: number }>;
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe('first');

    ws.send(JSON.stringify({ type: 'rpc', id: 11, method: 'webui/queue/update', params: { id: queued[0].id, text: ' edited ' } }));
    const updateResponse = await nextMessage(ws);
    expect(updateResponse.result).toEqual([{ ...queued[0], text: 'edited' }]);

    ws.send(JSON.stringify({ type: 'rpc', id: 12, method: 'webui/queue/remove', params: { id: queued[0].id } }));
    const removeResponse = await nextMessage(ws);
    expect(removeResponse).toEqual({ type: 'rpc/result', id: 12, result: [] });
    expect(stateStore.read().queue).toEqual([]);
  });

  it('does not write a direct started turn id into a different active session', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockReturnValue(startPromise);
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null });

    ws.send(JSON.stringify({ type: 'rpc', id: 13, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));
    await waitForRequest(request);
    stateStore.update((state) => ({ ...state, activeThreadId: 'thread-2', activeTurnId: 'turn-current' }));
    resolveStart({ turn: { id: 'turn-from-thread-1' } });

    const response = await nextRpcResponse(ws, 13);
    await flushPromises();

    expect(response).toEqual({ type: 'rpc/result', id: 13, result: { turn: { id: 'turn-from-thread-1' } } });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-2', activeTurnId: 'turn-current' });
  });

  it('rejects direct turn starts while the active thread is already busy', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: 'compact-pending:thread-1' });

    ws.send(JSON.stringify({ type: 'rpc', id: 131, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));

    expect(await nextRpcResponse(ws, 131)).toEqual({
      type: 'rpc/error',
      id: 131,
      error: 'Codex is already working; queue the message instead',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('marks direct turn starts pending before the app-server responds', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-1', cwd: '/work/project' } } as T);
      if (method === 'turn/start') return startPromise as Promise<T>;
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 132, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));
    await waitForRequestCalls(request, 2);

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' });

    ws.send(JSON.stringify({ type: 'rpc', id: 133, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'second' } }));
    expect(await nextRpcResponse(ws, 133)).toEqual({
      type: 'rpc/error',
      id: 133,
      error: 'Codex is already working; queue the message instead',
    });
    expect(request).toHaveBeenCalledTimes(2);

    resolveStart({ turn: { id: 'turn-1' } });
    expect(await nextRpcResponse(ws, 132)).toEqual({ type: 'rpc/result', id: 132, result: { turn: { id: 'turn-1' } } });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-1' });
  });

  it('keeps direct turn starts pending when app-server turn/start times out after send', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-1', cwd: '/work/project' } } as T);
      if (method === 'turn/start') return Promise.reject(new Error('JSON-RPC request timed out: turn/start'));
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 134, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));

    expect(await nextRpcResponse(ws, 134)).toEqual({
      type: 'rpc/error',
      id: 134,
      error: 'JSON-RPC request timed out: turn/start',
    });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' });
  });

  it('does not resurrect a direct turn that completes before turn/start returns', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-1', cwd: '/work/project' } } as T);
      if (method === 'turn/start') return startPromise as Promise<T>;
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { ws, stateStore, notify } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 135, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));
    await waitForRequestCalls(request, 2);
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-fast' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' });

    resolveStart({ turn: { id: 'turn-fast' } });
    expect(await nextRpcResponse(ws, 135)).toEqual({ type: 'rpc/result', id: 135, result: { turn: { id: 'turn-fast' } } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null });
  });

  it('does not let a stale same-thread completion clear a pending direct start', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) => {
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'thread-1', cwd: '/work/project' } } as T);
      if (method === 'turn/start') return startPromise as Promise<T>;
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { ws, stateStore, notify } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 136, method: 'webui/turn/start', params: { threadId: 'thread-1', text: 'hello' } }));
    await waitForRequestCalls(request, 2);
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' });

    resolveStart({ turn: { id: 'turn-new' } });
    expect(await nextRpcResponse(ws, 136)).toEqual({ type: 'rpc/result', id: 136, result: { turn: { id: 'turn-new' } } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-new' });
  });

  it('forwards run options when starting direct turns', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ turn: { id: 'turn-1' } });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeCwd: '/work/project' });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 14,
        method: 'webui/turn/start',
        params: {
          threadId: 'thread-1',
          text: 'hello',
          options: { model: 'gpt-5.5', effort: 'high', sandbox: 'danger-full-access' },
        },
      }),
    );
    await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      model: 'gpt-5.5',
      effort: 'high',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }, TURN_START_RPC_TIMEOUT_MS);
    expect(stateStore.read()).toMatchObject({
      model: 'gpt-5.5',
      effort: 'high',
      sandbox: 'danger-full-access',
    });
  });

  it('forwards collaboration mode when starting direct turns', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ turn: { id: 'turn-1' } });
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeThreadId: 'thread-1', activeCwd: '/work/project' });

    ws.send(
      JSON.stringify({
        type: 'rpc',
        id: 15,
        method: 'webui/turn/start',
        params: {
          threadId: 'thread-1',
          text: 'hello',
          options: { model: 'gpt-5.5', effort: 'high', mode: 'plan' },
        },
      }),
    );
    await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      model: 'gpt-5.5',
      effort: 'high',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.5', reasoning_effort: 'high', developer_instructions: null },
      },
    }, TURN_START_RPC_TIMEOUT_MS);
  });

  it('auto-starts exactly one queued message when duplicate completion notifications arrive', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', { threadId: 'thread-1', experimentalRawEvents: true, persistExtendedHistory: true, excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
    }, TURN_START_RPC_TIMEOUT_MS);
    expect(stateStore.read()).toMatchObject({ activeTurnId: 'turn-start-pending:thread-1', queue: [] });

    resolveStart({ turn: { id: 'turn-next' } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [] });
  });

  it('does not resurrect a queued turn that completes before turn/start returns', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);
    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-next' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-next' });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });

    resolveStart({ turn: { id: 'turn-next' } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });
  });

  it.each(['turn/failed', 'turn/interrupted'] as const)(
    'reconciles %s for a queued turn while its turn/start RPC is still in flight',
    async (terminalMethod) => {
      let rejectStart: (error: unknown) => void = () => undefined;
      const startPromise = new Promise<unknown>((_resolve, reject) => {
        rejectStart = reject;
      });
      const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
        method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
      );
      const { stateStore, notify } = await makeHarness(request);
      stateStore.write({
        ...stateStore.read(),
        activeThreadId: 'thread-1',
        activeTurnId: 'turn-old',
        queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
      });

      notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
      await waitForRequestCalls(request, 2);
      notify('turn/started', { threadId: 'thread-1', turnId: 'turn-next' });
      notify(terminalMethod, { threadId: 'thread-1', turnId: 'turn-next' });
      await flushPromises();

      expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });

      rejectStart(new Error('JSON-RPC request timed out: turn/start'));
      await flushPromises();

      expect(request).toHaveBeenCalledTimes(2);
      expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });
    },
  );

  it.each(['turn/failed', 'turn/interrupted', 'turn/completed'] as const)(
    'does not mark a queued turn active when %s arrives before turn/started',
    async (terminalMethod) => {
      let rejectStart: (error: unknown) => void = () => undefined;
      const startPromise = new Promise<unknown>((_resolve, reject) => {
        rejectStart = reject;
      });
      const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
        method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
      );
      const { stateStore, notify } = await makeHarness(request);
      stateStore.write({
        ...stateStore.read(),
        activeThreadId: 'thread-1',
        activeTurnId: 'turn-old',
        queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
      });

      notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
      await waitForRequestCalls(request, 2);
      notify(terminalMethod, { threadId: 'thread-1', turnId: 'turn-next' });
      await flushPromises();
      expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1', queue: [] });

      notify('turn/started', { threadId: 'thread-1', turnId: 'turn-next' });
      await flushPromises();
      expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });

      rejectStart(new Error('JSON-RPC request timed out: turn/start'));
      await flushPromises();

      expect(request).toHaveBeenCalledTimes(2);
      expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });
    },
  );

  it('does not mark a queued turn active after terminal-before-started when file summary finalization fails', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'codex-webui-session-dir-'));
    const root = mkdtempSync(join(tmpdir(), 'codex-webui-diff-root-'));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const threadPath = join(sessionDir, 'rollout-2026-04-29T00-00-00-thread-queued-terminal.jsonl');
    const filePath = join(root, 'queued-terminal.txt');
    writeFileSync(threadPath, '');
    writeFileSync(filePath, 'after\n');
    const store = new FileEditStore(sessionFileEditDbPath(threadPath));
    store.recordSnapshot({ turnId: 'turn-next', itemId: 'edit-1', path: filePath, before: 'before\n' });
    store.close();
    const finalizeSpy = vi.spyOn(FileEditStore.prototype, 'finalizeFile').mockImplementationOnce(() => {
      throw new Error('finalize failed');
    });
    cleanups.push(() => finalizeSpy.mockRestore());

    let rejectStart: (error: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((_resolve, reject) => {
      rejectStart = reject;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeThreadPath: threadPath,
      activeCwd: root,
      activeTurnId: 'turn-old',
      queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-next' });
    for (let attempt = 0; attempt < 20 && finalizeSpy.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1', queue: [] });

    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-next' });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });

    rejectStart(new Error('JSON-RPC request timed out: turn/start'));
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });
  });

  it('reconciles completion for a queued turn without starting another queued prompt while turn/start is in flight', async () => {
    let rejectStart: (error: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((_resolve, reject) => {
      rejectStart = reject;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
    );
    const secondQueued = { id: 'queued-2', text: 'second', createdAt: 2 };
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [
        { id: 'queued-1', text: 'first', createdAt: 1 },
        secondQueued,
      ],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);
    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-next' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-next' });
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [secondQueued] });

    rejectStart(new Error('JSON-RPC request timed out: turn/start'));
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [secondQueued] });
  });

  it('treats Codex task_complete event messages as turn completion', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ turn: { id: 'turn-next' } });
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
    });

    notify('event_msg', { payload: { type: 'task_complete', thread_id: 'thread-1', turn_id: 'turn-old' } });
    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', { threadId: 'thread-1', experimentalRawEvents: true, persistExtendedHistory: true, excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
    }, TURN_START_RPC_TIMEOUT_MS);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [] });
  });

  it('auto-starts queued messages with captured run options', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ turn: { id: 'turn-next' } });
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      activeCwd: '/work/project',
      queue: [
        {
          id: 'queued-1',
          text: 'next',
          createdAt: 1,
          options: { model: 'gpt-5.5', effort: 'medium', sandbox: 'workspace-write' },
        },
      ],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
      model: 'gpt-5.5',
      effort: 'medium',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/work/project'],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }, TURN_START_RPC_TIMEOUT_MS);
  });

  it('drops queued collaboration mode without model during auto-start', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ turn: { id: 'turn-next' } });
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [
        {
          id: 'queued-1',
          text: 'next',
          createdAt: 1,
          options: { mode: 'plan', effort: 'high' },
        },
      ],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
      effort: 'high',
    }, TURN_START_RPC_TIMEOUT_MS);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [] });
  });

  it('does not claim a second queued message while a queued start is in flight', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : (startPromise as Promise<T>),
    );
    const { stateStore, notify } = await makeHarness(request);
    const secondQueued = { id: 'queued-2', text: 'second', createdAt: 2 };
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [
        { id: 'queued-1', text: 'first', createdAt: 1 },
        secondQueued,
      ],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'thread/resume', { threadId: 'thread-1', experimentalRawEvents: true, persistExtendedHistory: true, excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'first', text_elements: [] }],
    }, TURN_START_RPC_TIMEOUT_MS);
    expect(stateStore.read()).toMatchObject({ activeTurnId: 'turn-start-pending:thread-1', queue: [secondQueued] });

    resolveStart({ turn: { id: 'turn-next' } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [secondQueued] });
  });

  it('restores a claimed queued message when queued turn start fails', async () => {
    const claimed = { id: 'queued-1', text: 'first', createdAt: 1 };
    const secondQueued = { id: 'queued-2', text: 'second', createdAt: 2 };
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : Promise.reject(new Error('start failed')),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [claimed, secondQueued],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);

    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeTurnId: null,
      queue: [claimed, secondQueued],
    });
  });

  it('restores a claimed queued message when queued turn start times out before a task starts', async () => {
    const claimed = { id: 'queued-1', text: 'first', createdAt: 1 };
    const secondQueued = { id: 'queued-2', text: 'second', createdAt: 2 };
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : Promise.reject(new Error('JSON-RPC request timed out: turn/start')),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [claimed, secondQueued],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);

    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeTurnId: null,
      queue: [claimed, secondQueued],
    });
  });

  it('removes a restored queued message if its timed-out turn starts late', async () => {
    const claimed = { id: 'queued-1', text: 'first', createdAt: 1 };
    const request = vi.fn<CodexAppServer['request']>().mockImplementation(<T = unknown>(method: string) =>
      method === 'thread/resume' ? Promise.resolve({} as T) : Promise.reject(new Error('JSON-RPC request timed out: turn/start')),
    );
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [claimed],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await waitForRequestCalls(request, 2);
    expect(stateStore.read()).toMatchObject({ activeTurnId: null, queue: [claimed] });

    notify('turn/started', { threadId: 'thread-1', turnId: 'turn-late' });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-late', queue: [] });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-late' });
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: null, queue: [] });
  });

  it('preserves queued messages on completion when no thread is active', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notify } = await makeHarness(request);
    const queued = [{ id: 'queued-1', text: 'next', createdAt: 1 }];
    stateStore.write({ ...stateStore.read(), activeThreadId: null, activeTurnId: 'turn-old', queue: queued });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    await flushPromises();

    expect(request).not.toHaveBeenCalled();
    expect(stateStore.read()).toMatchObject({ activeTurnId: null, queue: queued });
  });

  it('does not write a queued turn id into a different active session', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockReturnValue(startPromise);
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }],
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    stateStore.update((state) => ({ ...state, activeThreadId: 'thread-2', activeTurnId: null }));
    resolveStart({ turn: { id: 'turn-from-thread-1' } });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-2', activeTurnId: null, queue: [{ id: 'queued-1', text: 'next', createdAt: 1 }] });
  });

  it('ignores stale completion notifications from a different active session', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notify } = await makeHarness(request);
    const queued = [{ id: 'queued-1', text: 'next', createdAt: 1 }];
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-current',
      activeTurnId: 'turn-current',
      queue: queued,
    });

    notify('turn/completed', { threadId: 'thread-old', turnId: 'turn-old' });

    expect(request).not.toHaveBeenCalled();
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-current',
      activeTurnId: 'turn-current',
      queue: queued,
    });
  });

  it('ignores stale completion notifications for a previous turn in the active session', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notify } = await makeHarness(request);
    const queued = [{ id: 'queued-1', text: 'next', createdAt: 1 }];
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-current',
      queue: queued,
    });

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

    expect(request).not.toHaveBeenCalled();
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-current',
      queue: queued,
    });
  });
});
