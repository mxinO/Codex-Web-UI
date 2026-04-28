import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
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

async function makeHarness(request: TestRequest) {
  const server = http.createServer();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-webui-browser-socket-'));
  const stateStore = new HostStateStore(stateDir, 'test-host');
  let notificationHandler: NotificationHandler | null = null;
  let serverRequestHandler: ServerRequestHandler | null = null;
  const respond = vi.fn<CodexAppServer['respond']>();
  const codex = {
    request,
    respond,
    onNotification: vi.fn((handler: NotificationHandler) => {
      notificationHandler = handler;
      return () => undefined;
    }),
    onServerRequest: vi.fn((handler: ServerRequestHandler) => {
      serverRequestHandler = handler;
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
  const requestFromServer = (message: Parameters<ServerRequestHandler>[0]) => {
    serverRequestHandler?.(message);
  };

  return { ws, stateStore, notify, requestFromServer, respond, port };
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
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      config: { model_reasoning_effort: 'high' },
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
      experimentalRawEvents: false,
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
      persistExtendedHistory: true,
      model: 'gpt-5.5',
      sandbox: 'danger-full-access',
      config: { model_reasoning_effort: 'xhigh' },
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

  it('executes valid bang commands through command exec with cwd and configured limits', async () => {
    const result = { exitCode: 0, stdout: 'ok\n', stderr: '' };
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue(result);
    const { ws, stateStore } = await makeHarness(request);
    stateStore.write({ ...stateStore.read(), activeTurnId: null, activeCwd: '/work/project' });

    ws.send(JSON.stringify({ type: 'rpc', id: 22, method: 'webui/bang/run', params: { command: 'echo ok' } }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith(
      'command/exec',
      {
        command: ['bash', '-lc', 'echo ok'],
        cwd: '/work/project',
        timeoutMs: 30_000,
        outputBytesCap: 256_000,
        tty: false,
        streamStdoutStderr: false,
        streamStdin: false,
      },
      32_000,
    );
    expect(response).toEqual({ type: 'rpc/result', id: 22, result });
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
  it('forwards read directory requests through the bounded webui RPC', async () => {
    const result = { entries: [{ name: 'src', isDirectory: true }] };
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue(result);
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    mkdirSync(join(workspace, 'src'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });

    ws.send(JSON.stringify({ type: 'rpc', id: 30, method: 'webui/fs/readDirectory', params: { path: ` ${workspace} ` } }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('fs/readDirectory', { path: workspace });
    expect(response).toEqual({ type: 'rpc/result', id: 30, result });
  });

  it('creates files by writing empty base64 data', async () => {
    const request = vi.fn<CodexAppServer['request']>().mockResolvedValue({ ok: true });
    const { ws, stateStore } = await makeHarness(request);
    const workspace = mkdtempSync(join(tmpdir(), 'codex-webui-workspace-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    stateStore.write({ ...stateStore.read(), activeCwd: workspace });
    const filePath = join(workspace, 'new.txt');

    ws.send(JSON.stringify({ type: 'rpc', id: 31, method: 'webui/fs/createFile', params: { path: filePath } }));
    const response = await nextMessage(ws);

    expect(request).toHaveBeenCalledWith('fs/writeFile', { path: filePath, dataBase64: '' });
    expect(response).toEqual({ type: 'rpc/result', id: 31, result: { ok: true } });
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
    });
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

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

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
    await flushPromises();

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
    });
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
    await flushPromises();

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'next', text_elements: [] }],
      effort: 'high',
    });
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

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

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

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });
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

    notify('turn/completed', { threadId: 'thread-1', turnId: 'turn-old' });

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

    expect(stateStore.read()).toMatchObject({ activeThreadId: 'thread-2', activeTurnId: null, queue: [] });
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
