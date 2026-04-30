import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import {
  JsonRpcPeer,
  type JsonRpcNotification,
  type JsonRpcNotificationHandler,
  type JsonRpcServerRequest,
  type JsonRpcServerRequestHandler,
} from './jsonRpc.js';
import { logError, logInfo, logWarn } from './logger.js';
import type { CodexInitializeResponse } from './types.js';

export interface CodexAppServerOptions {
  cwd: string;
  mock: boolean;
}

export interface CodexAppServerHealth {
  connected: boolean;
  dead: boolean;
  error: string | null;
  readyzUrl: string | null;
  url: string | null;
}

export class CodexAppServer {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private peer: JsonRpcPeer | null = null;
  private socket: WebSocket | null = null;
  private openingSocket: WebSocket | null = null;
  private url: string | null = null;
  private readyzUrl: string | null = null;
  private deadError: Error | null = null;
  private startPromise: Promise<CodexInitializeResponse | void> | null = null;
  private initialized = false;
  private lifecycleId = 0;
  private readonly healthHandlers = new Set<() => void>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private readonly requestHandlers = new Set<JsonRpcServerRequestHandler>();

  constructor(private readonly options: CodexAppServerOptions) {}

  start(): Promise<CodexInitializeResponse | void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.deadError = null;
    this.initialized = false;

    if (this.options.mock) {
      this.url = 'mock://codex-app-server';
      this.initialized = true;
      this.emitHealthChange();
      return Promise.resolve();
    }

    const startup = this.startReal();
    this.startPromise = startup;
    void startup.then(
      () => {
        if (this.startPromise === startup) this.startPromise = null;
      },
      () => {
        if (this.startPromise === startup) this.startPromise = null;
      },
    );
    return startup;
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.peer || !this.isConnected()) {
      throw this.deadError ?? new Error('Codex app-server is not connected');
    }

    return this.peer.request<T>(method, params, timeoutMs);
  }

  respond(id: number | string, result: unknown): void {
    if (!this.peer || !this.isConnected()) {
      throw this.deadError ?? new Error('Codex app-server is not connected');
    }

    this.peer.respond(id, result);
  }

  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: JsonRpcServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => {
      this.requestHandlers.delete(handler);
    };
  }

  onHealthChange(handler: () => void): () => void {
    this.healthHandlers.add(handler);
    return () => {
      this.healthHandlers.delete(handler);
    };
  }

  health(): CodexAppServerHealth {
    return {
      connected: this.isConnected(),
      dead: this.deadError !== null,
      error: this.deadError?.message ?? null,
      readyzUrl: this.readyzUrl,
      url: this.url,
    };
  }

  getUrl(): string | null {
    return this.url;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  stop(): void {
    this.lifecycleId++;
    const child = this.child;
    const socket = this.socket;
    const openingSocket = this.openingSocket;

    this.child = null;
    this.startPromise = null;
    this.initialized = false;
    this.url = null;
    this.readyzUrl = null;
    this.deadError = null;
    this.socket = null;
    this.openingSocket = null;
    this.peer = null;

    socket?.close();
    openingSocket?.close();

    if (child && !child.killed) {
      logInfo('Stopping Codex app-server child', { pid: child.pid });
      child.kill();
    }
  }

  private startReal(): Promise<CodexInitializeResponse> {
    return new Promise<CodexInitializeResponse>((resolve, reject) => {
      const lifecycleId = ++this.lifecycleId;
      logInfo('Starting Codex app-server child', { cwd: this.options.cwd });
      const child = spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:0'], {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child = child;
      logInfo('Codex app-server child spawned', { pid: child.pid });

      let settled = false;
      let connecting = false;
      const stdoutBuffer = new StartupOutputBuffer((line) => handleOutputLine('stdout', line));
      const stderrBuffer = new StartupOutputBuffer((line) => handleOutputLine('stderr', line));
      const startupTimeout = setTimeout(() => {
        fail(new Error('Timed out waiting for Codex app-server startup'));
      }, 15000);

      const cleanupStartup = () => {
        clearTimeout(startupTimeout);
        child.off('exit', onStartupExit);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        const current = this.isCurrentLifecycle(lifecycleId, child);
        cleanupStartup();
        logError('Codex app-server startup failed', { pid: child.pid, error });
        if (current) {
          this.closeSockets();
        }
        this.stopChild(child);
        if (current) {
          this.deadError = error;
          this.startPromise = null;
          this.initialized = false;
          this.emitHealthChange();
        }
        reject(error);
      };

      const succeed = (response: CodexInitializeResponse) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        if (this.isCurrentLifecycle(lifecycleId, child)) {
          this.initialized = true;
          logInfo('Codex app-server initialized', { pid: child.pid, url: this.url, readyzUrl: this.readyzUrl });
          this.emitHealthChange();
        }
        resolve(response);
      };

      const onError = (error: Error) => {
        if (!settled) {
          fail(error);
          return;
        }
        if (this.isCurrentLifecycle(lifecycleId, child)) {
          logError('Codex app-server child error', { pid: child.pid, error });
        }
      };

      const onStartupExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new Error(`Codex app-server exited during startup: ${this.formatExit(code, signal)}`));
      };

      const handleOutputLine = (stream: 'stdout' | 'stderr', line: string) => {
        if (!this.isCurrentLifecycle(lifecycleId, child)) return;
        this.captureReadyz(line);
        if (line.trim()) {
          const meta = { pid: child.pid, line };
          if (stream === 'stderr') logWarn('Codex app-server stderr', meta);
          else logInfo('Codex app-server stdout', meta);
        }

        const url = this.captureListeningUrl(line);
        if (!url || connecting) return;

        connecting = true;
        this.connect(url, () => !this.isCurrentLifecycle(lifecycleId, child)).then(succeed, fail);
      };

      const onStdoutOutput = (chunk: Buffer) => stdoutBuffer.feed(chunk);
      const onStderrOutput = (chunk: Buffer) => stderrBuffer.feed(chunk);

      child.stdout.on('data', onStdoutOutput);
      child.stderr.on('data', onStderrOutput);
      child.on('error', onError);
      child.once('exit', onStartupExit);

      child.once('exit', (code, signal) => {
        if (!this.isCurrentLifecycle(lifecycleId, child)) return;

        const error = new Error(`Codex app-server exited: ${this.formatExit(code, signal)}`);
        logError('Codex app-server child exited', { pid: child.pid, code, signal, error });
        this.deadError = error;
        this.peer = null;
        this.socket = null;
        this.child = null;
        this.startPromise = null;
        this.initialized = false;
        this.emitHealthChange();
      });
    });
  }

  private async connect(url: string, isCancelled: () => boolean): Promise<CodexInitializeResponse> {
    if (isCancelled()) {
      throw new Error('Codex app-server startup was cancelled');
    }

    this.url = url;

    const socket = await this.openSocket(url, isCancelled);
    if (isCancelled()) {
      socket.close();
      throw new Error('Codex app-server startup was cancelled');
    }

    this.socket = socket;
    this.peer = new JsonRpcPeer(socket);
    this.peer.onNotification((message) => this.forwardNotification(message));
    this.peer.onServerRequest((message) => this.forwardServerRequest(message));

    return this.peer.request<CodexInitializeResponse>('initialize', {
      clientInfo: { name: 'codex-web-ui', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  private openSocket(url: string, isCancelled: () => boolean): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (isCancelled()) {
        reject(new Error('Codex app-server startup was cancelled'));
        return;
      }

      const socket = new WebSocket(url);
      this.openingSocket = socket;

      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (this.openingSocket === socket) {
          this.openingSocket = null;
        }
      };

      const onOpen = () => {
        cleanup();
        if (isCancelled()) {
          socket.close();
          reject(new Error('Codex app-server startup was cancelled'));
          return;
        }
        this.handleSocketOpen(socket);
        resolve(socket);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Codex app-server WebSocket closed during startup'));
      };

      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  private isCurrentLifecycle(lifecycleId: number, child: ChildProcessByStdio<null, Readable, Readable>): boolean {
    return this.lifecycleId === lifecycleId && this.child === child;
  }

  private isConnected(): boolean {
    if (this.options.mock) return this.initialized;
    return this.initialized && this.socket?.readyState === WebSocket.OPEN && this.peer !== null;
  }

  private handleSocketOpen(socket: WebSocket): void {
    socket.on('close', () => {
      this.failCurrentSocket(socket, new Error('Codex app-server WebSocket closed'));
    });
    socket.on('error', (error) => {
      this.failCurrentSocket(socket, error);
    });
  }

  private failCurrentSocket(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;

    const child = this.child;
    logError('Codex app-server WebSocket failed', { pid: child?.pid ?? null, error });
    this.deadError = error;
    this.peer = null;
    this.socket = null;
    this.startPromise = null;
    this.initialized = false;
    this.url = null;
    this.readyzUrl = null;

    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
    if (child) this.stopChild(child);
    this.emitHealthChange();
  }

  private stopChild(child: ChildProcessByStdio<null, Readable, Readable>): void {
    if (this.child === child) {
      this.child = null;
    }
    if (!child.killed) {
      child.kill();
    }
  }

  private closeSockets(): void {
    const socket = this.socket;
    const openingSocket = this.openingSocket;
    this.socket = null;
    this.openingSocket = null;
    this.peer = null;
    this.initialized = false;
    socket?.close();
    openingSocket?.close();
  }

  private emitHealthChange(): void {
    for (const handler of this.healthHandlers) handler();
  }

  private forwardNotification(message: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) handler(message);
  }

  private forwardServerRequest(message: JsonRpcServerRequest): void {
    for (const handler of this.requestHandlers) handler(message);
  }

  private captureReadyz(output: string): void {
    const match = output.match(/readyz:\s*(https?:\/\/\S+)/i);
    if (match) this.readyzUrl = match[1];
  }

  private captureListeningUrl(output: string): string | null {
    const match = output.match(/listening on:\s*(ws:\/\/\S+)/i);
    if (!match) return null;

    this.url = match[1];
    return match[1];
  }

  private formatExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (code !== null) return `code ${code}`;
    if (signal !== null) return `signal ${signal}`;
    return 'unknown status';
  }
}

class StartupOutputBuffer {
  private pending = '';
  private readonly maxPendingChars = 4096;

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: Buffer): void {
    this.pending += chunk.toString('utf8');

    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';

    if (this.pending.length > this.maxPendingChars) {
      this.pending = this.pending.slice(-this.maxPendingChars);
    }

    for (const line of lines) {
      this.onLine(line);
    }
  }
}
