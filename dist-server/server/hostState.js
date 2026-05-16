import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
    const effort = optionalEnum(candidate.effort, REASONING_EFFORTS);
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
    if (options)
        message.options = options;
    return message;
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
    return {
        ...base,
        ...candidate,
        hostname,
        activeThreadPath: typeof candidate.activeThreadPath === 'string' && candidate.activeThreadPath.trim() ? candidate.activeThreadPath : null,
        model,
        effort: optionalEnum(candidate.effort, REASONING_EFFORTS) ?? null,
        mode: model ? (optionalEnum(candidate.mode, COLLABORATION_MODES) ?? null) : null,
        sandbox: optionalEnum(candidate.sandbox, SANDBOX_MODES) ?? null,
        queue: Array.isArray(candidate.queue)
            ? candidate.queue
                .map(sanitizeQueuedMessage)
                .filter((message) => Boolean(message))
                .slice(-maxQueueItems)
            : [],
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
        this.maxQueueItems = options.maxQueueItems ?? DEFAULT_MAX_QUEUE_ITEMS;
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
        fs.mkdirSync(this.stateDir, { recursive: true });
        const next = { ...state, hostname: this.hostname };
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, this.filePath);
    }
    update(fn) {
        const next = fn(this.read());
        this.write(next);
        return next;
    }
}
