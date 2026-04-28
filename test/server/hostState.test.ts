import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostStateStore } from '../../server/hostState.js';

describe('HostStateStore', () => {
  it('namespaces state by hostname', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      const a = new HostStateStore(dir, 'host-a');
      const b = new HostStateStore(dir, 'host-b');
      a.update((state) => ({ ...state, activeThreadId: 'thread-a' }));
      b.update((state) => ({ ...state, activeThreadId: 'thread-b' }));

      expect(a.read().activeThreadId).toBe('thread-a');
      expect(b.read().activeThreadId).toBe('thread-b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to bounded empty runtime state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      const store = new HostStateStore(dir, 'login-node');
      expect(store.read()).toMatchObject({
        hostname: 'login-node',
        activeThreadId: null,
        queue: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes and bounds persisted queue and recent cwd data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      const queue = Array.from({ length: 25 }, (_, idx) => ({
        id: `message-${idx}`,
        text: `text-${idx}`,
        createdAt: idx,
      }));
      const recentCwds = Array.from({ length: 25 }, (_, idx) => `/work/${idx}`);
      writeFileSync(
        join(dir, 'login-node.runtime.json'),
        JSON.stringify({
          activeThreadId: 'thread-a',
          queue: [...queue, { id: 'bad', text: 'bad', createdAt: 'now' }],
          recentCwds: [...recentCwds, 42],
        }),
      );

      const state = new HostStateStore(dir, 'login-node').read();

      expect(state.activeThreadId).toBe('thread-a');
      expect(state.queue).toHaveLength(20);
      expect(state.queue[0]).toEqual({ id: 'message-5', text: 'text-5', createdAt: 5 });
      expect(state.queue[19]).toEqual({ id: 'message-24', text: 'text-24', createdAt: 24 });
      expect(state.recentCwds).toHaveLength(20);
      expect(state.recentCwds[0]).toBe('/work/5');
      expect(state.recentCwds[19]).toBe('/work/24');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults for malformed or oversized state files', () => {
    const malformedDir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    const oversizedDir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      writeFileSync(join(malformedDir, 'login-node.runtime.json'), '{');
      writeFileSync(join(oversizedDir, 'login-node.runtime.json'), '{"activeThreadId":"too-large"}');

      expect(new HostStateStore(malformedDir, 'login-node').read()).toMatchObject({
        hostname: 'login-node',
        activeThreadId: null,
        queue: [],
      });
      expect(new HostStateStore(oversizedDir, 'login-node', { maxStateFileBytes: 10 }).read()).toMatchObject({
        hostname: 'login-node',
        activeThreadId: null,
        queue: [],
      });
    } finally {
      rmSync(malformedDir, { recursive: true, force: true });
      rmSync(oversizedDir, { recursive: true, force: true });
    }
  });
});
