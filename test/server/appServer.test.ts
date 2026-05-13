import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from '../../server/appServer.js';

describe('CodexAppServer lifecycle', () => {
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
