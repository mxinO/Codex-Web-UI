import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
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

export interface CodexSpawnConfig {
  command: string;
  env: NodeJS.ProcessEnv;
  source: 'env' | 'native-package' | 'path';
}

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};
const NODE_FETCH_MEMORY_OPTION = '--no-experimental-fetch';
const NODE_WEBSOCKET_MEMORY_OPTION = '--no-experimental-websocket';
const NODE_EVENTSOURCE_MEMORY_OPTION = '--no-experimental-eventsource';
const NODE_WEB_API_MEMORY_OPTIONS = [NODE_FETCH_MEMORY_OPTION, NODE_WEBSOCKET_MEMORY_OPTION, NODE_EVENTSOURCE_MEMORY_OPTION];
const ACTIVE_NODE_WEB_API_MEMORY_OPTIONS = NODE_WEB_API_MEMORY_OPTIONS.filter((option) => process.allowedNodeEnvironmentFlags.has(option));

function truthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? '');
}

function preserveNodeWebApis(env: NodeJS.ProcessEnv): boolean {
  return truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_FETCH) || truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_WEB_APIS);
}

function appendNodeOptions(options: string | undefined, nextOptions: string[]): string {
  const trimmed = options?.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  for (const option of nextOptions) {
    if (!tokens.includes(option)) tokens.push(option);
  }
  return tokens.join(' ');
}

function codexChildBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  if (!preserveNodeWebApis(childEnv)) {
    childEnv.NODE_OPTIONS = appendNodeOptions(childEnv.NODE_OPTIONS, ACTIVE_NODE_WEB_API_MEMORY_OPTIONS);
  }
  return childEnv;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createNodeWrapper(realNode: string, platform = process.platform): { directory: string; path: string; cleanup: () => void } | null {
  if (!realNode || !path.isAbsolute(realNode) || !fs.existsSync(realNode)) return null;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-webui-node-'));
  const wrapperPath = path.join(directory, platform === 'win32' ? 'node.cmd' : 'node');
  const options = ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.join(' ');
  const posixAddOptions = ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.map((option) => `add_node_option ${option}`).join('\n');
  const content =
    platform === 'win32'
      ? `@echo off\r\nset "NODE_OPTIONS=%NODE_OPTIONS% ${options}"\r\n"${realNode}" %*\r\n`
      : `#!/bin/sh
add_node_option() {
  case " \${NODE_OPTIONS:-} " in
    *" $1 "*) ;;
    *) NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }$1" ;;
  esac
}
${posixAddOptions}
export NODE_OPTIONS
exec ${shellQuote(realNode)} "$@"
`;
  fs.writeFileSync(wrapperPath, content, { encoding: 'utf8', mode: platform === 'win32' ? 0o600 : 0o700 });
  if (platform !== 'win32') fs.chmodSync(wrapperPath, 0o700);

  return {
    directory,
    path: wrapperPath,
    cleanup: () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function prepareCodexChildRuntimeEnv(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  realNode = process.execPath,
): { env: NodeJS.ProcessEnv; nodeWrapperPath: string | null; cleanup: () => void } {
  if (preserveNodeWebApis(env)) return { env, nodeWrapperPath: null, cleanup: () => undefined };

  const wrapper = createNodeWrapper(realNode, platform);
  if (!wrapper) return { env, nodeWrapperPath: null, cleanup: () => undefined };

  return {
    env: {
      ...env,
      PATH: [wrapper.directory, ...pathEntries(env)].join(path.delimiter),
    },
    nodeWrapperPath: wrapper.path,
    cleanup: wrapper.cleanup,
  };
}

function selectedTraceEnv(pid: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let raw = '';
  try {
    raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return result;
  }

  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (key === 'NODE_OPTIONS') result.NODE_OPTIONS = value;
    if (key === 'PATH') result.PATH_HEAD = value.split(path.delimiter).slice(0, 5);
    if (key === 'npm_execpath') result.npm_execpath = value;
    if (key === 'npm_config_user_agent') result.npm_config_user_agent = value;
    if (key === 'CODEX_MANAGED_BY_NPM') result.CODEX_MANAGED_BY_NPM = value;
    if (key === 'CODEX_MANAGED_BY_BUN') result.CODEX_MANAGED_BY_BUN = value;
  }
  return result;
}

const TRACE_SECRET_KEY_PATTERN = /(?:api[-_]?key|token|secret|password|passwd|credential|authorization|cookie)/i;

function redactTraceArgValue(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/(cookie:\s*)[^\s"']+/gi, '$1<redacted>')
    .replace(/((?:api[-_]?key|token|secret|password|passwd|credential)\s*[:=]\s*)[^\s"']+/gi, '$1<redacted>')
    .replace(/(?:sk|gh[pousr]|github_pat|xox[baprs]|nvapi)-[A-Za-z0-9_=-]{16,}/g, '<redacted>');
}

export function sanitizeProcessArgvForTrace(argv: string[]): string[] {
  const maxArgs = 64;
  const sanitized: string[] = [];
  let redactNext = false;

  for (const arg of argv.slice(0, maxArgs)) {
    if (redactNext) {
      sanitized.push('<redacted>');
      redactNext = false;
      continue;
    }

    const separator = arg.indexOf('=');
    if (separator > 0 && TRACE_SECRET_KEY_PATTERN.test(arg.slice(0, separator))) {
      sanitized.push(`${arg.slice(0, separator)}=<redacted>`);
      continue;
    }

    if (/^--?/.test(arg) && TRACE_SECRET_KEY_PATTERN.test(arg)) {
      sanitized.push(arg);
      redactNext = true;
      continue;
    }

    sanitized.push(redactTraceArgValue(arg));
  }

  if (argv.length > maxArgs) sanitized.push(`<truncated ${argv.length - maxArgs} args>`);
  return sanitized;
}

function readProcSnapshot(pid: number): { pid: number; ppid: number; comm: string; argv: string[]; exe: string | null } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    if (!Number.isFinite(ppid)) return null;
    const argv = sanitizeProcessArgvForTrace(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
    let exe: string | null = null;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = null;
    }
    return { pid, ppid, comm, argv, exe };
  } catch {
    return null;
  }
}

function codexTraceDurationMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.CODEX_WEB_UI_TRACE_CODEX_PROCESSES_MS ?? 5000);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(1000, Math.min(30000, parsed));
}

function startCodexProcessTrace(rootPid: number | undefined, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!rootPid || process.platform !== 'linux' || !truthyEnv(env.CODEX_WEB_UI_TRACE_CODEX_PROCESSES)) return () => undefined;

  const seen = new Set<number>();
  const durationMs = codexTraceDurationMs(env);
  let stopped = false;

  const sample = () => {
    if (stopped) return;
    const snapshots = new Map<number, NonNullable<ReturnType<typeof readProcSnapshot>>>();
    let procEntries: string[];
    try {
      procEntries = fs.readdirSync('/proc');
    } catch {
      stop();
      return;
    }
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      const snapshot = readProcSnapshot(Number(entry));
      if (snapshot) snapshots.set(snapshot.pid, snapshot);
    }

    const descendants = new Set<number>([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const snapshot of snapshots.values()) {
        if (!descendants.has(snapshot.pid) && descendants.has(snapshot.ppid)) {
          descendants.add(snapshot.pid);
          changed = true;
        }
      }
    }

    for (const pid of descendants) {
      if (seen.has(pid)) continue;
      const snapshot = snapshots.get(pid);
      if (!snapshot) continue;
      seen.add(pid);
      logWarn('Codex process trace observed process', {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        comm: snapshot.comm,
        exe: snapshot.exe,
        argv: snapshot.argv,
        selectedEnv: selectedTraceEnv(snapshot.pid),
      });
    }
  };

  logWarn('Codex process tracing enabled', { rootPid, durationMs });
  const interval = setInterval(sample, 50);
  const timeout = setTimeout(stop, durationMs);
  interval.unref();
  timeout.unref();
  sample();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(timeout);
    logWarn('Codex process tracing stopped', { rootPid, observedProcesses: seen.size });
  }

  return stop;
}

function targetTripleFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  }
  return null;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, platform = process.platform): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutableFile(command) ? command : null;
  }

  const extensions = platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of pathEntries(env)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function safeRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return null;
  }
}

function managedByEnvVar(launcherPath: string, env: NodeJS.ProcessEnv): 'CODEX_MANAGED_BY_BUN' | 'CODEX_MANAGED_BY_NPM' {
  if (/\bbun\//.test(env.npm_config_user_agent ?? '')) return 'CODEX_MANAGED_BY_BUN';
  if ((env.npm_execpath ?? '').includes('bun')) return 'CODEX_MANAGED_BY_BUN';
  if (launcherPath.includes('.bun/install/global') || launcherPath.includes('.bun\\install\\global')) return 'CODEX_MANAGED_BY_BUN';
  return 'CODEX_MANAGED_BY_NPM';
}

function nativeBinaryFromCodexLauncher(launcherPath: string, targetTriple: string, platformPackage: string, binaryName: string): string | null {
  const candidates = Array.from(new Set([launcherPath, safeRealPath(launcherPath)].filter((candidate): candidate is string => Boolean(candidate))));

  for (const candidate of candidates) {
    try {
      const requireFromLauncher = createRequire(pathToFileURL(candidate));
      const packageJsonPath = requireFromLauncher.resolve(`${platformPackage}/package.json`);
      const binaryPath = path.join(path.dirname(packageJsonPath), 'vendor', targetTriple, 'codex', binaryName);
      if (isExecutableFile(binaryPath)) return binaryPath;
    } catch {
      // Fall through to local vendor layout below.
    }

    const localBinaryPath = path.join(path.dirname(candidate), '..', 'vendor', targetTriple, 'codex', binaryName);
    if (isExecutableFile(localBinaryPath)) return localBinaryPath;
  }

  return null;
}

export function resolveCodexSpawnConfig(env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): CodexSpawnConfig {
  const baseEnv = codexChildBaseEnv(env);
  const override = env.CODEX_WEB_UI_CODEX_BIN?.trim();
  if (override) return { command: override, env: baseEnv, source: 'env' };

  const targetTriple = targetTripleFor(platform, arch);
  const platformPackage = targetTriple ? PLATFORM_PACKAGE_BY_TARGET[targetTriple] : null;
  const launcherPath = findOnPath('codex', baseEnv, platform);
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';

  if (targetTriple && platformPackage && launcherPath) {
    const binaryPath = nativeBinaryFromCodexLauncher(launcherPath, targetTriple, platformPackage, binaryName);
    if (binaryPath) {
      const archRoot = path.dirname(path.dirname(binaryPath));
      const pathDir = path.join(archRoot, 'path');
      const nextPath = fs.existsSync(pathDir) ? [pathDir, ...pathEntries(baseEnv)].join(path.delimiter) : baseEnv.PATH;
      const managerEnvVar = managedByEnvVar(launcherPath, baseEnv);
      return {
        command: binaryPath,
        env: {
          ...baseEnv,
          ...(nextPath ? { PATH: nextPath } : {}),
          [managerEnvVar]: baseEnv[managerEnvVar] ?? '1',
        },
        source: 'native-package',
      };
    }
  }

  return { command: launcherPath ?? 'codex', env: baseEnv, source: 'path' };
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
  private restartPromise: Promise<CodexInitializeResponse | void> | null = null;
  private initialized = false;
  private lifecycleId = 0;
  private readonly healthHandlers = new Set<() => void>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private readonly requestHandlers = new Set<JsonRpcServerRequestHandler>();

  constructor(private readonly options: CodexAppServerOptions) {}

  start(): Promise<CodexInitializeResponse | void> {
    if (this.restartPromise) return this.restartPromise;
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
    this.emitHealthChange();
  }

  async restart(): Promise<CodexInitializeResponse | void> {
    if (this.restartPromise) return this.restartPromise;

    let restart: Promise<CodexInitializeResponse | void>;
    const operation = (async () => {
      const child = this.child;
      this.stop();
      if (child) await this.waitForChildExit(child);
      this.restartPromise = null;
      return this.start();
    })();
    restart = operation.finally(() => {
      if (this.restartPromise === restart) this.restartPromise = null;
    });
    this.restartPromise = restart;
    return this.restartPromise;
  }

  private startReal(): Promise<CodexInitializeResponse> {
    return new Promise<CodexInitializeResponse>((resolve, reject) => {
      const lifecycleId = ++this.lifecycleId;
      const codexSpawn = resolveCodexSpawnConfig();
      const runtimeEnv = prepareCodexChildRuntimeEnv(codexSpawn.env);
      const runtimeNodeOptions = runtimeEnv.env.NODE_OPTIONS?.split(/\s+/).filter(Boolean) ?? [];
      let runtimeCleaned = false;
      const cleanupRuntime = () => {
        if (runtimeCleaned) return;
        runtimeCleaned = true;
        runtimeEnv.cleanup();
      };
      logInfo('Starting Codex app-server child', {
        cwd: this.options.cwd,
        command: codexSpawn.command,
        source: codexSpawn.source,
        nodeWebApis:
          ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.length > 0 && ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.every((option) => runtimeNodeOptions.includes(option)) ? 'disabled' : 'default',
        nodeWrapper: runtimeEnv.nodeWrapperPath ? 'enabled' : 'disabled',
      });
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(codexSpawn.command, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
          cwd: this.options.cwd,
          env: runtimeEnv.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        cleanupRuntime();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.child = child;
      logInfo('Codex app-server child spawned', { pid: child.pid });
      const cleanupProcessTrace = startCodexProcessTrace(child.pid);

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
        cleanupProcessTrace();
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
          cleanupRuntime();
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
      child.once('exit', cleanupRuntime);
      child.once('exit', cleanupProcessTrace);
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

  private waitForChildExit(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs = 3000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let forceResolveTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (forceResolveTimer) clearTimeout(forceResolveTimer);
        child.off('exit', finish);
        resolve();
      };
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logWarn('Force killing Codex app-server child after restart timeout', { pid: child.pid });
          child.kill('SIGKILL');
        }
        forceResolveTimer = setTimeout(finish, 1000);
      }, timeoutMs);

      child.once('exit', finish);
    });
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
