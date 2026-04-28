import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';

const MARKER = 'CODEX_WEB_UI_DISCONNECT_TEST';
const STARTUP_TIMEOUT_MS = 15000;
const SOCKET_OPEN_TIMEOUT_MS = 10000;
const TURN_SETTLE_DELAY_MS = 20000;
const TURN_RESULT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 5000;

type AppServerChild = ChildProcessByStdio<null, Readable, Readable>;

interface Client {
  socket: WebSocket;
  peer: ProbeRpcPeer;
}

interface ThreadStartResponse {
  thread?: { id?: string };
  id?: string;
  threadId?: string;
}

interface TurnListResponse {
  data?: unknown[];
  turns?: unknown[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function request<T>(peer: ProbeRpcPeer, method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
  return peer.request<T>(method, params, timeoutMs);
}

function startAppServer(): Promise<{ child: AppServerChild; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:0'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const recentOutput: string[] = [];
    const stdoutBuffer = new StartupOutputBuffer((line) => handleOutputLine(line));
    const stderrBuffer = new StartupOutputBuffer((line) => handleOutputLine(line));
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for Codex app-server startup. Recent output:\n${recentOutput.join('\n')}`));
    }, STARTUP_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', fail);
      child.off('exit', onExit);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild(child).finally(() => reject(error));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`Codex app-server exited during startup: ${formatExit(code, signal)}`));
    };

    const handleOutputLine = (line: string) => {
      recentOutput.push(line);
      recentOutput.splice(0, Math.max(0, recentOutput.length - 20));

      const match = line.match(/listening on:\s*(ws:\/\/\S+)/i);
      if (!match || settled) return;

      settled = true;
      cleanup();
      resolve({ child, url: match[1] });
    };

    const onStdout = (chunk: Buffer) => stdoutBuffer.feed(chunk);
    const onStderr = (chunk: Buffer) => stderrBuffer.feed(chunk);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', fail);
    child.once('exit', onExit);
  });
}

async function connect(url: string): Promise<Client> {
  const socket = await openSocket(url);
  const peer = new ProbeRpcPeer(socket);
  peer.onServerRequest((message) => respondToServerRequest(peer, message));
  await request(peer, 'initialize', {
    clientInfo: { name: 'codex-web-ui-continuity-probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  return { socket, peer };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: SOCKET_OPEN_TIMEOUT_MS });
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Timed out opening WebSocket: ${url}`));
    }, SOCKET_OPEN_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.terminate();
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onClose = () => {
      fail(new Error('WebSocket closed before opening'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function closeClient(client: Client | null): Promise<void> {
  if (!client) return;
  await closeSocket(client.socket);
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1000);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

async function killChild(child: AppServerChild | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function respondToServerRequest(peer: ProbeRpcPeer, message: ProbeServerRequest): void {
  if (message.method === 'item/commandExecution/requestApproval') {
    peer.respond(message.id, { decision: 'acceptForSession' });
    return;
  }
  if (message.method === 'item/permissions/requestApproval') {
    peer.respond(message.id, { permissions: {}, scope: 'session' });
    return;
  }
  peer.respondError(message.id, -32601, `Probe cannot handle server request: ${message.method}`);
}

function extractThreadId(result: ThreadStartResponse): string {
  const threadId = result.thread?.id ?? result.id ?? result.threadId;
  if (!threadId) throw new Error(`thread/start response did not include a thread id: ${JSON.stringify(result)}`);
  return threadId;
}

async function waitForMarker(peer: ProbeRpcPeer, threadId: string): Promise<unknown> {
  const deadline = Date.now() + TURN_RESULT_TIMEOUT_MS;
  let lastResult: unknown = null;

  while (Date.now() < deadline) {
    lastResult = await request<TurnListResponse>(peer, 'thread/turns/list', {
      threadId,
      cursor: null,
      limit: 20,
      sortDirection: 'desc',
    });

    if (findCompletedMarkerCommand(lastResult)) return lastResult;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${MARKER} in thread/turns/list. Last response:\n${JSON.stringify(lastResult, null, 2)}`);
}

function findCompletedMarkerCommand(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const turns = Array.isArray(result.data) ? result.data : Array.isArray(result.turns) ? result.turns : [];

  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;

    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      if (item.type !== 'commandExecution') continue;
      if (item.status !== 'completed') continue;
      if (item.exitCode !== 0) continue;
      if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.includes(MARKER)) return true;
    }
  }

  return false;
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return 'unknown status';
}

interface ProbeServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

class ProbeRpcPeer {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private serverRequestHandler: ((message: ProbeServerRequest) => void) | null = null;

  constructor(private readonly socket: WebSocket) {
    this.socket.on('message', (data) => this.handleMessage(data));
    this.socket.on('close', () => this.closePending(new Error('JSON-RPC socket closed')));
    this.socket.on('error', (error) => this.closePending(error));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC socket is closed'));

    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.closed) this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.closed) this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  onServerRequest(handler: (message: ProbeServerRequest) => void): void {
    this.serverRequestHandler = handler;
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    const id = message.id;
    if ((typeof id === 'number' || typeof id === 'string') && ('result' in message || 'error' in message)) {
      this.handleResponse({ ...message, id });
      return;
    }

    if ((typeof id === 'number' || typeof id === 'string') && typeof message.method === 'string') {
      this.serverRequestHandler?.({ id, method: message.method, params: message.params });
    }
  }

  private handleResponse(response: Record<string, unknown> & { id: number | string }): void {
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    const error = response.error;
    if (isRecord(error) && typeof error.message === 'string') {
      pending.reject(new Error(`${pending.method} failed: ${error.message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private closePending(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class StartupOutputBuffer {
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: Buffer): void {
    this.pending += chunk.toString('utf8');
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.onLine(line);
  }
}

let child: AppServerChild | null = null;
let firstClient: Client | null = null;
let secondClient: Client | null = null;

try {
  const started = await startAppServer();
  child = started.child;

  firstClient = await connect(started.url);
  const thread = await request<ThreadStartResponse>(firstClient.peer, 'thread/start', {
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  });
  const threadId = extractThreadId(thread);

  await request(firstClient.peer, 'turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: `Run exactly this shell command and do not edit files: sleep 8 && echo ${MARKER}`,
        text_elements: [],
      },
    ],
  });

  await closeClient(firstClient);
  firstClient = null;

  await sleep(TURN_SETTLE_DELAY_MS);

  secondClient = await connect(started.url);
  await waitForMarker(secondClient.peer, threadId);

  console.log('Continuity probe passed');
} finally {
  await closeClient(firstClient);
  await closeClient(secondClient);
  await killChild(child);
}
