// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitTrackerPanel from '../../src/components/GitTrackerPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
type GitRpc = React.ComponentProps<typeof GitTrackerPanel>['rpc'];

function asRpc(mock: unknown): GitRpc {
  return mock as GitRpc;
}

function changeInputValue(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('missing input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPanel(rpc: GitRpc, workspaceRoot = '/workspace') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<GitTrackerPanel root={workspaceRoot} rpc={rpc} />);
  });
}

function rerenderPanel(rpc: GitRpc, workspaceRoot: string) {
  act(() => {
    root?.render(<GitTrackerPanel root={workspaceRoot} rpc={rpc} />);
  });
}

const repo = { id: 'repo:1', path: '/workspace/repo', label: 'repo', addedAt: 1000, untrackedMode: 'normal' };
const status = {
  repoId: repo.id,
  path: repo.path,
  branch: 'main',
  headOid: 'abc123',
  upstream: 'origin/main',
  ahead: 1,
  behind: 2,
  refreshedAt: 1000,
  truncated: false,
  entries: [
    { path: 'staged.txt', indexStatus: 'M', worktreeStatus: '.', kind: 'staged' },
    { path: 'renamed.txt', originalPath: 'old.txt', indexStatus: 'R', worktreeStatus: '.', kind: 'staged' },
    { path: 'changed.txt', indexStatus: '.', worktreeStatus: 'M', kind: 'unstaged' },
    { path: 'new-dir/', indexStatus: '?', worktreeStatus: '?', kind: 'untracked', isDirectory: true },
    { path: 'new.txt', indexStatus: '?', worktreeStatus: '?', kind: 'untracked' },
  ],
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('GitTrackerPanel', () => {
  it('loads repos and renders grouped status rows with directory safeguards', async () => {
    const rpc = vi.fn((method: string, params?: unknown) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [repo] });
      if (method === 'webui/git/status' && (params as { repoId: string }).repoId === repo.id) return Promise.resolve(status);
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[aria-label="Staged files"]')?.textContent).toContain('staged.txt');
    expect(document.querySelector('[aria-label="Changed files"]')?.textContent).toContain('changed.txt');
    expect(document.querySelector('[aria-label="Untracked files"]')?.textContent).toContain('new-dir/');
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Stage new-dir/"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Diff new-dir/"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Stage new.txt"]')?.disabled).toBe(false);
  });

  it('stages one path, refreshes the repo, and opens a fetched diff', async () => {
    const rpc = vi.fn((method: string, params?: unknown) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [repo] });
      if (method === 'webui/git/status') return Promise.resolve(status);
      if (method === 'webui/git/stage') return Promise.resolve({ ok: true });
      if (method === 'webui/git/diff') {
        return Promise.resolve({ repoId: repo.id, path: 'changed.txt', scope: 'unstaged', patch: 'diff --git a/changed.txt b/changed.txt', truncated: false });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Stage changed.txt"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/git/stage', { repoId: repo.id, paths: ['changed.txt'] });
    expect(rpc).toHaveBeenCalledWith('webui/git/status', { repoId: repo.id });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Diff changed.txt"]')?.click();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/git/diff', { repoId: repo.id, path: 'changed.txt', scope: 'unstaged' });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('changed.txt');
  });

  it('commits staged changes with a 65 second timeout then clears the message', async () => {
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [repo] });
      if (method === 'webui/git/status') return Promise.resolve(status);
      if (method === 'webui/git/commit') return Promise.resolve({ ok: true, commit: 'abc123', output: 'ok' });
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const commit = document.querySelector<HTMLButtonElement>('button[aria-label="Commit repo"]');
    expect(commit?.disabled).toBe(true);

    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Commit message for repo"]');
      changeInputValue(input, 'ship it');
      await Promise.resolve();
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Commit repo"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/git/commit', { repoId: repo.id, message: 'ship it' }, 65_000);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Commit message for repo"]')?.value).toBe('');
  });

  it('clears stale workspace state and ignores slow old workspace responses', async () => {
    const oldList = deferred<unknown>();
    const newList = deferred<unknown>();
    const oldRepo = { id: 'repo:old', path: '/old/repo', label: 'old-repo', addedAt: 1 };
    const newRepo = { id: 'repo:new', path: '/new/repo', label: 'new-repo', addedAt: 2 };
    const rpc = vi.fn((method: string, params?: unknown) => {
      if (method === 'webui/git/repos/list') return rpc.mock.calls.filter(([called]) => called === 'webui/git/repos/list').length === 1 ? oldList.promise : newList.promise;
      if (method === 'webui/git/status') {
        const repoId = (params as { repoId: string }).repoId;
        return Promise.resolve({
          ...status,
          repoId,
          path: repoId === oldRepo.id ? oldRepo.path : newRepo.path,
          entries: [{ path: `${repoId}.txt`, indexStatus: '.', worktreeStatus: 'M', kind: 'unstaged' }],
        });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc), '/old');
    rerenderPanel(asRpc(rpc), '/new');
    expect(document.querySelector('.git-repo-list')?.textContent).not.toContain('old-repo');

    await act(async () => {
      oldList.resolve({ cwd: '/old', repos: [oldRepo] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('.git-repo-list')?.textContent).not.toContain('old-repo');

    await act(async () => {
      newList.resolve({ cwd: '/new', repos: [newRepo] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('.git-repo-list')?.textContent).toContain('new-repo');
    expect(document.querySelector('.git-repo-list')?.textContent).not.toContain('old-repo');
  });

  it('adds current workspace and picker selections once while add is in flight', async () => {
    const addCurrent = deferred<unknown>();
    const browse = deferred<unknown>();
    const rpc = vi.fn((method: string, params?: unknown) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [] });
      if (method === 'webui/git/repos/add' && (params as { path: string }).path === '/workspace') return addCurrent.promise;
      if (method === 'webui/fs/browseWorkspaceDirectory') return browse.promise;
      if (method === 'webui/git/status') return Promise.resolve(status);
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      const addCurrentButton = document.querySelector<HTMLButtonElement>('button[aria-label="Add current workspace"]');
      addCurrentButton?.click();
      addCurrentButton?.click();
    });

    expect(rpc.mock.calls.filter(([method]) => method === 'webui/git/repos/add')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Add current workspace"]')?.disabled).toBe(true);

    await act(async () => {
      addCurrent.resolve({ repo, repos: [repo] });
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Add Git repository"]')?.click();
    });
    await act(async () => {
      browse.resolve({
        path: '/workspace',
        parent: '/workspace',
        truncated: false,
        entries: [{ name: 'repo', path: '/workspace/repo', isDirectory: true }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Select repo"]')?.disabled).toBe(false);
  });

  it('unstages, passes originalPath for staged diff, and guards duplicate manual refresh', async () => {
    const manualRefresh = deferred<unknown>();
    let statusCalls = 0;
    const rpc = vi.fn((method: string, params?: unknown) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [repo] });
      if (method === 'webui/git/status') {
        statusCalls += 1;
        return statusCalls === 2 ? manualRefresh.promise : Promise.resolve(status);
      }
      if (method === 'webui/git/unstage') return Promise.resolve({ ok: true });
      if (method === 'webui/git/diff') {
        return Promise.resolve({ repoId: repo.id, path: 'renamed.txt', scope: 'staged', patch: 'diff --git', truncated: false });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Unstage staged.txt"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith('webui/git/unstage', { repoId: repo.id, paths: ['staged.txt'] });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Diff renamed.txt"]')?.click();
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith('webui/git/diff', { repoId: repo.id, path: 'renamed.txt', scope: 'staged', originalPath: 'old.txt' });

    act(() => {
      const refreshButton = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh repo"]');
      refreshButton?.click();
      refreshButton?.click();
    });
    expect(rpc.mock.calls.filter(([method]) => method === 'webui/git/status')).toHaveLength(statusCalls);

    await act(async () => {
      manualRefresh.resolve(status);
      await Promise.resolve();
    });
  });

  it('does not allow selecting stale folder picker browse results after a failed browse', async () => {
    const firstBrowse = deferred<unknown>();
    const failedBrowse = deferred<unknown>();
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/workspace', repos: [] });
      if (method === 'webui/fs/browseWorkspaceDirectory') {
        return rpc.mock.calls.filter(([called]) => called === 'webui/fs/browseWorkspaceDirectory').length === 1 ? firstBrowse.promise : failedBrowse.promise;
      }
      if (method === 'webui/git/repos/add') return Promise.resolve({ repo, repos: [repo] });
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderPanel(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Add Git repository"]')?.click();
    });
    await act(async () => {
      firstBrowse.resolve({
        path: '/workspace',
        parent: '/workspace',
        truncated: false,
        entries: [{ name: 'repo', path: '/workspace/repo', isDirectory: true }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Select folder"]')?.disabled).toBe(false);

    await act(async () => {
      changeInputValue(document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]'), '/workspace/missing');
      document.querySelector<HTMLButtonElement>('button[aria-label="Browse typed folder"]')?.click();
      failedBrowse.reject(new Error('missing'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('.folder-picker-body')?.textContent).not.toContain('repo');
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Select folder"]')?.disabled).toBe(true);
  });
});
