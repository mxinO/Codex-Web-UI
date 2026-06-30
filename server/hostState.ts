import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_QUEUE_LIMIT, normalizeQueueLimit } from './queue.js';
import type { CodexRunOptions, GitTrackedRepo, GitUntrackedMode, GitWorkspaceState, HostRuntimeState, QueuedMessage, ThreadGoal, ThreadGoalStatus } from './types.js';

interface HostStateStoreOptions {
  maxQueueItems?: number;
  maxRecentCwds?: number;
  maxStateFileBytes?: number;
}

const DEFAULT_MAX_RECENT_CWDS = 20;
const DEFAULT_MAX_STATE_FILE_BYTES = 256_000;
const MAX_GIT_WORKSPACES = 20;
const MAX_GIT_REPOS_PER_WORKSPACE = 20;
const MAX_PATH_LENGTH = 4096;
const MAX_LABEL_LENGTH = 256;
const MAX_REPO_ID_LENGTH = 256;
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const COLLABORATION_MODES = new Set(['default', 'plan']);
const GIT_UNTRACKED_MODES = new Set(['normal', 'all', 'no']);
const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

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
    activeGoal: null,
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

  const effort = sanitizeBoundedString(candidate.effort, 64);
  if (effort) next.effort = effort;

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
  const threadId = sanitizeBoundedString((value as Partial<QueuedMessage>).threadId, 256);
  const deliveryState = (value as Partial<QueuedMessage>).deliveryState;
  if (threadId) message.threadId = threadId;
  if (deliveryState === 'maybeSent') message.deliveryState = deliveryState;
  if (options) message.options = options;
  return message;
}

function limitQueue(queue: QueuedMessage[], limit: number): QueuedMessage[] {
  return queue.slice(-limit);
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

function sanitizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeGoal(value: unknown): ThreadGoal | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ThreadGoal>;
  const threadId = sanitizeBoundedString(candidate.threadId, 256);
  const objective = sanitizeBoundedString(candidate.objective, MAX_GOAL_OBJECTIVE_LENGTH);
  const status = optionalEnum(candidate.status, GOAL_STATUSES) as ThreadGoalStatus | undefined;
  const tokensUsed = sanitizeFiniteNumber(candidate.tokensUsed);
  const timeUsedSeconds = sanitizeFiniteNumber(candidate.timeUsedSeconds);
  const createdAt = sanitizeFiniteNumber(candidate.createdAt);
  const updatedAt = sanitizeFiniteNumber(candidate.updatedAt);
  if (!threadId || !objective || !status || tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null) return null;

  return {
    threadId,
    objective,
    status,
    tokenBudget: sanitizeFiniteNumber(candidate.tokenBudget),
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
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
  const activeThreadId = sanitizeBoundedString(candidate.activeThreadId, 256);
  const queue = Array.isArray(candidate.queue)
    ? limitQueue(
        candidate.queue
          .map(sanitizeQueuedMessage)
          .filter((message): message is QueuedMessage => Boolean(message))
          .map((message) => activeThreadId && !message.threadId ? { ...message, threadId: activeThreadId } : message),
        maxQueueItems,
      )
    : [];

  return {
    ...base,
    ...candidate,
    hostname,
    activeThreadId,
    activeThreadPath: typeof candidate.activeThreadPath === 'string' && candidate.activeThreadPath.trim() ? candidate.activeThreadPath : null,
    model,
    effort: sanitizeBoundedString(candidate.effort, 64),
    mode: model ? ((optionalEnum(candidate.mode, COLLABORATION_MODES) as HostRuntimeState['mode']) ?? null) : null,
    sandbox: (optionalEnum(candidate.sandbox, SANDBOX_MODES) as HostRuntimeState['sandbox']) ?? null,
    activeGoal: sanitizeGoal(candidate.activeGoal),
    queue,
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
    this.maxQueueItems = normalizeQueueLimit(options.maxQueueItems ?? DEFAULT_QUEUE_LIMIT);
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
    this.persist(sanitizeState(this.hostname, state, this.maxQueueItems, this.maxRecentCwds));
  }

  private persist(state: HostRuntimeState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const next = { ...state, hostname: this.hostname };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  update(fn: (state: HostRuntimeState) => HostRuntimeState): HostRuntimeState {
    const next = sanitizeState(this.hostname, fn(this.read()), this.maxQueueItems, this.maxRecentCwds);
    this.persist(next);
    return next;
  }
}
