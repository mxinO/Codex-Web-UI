import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachBrowserSocket } from '../../server/browserSocket.js';
import { HostStateStore } from '../../server/hostState.js';
import type { CodexAppServer } from '../../server/appServer.js';
import type { ServerConfig } from '../../server/config.js';

interface RpcMessage {
  type: string;
  id?: number;
  result?: unknown;
  error?: string;
}

const cleanups: Array<() => void> = [];
type NotificationHandler = Parameters<CodexAppServer['onNotification']>[0];

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

async function makeHarness(request: TestRequest) {
  const server = http.createServer();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-webui-browser-socket-'));
  const stateStore = new HostStateStore(stateDir, 'test-host');
  let notificationHandler: NotificationHandler | null = null;
  const codex = {
    request,
    onNotification: vi.fn((handler: NotificationHandler) => {
      notificationHandler = handler;
      return () => undefined;
    }),
  } as unknown as CodexAppServer;
  const cleanup = attachBrowserSocket(server, { config: makeConfig(), codex, stateStore, token: 'token' });

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

  await hello;
  const notify = (method: string, params?: unknown) => {
    notificationHandler?.({ jsonrpc: '2.0', method, params });
  };

  return { ws, stateStore, notify };
}

function nextMessage(ws: WebSocket): Promise<RpcMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as RpcMessage));
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
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(response).toEqual({ type: 'rpc/result', id: 2, result: { thread: { id: 'thread-1', cwd: '/normalized/project' } } });
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeCwd: '/normalized/project',
      recentCwds: ['/normalized/project'],
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
      persistExtendedHistory: true,
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

  it('sends rpc errors for invalid session params', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { ws } = await makeHarness(request);

    ws.send(JSON.stringify({ type: 'rpc', id: 4, method: 'webui/session/resume', params: { threadId: '   ' } }));
    const response = await nextMessage(ws);

    expect(request).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'rpc/error', id: 4, error: 'threadId is required' });
  });
});

describe('attachBrowserSocket queue and turn RPCs', () => {
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

    const response = await nextMessage(ws);
    await flushPromises();

    expect(response).toEqual({ type: 'rpc/result', id: 13, result: { turn: { id: 'turn-from-thread-1' } } });
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-2', activeTurnId: 'turn-current' });
  });

  it('auto-starts exactly one queued message when duplicate completion notifications arrive', async () => {
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

    notify('turn/completed');
    notify('turn/completed');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
    });
    expect(stateStore.read()).toMatchObject({ activeTurnId: null, queue: [] });

    resolveStart({ turn: { id: 'turn-next' } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [] });
  });

  it('does not claim a second queued message while a queued start is in flight', async () => {
    let resolveStart: (value: unknown) => void = () => undefined;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const request = vi.fn<CodexAppServer['request']>().mockReturnValue(startPromise);
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

    notify('turn/completed');
    notify('turn/completed');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'first', text_elements: [] }],
    });
    expect(stateStore.read()).toMatchObject({ activeTurnId: null, queue: [secondQueued] });

    resolveStart({ turn: { id: 'turn-next' } });
    await flushPromises();
    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-1', activeTurnId: 'turn-next', queue: [secondQueued] });
  });

  it('restores a claimed queued message when queued turn start fails', async () => {
    const claimed = { id: 'queued-1', text: 'first', createdAt: 1 };
    const secondQueued = { id: 'queued-2', text: 'second', createdAt: 2 };
    const request = vi.fn<CodexAppServer['request']>().mockRejectedValue(new Error('start failed'));
    const { stateStore, notify } = await makeHarness(request);
    stateStore.write({
      ...stateStore.read(),
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-old',
      queue: [claimed, secondQueued],
    });

    notify('turn/completed');
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(1);
    expect(stateStore.read()).toMatchObject({
      activeThreadId: 'thread-1',
      activeTurnId: null,
      queue: [claimed, secondQueued],
    });
  });

  it('preserves queued messages on completion when no thread is active', async () => {
    const request = vi.fn<CodexAppServer['request']>();
    const { stateStore, notify } = await makeHarness(request);
    const queued = [{ id: 'queued-1', text: 'next', createdAt: 1 }];
    stateStore.write({ ...stateStore.read(), activeThreadId: null, activeTurnId: 'turn-old', queue: queued });

    notify('turn/completed');

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

    notify('turn/completed');
    stateStore.update((state) => ({ ...state, activeThreadId: 'thread-2', activeTurnId: null }));
    resolveStart({ turn: { id: 'turn-from-thread-1' } });
    await flushPromises();

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-2', activeTurnId: null, queue: [] });
  });
});
