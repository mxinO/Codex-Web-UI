import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
  CodexAppServer,
  codexAppServerArgs,
  codexBackfillBusyStartupLine,
  prepareCodexChildRuntimeEnv,
  resolveCodexAppServerStartupTimeoutMs,
  resolveCodexSpawnConfig,
  sanitizeProcessArgvForTrace,
} from '../../server/appServer.js';

const tempDirs: string[] = [];
const expectedNodeWebApiOptions = ['--no-experimental-fetch', '--no-experimental-websocket', '--no-experimental-eventsource'].filter((option) =>
  process.allowedNodeEnvironmentFlags.has(option),
);

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-webui-app-server-'));
  tempDirs.push(dir);
  return dir;
}

function nodeOptions(env: NodeJS.ProcessEnv): string[] {
  return env.NODE_OPTIONS?.split(/\s+/).filter(Boolean) ?? [];
}

function uniqueOptions(options: string[]): string[] {
  return [...new Set(options)];
}

function expectNodeWebApiOptions(env: NodeJS.ProcessEnv): void {
  expect(nodeOptions(env)).toEqual(expect.arrayContaining(expectedNodeWebApiOptions));
}

class FakeRpcSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];

  constructor(private readonly autoResolveInitialize = true) {
    super();
  }

  send(data: string): void {
    const message = JSON.parse(data) as { jsonrpc?: string; id?: number; method?: string; params?: unknown };
    this.sent.push(message);
    if (!this.autoResolveInitialize || message.method !== 'initialize' || typeof message.id !== 'number') return;
    queueMicrotask(() => {
      this.emit('message', JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  receive(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

describe('Codex process tracing', () => {
  it('redacts secrets from traced process argv', () => {
    expect(
      sanitizeProcessArgvForTrace([
        'node',
        'server.js',
        '--api-key=sk-testsecretsecretsecret',
        '--token',
        'plain-token-value',
        'OPENAI_API_KEY=sk-envsecretsecretsecret',
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
        'github_pat_abcdefghijklmnopqrstuvwxyz123456',
        'Authorization: Bearer bearer-secret',
        'safe-value',
      ]),
    ).toEqual([
      'node',
      'server.js',
      '--api-key=<redacted>',
      '--token',
      '<redacted>',
      'OPENAI_API_KEY=<redacted>',
      '<redacted>',
      '<redacted>',
      'Authorization: Bearer <redacted>',
      'safe-value',
    ]);
  });
});

describe('CodexAppServer lifecycle', () => {
  it('allows Codex state backfill to finish before startup times out', () => {
    expect(CODEX_APP_SERVER_STARTUP_TIMEOUT_MS).toBe(5 * 60_000);
    expect(resolveCodexAppServerStartupTimeoutMs({ CODEX_WEB_UI_CODEX_STARTUP_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(resolveCodexAppServerStartupTimeoutMs({ CODEX_WEB_UI_CODEX_STARTUP_TIMEOUT_MS: 'invalid' })).toBe(
      CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    );
    expect(resolveCodexAppServerStartupTimeoutMs({ CODEX_WEB_UI_CODEX_STARTUP_TIMEOUT_MS: '59999' })).toBe(
      CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    );
    expect(resolveCodexAppServerStartupTimeoutMs({ CODEX_WEB_UI_CODEX_STARTUP_TIMEOUT_MS: '3600001' })).toBe(
      CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    );
  });

  it('recognizes only the terminal Codex state-backfill timeout', () => {
    expect(
      codexBackfillBusyStartupLine(
        'Error: failed to initialize sqlite state runtime: timed out waiting for state db backfill at /home/me/.codex after 30s (status: running)',
      ),
    ).toBe(true);
    expect(
      codexBackfillBusyStartupLine('state db backfill is running at /home/me/.codex; waiting up to 30s before retrying startup initialization'),
    ).toBe(false);
    expect(
      codexBackfillBusyStartupLine('Error: timed out waiting for state db backfill at /home/me/.codex after 30s (status: complete)'),
    ).toBe(
      false,
    );
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the native Codex binary from the npm launcher to avoid the Node wrapper at runtime', () => {
    const root = tempRoot();
    const packageRoot = join(root, 'lib', 'node_modules', '@openai', 'codex');
    const launcherDir = join(packageRoot, 'bin');
    const binDir = join(root, 'bin');
    const platformPackageRoot = join(packageRoot, 'node_modules', '@openai', 'codex-linux-x64');
    const nativeDir = join(platformPackageRoot, 'vendor', 'x86_64-unknown-linux-musl', 'codex');
    const helperPathDir = join(platformPackageRoot, 'vendor', 'x86_64-unknown-linux-musl', 'path');
    mkdirSync(launcherDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(helperPathDir, { recursive: true });
    writeFileSync(join(launcherDir, 'codex.js'), '#!/usr/bin/env node\n');
    chmodSync(join(launcherDir, 'codex.js'), 0o755);
    writeFileSync(join(platformPackageRoot, 'package.json'), '{"name":"@openai/codex-linux-x64"}\n');
    writeFileSync(join(nativeDir, 'codex'), '#!/bin/sh\n');
    chmodSync(join(nativeDir, 'codex'), 0o755);
    symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(binDir, 'codex'));

    const resolved = resolveCodexSpawnConfig({ PATH: binDir }, 'linux', 'x64');

    expect(resolved.source).toBe('native-package');
    expect(resolved.command).toBe(join(nativeDir, 'codex'));
    expect(resolved.env.PATH?.split(':')[0]).toBe(helperPathDir);
    expect(resolved.env.CODEX_MANAGED_BY_NPM).toBe('1');
    expectNodeWebApiOptions(resolved.env);
  });

  it('resolves native Codex binaries from the launcher local vendor layout', () => {
    const root = tempRoot();
    const packageRoot = join(root, 'lib', 'node_modules', '@openai', 'codex');
    const launcherDir = join(packageRoot, 'bin');
    const binDir = join(root, 'bin');
    const nativeDir = join(packageRoot, 'vendor', 'x86_64-unknown-linux-musl', 'codex');
    mkdirSync(launcherDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(launcherDir, 'codex.js'), '#!/usr/bin/env node\n');
    chmodSync(join(launcherDir, 'codex.js'), 0o755);
    writeFileSync(join(nativeDir, 'codex'), '#!/bin/sh\n');
    chmodSync(join(nativeDir, 'codex'), 0o755);
    symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(binDir, 'codex'));

    const resolved = resolveCodexSpawnConfig({ PATH: binDir, npm_config_user_agent: 'bun/1.2.0' }, 'linux', 'x64');

    expect(resolved.source).toBe('native-package');
    expect(resolved.command).toBe(join(nativeDir, 'codex'));
    expect(resolved.env.CODEX_MANAGED_BY_BUN).toBe('1');
    expect(resolved.env.CODEX_MANAGED_BY_NPM).toBeUndefined();
    expectNodeWebApiOptions(resolved.env);
  });

  it('can force the Codex launcher path instead of the native package binary', () => {
    const root = tempRoot();
    const packageRoot = join(root, 'lib', 'node_modules', '@openai', 'codex');
    const launcherDir = join(packageRoot, 'bin');
    const binDir = join(root, 'bin');
    const platformPackageRoot = join(packageRoot, 'node_modules', '@openai', 'codex-linux-x64');
    const nativeDir = join(platformPackageRoot, 'vendor', 'x86_64-unknown-linux-musl', 'codex');
    mkdirSync(launcherDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(launcherDir, 'codex.js'), '#!/usr/bin/env node\n');
    chmodSync(join(launcherDir, 'codex.js'), 0o755);
    writeFileSync(join(platformPackageRoot, 'package.json'), '{"name":"@openai/codex-linux-x64"}\n');
    writeFileSync(join(nativeDir, 'codex'), '#!/bin/sh\n');
    chmodSync(join(nativeDir, 'codex'), 0o755);
    symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(binDir, 'codex'));

    const resolved = resolveCodexSpawnConfig({ PATH: binDir, CODEX_WEB_UI_CODEX_LAUNCH_MODE: 'path' }, 'linux', 'x64');

    expect(resolved).toMatchObject({ command: join(binDir, 'codex'), source: 'path' });
    expectNodeWebApiOptions(resolved.env);
  });

  it('falls back to the codex launcher when a native package cannot be resolved', () => {
    const root = tempRoot();
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'codex'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'codex'), 0o755);

    const resolved = resolveCodexSpawnConfig({ PATH: binDir }, 'linux', 'x64');

    expect(resolved).toMatchObject({ command: join(binDir, 'codex'), source: 'path' });
    expectNodeWebApiOptions(resolved.env);
  });

  it('falls back to the codex launcher on unsupported native platforms', () => {
    const root = tempRoot();
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'codex'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'codex'), 0o755);

    const resolved = resolveCodexSpawnConfig({ PATH: binDir }, 'linux', 'ppc64');

    expect(resolved).toMatchObject({ command: join(binDir, 'codex'), source: 'path' });
    expectNodeWebApiOptions(resolved.env);
  });

  it('allows an explicit Codex binary override', () => {
    const resolved = resolveCodexSpawnConfig({ CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', PATH: '' }, 'linux', 'x64');

    expect(resolved).toMatchObject({
      command: '/opt/codex-native',
      source: 'env',
    });
    expectNodeWebApiOptions(resolved.env);
  });

  it('preserves existing child NODE_OPTIONS while disabling Node global fetch by default', () => {
    const resolved = resolveCodexSpawnConfig({ CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', NODE_OPTIONS: '--max-old-space-size=256' }, 'linux', 'x64');

    expect(nodeOptions(resolved.env)).toEqual(['--max-old-space-size=256', ...expectedNodeWebApiOptions]);
  });

  it('does not duplicate the child Node web API options', () => {
    const resolved = resolveCodexSpawnConfig(
      { CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', NODE_OPTIONS: '--no-experimental-fetch --no-experimental-websocket' },
      'linux',
      'x64',
    );

    expect(nodeOptions(resolved.env)).toEqual(uniqueOptions(['--no-experimental-fetch', '--no-experimental-websocket', ...expectedNodeWebApiOptions]));
  });

  it('allows preserving Node global fetch for Codex child processes', () => {
    const resolved = resolveCodexSpawnConfig({ CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', CODEX_WEB_UI_PRESERVE_NODE_FETCH: '1' }, 'linux', 'x64');

    expect(resolved.env.NODE_OPTIONS).toBeUndefined();
  });

  it('does not mutate existing child NODE_OPTIONS when preserving Node global fetch', () => {
    const resolved = resolveCodexSpawnConfig(
      { CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', CODEX_WEB_UI_PRESERVE_NODE_FETCH: '1', NODE_OPTIONS: '--max-old-space-size=256' },
      'linux',
      'x64',
    );

    expect(nodeOptions(resolved.env)).toEqual(['--max-old-space-size=256']);
  });

  it('supports the clearer web API preservation env alias', () => {
    const resolved = resolveCodexSpawnConfig({ CODEX_WEB_UI_CODEX_BIN: '/opt/codex-native', CODEX_WEB_UI_PRESERVE_NODE_WEB_APIS: 'true' }, 'linux', 'x64');

    expect(resolved.env.NODE_OPTIONS).toBeUndefined();
  });

  it('prepends a node wrapper for Codex-launched Node helpers', () => {
    const root = tempRoot();
    const realNode = join(root, 'node-real');
    writeFileSync(realNode, '#!/bin/sh\nprintf "%s" "$NODE_OPTIONS"\n');
    chmodSync(realNode, 0o755);

    const runtime = prepareCodexChildRuntimeEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=256' }, 'linux', realNode);
    try {
      expect(runtime.nodeWrapperPath).not.toBeNull();
      expect(runtime.env.PATH?.split(':')[0]).toBe(runtime.nodeWrapperPath ? join(runtime.nodeWrapperPath, '..') : '');
      const wrapper = readFileSync(runtime.nodeWrapperPath ?? '', 'utf8');
      for (const option of expectedNodeWebApiOptions) expect(wrapper).toContain(option);
      expect(wrapper).toContain(realNode);
      const output = execFileSync(runtime.nodeWrapperPath ?? '', [], {
        encoding: 'utf8',
        env: { NODE_OPTIONS: '--max-old-space-size=256 --no-experimental-fetch' },
      });
      expect(output.trim().split(/\s+/)).toEqual(uniqueOptions(['--max-old-space-size=256', '--no-experimental-fetch', ...expectedNodeWebApiOptions]));
    } finally {
      runtime.cleanup();
    }
    expect(runtime.nodeWrapperPath ? existsSync(runtime.nodeWrapperPath) : false).toBe(false);
  });

  it('passes an isolated SQLite home to the Codex child environment', () => {
    const root = tempRoot();
    const realNode = join(root, 'node-real');
    const sqliteHome = join(root, 'codex-sqlite', 'login-node');
    writeFileSync(realNode, '#!/bin/sh\n');
    chmodSync(realNode, 0o755);

    const runtime = prepareCodexChildRuntimeEnv({ PATH: '/usr/bin' }, 'linux', realNode, sqliteHome);
    try {
      expect(runtime.env.CODEX_SQLITE_HOME).toBe(sqliteHome);
    } finally {
      runtime.cleanup();
    }
  });

  it('forces the isolated SQLite home through Codex config precedence', () => {
    expect(codexAppServerArgs('/tmp/codex sqlite/host')).toEqual([
      '-c',
      'sqlite_home="/tmp/codex sqlite/host"',
      'app-server',
      '--listen',
      'ws://127.0.0.1:0',
    ]);
  });

  it('logs sanitized node wrapper trace lines when process tracing is enabled', () => {
    const root = tempRoot();
    const realNode = join(root, 'node-real');
    writeFileSync(realNode, '#!/bin/sh\nprintf "%s" "$NODE_OPTIONS"\n');
    chmodSync(realNode, 0o755);

    const runtime = prepareCodexChildRuntimeEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=256', CODEX_WEB_UI_TRACE_CODEX_PROCESSES: '1' }, 'linux', realNode);
    try {
      const result = spawnSync(runtime.nodeWrapperPath ?? '', ['OPENAI_API_KEY=sk-testsecretsecretsecret'], {
        encoding: 'utf8',
        env: { ...runtime.env, NODE_OPTIONS: '--max-old-space-size=256\nOPENAI_API_KEY=sk-testsecretsecretsecret', CODEX_WEB_UI_TRACE_CODEX_PROCESSES: 'True' },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('[codex-web-ui-node-wrapper]');
      expect(result.stderr).toContain(`real_node=${realNode}`);
      expect(result.stderr).toContain('node_options=<redacted>');
      expect(result.stderr).toContain('argc=1');
      expect(result.stderr).toContain('first_arg=<redacted>');
      expect(result.stderr).not.toContain('sk-testsecretsecretsecret');
    } finally {
      runtime.cleanup();
    }
  });

  it('does not report connected until initialize has completed', () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const socket = { readyState: 1 };

    (server as unknown as { socket: unknown }).socket = socket;
    (server as unknown as { peer: unknown }).peer = {};

    expect(server.health()).toMatchObject({ connected: false, dead: false });

    (server as unknown as { initialized: boolean }).initialized = true;

    expect(server.health()).toMatchObject({ connected: true, dead: false });
  });

  it('sends initialized only after the initialize request resolves', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const socket = new FakeRpcSocket(false);
    const internals = server as unknown as {
      openSocket: ReturnType<typeof vi.fn>;
      connect(url: string, isCancelled: () => boolean): Promise<unknown>;
    };
    internals.openSocket = vi.fn().mockResolvedValue(socket);

    const connecting = internals.connect('ws://app-server', () => false);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    expect(socket.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(socket.sent.map(({ method }) => method)).toEqual(['initialize']);

    socket.receive({ jsonrpc: '2.0', id: 1, result: { userAgent: 'codex-test' } });

    await expect(connecting).resolves.toEqual({ userAgent: 'codex-test' });
    expect(socket.sent).toEqual([
      expect.objectContaining({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      { jsonrpc: '2.0', method: 'initialized' },
    ]);
  });

  it('does not acknowledge an initialize response after its lifecycle is cancelled', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const socket = new FakeRpcSocket(false);
    const internals = server as unknown as {
      openSocket: ReturnType<typeof vi.fn>;
      connect(url: string, isCancelled: () => boolean): Promise<unknown>;
    };
    internals.openSocket = vi.fn().mockResolvedValue(socket);
    let cancelled = false;

    const connecting = internals.connect('ws://app-server', () => cancelled);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    cancelled = true;
    socket.receive({ jsonrpc: '2.0', id: 1, result: { userAgent: 'stale-codex-test' } });

    await expect(connecting).rejects.toThrow('startup was cancelled');
    expect(socket.sent.map(({ method }) => method)).toEqual(['initialize']);
  });

  it('does not send initialized when the initialize request rejects', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const socket = new FakeRpcSocket(false);
    const internals = server as unknown as {
      openSocket: ReturnType<typeof vi.fn>;
      connect(url: string, isCancelled: () => boolean): Promise<unknown>;
    };
    internals.openSocket = vi.fn().mockResolvedValue(socket);

    const connecting = internals.connect('ws://app-server', () => false);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'initialize failed' } });

    await expect(connecting).rejects.toThrow('initialize failed');
    expect(socket.sent.map(({ method }) => method)).toEqual(['initialize']);
  });

  it('drops notifications and server requests from a stale peer after reconnect', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const staleSocket = new FakeRpcSocket();
    const currentSocket = new FakeRpcSocket();
    const notification = vi.fn();
    const serverRequest = vi.fn();
    server.onNotification(notification);
    server.onServerRequest(serverRequest);

    const internals = server as unknown as {
      openSocket: ReturnType<typeof vi.fn>;
      connect(url: string, isCancelled: () => boolean): Promise<unknown>;
    };
    internals.openSocket = vi.fn()
      .mockResolvedValueOnce(staleSocket)
      .mockResolvedValueOnce(currentSocket);

    await internals.connect('ws://stale', () => false);
    server.stop();
    await internals.connect('ws://current', () => false);

    staleSocket.receive({ jsonrpc: '2.0', method: 'thread/stale', params: { threadId: 'stale' } });
    staleSocket.receive({ jsonrpc: '2.0', id: 'stale-request', method: 'item/stale', params: {} });
    currentSocket.receive({ jsonrpc: '2.0', method: 'thread/current', params: { threadId: 'current' } });
    currentSocket.receive({ jsonrpc: '2.0', id: 'current-request', method: 'item/current', params: {} });

    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'thread/current',
      params: { threadId: 'current' },
    });
    expect(serverRequest).toHaveBeenCalledTimes(1);
    expect(serverRequest).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 'current-request',
      method: 'item/current',
      params: {},
    });
  });

  it('clears the cached startup promise and stale child when the app-server websocket closes', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const startup = Promise.resolve(undefined);
    const closeHandlers = new Map<string, () => void>();
    const kill = vi.fn();
    const onHealthChange = vi.fn();
    (server as unknown as { startPromise: Promise<unknown> | null }).startPromise = startup;
    server.onHealthChange(onHealthChange);
    type FakeSocket = {
      readyState: number;
      on(event: string, handler: () => void): void;
      close(): undefined;
    };
    const socket: FakeSocket = {
      readyState: 1,
      on(event: string, handler: () => void) {
        closeHandlers.set(event, handler);
      },
      close() {
        return undefined;
      },
    };

    (server as unknown as { socket: unknown }).socket = socket;
    (server as unknown as { peer: unknown }).peer = {};
    (server as unknown as { child: unknown }).child = { killed: false, kill };

    (server as unknown as { handleSocketOpen(socket: FakeSocket): void }).handleSocketOpen(socket);

    closeHandlers.get('close')?.();

    expect((server as unknown as { startPromise: Promise<unknown> | null }).startPromise).toBeNull();
    expect((server as unknown as { child: unknown }).child).toBeNull();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(server.health()).toMatchObject({ connected: false, dead: true, error: 'Codex app-server WebSocket closed' });
    expect(onHealthChange).toHaveBeenCalledTimes(1);
  });

  it('waits for the old child to exit before starting again on restart', async () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      pid: number;
    };
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 1234;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const start = vi.fn().mockResolvedValue(undefined);

    (server as unknown as { child: unknown; start: typeof start }).child = child;
    (server as unknown as { child: unknown; start: typeof start }).start = start;

    const restarting = server.restart();
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await restarting;

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('holds normal starts behind an active restart', () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: true });
    const restartPromise = Promise.resolve(undefined);

    (server as unknown as { restartPromise: Promise<unknown> | null }).restartPromise = restartPromise;

    expect(server.start()).toBe(restartPromise);
  });
});
