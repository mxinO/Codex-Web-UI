import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

describe('CLI update helper', () => {
  it('builds a global npm install for the default GitHub tarball', async () => {
    const { DEFAULT_UPDATE_SOURCE, runUpdate } = await import('../bin/update.mjs');
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const resultPromise = runUpdate(['--update'], {
      currentVersion: '0.1.0',
      platform: 'linux',
      spawn,
      stdout,
      stderr,
    });
    child.emit('exit', 0, null);

    await expect(resultPromise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith('npm', ['install', '-g', DEFAULT_UPDATE_SOURCE], expect.objectContaining({ stdio: 'inherit' }));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Updating codex-web-ui 0.1.0'));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('accepts an explicit update source', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);

    const resultPromise = runUpdate(['--update', '--source', 'file:///tmp/codex-web-ui.tgz'], {
      platform: 'linux',
      spawn,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });
    child.emit('exit', 0, null);

    await expect(resultPromise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith('npm', ['install', '-g', 'file:///tmp/codex-web-ui.tgz'], expect.any(Object));
  });

  it('rejects a missing update source value before spawning npm', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const spawn = vi.fn();
    const stderr = { write: vi.fn() };

    await expect(
      runUpdate(['--update', '--source'], {
        spawn,
        stdout: { write: vi.fn() },
        stderr,
      }),
    ).resolves.toBe(2);

    expect(spawn).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('Usage: codex-web-ui --update'));
  });

  it('forwards termination signals to the npm update child while it is running', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = new EventEmitter() as EventEmitter & { killed?: boolean; kill: ReturnType<typeof vi.fn> };
    child.killed = false;
    child.kill = vi.fn((signal: string) => {
      child.killed = true;
      child.emit('exit', null, signal);
      return true;
    });
    const processEvents = new EventEmitter();

    const resultPromise = runUpdate(['--update'], {
      currentVersion: '0.1.0',
      platform: 'linux',
      process: processEvents,
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    processEvents.emit('SIGTERM');

    await expect(resultPromise).resolves.toBe(143);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(processEvents.listenerCount('SIGTERM')).toBe(0);
    expect(processEvents.listenerCount('SIGINT')).toBe(0);
  });
});
