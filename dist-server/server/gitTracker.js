import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openExistingFileInsideRoot, readOpenedFileFully } from './fileTransfer.js';
import { runGit } from './gitRunner.js';
import { parseGitStatusPorcelainV2 } from './gitStatus.js';
const MAX_WORKSPACES = 20;
const MAX_REPOS_PER_WORKSPACE = 20;
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const GIT_DIFF_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 20_000;
const COMMIT_TIMEOUT_MS = 60_000;
const COMMIT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_PATHS_PER_MUTATION = 50;
const MAX_PATH_BYTES = 4096;
const MAX_PATHSPEC_STDIN_BYTES = 128 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const GIT_UNTRACKED_MODES = new Set(['normal', 'all', 'no']);
function repoIdForPath(repoPath) {
    return `repo:${createHash('sha1').update(repoPath).digest('hex')}`;
}
function isPathInsideRoot(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function requireActiveCwd(state) {
    if (!state.activeCwd)
        throw new Error('no active cwd');
    return state.activeCwd;
}
function workspaceFor(state, cwd) {
    return state.gitWorkspaces.find((workspace) => workspace.cwd === cwd) ?? { cwd, repos: [] };
}
function ensureWorkspace(workspaces, cwd) {
    const index = workspaces.findIndex((workspace) => workspace.cwd === cwd);
    if (index >= 0)
        return { workspace: workspaces[index], workspaces };
    const workspace = { cwd, repos: [] };
    return { workspace, workspaces: [...workspaces, workspace].slice(-MAX_WORKSPACES) };
}
async function realPathInsideActive(active, target) {
    const [realActive, realTarget] = await Promise.all([fs.realpath(active), fs.realpath(target)]);
    if (!isPathInsideRoot(realActive, realTarget))
        throw new Error('path is outside active workspace');
    return realTarget;
}
function resolveLexicalPathInsideRoot(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(resolvedRoot, target);
    if (!isPathInsideRoot(resolvedRoot, resolvedTarget))
        throw new Error('path is outside active workspace');
    return resolvedTarget;
}
async function revalidateRepo(state, repoId) {
    const activeCwd = requireActiveCwd(state);
    const workspace = workspaceFor(state, activeCwd);
    const repo = workspace.repos.find((candidate) => candidate.id === repoId);
    if (!repo)
        throw new Error('tracked repo not found');
    const [realActiveCwd, realRepoPath] = await Promise.all([fs.realpath(activeCwd), fs.realpath(repo.path)]);
    if (!isPathInsideRoot(realActiveCwd, realRepoPath))
        throw new Error('tracked repo is outside active workspace');
    return { activeCwd, repo, realActiveCwd, realRepoPath };
}
function mutationAllowed(state) {
    if (state.activeTurnId)
        throw new Error('git mutation is disabled while a turn is active');
}
function requireUnchangedMutationTarget(state, latest, lookup) {
    if (latest.activeThreadId !== state.activeThreadId || latest.activeThreadPath !== state.activeThreadPath || latest.activeCwd !== lookup.activeCwd) {
        throw new Error('git mutation target changed');
    }
    const workspace = workspaceFor(latest, lookup.activeCwd);
    const latestRepo = workspace.repos.find((candidate) => candidate.id === lookup.repo.id);
    if (!latestRepo || latestRepo.path !== lookup.repo.path) {
        throw new Error('git mutation target changed');
    }
}
function mutationAllowedBeforeSpawn(state, lookup, latestState) {
    mutationAllowed(state);
    if (latestState) {
        const latest = latestState();
        mutationAllowed(latest);
        requireUnchangedMutationTarget(state, latest, lookup);
    }
}
export function normalizeRepoRelativePath(input) {
    if (typeof input !== 'string' || input.length === 0)
        throw new Error('path is required');
    if (input.includes('\0'))
        throw new Error('path contains NUL byte');
    if (path.isAbsolute(input) || path.win32.isAbsolute(input))
        throw new Error('path must be repo-relative');
    const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
    if (!normalized || normalized === '.')
        throw new Error('path is required');
    if (normalized === '..' || normalized.startsWith('../'))
        throw new Error('path escapes repo');
    if (Buffer.byteLength(normalized) > MAX_PATH_BYTES)
        throw new Error(`path is too long (max ${MAX_PATH_BYTES} bytes)`);
    return normalized;
}
function pathspecArg(repoPath) {
    return `:(literal)${repoPath}`;
}
function validatePathList(paths) {
    if (!Array.isArray(paths) || paths.length === 0)
        throw new Error('paths are required');
    if (paths.length > MAX_PATHS_PER_MUTATION)
        throw new Error(`too many paths (max ${MAX_PATHS_PER_MUTATION})`);
    const normalized = paths.map(normalizeRepoRelativePath);
    const stdin = Buffer.from(`${normalized.join('\0')}\0`, 'utf8');
    if (stdin.length > MAX_PATHSPEC_STDIN_BYTES)
        throw new Error(`pathspec input is too large (max ${MAX_PATHSPEC_STDIN_BYTES} bytes)`);
    return { normalized, stdin };
}
async function rejectDirectoryPaths(repoPath, repoPaths) {
    for (const repoRelativePath of repoPaths) {
        const target = path.resolve(repoPath, repoRelativePath);
        try {
            const stats = await fs.lstat(target);
            if (stats.isDirectory())
                throw new Error('cannot stage directory paths');
        }
        catch (error) {
            if (error instanceof Error && error.message === 'cannot stage directory paths')
                throw error;
            if (typeof error === 'object' && error !== null && error.code === 'ENOENT')
                continue;
            throw error;
        }
    }
}
async function assertExistingPathsInsideActive(lookup, repoPaths) {
    for (const repoRelativePath of repoPaths) {
        const target = path.resolve(lookup.repo.path, repoRelativePath);
        try {
            await fs.lstat(target);
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && error.code === 'ENOENT')
                continue;
            throw error;
        }
        const realTarget = await fs.realpath(target);
        if (!isPathInsideRoot(lookup.realActiveCwd, realTarget))
            throw new Error('path is outside active workspace');
    }
}
function isLikelyBinary(buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}
function syntheticUntrackedPatch(repoPath, content) {
    if (isLikelyBinary(content))
        throw new Error('binary diff is not shown');
    const text = content.toString('utf8');
    const lines = text.length === 0 ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const header = [`diff --git a/${repoPath} b/${repoPath}`, 'new file mode 100644', '--- /dev/null', `+++ b/${repoPath}`, `@@ -0,0 +1,${lines.length} @@`];
    const patch = `${header.join('\n')}\n${lines.map((line) => `+${line}`).join('\n')}${lines.length > 0 ? '\n' : ''}`;
    if (Buffer.byteLength(patch, 'utf8') > GIT_DIFF_OUTPUT_LIMIT_BYTES)
        throw new Error('diff is too large');
    return patch;
}
function parseCommitHash(output) {
    const full = /\b[0-9a-f]{40}\b/i.exec(output);
    if (full)
        return full[0];
    const short = /\[[^\]\s]+ ([0-9a-f]{7,40})[^\]]*\]/i.exec(output);
    return short?.[1] ?? null;
}
function untrackedModeForRepo(repo) {
    return repo.untrackedMode && GIT_UNTRACKED_MODES.has(repo.untrackedMode) ? repo.untrackedMode : 'normal';
}
function isBinaryGitDiff(output) {
    return output.split(/\r?\n/).some((line) => line.startsWith('Binary files ') || line.startsWith('Binary file ') || line === 'GIT binary patch' || line.startsWith('GIT binary patch '));
}
function textFromBuffer(buffer) {
    if (buffer.includes(0))
        return null;
    return buffer.toString('utf8');
}
async function gitObjectText(repoPath, ref, repoRelativePath, missingAsEmpty = false) {
    const revision = ref === 'HEAD' ? `HEAD:${repoRelativePath}` : `:${repoRelativePath}`;
    const result = await runGit({
        args: ['-C', repoPath, 'show', revision],
        timeoutMs: DIFF_TIMEOUT_MS,
        outputLimitBytes: GIT_DIFF_OUTPUT_LIMIT_BYTES,
        readOnly: true,
    });
    if (result.timedOut || result.stdoutTruncated)
        return null;
    if (result.exitCode !== 0)
        return missingAsEmpty ? '' : null;
    return result.stdout.includes('\0') ? null : result.stdout;
}
async function worktreeText(lookup, repoRelativePath) {
    const target = path.resolve(lookup.repo.path, repoRelativePath);
    let opened = null;
    try {
        opened = await openExistingFileInsideRoot(lookup.activeCwd, target);
        if (!opened.stats.isFile() || opened.stats.size > GIT_DIFF_OUTPUT_LIMIT_BYTES)
            return null;
        const content = await readOpenedFileFully(opened.handle, opened.stats.size);
        return textFromBuffer(content);
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && error.code === 'ENOENT')
            return '';
        return null;
    }
    finally {
        if (opened)
            await opened.handle.close().catch(() => undefined);
    }
}
async function trackedDiffSnapshot(lookup, scope, repoPath, originalRepoPath) {
    const beforePath = originalRepoPath ?? repoPath;
    const before = scope === 'staged' ? await gitObjectText(lookup.realRepoPath, 'HEAD', beforePath, true) : await gitObjectText(lookup.realRepoPath, 'index', beforePath, true);
    const after = scope === 'staged' ? await gitObjectText(lookup.realRepoPath, 'index', repoPath, true) : await worktreeText(lookup, repoPath);
    if (before === null || after === null)
        return null;
    return { before, after };
}
async function repoHasHead(repoPath) {
    const result = await runGit({
        args: ['-C', repoPath, 'rev-parse', '--verify', '--quiet', 'HEAD'],
        timeoutMs: MUTATION_TIMEOUT_MS,
        outputLimitBytes: 64 * 1024,
        readOnly: true,
    });
    if (result.timedOut)
        throw new Error('git HEAD check timed out');
    if (result.exitCode === 0)
        return true;
    if (result.exitCode === 1)
        return false;
    throw new Error(result.stderr.trim() || 'git HEAD check failed');
}
export async function listGitRepos(state) {
    const cwd = requireActiveCwd(state);
    return { cwd, repos: [...workspaceFor(state, cwd).repos] };
}
export async function addGitRepo(state, stateStore, requestedPath) {
    const cwd = requireActiveCwd(state);
    if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0)
        throw new Error('path is required');
    const selected = await realPathInsideActive(cwd, resolveLexicalPathInsideRoot(cwd, requestedPath.trim()));
    const revParse = await runGit({
        args: ['-C', selected, 'rev-parse', '--show-toplevel', '--is-inside-work-tree'],
        timeoutMs: STATUS_TIMEOUT_MS,
        outputLimitBytes: 64 * 1024,
        readOnly: true,
    });
    if (revParse.exitCode !== 0 || revParse.timedOut)
        throw new Error(revParse.stderr.trim() || 'path is not inside a git work tree');
    const lines = revParse.stdout.trim().split(/\r?\n/).filter(Boolean);
    const topLevel = lines.find((line) => line !== 'true' && line !== 'false');
    const inside = lines.includes('true');
    if (!inside || !topLevel)
        throw new Error('path is not inside a git work tree');
    const realRepoPath = await realPathInsideActive(cwd, topLevel);
    const { workspace, workspaces } = ensureWorkspace(state.gitWorkspaces, cwd);
    const existing = workspace.repos.find((repo) => repo.path === realRepoPath || repo.id === repoIdForPath(realRepoPath));
    if (existing)
        return { repo: existing, repos: [...workspace.repos] };
    if (workspace.repos.length >= MAX_REPOS_PER_WORKSPACE)
        throw new Error('tracked repo limit reached');
    const repo = {
        id: repoIdForPath(realRepoPath),
        path: realRepoPath,
        label: path.basename(realRepoPath) || realRepoPath,
        addedAt: Date.now(),
        untrackedMode: 'normal',
    };
    const repos = [...workspace.repos, repo];
    stateStore.write({
        ...state,
        gitWorkspaces: workspaces.map((candidate) => (candidate.cwd === cwd ? { cwd, repos } : candidate)),
    });
    return { repo, repos };
}
export function removeGitRepo(state, stateStore, repoId) {
    const cwd = requireActiveCwd(state);
    let repos = workspaceFor(state, cwd).repos;
    const gitWorkspaces = state.gitWorkspaces.map((workspace) => {
        if (workspace.cwd !== cwd)
            return workspace;
        repos = workspace.repos.filter((repo) => repo.id !== repoId);
        return { cwd, repos };
    });
    stateStore.write({ ...state, gitWorkspaces });
    return { repos };
}
export async function gitStatusForRepo(state, repoId) {
    const lookup = await revalidateRepo(state, repoId);
    const result = await runGit({
        args: [
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.untrackedCache=false',
            '-C',
            lookup.realRepoPath,
            'status',
            '--porcelain=v2',
            '-z',
            '--branch',
            `--untracked-files=${untrackedModeForRepo(lookup.repo)}`,
        ],
        timeoutMs: STATUS_TIMEOUT_MS,
        outputLimitBytes: STATUS_OUTPUT_LIMIT_BYTES,
        readOnly: true,
    });
    if (result.timedOut)
        throw new Error('git status timed out');
    if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || 'git status failed');
    const parsed = parseGitStatusPorcelainV2(result.stdout);
    return {
        repoId,
        path: lookup.repo.path,
        branch: parsed.branch,
        headOid: parsed.headOid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        entries: parsed.entries,
        refreshedAt: Date.now(),
        truncated: parsed.truncated || result.stdoutTruncated,
    };
}
export async function gitDiffForRepo(state, params) {
    const lookup = await revalidateRepo(state, params.repoId);
    const repoPath = normalizeRepoRelativePath(params.path);
    if (params.scope === 'untracked') {
        const target = path.resolve(lookup.repo.path, repoPath);
        const stats = await fs.lstat(target);
        if (!stats.isFile())
            throw new Error('untracked diff target must be a regular file');
        if (stats.size > GIT_DIFF_OUTPUT_LIMIT_BYTES)
            throw new Error('diff is too large');
        const opened = await openExistingFileInsideRoot(lookup.activeCwd, target);
        try {
            if (!opened.stats.isFile())
                throw new Error('untracked diff target must be a regular file');
            if (opened.stats.size > GIT_DIFF_OUTPUT_LIMIT_BYTES)
                throw new Error('diff is too large');
            const content = await readOpenedFileFully(opened.handle, opened.stats.size);
            const text = textFromBuffer(content);
            if (text === null)
                throw new Error('binary diff is not shown');
            return {
                repoId: params.repoId,
                path: repoPath,
                scope: 'untracked',
                patch: syntheticUntrackedPatch(repoPath, content),
                truncated: false,
                before: '',
                after: text,
            };
        }
        finally {
            await opened.handle.close().catch(() => undefined);
        }
    }
    const originalRepoPath = params.originalPath ? normalizeRepoRelativePath(params.originalPath) : null;
    const diffPaths = originalRepoPath ? [originalRepoPath, repoPath] : [repoPath];
    await assertExistingPathsInsideActive(lookup, diffPaths);
    const args = ['-C', lookup.realRepoPath, 'diff'];
    if (params.scope === 'staged')
        args.push('--cached');
    args.push('--no-ext-diff', '--no-textconv', '--', ...diffPaths.map(pathspecArg));
    const result = await runGit({
        args,
        timeoutMs: DIFF_TIMEOUT_MS,
        outputLimitBytes: GIT_DIFF_OUTPUT_LIMIT_BYTES,
        readOnly: true,
    });
    if (result.timedOut)
        throw new Error('git diff timed out');
    if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || 'git diff failed');
    const binary = isBinaryGitDiff(result.stdout);
    const snapshot = !binary && !result.stdoutTruncated ? await trackedDiffSnapshot(lookup, params.scope, repoPath, originalRepoPath) : null;
    return {
        repoId: params.repoId,
        path: repoPath,
        scope: params.scope,
        patch: binary ? '' : result.stdout,
        truncated: result.stdoutTruncated,
        binary,
        ...(snapshot ? { before: snapshot.before, after: snapshot.after } : {}),
    };
}
export async function gitStagePaths(state, params, latestState) {
    mutationAllowed(state);
    const lookup = await revalidateRepo(state, params.repoId);
    const { normalized, stdin } = validatePathList(params.paths);
    await assertExistingPathsInsideActive(lookup, normalized);
    await rejectDirectoryPaths(lookup.repo.path, normalized);
    mutationAllowedBeforeSpawn(state, lookup, latestState);
    const result = await runGit({
        args: ['--literal-pathspecs', '-C', lookup.realRepoPath, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        stdin,
        timeoutMs: MUTATION_TIMEOUT_MS,
        outputLimitBytes: COMMIT_OUTPUT_LIMIT_BYTES,
        beforeSpawn: () => mutationAllowedBeforeSpawn(state, lookup, latestState),
    });
    if (result.timedOut)
        throw new Error('git add timed out');
    if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || 'git add failed');
    return { ok: true };
}
export async function gitUnstagePaths(state, params, latestState) {
    mutationAllowed(state);
    const lookup = await revalidateRepo(state, params.repoId);
    const { normalized, stdin } = validatePathList(params.paths);
    await assertExistingPathsInsideActive(lookup, normalized);
    await rejectDirectoryPaths(lookup.repo.path, normalized);
    mutationAllowedBeforeSpawn(state, lookup, latestState);
    const hasHead = await repoHasHead(lookup.realRepoPath);
    mutationAllowedBeforeSpawn(state, lookup, latestState);
    const result = await runGit({
        args: hasHead
            ? ['--literal-pathspecs', '-C', lookup.realRepoPath, 'restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
            : ['--literal-pathspecs', '-C', lookup.realRepoPath, 'rm', '--cached', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
        stdin,
        timeoutMs: MUTATION_TIMEOUT_MS,
        outputLimitBytes: COMMIT_OUTPUT_LIMIT_BYTES,
        beforeSpawn: () => mutationAllowedBeforeSpawn(state, lookup, latestState),
    });
    if (result.timedOut)
        throw new Error('git unstage timed out');
    if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || 'git unstage failed');
    return { ok: true };
}
export async function gitCommit(state, params, latestState) {
    mutationAllowed(state);
    if (typeof params.message !== 'string' || params.message.trim().length === 0)
        throw new Error('commit message is required');
    if (Buffer.byteLength(params.message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
        throw new Error(`commit message is too large (max ${MAX_COMMIT_MESSAGE_BYTES} bytes)`);
    }
    const lookup = await revalidateRepo(state, params.repoId);
    mutationAllowedBeforeSpawn(state, lookup, latestState);
    const result = await runGit({
        args: ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', lookup.realRepoPath, 'commit', '--file=-'],
        stdin: params.message,
        timeoutMs: COMMIT_TIMEOUT_MS,
        outputLimitBytes: COMMIT_OUTPUT_LIMIT_BYTES,
        beforeSpawn: () => mutationAllowedBeforeSpawn(state, lookup, latestState),
    });
    const output = `${result.stdout}${result.stderr}`;
    if (result.timedOut)
        throw new Error('git commit timed out');
    if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || 'git commit failed');
    return { ok: true, commit: parseCommitHash(output), output };
}
