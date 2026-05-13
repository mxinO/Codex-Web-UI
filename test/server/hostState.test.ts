import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostStateStore } from '../../server/hostState.js';

function repoIdForPath(repoPath: string): string {
  return `repo:${createHash('sha1').update(repoPath).digest('hex')}`;
}

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
        model: null,
        effort: null,
        queue: [],
        gitWorkspaces: [],
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

  it('sanitizes persisted runtime status fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      writeFileSync(
        join(dir, 'login-node.runtime.json'),
        JSON.stringify({
          model: ' gpt-5.5 ',
          effort: 'xhigh',
          mode: 'plan',
          sandbox: 'danger-full-access',
        }),
      );

      expect(new HostStateStore(dir, 'login-node').read()).toMatchObject({
        model: 'gpt-5.5',
        effort: 'xhigh',
        mode: 'plan',
        sandbox: 'danger-full-access',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops queued collaboration mode options when no model is persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      writeFileSync(
        join(dir, 'login-node.runtime.json'),
        JSON.stringify({
          queue: [
            {
              id: 'mode-only',
              text: 'next',
              createdAt: 1,
              options: { mode: 'plan', effort: 'high', sandbox: 'workspace-write' },
            },
            {
              id: 'mode-with-model',
              text: 'next with model',
              createdAt: 2,
              options: { model: 'gpt-5.5', mode: 'plan', effort: 'high' },
            },
          ],
        }),
      );

      const state = new HostStateStore(dir, 'login-node').read();

      expect(state.queue[0]).toMatchObject({
        id: 'mode-only',
        options: { effort: 'high', sandbox: 'workspace-write' },
      });
      expect(state.queue[0].options).not.toHaveProperty('mode');
      expect(state.queue[1]).toMatchObject({
        id: 'mode-with-model',
        options: { model: 'gpt-5.5', mode: 'plan', effort: 'high' },
      });
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
        gitWorkspaces: [],
      });
      expect(new HostStateStore(oversizedDir, 'login-node', { maxStateFileBytes: 10 }).read()).toMatchObject({
        hostname: 'login-node',
        activeThreadId: null,
        queue: [],
        gitWorkspaces: [],
      });
    } finally {
      rmSync(malformedDir, { recursive: true, force: true });
      rmSync(oversizedDir, { recursive: true, force: true });
    }
  });

  it('sanitizes git workspace metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      writeFileSync(
        join(dir, 'login-node.runtime.json'),
        JSON.stringify({
          gitWorkspaces: [
            {
              cwd: ' /workspace ',
              ignored: true,
              repos: [
                {
                  path: ' /workspace/repo-a ',
                  label: ' repo-a ',
                  addedAt: 1000,
                  untrackedMode: 'normal',
                  extra: { nested: true },
                },
                {
                  id: 'repo:kept',
                  path: '/workspace/repo-b',
                  label: '/workspace/repo-b'.repeat(100),
                  addedAt: 2000,
                  untrackedMode: 'everything',
                  extra: 'drop me',
                },
                { id: 'missing-path', label: 'bad', addedAt: 1 },
                { path: '/workspace/no-label', addedAt: 1 },
                { path: '/workspace/no-added-at', label: 'bad' },
                { path: 42, label: 'bad', addedAt: 1 },
              ],
            },
            { cwd: 42, repos: [] },
            { cwd: '/workspace/no-repos' },
            'bad',
          ],
        }),
      );

      const state = new HostStateStore(dir, 'login-node').read();

      expect(state.gitWorkspaces).toEqual([
        {
          cwd: '/workspace',
          repos: [
            {
              id: repoIdForPath('/workspace/repo-a'),
              path: '/workspace/repo-a',
              label: 'repo-a',
              addedAt: 1000,
              untrackedMode: 'normal',
            },
            {
              id: 'repo:kept',
              path: '/workspace/repo-b',
              label: '/workspace/repo-b'.repeat(100).slice(0, 256),
              addedAt: 2000,
            },
          ],
        },
      ]);
      expect(state.gitWorkspaces[0]).not.toHaveProperty('ignored');
      expect(state.gitWorkspaces[0].repos[0]).not.toHaveProperty('extra');
      expect(state.gitWorkspaces[0].repos[1]).not.toHaveProperty('untrackedMode');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds persisted git workspace and repo metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-state-'));
    try {
      const gitWorkspaces = Array.from({ length: 25 }, (_, workspaceIdx) => ({
        cwd: `/workspace/${workspaceIdx}`,
        repos: Array.from({ length: 25 }, (_, repoIdx) => ({
          id: `repo:${workspaceIdx}:${repoIdx}`,
          path: `/workspace/${workspaceIdx}/repo-${repoIdx}`,
          label: `repo-${repoIdx}`,
          addedAt: repoIdx,
        })),
      }));
      writeFileSync(join(dir, 'login-node.runtime.json'), JSON.stringify({ gitWorkspaces }));

      const state = new HostStateStore(dir, 'login-node').read();

      expect(state.gitWorkspaces).toHaveLength(20);
      expect(state.gitWorkspaces[0].cwd).toBe('/workspace/0');
      expect(state.gitWorkspaces[19].cwd).toBe('/workspace/19');
      expect(state.gitWorkspaces[0].repos).toHaveLength(20);
      expect(state.gitWorkspaces[0].repos[0].id).toBe('repo:0:0');
      expect(state.gitWorkspaces[0].repos[19].id).toBe('repo:0:19');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
