import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostStateStore } from '../../server/hostState.js';
import {
  addGitRepo,
  gitCommit,
  gitDiffForRepo,
  gitStagePaths,
  gitStatusForRepo,
  gitUnstagePaths,
  listGitRepos,
  removeGitRepo,
  normalizeRepoRelativePath,
} from '../../server/gitTracker.js';

const tempDirs: string[] = [];

function tempRoot(prefix = 'codex-webui-git-tracker-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[], stdin?: string): string {
  return execFileSync('git', args, { cwd, input: stdin, encoding: 'utf8' });
}

function initRepo(workspace: string, name = 'repo'): string {
  const repo = join(workspace, name);
  mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'tracked.txt'), 'initial\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function makeContext(activeCwd: string) {
  const stateStore = new HostStateStore(tempRoot('codex-webui-git-state-'), 'login-node');
  stateStore.write({ ...stateStore.read(), activeCwd });
  return { stateStore };
}

describe('gitTracker', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds, lists, removes, and scopes repos to the active cwd workspace', async () => {
    const workspaceA = tempRoot();
    const workspaceB = tempRoot();
    const repoA = initRepo(workspaceA, 'repo');
    const repoB = initRepo(workspaceB, 'repo');
    const context = makeContext(workspaceA);

    const addedA = await addGitRepo(context.stateStore.read(), context.stateStore, repoA);
    context.stateStore.update((state) => ({
      ...state,
      gitWorkspaces: [
        ...state.gitWorkspaces,
        { cwd: workspaceB, repos: [{ id: addedA.repo.id, path: repoB, label: 'repo', addedAt: 1 }] },
      ],
    }));

    expect(await listGitRepos(context.stateStore.read())).toEqual({ cwd: workspaceA, repos: [addedA.repo] });
    await expect(gitStatusForRepo(context.stateStore.read(), 'missing')).rejects.toThrow('tracked repo not found');

    const removed = removeGitRepo(context.stateStore.read(), context.stateStore, addedA.repo.id);
    expect(removed.repos).toEqual([]);
    expect(context.stateStore.read().gitWorkspaces.find((workspace) => workspace.cwd === workspaceB)?.repos).toHaveLength(1);
  });

  it('rejects empty add paths and repo additions over the workspace limit', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);

    await expect(addGitRepo(context.stateStore.read(), context.stateStore, '   ')).rejects.toThrow('path is required');

    context.stateStore.write({
      ...context.stateStore.read(),
      gitWorkspaces: [
        {
          cwd: workspace,
          repos: Array.from({ length: 20 }, (_, index) => ({
            id: `repo:${index}`,
            path: join(workspace, `existing-${index}`),
            label: `existing-${index}`,
            addedAt: index,
          })),
        },
      ],
    });

    await expect(addGitRepo(context.stateStore.read(), context.stateStore, repo)).rejects.toThrow('tracked repo limit reached');
  });

  it('parses real git status for staged, unstaged, and untracked files', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git(repo, ['add', 'staged.txt']);
    writeFileSync(join(repo, 'notes.md'), 'untracked\n');

    const status = await gitStatusForRepo(state, trackedRepo.id);

    expect(status.repoId).toBe(trackedRepo.id);
    expect(status.path).toBe(repo);
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', kind: 'unstaged', worktreeStatus: 'M' }),
        expect.objectContaining({ path: 'staged.txt', kind: 'staged', indexStatus: 'A' }),
        expect.objectContaining({ path: 'notes.md', kind: 'untracked' }),
      ]),
    );
  });

  it('honors repo untrackedMode when refreshing status', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    context.stateStore.write({
      ...context.stateStore.read(),
      gitWorkspaces: [
        {
          cwd: workspace,
          repos: [{ ...trackedRepo, untrackedMode: 'no' }],
        },
      ],
    });

    writeFileSync(join(repo, 'hidden-untracked.txt'), 'not listed\n');

    const status = await gitStatusForRepo(context.stateStore.read(), trackedRepo.id);

    expect(status.entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'hidden-untracked.txt' })]));
  });

  it('validates repo-relative paths strictly', () => {
    expect(() => normalizeRepoRelativePath('')).toThrow('path is required');
    expect(() => normalizeRepoRelativePath('/absolute.txt')).toThrow('path must be repo-relative');
    expect(() => normalizeRepoRelativePath('a\0b')).toThrow('path contains NUL byte');
    expect(() => normalizeRepoRelativePath('../outside.txt')).toThrow('path escapes repo');
    expect(() => normalizeRepoRelativePath('src/../file.txt')).not.toThrow();
    expect(normalizeRepoRelativePath('src\\file.txt')).toBe('src/file.txt');
  });

  it('returns tracked and untracked diffs and enforces untracked file safety', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    writeFileSync(join(repo, 'tracked.txt'), 'Binary files this and that differ\n');
    writeFileSync(join(repo, 'new.txt'), 'hello\nworld\n');

    const unstaged = await gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'tracked.txt', scope: 'unstaged' });
    expect(unstaged.patch).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(unstaged.patch).toContain('+Binary files this and that differ');
    expect(unstaged.binary).toBe(false);
    expect(unstaged.truncated).toBe(false);

    const untracked = await gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'new.txt', scope: 'untracked' });
    expect(untracked.patch).toContain('new file mode 100644');
    expect(untracked.patch).toContain('+hello');

    symlinkSync(join(workspace, 'outside.txt'), join(repo, 'linked.txt'));
    writeFileSync(join(workspace, 'outside.txt'), 'outside\n');
    await expect(gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'linked.txt', scope: 'untracked' })).rejects.toThrow(
      'untracked diff target must be a regular file',
    );

    mkdirSync(join(repo, 'dir'));
    await expect(gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'dir', scope: 'untracked' })).rejects.toThrow(
      'untracked diff target must be a regular file',
    );

    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await expect(gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'binary.bin', scope: 'untracked' })).rejects.toThrow(
      'binary diff is not shown',
    );

    writeFileSync(join(repo, 'large.txt'), `${'x'.repeat(2 * 1024 * 1024)}\n`);
    await expect(gitDiffForRepo(state, { repoId: trackedRepo.id, path: 'large.txt', scope: 'untracked' })).rejects.toThrow(
      'diff is too large',
    );
  });

  it('uses originalPath for staged pure rename diffs', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    git(repo, ['mv', 'tracked.txt', 'renamed.txt']);

    const status = await gitStatusForRepo(state, trackedRepo.id);
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'renamed.txt',
          originalPath: 'tracked.txt',
          indexStatus: 'R',
          kind: 'staged',
        }),
      ]),
    );

    const diff = await gitDiffForRepo(state, {
      repoId: trackedRepo.id,
      scope: 'staged',
      path: 'renamed.txt',
      originalPath: 'tracked.txt',
    });

    expect(diff.patch).toContain('similarity index 100%');
    expect(diff.patch).toContain('rename from tracked.txt');
    expect(diff.patch).toContain('rename to renamed.txt');
    expect(diff.patch).not.toContain('new file mode');
  });

  it('stages, unstages, and rejects untracked directories', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    await gitStagePaths(state, { repoId: trackedRepo.id, paths: ['tracked.txt'] });
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('tracked.txt');

    await gitUnstagePaths(state, { repoId: trackedRepo.id, paths: ['tracked.txt'] });
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');

    mkdirSync(join(repo, 'scratch'));
    writeFileSync(join(repo, 'scratch', 'note.txt'), 'note\n');
    await expect(gitStagePaths(state, { repoId: trackedRepo.id, paths: ['scratch/'] })).rejects.toThrow(
      'cannot stage directory paths',
    );
  });

  it('checks latest runtime state before mutating git', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');

    await expect(
      gitStagePaths(state, { repoId: trackedRepo.id, paths: ['tracked.txt'] }, () => ({ ...state, activeTurnId: 'turn-latest' })),
    ).rejects.toThrow('git mutation is disabled while a turn is active');
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('commits staged changes with hooks and signing disabled', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();

    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
    await gitStagePaths(state, { repoId: trackedRepo.id, paths: ['tracked.txt'] });

    await expect(gitCommit(state, { repoId: trackedRepo.id, message: '   ' })).rejects.toThrow('commit message is required');
    const result = await gitCommit(state, { repoId: trackedRepo.id, message: 'web commit\n\nbody' });

    expect(result.ok).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('rechecks untracked file size after race-safe open before reading', async () => {
    const workspace = tempRoot();
    const repo = initRepo(workspace);
    const context = makeContext(workspace);
    const { repo: trackedRepo } = await addGitRepo(context.stateStore.read(), context.stateStore, repo);
    const state = context.stateStore.read();
    const filePath = join(repo, 'race.txt');
    writeFileSync(filePath, 'small\n');

    const readOpenedFileFully = vi.fn(async () => Buffer.from('should not read'));
    vi.resetModules();
    vi.doMock('../../server/fileTransfer.js', () => ({
      openExistingFileInsideRoot: vi.fn(async () => ({
        handle: { close: vi.fn(async () => undefined) },
        realPath: filePath,
        stats: { size: 3 * 1024 * 1024, isFile: () => true },
      })),
      readOpenedFileFully,
    }));

    try {
      const { gitDiffForRepo: mockedGitDiffForRepo } = await import('../../server/gitTracker.js');
      await expect(mockedGitDiffForRepo(state, { repoId: trackedRepo.id, path: 'race.txt', scope: 'untracked' })).rejects.toThrow(
        'diff is too large',
      );
      expect(readOpenedFileFully).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../server/fileTransfer.js');
      vi.resetModules();
    }
  });
});
