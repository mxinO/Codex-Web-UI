import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_QUEUE_LIMIT, normalizeQueueLimit } from './queue.js';
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
function safeHost(hostname) {
    return hostname.replace(/[^A-Za-z0-9_.-]/g, '_');
}
function defaultState(hostname) {
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
function optionalEnum(value, allowed) {
    return typeof value === 'string' && allowed.has(value) ? value : undefined;
}
function sanitizeRunOptions(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const candidate = value;
    const next = {};
    if (typeof candidate.model === 'string' && candidate.model.trim())
        next.model = candidate.model.trim();
    const effort = sanitizeBoundedString(candidate.effort, 64);
    if (effort)
        next.effort = effort;
    const mode = optionalEnum(candidate.mode, COLLABORATION_MODES);
    if (mode && next.model)
        next.mode = mode;
    const sandbox = optionalEnum(candidate.sandbox, SANDBOX_MODES);
    if (sandbox)
        next.sandbox = sandbox;
    return Object.keys(next).length > 0 ? next : undefined;
}
function isQueuedMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.id === 'string' &&
        typeof candidate.text === 'string' &&
        typeof candidate.createdAt === 'number' &&
        Number.isFinite(candidate.createdAt));
}
function sanitizeQueuedMessage(value) {
    if (!isQueuedMessage(value))
        return null;
    const options = sanitizeRunOptions(value.options);
    const message = { id: value.id, text: value.text, createdAt: value.createdAt };
    const threadId = sanitizeBoundedString(value.threadId, 256);
    const deliveryState = value.deliveryState;
    if (threadId)
        message.threadId = threadId;
    if (deliveryState === 'maybeSent')
        message.deliveryState = deliveryState;
    if (options)
        message.options = options;
    return message;
}
function limitQueue(queue, limit) {
    return queue.slice(-limit);
}
function sanitizeStringArray(value, limit) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string').slice(-limit);
}
function sanitizeBoundedString(value, maxLength) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim().slice(0, maxLength);
    return trimmed ? trimmed : null;
}
function sanitizeFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function sanitizeGoal(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const threadId = sanitizeBoundedString(candidate.threadId, 256);
    const objective = sanitizeBoundedString(candidate.objective, MAX_GOAL_OBJECTIVE_LENGTH);
    const status = optionalEnum(candidate.status, GOAL_STATUSES);
    const tokensUsed = sanitizeFiniteNumber(candidate.tokensUsed);
    const timeUsedSeconds = sanitizeFiniteNumber(candidate.timeUsedSeconds);
    const createdAt = sanitizeFiniteNumber(candidate.createdAt);
    const updatedAt = sanitizeFiniteNumber(candidate.updatedAt);
    if (!threadId || !objective || !status || tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null)
        return null;
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
function repoIdForPath(repoPath) {
    return `repo:${createHash('sha1').update(repoPath).digest('hex')}`;
}
function sanitizeGitRepo(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const repoPath = sanitizeBoundedString(candidate.path, MAX_PATH_LENGTH);
    const label = sanitizeBoundedString(candidate.label, MAX_LABEL_LENGTH);
    if (!repoPath || !label || typeof candidate.addedAt !== 'number' || !Number.isFinite(candidate.addedAt)) {
        return null;
    }
    const id = sanitizeBoundedString(candidate.id, MAX_REPO_ID_LENGTH) ?? repoIdForPath(repoPath);
    const repo = {
        id,
        path: repoPath,
        label,
        addedAt: candidate.addedAt,
    };
    const untrackedMode = optionalEnum(candidate.untrackedMode, GIT_UNTRACKED_MODES);
    if (untrackedMode)
        repo.untrackedMode = untrackedMode;
    return repo;
}
function sanitizeGitWorkspaces(value) {
    if (!Array.isArray(value))
        return [];
    const workspaces = [];
    for (const item of value) {
        if (workspaces.length >= MAX_GIT_WORKSPACES)
            break;
        if (!item || typeof item !== 'object')
            continue;
        const candidate = item;
        const cwd = sanitizeBoundedString(candidate.cwd, MAX_PATH_LENGTH);
        if (!cwd || !Array.isArray(candidate.repos))
            continue;
        const repos = candidate.repos
            .map(sanitizeGitRepo)
            .filter((repo) => Boolean(repo))
            .slice(0, MAX_GIT_REPOS_PER_WORKSPACE);
        workspaces.push({ cwd, repos });
    }
    return workspaces;
}
function sanitizeState(hostname, value, maxQueueItems, maxRecentCwds) {
    const base = defaultState(hostname);
    if (!value || typeof value !== 'object')
        return base;
    const candidate = value;
    const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : null;
    const activeThreadId = sanitizeBoundedString(candidate.activeThreadId, 256);
    const queue = Array.isArray(candidate.queue)
        ? limitQueue(candidate.queue
            .map(sanitizeQueuedMessage)
            .filter((message) => Boolean(message))
            .map((message) => activeThreadId && !message.threadId ? { ...message, threadId: activeThreadId } : message), maxQueueItems)
        : [];
    return {
        ...base,
        ...candidate,
        hostname,
        activeThreadId,
        activeThreadPath: typeof candidate.activeThreadPath === 'string' && candidate.activeThreadPath.trim() ? candidate.activeThreadPath : null,
        model,
        effort: sanitizeBoundedString(candidate.effort, 64),
        mode: model ? (optionalEnum(candidate.mode, COLLABORATION_MODES) ?? null) : null,
        sandbox: optionalEnum(candidate.sandbox, SANDBOX_MODES) ?? null,
        activeGoal: sanitizeGoal(candidate.activeGoal),
        queue,
        recentCwds: sanitizeStringArray(candidate.recentCwds, maxRecentCwds),
        gitWorkspaces: sanitizeGitWorkspaces(candidate.gitWorkspaces),
    };
}
export class HostStateStore {
    stateDir;
    hostname;
    filePath;
    maxQueueItems;
    maxRecentCwds;
    maxStateFileBytes;
    constructor(stateDir, hostname, options = {}) {
        this.stateDir = stateDir;
        this.hostname = hostname;
        this.filePath = path.join(stateDir, `${safeHost(hostname)}.runtime.json`);
        this.maxQueueItems = normalizeQueueLimit(options.maxQueueItems ?? DEFAULT_QUEUE_LIMIT);
        this.maxRecentCwds = options.maxRecentCwds ?? DEFAULT_MAX_RECENT_CWDS;
        this.maxStateFileBytes = options.maxStateFileBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
    }
    read() {
        try {
            if (fs.statSync(this.filePath).size > this.maxStateFileBytes) {
                return defaultState(this.hostname);
            }
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return sanitizeState(this.hostname, JSON.parse(raw), this.maxQueueItems, this.maxRecentCwds);
        }
        catch {
            return defaultState(this.hostname);
        }
    }
    write(state) {
        this.persist(sanitizeState(this.hostname, state, this.maxQueueItems, this.maxRecentCwds));
    }
    persist(state) {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const next = { ...state, hostname: this.hostname };
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, this.filePath);
    }
    update(fn) {
        const next = sanitizeState(this.hostname, fn(this.read()), this.maxQueueItems, this.maxRecentCwds);
        this.persist(next);
        return next;
    }
}
