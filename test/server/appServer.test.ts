import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServer, prepareCodexChildRuntimeEnv, resolveCodexSpawnConfig, sanitizeProcessArgvForTrace } from '../../server/appServer.js';

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
      'Authorization: Bearer <redacted>',
      'safe-value',
    ]);
  });
});

describe('CodexAppServer lifecycle', () => {
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

  it('does not report connected until initialize has completed', () => {
    const server = new CodexAppServer({ cwd: process.cwd(), mock: false });
    const socket = { readyState: 1 };

    (server as unknown as { socket: unknown }).socket = socket;
    (server as unknown as { peer: unknown }).peer = {};

    expect(server.health()).toMatchObject({ connected: false, dead: false });

    (server as unknown as { initialized: boolean }).initialized = true;

    expect(server.health()).toMatchObject({ connected: true, dead: false });
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
