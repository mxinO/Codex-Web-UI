import fs from 'node:fs';
import path from 'node:path';
import type { CodexRunOptions, HostRuntimeState, QueuedMessage } from './types.js';

interface HostStateStoreOptions {
  maxQueueItems?: number;
  maxRecentCwds?: number;
  maxStateFileBytes?: number;
}

const DEFAULT_MAX_QUEUE_ITEMS = 20;
const DEFAULT_MAX_RECENT_CWDS = 20;
const DEFAULT_MAX_STATE_FILE_BYTES = 256_000;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const COLLABORATION_MODES = new Set(['default', 'plan']);

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
    authTokenHash: null,
    appServerUrl: null,
    appServerPid: null,
    queue: [],
    recentCwds: [],
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

function sanitizeState(
  hostname: string,
  value: unknown,
  maxQueueItems: number,
  maxRecentCwds: number,
): HostRuntimeState {
  const base = defaultState(hostname);
  if (!value || typeof value !== 'object') return base;
  const candidate = value as Partial<HostRuntimeState>;

  return {
    ...base,
    ...candidate,
    hostname,
    activeThreadPath: typeof candidate.activeThreadPath === 'string' && candidate.activeThreadPath.trim() ? candidate.activeThreadPath : null,
    queue: Array.isArray(candidate.queue)
      ? candidate.queue
          .map(sanitizeQueuedMessage)
          .filter((message): message is QueuedMessage => Boolean(message))
          .slice(-maxQueueItems)
      : [],
    recentCwds: sanitizeStringArray(candidate.recentCwds, maxRecentCwds),
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
