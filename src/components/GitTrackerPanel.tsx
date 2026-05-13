import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, GitCommit, Plus, RefreshCw, Search, X } from 'lucide-react';
import FolderPickerModal from './FolderPickerModal';
import GitDiffModal from './GitDiffModal';
import type { GitDiffResult, GitStatusEntry, GitStatusResult, GitTrackedRepo } from '../../server/types';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

interface GitTrackerPanelProps {
  root: string;
  rpc: Rpc;
}

interface RepoListResult {
  cwd: string;
  repos: GitTrackedRepo[];
}

interface RepoStatusState {
  status: GitStatusResult | null;
  loading: boolean;
  error: string | null;
}

type StatusGroup = 'staged' | 'changes' | 'untracked';

interface ActionToken {
  generation: number;
  root: string;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function normalizeRepoList(result: unknown): RepoListResult {
  const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const cwd = typeof record.cwd === 'string' ? record.cwd : '';
  const repos = Array.isArray(record.repos) ? (record.repos.filter((repo) => typeof repo === 'object' && repo !== null) as GitTrackedRepo[]) : [];
  return { cwd, repos };
}

function groupEntries(status: GitStatusResult | null, group: StatusGroup): GitStatusEntry[] {
  const entries = status?.entries ?? [];
  if (group === 'staged') return entries.filter((entry) => entry.kind === 'staged');
  if (group === 'untracked') return entries.filter((entry) => entry.kind === 'untracked');
  return entries.filter((entry) => entry.kind === 'unstaged' || entry.kind === 'conflict');
}

function diffScopeForGroup(group: StatusGroup): GitDiffResult['scope'] {
  if (group === 'staged') return 'staged';
  if (group === 'untracked') return 'untracked';
  return 'unstaged';
}

function statusSummary(status: GitStatusResult | null): string {
  if (!status) return 'No status';
  const staged = groupEntries(status, 'staged').length;
  const changes = groupEntries(status, 'changes').length;
  const untracked = groupEntries(status, 'untracked').length;
  return `${staged} staged, ${changes} changed, ${untracked} untracked`;
}

export default function GitTrackerPanel({ root, rpc }: GitTrackerPanelProps) {
  const [repos, setRepos] = useState<GitTrackedRepo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RepoStatusState>>({});
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const generationRef = useRef(0);
  const rootRef = useRef(root);
  const refreshInFlightRef = useRef(new Map<string, Promise<void>>());
  const actionInFlightRef = useRef(new Set<string>());
  const refreshingAllRef = useRef(false);
  const addingRepoRef = useRef(false);

  rootRef.current = root;

  const currentToken = (): ActionToken => ({ generation: generationRef.current, root: rootRef.current });
  const isCurrentToken = (token: ActionToken) => token.generation === generationRef.current && token.root === rootRef.current;

  const beginAction = (key: string): boolean => {
    if (actionInFlightRef.current.has(key)) return false;
    actionInFlightRef.current.add(key);
    setBusyActions((current) => ({ ...current, [key]: true }));
    return true;
  };

  const endAction = (key: string) => {
    actionInFlightRef.current.delete(key);
    setBusyActions((current) => ({ ...current, [key]: false }));
  };

  const refreshRepo = useCallback(
    async (repoId: string, token = currentToken()) => {
      if (!isCurrentToken(token)) return;
      const inFlightKey = `${token.generation}:${repoId}`;
      const existing = refreshInFlightRef.current.get(inFlightKey);
      if (existing) return existing;

      const promise = (async () => {
        setStatuses((current) => ({
          ...current,
          [repoId]: { status: current[repoId]?.status ?? null, loading: true, error: null },
        }));
        try {
          const status = await rpc<GitStatusResult>('webui/git/status', { repoId });
          if (!isCurrentToken(token)) return;
          setStatuses((current) => ({ ...current, [repoId]: { status, loading: false, error: null } }));
        } catch (caught) {
          if (!isCurrentToken(token)) return;
          setStatuses((current) => ({
            ...current,
            [repoId]: { status: current[repoId]?.status ?? null, loading: false, error: errorMessage(caught) },
          }));
        } finally {
          refreshInFlightRef.current.delete(inFlightKey);
        }
      })();

      refreshInFlightRef.current.set(inFlightKey, promise);
      return promise;
    },
    [rpc],
  );

  const loadRepos = useCallback(async () => {
    const generation = (generationRef.current += 1);
    const token = { generation, root: rootRef.current };
    refreshInFlightRef.current.clear();
    actionInFlightRef.current.clear();
    refreshingAllRef.current = false;
    addingRepoRef.current = false;
    setRepos([]);
    setStatuses({});
    setCommitMessages({});
    setBusyActions({});
    setRefreshingAll(false);
    setAddingRepo(false);
    setDiff(null);
    setPickerOpen(false);
    setLoadingRepos(true);
    setRepoError(null);
    try {
      const result = normalizeRepoList(await rpc<unknown>('webui/git/repos/list'));
      if (!isCurrentToken(token)) return;
      if (result.cwd && result.cwd !== token.root) return;
      setRepos(result.repos);
      setStatuses((current) => {
        const next: Record<string, RepoStatusState> = {};
        for (const repo of result.repos) next[repo.id] = current[repo.id] ?? { status: null, loading: false, error: null };
        return next;
      });
      for (const repo of result.repos) {
        if (!isCurrentToken(token)) return;
        await refreshRepo(repo.id, token);
      }
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setRepoError(errorMessage(caught));
    } finally {
      if (isCurrentToken(token)) setLoadingRepos(false);
    }
  }, [refreshRepo, rpc]);

  const refreshAll = useCallback(async () => {
    if (refreshingAllRef.current) return;
    const token = currentToken();
    refreshingAllRef.current = true;
    setRefreshingAll(true);
    try {
      for (const repo of repos) {
        if (!isCurrentToken(token)) return;
        await refreshRepo(repo.id, token);
      }
    } finally {
      if (isCurrentToken(token)) {
        refreshingAllRef.current = false;
        setRefreshingAll(false);
      }
    }
  }, [refreshRepo, repos]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos, root]);

  const addRepo = async (path: string) => {
    if (addingRepoRef.current) return;
    const token = currentToken();
    addingRepoRef.current = true;
    setAddingRepo(true);
    setRepoError(null);
    try {
      const result = (await rpc<unknown>('webui/git/repos/add', { path })) as { repo?: GitTrackedRepo; repos?: GitTrackedRepo[] };
      if (!isCurrentToken(token)) return;
      const nextRepos = Array.isArray(result.repos) ? result.repos : result.repo ? [...repos, result.repo] : repos;
      setRepos(nextRepos);
      setPickerOpen(false);
      if (result.repo?.id) await refreshRepo(result.repo.id, token);
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setRepoError(errorMessage(caught));
    } finally {
      if (isCurrentToken(token)) {
        addingRepoRef.current = false;
        setAddingRepo(false);
      }
    }
  };

  const removeRepo = async (repoId: string) => {
    const token = currentToken();
    const key = `remove:${repoId}`;
    if (!beginAction(key)) return;
    try {
      const result = (await rpc<unknown>('webui/git/repos/remove', { repoId })) as { repos?: GitTrackedRepo[] };
      if (!isCurrentToken(token)) return;
      if (Array.isArray(result.repos)) setRepos(result.repos);
      setStatuses((current) => {
        const next = { ...current };
        delete next[repoId];
        return next;
      });
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setRepoError(errorMessage(caught));
    } finally {
      if (isCurrentToken(token)) endAction(key);
    }
  };

  const stageEntry = async (repoId: string, entry: GitStatusEntry) => {
    const token = currentToken();
    const key = `stage:${repoId}:${entry.path}`;
    if (!beginAction(key)) return;
    try {
      await rpc('webui/git/stage', { repoId, paths: [entry.path] });
      if (!isCurrentToken(token)) return;
      await refreshRepo(repoId, token);
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setStatuses((current) => ({
        ...current,
        [repoId]: { status: current[repoId]?.status ?? null, loading: false, error: errorMessage(caught) },
      }));
    } finally {
      if (isCurrentToken(token)) endAction(key);
    }
  };

  const unstageEntry = async (repoId: string, entry: GitStatusEntry) => {
    const token = currentToken();
    const key = `unstage:${repoId}:${entry.path}`;
    if (!beginAction(key)) return;
    try {
      await rpc('webui/git/unstage', { repoId, paths: [entry.path] });
      if (!isCurrentToken(token)) return;
      await refreshRepo(repoId, token);
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setStatuses((current) => ({
        ...current,
        [repoId]: { status: current[repoId]?.status ?? null, loading: false, error: errorMessage(caught) },
      }));
    } finally {
      if (isCurrentToken(token)) endAction(key);
    }
  };

  const openDiff = async (repoId: string, entry: GitStatusEntry, group: StatusGroup) => {
    const token = currentToken();
    const key = `diff:${repoId}:${entry.path}`;
    if (!beginAction(key)) return;
    try {
      const params = { repoId, path: entry.path, scope: diffScopeForGroup(group), ...(entry.originalPath ? { originalPath: entry.originalPath } : {}) };
      const result = await rpc<GitDiffResult>('webui/git/diff', params);
      if (!isCurrentToken(token)) return;
      setDiff(result);
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setStatuses((current) => ({
        ...current,
        [repoId]: { status: current[repoId]?.status ?? null, loading: false, error: errorMessage(caught) },
      }));
    } finally {
      if (isCurrentToken(token)) endAction(key);
    }
  };

  const commitRepo = async (repoId: string, repoLabel: string) => {
    const message = (commitMessages[repoId] ?? '').trim();
    if (!message) return;
    const token = currentToken();
    const key = `commit:${repoId}`;
    if (!beginAction(key)) return;
    try {
      await rpc('webui/git/commit', { repoId, message }, 65_000);
      if (!isCurrentToken(token)) return;
      setCommitMessages((current) => ({ ...current, [repoId]: '' }));
      await refreshRepo(repoId, token);
    } catch (caught) {
      if (!isCurrentToken(token)) return;
      setStatuses((current) => ({
        ...current,
        [repoId]: { status: current[repoId]?.status ?? null, loading: false, error: `${repoLabel}: ${errorMessage(caught)}` },
      }));
    } finally {
      if (isCurrentToken(token)) endAction(key);
    }
  };

  const updateCommitMessage = (repoId: string, event: ChangeEvent<HTMLInputElement>) => {
    setCommitMessages((current) => ({ ...current, [repoId]: event.target.value }));
  };

  const renderGroup = (repo: GitTrackedRepo, status: GitStatusResult | null, group: StatusGroup, label: string, ariaLabel: string) => {
    const entries = groupEntries(status, group);
    return (
      <section className="git-status-group" aria-label={ariaLabel}>
        <div className="git-status-group__heading">
          <span>{label}</span>
          <small>{entries.length}</small>
        </div>
        {entries.length === 0 ? (
          <div className="git-empty">No files</div>
        ) : (
          entries.map((entry) => {
            const isUntrackedDirectory = entry.kind === 'untracked' && entry.isDirectory === true;
            const actionDisabled = isUntrackedDirectory;
            const actionBusy = busyActions[`stage:${repo.id}:${entry.path}`] || busyActions[`unstage:${repo.id}:${entry.path}`];
            return (
              <div className="git-status-row" key={`${group}:${entry.path}:${entry.originalPath ?? ''}`}>
                <div className="git-status-row__path" title={entry.path}>
                  <span>{entry.path}</span>
                  {entry.originalPath && <small>{entry.originalPath}</small>}
                </div>
                <div className="git-status-row__actions">
                  {group === 'staged' ? (
                    <button
                      className="file-compact"
                      type="button"
                      onClick={() => void unstageEntry(repo.id, entry)}
                      disabled={actionBusy}
                      aria-label={`Unstage ${entry.path}`}
                      title="Unstage"
                    >
                      -
                    </button>
                  ) : (
                    <button
                      className="file-compact"
                      type="button"
                      onClick={() => void stageEntry(repo.id, entry)}
                      disabled={actionDisabled || actionBusy}
                      aria-label={`Stage ${entry.path}`}
                      title="Stage"
                    >
                      +
                    </button>
                  )}
                  <button
                    className="file-compact"
                    type="button"
                    onClick={() => void openDiff(repo.id, entry, group)}
                    disabled={actionDisabled || busyActions[`diff:${repo.id}:${entry.path}`]}
                    aria-label={`Diff ${entry.path}`}
                    title="Diff"
                  >
                    <Search size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>
    );
  };

  return (
    <div className="git-tracker-panel">
      <div className="git-tracker-toolbar">
        <div className="git-tracker-title">
          <GitBranch size={14} aria-hidden="true" />
          <span>Git</span>
        </div>
        <button className="file-action" type="button" onClick={() => setPickerOpen(true)} disabled={addingRepo} aria-label="Add Git repository" title="Add repo">
          <Plus size={14} aria-hidden="true" />
        </button>
        <button className="file-action" type="button" onClick={() => void addRepo(root)} disabled={addingRepo} aria-label="Add current workspace" title="Add current workspace">
          <GitBranch size={14} aria-hidden="true" />
        </button>
        <button className="file-action" type="button" onClick={() => void refreshAll()} disabled={loadingRepos || refreshingAll} aria-label="Refresh all Git repositories" title="Refresh all">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {repoError && <div className="file-error">{repoError}</div>}
      {loadingRepos && repos.length === 0 && <div className="file-empty">Loading repositories...</div>}
      <div className="git-repo-list">
        {repos.length === 0 && !loadingRepos ? <div className="git-empty">No tracked repositories</div> : null}
        {repos.map((repo) => {
          const statusState = statuses[repo.id] ?? { status: null, loading: false, error: null };
          const stagedCount = groupEntries(statusState.status, 'staged').length;
          const commitMessage = commitMessages[repo.id] ?? '';
          const canCommit = commitMessage.trim().length > 0 && stagedCount > 0 && !busyActions[`commit:${repo.id}`];

          return (
            <section className="git-repo" key={repo.id} aria-label={`Repository ${repo.label}`}>
              <div className="git-repo-header">
                <div className="git-repo-heading">
                  <strong title={repo.path}>{repo.label || basename(repo.path)}</strong>
                  <small>{statusSummary(statusState.status)}</small>
                </div>
                <div className="git-repo-actions">
                  <button className="file-compact" type="button" onClick={() => void refreshRepo(repo.id)} disabled={statusState.loading} aria-label={`Refresh ${repo.label}`} title="Refresh">
                    <RefreshCw size={13} aria-hidden="true" />
                  </button>
                  <button
                    className="file-compact"
                    type="button"
                    onClick={() => void removeRepo(repo.id)}
                    disabled={busyActions[`remove:${repo.id}`]}
                    aria-label={`Remove ${repo.label}`}
                    title="Remove"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="git-repo-meta">
                {statusState.status?.branch ?? 'detached'}
                {statusState.status?.upstream ? ` -> ${statusState.status.upstream}` : ''}
                {statusState.status && (statusState.status.ahead || statusState.status.behind) ? ` +${statusState.status.ahead ?? 0}/-${statusState.status.behind ?? 0}` : ''}
                {statusState.status?.truncated ? ' truncated' : ''}
              </div>
              {statusState.error && <div className="file-error">{statusState.error}</div>}
              {statusState.loading && <div className="git-empty">Refreshing...</div>}
              {renderGroup(repo, statusState.status, 'staged', 'Staged', 'Staged files')}
              {renderGroup(repo, statusState.status, 'changes', 'Changes', 'Changed files')}
              {renderGroup(repo, statusState.status, 'untracked', 'Untracked', 'Untracked files')}
              <div className="git-commit-row">
                <input value={commitMessage} onChange={(event) => updateCommitMessage(repo.id, event)} placeholder="Commit message" aria-label={`Commit message for ${repo.label}`} />
                <button
                  className="primary-button git-commit-button"
                  type="button"
                  onClick={() => void commitRepo(repo.id, repo.label)}
                  disabled={!canCommit}
                  aria-label={`Commit ${repo.label}`}
                >
                  <GitCommit size={13} aria-hidden="true" />
                  <span>Commit</span>
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <FolderPickerModal open={pickerOpen} root={root} rpc={rpc} selectDisabled={addingRepo} onClose={() => setPickerOpen(false)} onSelect={(path) => void addRepo(path)} />
      {diff && <GitDiffModal diff={diff} onClose={() => setDiff(null)} />}
    </div>
  );
}
