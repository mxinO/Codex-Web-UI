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
  const codex = {
    request,
    onNotification: vi.fn(() => () => undefined),
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
  return { ws, stateStore };
}

function nextMessage(ws: WebSocket): Promise<RpcMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as RpcMessage));
  });
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
