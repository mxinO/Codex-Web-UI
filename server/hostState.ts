import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexRunOptions, GitTrackedRepo, GitUntrackedMode, GitWorkspaceState, HostRuntimeState, QueuedMessage } from './types.js';

interface HostStateStoreOptions {
  maxQueueItems?: number;
  maxRecentCwds?: number;
  maxStateFileBytes?: number;
}

const DEFAULT_MAX_QUEUE_ITEMS = 20;
const DEFAULT_MAX_RECENT_CWDS = 20;
const DEFAULT_MAX_STATE_FILE_BYTES = 256_000;
const MAX_GIT_WORKSPACES = 20;
const MAX_GIT_REPOS_PER_WORKSPACE = 20;
const MAX_PATH_LENGTH = 4096;
const MAX_LABEL_LENGTH = 256;
const MAX_REPO_ID_LENGTH = 256;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const COLLABORATION_MODES = new Set(['default', 'plan']);
const GIT_UNTRACKED_MODES = new Set(['normal', 'all', 'no']);

function safeHost(hostname: string): string {
  return hostname.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function defaultState(hostname: string): HostRuntimeState {
  return {
    hostname,
    activeThreadId: null,
    activeThreadPath: null,
    activeTurnId: null,
    activeCwd: null,
    model: null,
    effort: null,
    mode: null,
    sandbox: null,
    authTokenHash: null,
    appServerUrl: null,
    appServerPid: null,
    queue: [],
    recentCwds: [],
    gitWorkspaces: [],
    theme: 'dark',
  };
}

function optionalEnum(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function sanitizeRunOptions(value: unknown): CodexRunOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CodexRunOptions>;
  const next: CodexRunOptions = {};

  if (typeof candidate.model === 'string' && candidate.model.trim()) next.model = candidate.model.trim();

  const effort = optionalEnum(candidate.effort, REASONING_EFFORTS);
  if (effort) next.effort = effort as CodexRunOptions['effort'];

  const mode = optionalEnum(candidate.mode, COLLABORATION_MODES);
  if (mode && next.model) next.mode = mode as CodexRunOptions['mode'];

  const sandbox = optionalEnum(candidate.sandbox, SANDBOX_MODES);
  if (sandbox) next.sandbox = sandbox as CodexRunOptions['sandbox'];

  return Object.keys(next).length > 0 ? next : undefined;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<QueuedMessage>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
}

function sanitizeQueuedMessage(value: unknown): QueuedMessage | null {
  if (!isQueuedMessage(value)) return null;
  const options = sanitizeRunOptions((value as Partial<QueuedMessage>).options);
  const message: QueuedMessage = { id: value.id, text: value.text, createdAt: value.createdAt };
  if (options) message.options = options;
  return message;
}

function sanitizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(-limit);
}

function sanitizeBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed ? trimmed : null;
}

function repoIdForPath(repoPath: string): string {
  return `repo:${createHash('sha1').update(repoPath).digest('hex')}`;
}

function sanitizeGitRepo(value: unknown): GitTrackedRepo | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<GitTrackedRepo>;
  const repoPath = sanitizeBoundedString(candidate.path, MAX_PATH_LENGTH);
  const label = sanitizeBoundedString(candidate.label, MAX_LABEL_LENGTH);
  if (!repoPath || !label || typeof candidate.addedAt !== 'number' || !Number.isFinite(candidate.addedAt)) {
    return null;
  }

  const id = sanitizeBoundedString(candidate.id, MAX_REPO_ID_LENGTH) ?? repoIdForPath(repoPath);
  const repo: GitTrackedRepo = {
    id,
    path: repoPath,
    label,
    addedAt: candidate.addedAt,
  };

  const untrackedMode = optionalEnum(candidate.untrackedMode, GIT_UNTRACKED_MODES);
  if (untrackedMode) repo.untrackedMode = untrackedMode as GitUntrackedMode;

  return repo;
}

function sanitizeGitWorkspaces(value: unknown): GitWorkspaceState[] {
  if (!Array.isArray(value)) return [];

  const workspaces: GitWorkspaceState[] = [];
  for (const item of value) {
    if (workspaces.length >= MAX_GIT_WORKSPACES) break;
    if (!item || typeof item !== 'object') continue;

    const candidate = item as Partial<GitWorkspaceState>;
    const cwd = sanitizeBoundedString(candidate.cwd, MAX_PATH_LENGTH);
    if (!cwd || !Array.isArray(candidate.repos)) continue;

    const repos = candidate.repos
      .map(sanitizeGitRepo)
      .filter((repo): repo is GitTrackedRepo => Boolean(repo))
      .slice(0, MAX_GIT_REPOS_PER_WORKSPACE);

    workspaces.push({ cwd, repos });
  }

  return workspaces;
}

function sanitizeState(
  hostname: string,
  value: unknown,
  maxQueueItems: number,
  maxRecentCwds: number,
): HostRuntimeState {
  const base = defaultState(hostname);
  if (!value || typeof value !== 'object') return base;
  const candidate = value as Partial<HostRuntimeState>;
  const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : null;

  return {
    ...base,
    ...candidate,
    hostname,
    activeThreadPath: typeof candidate.activeThreadPath === 'string' && candidate.activeThreadPath.trim() ? candidate.activeThreadPath : null,
    model,
    effort: (optionalEnum(candidate.effort, REASONING_EFFORTS) as HostRuntimeState['effort']) ?? null,
    mode: model ? ((optionalEnum(candidate.mode, COLLABORATION_MODES) as HostRuntimeState['mode']) ?? null) : null,
    sandbox: (optionalEnum(candidate.sandbox, SANDBOX_MODES) as HostRuntimeState['sandbox']) ?? null,
    queue: Array.isArray(candidate.queue)
      ? candidate.queue
          .map(sanitizeQueuedMessage)
          .filter((message): message is QueuedMessage => Boolean(message))
          .slice(-maxQueueItems)
      : [],
    recentCwds: sanitizeStringArray(candidate.recentCwds, maxRecentCwds),
    gitWorkspaces: sanitizeGitWorkspaces(candidate.gitWorkspaces),
  };
}

export class HostStateStore {
  private readonly filePath: string;
  private readonly maxQueueItems: number;
  private readonly maxRecentCwds: number;
  private readonly maxStateFileBytes: number;

  constructor(
    private readonly stateDir: string,
    private readonly hostname: string,
    options: HostStateStoreOptions = {},
  ) {
    this.filePath = path.join(stateDir, `${safeHost(hostname)}.runtime.json`);
    this.maxQueueItems = options.maxQueueItems ?? DEFAULT_MAX_QUEUE_ITEMS;
    this.maxRecentCwds = options.maxRecentCwds ?? DEFAULT_MAX_RECENT_CWDS;
    this.maxStateFileBytes = options.maxStateFileBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
  }

  read(): HostRuntimeState {
    try {
      if (fs.statSync(this.filePath).size > this.maxStateFileBytes) {
        return defaultState(this.hostname);
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return sanitizeState(this.hostname, JSON.parse(raw), this.maxQueueItems, this.maxRecentCwds);
    } catch {
      return defaultState(this.hostname);
    }
  }

  write(state: HostRuntimeState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const next = { ...state, hostname: this.hostname };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  update(fn: (state: HostRuntimeState) => HostRuntimeState): HostRuntimeState {
    const next = fn(this.read());
    this.write(next);
    return next;
  }
}
