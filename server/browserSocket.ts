import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type http from 'node:http';
import nodePath from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { authScopeFromHostHeader, isTokenValid, parseTokenFromCookieScopes } from './auth.js';
import type { CodexAppServer } from './appServer.js';
import { isInteractiveCommandBlocked, runBangCommand } from './bangCommand.js';
import type { ServerConfig } from './config.js';
import { FileEditStore, sessionFileEditDbPath } from './fileEditStore.js';
import {
  addGitRepo,
  gitCommit,
  gitDiffForRepo,
  gitStagePaths,
  gitStatusForRepo,
  gitUnstagePaths,
  listGitRepos,
  removeGitRepo,
} from './gitTracker.js';
import {
  assertPathInsideRoot,
  openExistingFileInsideRoot,
  readOpenedFileFully,
  resolveExistingPathInsideRoot,
  resolveWritablePathInsideRoot,
  writeFileInsideRoot,
} from './fileTransfer.js';
import type { HostStateStore } from './hostState.js';
import type { JsonRpcServerRequest } from './jsonRpc.js';
import { logInfo, logWarn } from './logger.js';
import {
  enqueueMessage,
  normalizeQueueLimit,
  prependQueuedMessagesForThread,
  queueForThread,
  removeQueuedMessage,
  shiftQueuedMessage,
  updateQueuedMessage,
} from './queue.js';
import { readLatestTurnRuntimeContext, type TurnRuntimeContextLookup } from './turnRuntimeStatus.js';
import type {
  CodexCollaborationMode,
  CodexRunOptions,
  CodexSandboxMode,
  GitDiffResult,
  HostRuntimeState,
  ModelCapacityRetry,
  QueuedMessage,
  RuntimeSettingsConfirmation,
  ThreadGoal,
  ThreadGoalStatus,
} from './types.js';

interface BrowserSocketDeps {
  config: ServerConfig;
  codex: CodexAppServer;
  stateStore: HostStateStore;
  token: string;
  authCookieScope?: string;
  startCwd?: string;
  modelCapacityRetryDelayMs?: number;
  modelCapacityReconcileDelayMs?: number;
  browserHeartbeatIntervalMs?: number;
}

interface BrowserRequest {
  id?: unknown;
  type?: unknown;
  method?: unknown;
  params?: unknown;
}

interface SessionStartParams {
  cwd: string;
}

interface SessionResumeParams {
  threadId: string;
}

interface TurnStartParams {
  threadId: string;
  text: string;
  options?: CodexRunOptions;
  clientUserMessageId?: string;
}

interface RuntimeSettingsNotification {
  threadId: string;
  model: string;
  effort: string | null;
}

interface RuntimeSettingsUpdateWaiter {
  threadId: string;
  model: string | undefined;
  effort: string | null | undefined;
  generation: number;
  promise: Promise<{ confirmed: true } | { confirmed: false; error: Error }>;
  resolve: (result: { confirmed: true } | { confirmed: false; error: Error }) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface QueuedTurnClaim {
  threadId: string;
  queuedMessage: QueuedMessage;
}

interface QueuedSteerClaim extends QueuedTurnClaim {
  turnId: string;
}

interface QueuedSteerInFlight extends QueuedSteerClaim {
  terminalDisposition: TerminalDisposition | null;
  settled: boolean;
  timedOut: boolean;
}

export interface BrowserSocketCleanup {
  close(): void;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function parseBrowserRequest(raw: Buffer | ArrayBuffer | Buffer[]): BrowserRequest | null {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as BrowserRequest) : null;
  } catch {
    return null;
  }
}

function authScopesForRequest(hostHeader: string | undefined, fallbackScope?: string): string[] {
  const requestScope = authScopeFromHostHeader(hostHeader, fallbackScope) ?? fallbackScope;
  if (!requestScope) return [];
  if (!fallbackScope || requestScope === fallbackScope) return [requestScope];
  return [requestScope, fallbackScope];
}

function authorized(
  deps: BrowserSocketDeps,
  queryToken: string | null,
  cookieHeader: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (deps.config.noAuth) return true;
  return (
    isTokenValid(deps.token, queryToken) ||
    isTokenValid(deps.token, parseTokenFromCookieScopes(cookieHeader, authScopesForRequest(hostHeader, deps.authCookieScope)))
  );
}

function closeClient(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING) {
    ws.terminate();
    return;
  }
  ws.close(1001, 'server shutting down');
  ws.terminate();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function getRequiredString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  const value = params[key].trim();
  return value.length > 0 ? value : null;
}

function getString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  return params[key];
}

function getRequiredRawString(params: unknown, key: string): string | null {
  if (!isRecord(params) || typeof params[key] !== 'string') return null;
  return params[key].length > 0 ? params[key] : null;
}

function getOptionalRawString(params: unknown, key: string): string | undefined {
  if (!isRecord(params) || !hasOwn(params, key)) return undefined;
  const value = params[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function getRequiredStringArray(params: unknown, key: string): string[] | null {
  if (!isRecord(params) || !Array.isArray(params[key])) return null;
  const values = params[key];
  return values.every((value) => typeof value === 'string') ? values : null;
}

const SANDBOX_MODES = new Set<CodexSandboxMode>(['read-only', 'workspace-write', 'danger-full-access']);
const COLLABORATION_MODES = new Set<CodexCollaborationMode>(['default', 'plan']);
const GOAL_STATUSES = new Set<ThreadGoalStatus>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const TURN_ITEMS_VIEWS = new Set(['notLoaded', 'summary', 'full'] as const);
const GIT_DIFF_SCOPES = new Set<GitDiffResult['scope']>(['staged', 'unstaged', 'untracked']);
const BROWSE_DIRECTORY_LIMIT = 500;
export const LEGACY_READ_FILE_MAX_BYTES = 5 * 1024 * 1024;
const FILE_DIFF_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const FILE_DIFF_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const FILE_DIFF_SNAPSHOT_MAX_ENTRIES = 50;
const FILE_DIFF_PATCH_MAX_PATCHES_PER_FILE = 100;
const FILE_DIFF_PATCH_MAX_BYTES_PER_FILE = FILE_DIFF_SNAPSHOT_MAX_BYTES;
const FILE_DIFF_PATCH_MAX_PENDING_NOTIFICATIONS = 100;
const FILE_DIFF_PATCH_MAX_INCOMPLETE_TURNS = 200;
const COMPACTION_PENDING_TURN_PREFIX = 'compact-pending:';
const TURN_START_PENDING_TURN_PREFIX = 'turn-start-pending:';
const THREAD_TURNS_LIST_RPC_TIMEOUT_MS = 2 * 60 * 1000;
const UNSCOPED_TERMINAL_VERIFY_RPC_TIMEOUT_MS = 10 * 1000;
const TURN_START_RPC_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_STEER_RPC_TIMEOUT_MS = 10 * 60 * 1000;
const RECENT_NOTIFICATION_MAX_ENTRIES = 500;
const RECENT_NOTIFICATION_MAX_BYTES = 2 * 1024 * 1024;
const RECENT_NOTIFICATION_SINGLE_MAX_BYTES = 256 * 1024;
const UNFORWARDED_BROWSER_NOTIFICATION_METHODS = new Set([
  'command/exec/outputDelta',
  'process/outputDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
]);
const RUNTIME_SETTINGS_CONFIRMATION_TIMEOUT_MS = 2_000;
const MODEL_CAPACITY_ERROR_MESSAGE = 'Selected model is at capacity. Please try a different model.';
const MODEL_CAPACITY_RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 300_000];
const MODEL_CAPACITY_RECONCILE_DELAY_MS = 30_000;
const MODEL_CAPACITY_RETRY_PROMPT = 'The previous turn was aborted. Carefully resume the work.';
const MODEL_CAPACITY_RECONCILE_PAGE_LIMIT = 100;
const MODEL_CAPACITY_RECONCILE_MAX_PAGES = 20;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const BROWSER_HEARTBEAT_INTERVAL_MS = 15_000;

function getOptionalString(params: unknown, key: string): string | null {
  if (!isRecord(params) || !hasOwn(params, key)) return null;
  const value = params[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getOptionalEnum<T extends string>(params: unknown, key: string, allowed: Set<T>): T | undefined {
  const value = getOptionalString(params, key);
  if (!value) return undefined;
  if (!allowed.has(value as T)) throw new Error(`unsupported ${key}: ${value}`);
  return value as T;
}

function runOptionsFromParams(params: unknown): CodexRunOptions | undefined {
  const source = isRecord(params) && isRecord(params.options) ? params.options : params;
  if (!isRecord(source)) return undefined;

  const options: CodexRunOptions = {};
  const model = getOptionalString(source, 'model');
  if (model) options.model = model;

  const effort = getOptionalString(source, 'effort');
  if (effort) {
    if (effort.length > 64) throw new Error('effort must be at most 64 characters');
    options.effort = effort;
  }

  const mode = getOptionalEnum(source, 'mode', COLLABORATION_MODES);
  if (mode && options.model) options.mode = mode;

  const sandbox = getOptionalEnum(source, 'sandbox', SANDBOX_MODES);
  if (sandbox) options.sandbox = sandbox;

  return Object.keys(options).length > 0 ? options : undefined;
}

function collaborationMode(options: CodexRunOptions): unknown | null {
  if (!options.mode) return null;
  if (!options.model) return null;
  return {
    mode: options.mode,
    settings: {
      model: options.model,
      reasoning_effort: options.effort ?? null,
      developer_instructions: null,
    },
  };
}

function applyThreadRunOptions<T extends Record<string, unknown>>(params: T, options?: CodexRunOptions): T {
  if (!options) return params;
  const next = params as Record<string, unknown>;
  if (options.model) next.model = options.model;
  if (options.sandbox) next.sandbox = options.sandbox;
  if (options.effort) {
    const existingConfig = isRecord(next.config) ? next.config : {};
    next.config = { ...existingConfig, model_reasoning_effort: options.effort };
  }
  return params;
}

function sandboxPolicy(mode: CodexSandboxMode, cwd: string | null): unknown {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: false,
    };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: cwd ? [cwd] : [],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function applyTurnRunOptions<T extends Record<string, unknown>>(params: T, options: CodexRunOptions | undefined, cwd: string | null): T {
  if (!options) return params;
  const next = params as Record<string, unknown>;
  if (options.model) next.model = options.model;
  if (options.effort) next.effort = options.effort;
  if (options.sandbox) next.sandboxPolicy = sandboxPolicy(options.sandbox, cwd);
  const mode = collaborationMode(options);
  if (mode) next.collaborationMode = mode;
  return params;
}

function getStringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function getValuePath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | null {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : null;
}

function sandboxModeFromPolicy(value: unknown): CodexSandboxMode | null {
  const type = getStringPath(value, ['type']);
  if (type === 'dangerFullAccess') return 'danger-full-access';
  if (type === 'readOnly') return 'read-only';
  if (type === 'workspaceWrite') return 'workspace-write';
  return enumValue(value, SANDBOX_MODES);
}

function runtimeStatusFromThreadResult(result: unknown, fallback?: CodexRunOptions): Pick<HostRuntimeState, 'model' | 'effort' | 'mode' | 'sandbox'> {
  const model = getStringPath(result, ['model']) ?? getStringPath(result, ['data', 'model']) ?? fallback?.model ?? null;
  const effortValue =
    getStringPath(result, ['reasoningEffort']) ??
    getStringPath(result, ['reasoning_effort']) ??
    getStringPath(result, ['effort']);
  const effort = effortValue && effortValue.length <= 64 ? effortValue : fallback?.effort ?? null;
  const sandbox =
    sandboxModeFromPolicy(getValuePath(result, ['sandbox'])) ??
    sandboxModeFromPolicy(getValuePath(result, ['data', 'sandbox'])) ??
    fallback?.sandbox ??
    null;
  return {
    model,
    effort,
    mode: fallback?.mode ?? null,
    sandbox,
  };
}

function runtimeSettingsFromNotification(message: { method?: unknown; params?: unknown }): RuntimeSettingsNotification | null {
  if (message.method !== 'thread/settings/updated' || !isRecord(message.params)) return null;
  const threadId = getStringPath(message.params, ['threadId']);
  const threadSettings = getValuePath(message.params, ['threadSettings']);
  if (!threadId || !isRecord(threadSettings)) return null;

  const model = getStringPath(threadSettings, ['model']);
  if (!model || !hasOwn(threadSettings, 'effort')) return null;
  const rawEffort = threadSettings.effort;
  if (rawEffort !== null && typeof rawEffort !== 'string') return null;
  const effort = typeof rawEffort === 'string' ? rawEffort.trim() : null;
  if ((typeof rawEffort === 'string' && !effort) || (effort && effort.length > 64)) return null;

  return { threadId, model, effort };
}

function applyRunOptionsToRuntimeState(state: HostRuntimeState, options?: CodexRunOptions): HostRuntimeState {
  if (!options) return state;
  return {
    ...state,
    model: options.model ?? state.model,
    effort: options.effort ?? state.effort,
    mode: options.mode ?? state.mode,
    sandbox: options.sandbox ?? state.sandbox,
  };
}

function runOptionsFromRuntimeState(state: HostRuntimeState): CodexRunOptions | undefined {
  const options: CodexRunOptions = {};
  if (state.model) options.model = state.model;
  if (state.effort) options.effort = state.effort;
  if (state.sandbox) options.sandbox = state.sandbox;
  if (state.mode && state.model) options.mode = state.mode;
  return Object.keys(options).length > 0 ? options : undefined;
}

function modelCapacityRetryDelayMs(attempt: number, override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  return MODEL_CAPACITY_RETRY_DELAYS_MS[Math.min(Math.max(1, attempt), MODEL_CAPACITY_RETRY_DELAYS_MS.length) - 1];
}

function turnErrorValue(message: { params?: unknown }): unknown {
  return getValuePath(message.params, ['turn', 'error']);
}

function isModelCapacityError(value: unknown): boolean {
  return (
    getStringPath(value, ['codexErrorInfo']) === 'serverOverloaded' ||
    getStringPath(value, ['codex_error_info']) === 'serverOverloaded' ||
    getStringPath(value, ['message']) === MODEL_CAPACITY_ERROR_MESSAGE
  );
}

function isFailedModelCapacityCompletion(message: { method?: unknown; params?: unknown }): boolean {
  return (
    message.method === 'turn/completed' &&
    getStringPath(message.params, ['turn', 'status']) === 'failed' &&
    isModelCapacityError(turnErrorValue(message))
  );
}

function isTerminalModelCapacityErrorNotification(message: { method?: unknown; params?: unknown }): boolean {
  return (
    message.method === 'error' &&
    getValuePath(message.params, ['willRetry']) === false &&
    isModelCapacityError(getValuePath(message.params, ['error']))
  );
}

function turnUserMessageClientId(turn: unknown): string | null {
  const items = getValuePath(turn, ['items']);
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (getStringPath(item, ['type']) !== 'userMessage') continue;
    return getStringPath(item, ['clientId']) ?? getStringPath(item, ['client_id']);
  }
  return null;
}

function notificationPayload(message: { params?: unknown; payload?: unknown }): unknown {
  if (isRecord(message.params) && isRecord(message.params.payload)) return message.params.payload;
  if (isRecord(message.payload)) return message.payload;
  if (isRecord(message.params)) return message.params;
  return null;
}

function notificationThreadId(message: { params?: unknown; payload?: unknown }): string | null {
  const payload = notificationPayload(message);
  return (
    getStringPath(message.params, ['threadId']) ??
    getStringPath(message.params, ['thread_id']) ??
    getStringPath(message.params, ['thread', 'id']) ??
    getStringPath(message.params, ['thread', 'threadId']) ??
    getStringPath(message.params, ['thread', 'thread_id']) ??
    getStringPath(message.params, ['turn', 'threadId']) ??
    getStringPath(message.params, ['turn', 'thread_id']) ??
    getStringPath(message.params, ['turn', 'thread', 'id']) ??
    getStringPath(payload, ['threadId']) ??
    getStringPath(payload, ['thread_id']) ??
    getStringPath(payload, ['thread', 'id']) ??
    getStringPath(payload, ['turn', 'threadId']) ??
    getStringPath(payload, ['turn', 'thread_id'])
  );
}

function notificationTurnId(message: { params?: unknown; payload?: unknown }): string | null {
  const payload = notificationPayload(message);
  return (
    getStringPath(message.params, ['turnId']) ??
    getStringPath(message.params, ['turn_id']) ??
    getStringPath(message.params, ['turn', 'id']) ??
    getStringPath(payload, ['turnId']) ??
    getStringPath(payload, ['turn_id']) ??
    getStringPath(payload, ['turn', 'id'])
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function threadGoalFromValue(value: unknown): ThreadGoal | null {
  if (!isRecord(value)) return null;
  const threadId = getStringPath(value, ['threadId']) ?? getStringPath(value, ['thread_id']);
  const objective = getStringPath(value, ['objective']);
  const status = enumValue(getValuePath(value, ['status']), GOAL_STATUSES);
  const tokensUsed = finiteNumber(getValuePath(value, ['tokensUsed'])) ?? finiteNumber(getValuePath(value, ['tokens_used']));
  const timeUsedSeconds = finiteNumber(getValuePath(value, ['timeUsedSeconds'])) ?? finiteNumber(getValuePath(value, ['time_used_seconds']));
  const createdAt = finiteNumber(getValuePath(value, ['createdAt'])) ?? finiteNumber(getValuePath(value, ['created_at']));
  const updatedAt = finiteNumber(getValuePath(value, ['updatedAt'])) ?? finiteNumber(getValuePath(value, ['updated_at']));
  if (!threadId || !objective || !status || tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null) {
    return null;
  }

  const tokenBudget =
    optionalFiniteNumber(getValuePath(value, ['tokenBudget'])) ?? optionalFiniteNumber(getValuePath(value, ['token_budget']));

  return {
    threadId,
    objective: objective.slice(0, 4000),
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function threadGoalFromResult(result: unknown): ThreadGoal | null {
  return threadGoalFromValue(getValuePath(result, ['goal'])) ?? threadGoalFromValue(getValuePath(result, ['data', 'goal'])) ?? threadGoalFromValue(result);
}

function threadGoalFromNotification(message: { params?: unknown; payload?: unknown }): ThreadGoal | null {
  const payload = notificationPayload(message);
  return threadGoalFromValue(getValuePath(message.params, ['goal'])) ?? threadGoalFromValue(getValuePath(payload, ['goal']));
}

type GoalFingerprint = Pick<ThreadGoal, 'objective' | 'createdAt'> & { status?: ThreadGoal['status'] };

function expectedGoalFromParams(params: unknown, requireStatus: boolean): { value: GoalFingerprint | null } | { error: string } {
  if (!isRecord(params) || !hasOwn(params, 'expectedGoal')) return { error: 'expectedGoal is required' };
  if (params.expectedGoal === null) return { value: null };
  if (!isRecord(params.expectedGoal)) return { error: 'expectedGoal must be a goal fingerprint or null' };
  const objective = getRequiredString(params.expectedGoal, 'objective');
  const createdAt = finiteNumber(params.expectedGoal.createdAt);
  if (!objective || createdAt === null) return { error: 'expectedGoal must include objective and createdAt' };
  if (!requireStatus) return { value: { objective, createdAt } };
  const status = enumValue(params.expectedGoal.status, GOAL_STATUSES);
  if (!status) return { error: 'expectedGoal must include status for replacement' };
  return { value: { objective, createdAt, status } };
}

function goalMatchesFingerprint(goal: ThreadGoal | null, expected: GoalFingerprint | null): boolean {
  if (!goal || !expected) return goal === null && expected === null;
  return (
    goal.objective === expected.objective &&
    goal.createdAt === expected.createdAt &&
    (expected.status === undefined || goal.status === expected.status)
  );
}

type TerminalDisposition = 'advance-queue' | 'barrier';
type ActiveCompletionTarget = { threadId: string; turnId: string };

const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted', 'canceled', 'cancelled']);

function turnsFromTurnListResult(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return [];
  if (Array.isArray(result.data)) return result.data;
  if (isRecord(result.data) && Array.isArray(result.data.turns)) return result.data.turns;
  if (Array.isArray(result.turns)) return result.turns;
  if (isRecord(result.thread) && Array.isArray(result.thread.turns)) return result.thread.turns;
  return [];
}

function turnRecordId(turn: unknown): string | null {
  return getStringPath(turn, ['id']) ?? getStringPath(turn, ['turnId']) ?? getStringPath(turn, ['turn_id']);
}

function turnStatusText(status: unknown): string | null {
  if (typeof status === 'string' && status.trim()) return status.trim();
  return getStringPath(status, ['type']) ?? getStringPath(status, ['status']) ?? getStringPath(status, ['state']);
}

function turnRecordHasCompletedAt(turn: unknown): boolean {
  const completedAt = getValuePath(turn, ['completedAt']) ?? getValuePath(turn, ['completed_at']);
  return completedAt !== null && completedAt !== undefined;
}

function isTerminalTurnRecord(turn: unknown): boolean {
  const status = turnStatusText(getValuePath(turn, ['status']) ?? getValuePath(turn, ['state']));
  if (status) return TERMINAL_TURN_STATUSES.has(status.toLowerCase());
  return turnRecordHasCompletedAt(turn);
}

function turnListShowsTerminalTurn(result: unknown, turnId: string): boolean {
  return turnsFromTurnListResult(result).some((turn) => turnRecordId(turn) === turnId && isTerminalTurnRecord(turn));
}

function queuedRunOptionsMatchActiveTurn(state: HostRuntimeState, message: QueuedMessage): boolean {
  const options = message.options;
  if (!options) return true;
  if (options.model && options.model !== state.model) return false;
  if (options.effort && options.effort !== state.effort) return false;
  if (options.mode && options.mode !== state.mode) return false;
  if (options.sandbox && options.sandbox !== state.sandbox) return false;
  return true;
}

function taskTerminalDisposition(message: { method?: unknown; params?: unknown; payload?: unknown }): TerminalDisposition | null {
  if (message.method !== 'event_msg') return null;
  const payload = notificationPayload(message);
  const type = getStringPath(payload, ['type']);
  if (type === 'task_complete') return 'advance-queue';
  if (type === 'task_failed' || type === 'task_interrupted') return 'barrier';
  return null;
}

function notificationTerminalDisposition(message: { method?: unknown; params?: unknown; payload?: unknown }): TerminalDisposition | null {
  if (message.method === 'turn/completed') {
    const status = getStringPath(message.params, ['turn', 'status']);
    return status === null || status === 'completed' ? 'advance-queue' : 'barrier';
  }
  if (message.method === 'thread/compacted') return 'advance-queue';
  if (message.method === 'turn/failed' || message.method === 'turn/interrupted') return 'barrier';
  return taskTerminalDisposition(message);
}

function isTaskStartedEvent(message: { method?: unknown; params?: unknown; payload?: unknown }): boolean {
  if (message.method !== 'event_msg') return false;
  const payload = notificationPayload(message);
  return getStringPath(payload, ['type']) === 'task_started';
}

function extractThreadId(result: unknown): string | null {
  return (
    getStringPath(result, ['thread', 'id']) ??
    getStringPath(result, ['data', 'id']) ??
    getStringPath(result, ['id']) ??
    getStringPath(result, ['threadId'])
  );
}

function extractThreadCwd(result: unknown): string | null {
  return getStringPath(result, ['thread', 'cwd']) ?? getStringPath(result, ['data', 'cwd']) ?? getStringPath(result, ['cwd']);
}

function extractThreadPath(result: unknown): string | null {
  return getStringPath(result, ['thread', 'path']) ?? getStringPath(result, ['data', 'path']) ?? getStringPath(result, ['path']);
}

function extractTurnId(result: unknown): string | null {
  return getStringPath(result, ['turn', 'id']) ?? getStringPath(result, ['data', 'id']) ?? getStringPath(result, ['id']) ?? getStringPath(result, ['turnId']);
}

function rememberCwd(cwds: string[], cwd: string): string[] {
  return [cwd, ...cwds.filter((item) => item !== cwd)].slice(0, 20);
}

function sanitizeThreadHistory(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeThreadHistory(item));
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(next.turns)) next.turns = [];

  for (const [key, child] of Object.entries(next)) {
    if (key !== 'turns') next[key] = sanitizeThreadHistory(child);
  }

  return next;
}

function approvalResponseForDecision(method: string, decision: unknown, params: unknown): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision };
  }

  if (method === 'mcpServer/elicitation/request') {
    if (decision !== 'decline' && decision !== 'cancel') {
      throw new Error('unsupported MCP elicitation decision');
    }
    return { action: decision, content: null, _meta: null };
  }

  if (method === 'item/tool/requestUserInput') {
    return { answers: decision };
  }

  if (method === 'item/tool/call') {
    return decision;
  }

  if (method === 'item/permissions/requestApproval') {
    if (decision !== 'accept' && decision !== 'decline') {
      throw new Error('unsupported permissions approval decision');
    }
    return { permissions: decision === 'accept' && isRecord(params) ? params.permissions : {}, scope: 'session' };
  }

  throw new Error(`unsupported approval request method: ${method}`);
}

function approvalRespondParams(params: unknown): { requestId: number | string; decision: unknown; method: string | null } | string {
  if (!isRecord(params)) return 'approval response params are required';
  const { requestId, method } = params;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return 'requestId is required';
  if (!hasOwn(params, 'decision')) return 'decision is required';
  return { requestId, decision: params.decision, method: typeof method === 'string' ? method : null };
}

function activeWorkspaceRoot(deps: BrowserSocketDeps): string {
  const activeCwd = deps.stateStore.read().activeCwd;
  if (!activeCwd) throw new Error('no active cwd');
  return activeCwd;
}

function assertNoActiveTurnForGitMutation(deps: BrowserSocketDeps): void {
  if (deps.stateStore.read().activeTurnId) throw new Error('git mutation is disabled while a turn is active');
}

async function resolveReadableRpcPath(deps: BrowserSocketDeps, filePath: string): Promise<string> {
  return resolveExistingPathInsideRoot(activeWorkspaceRoot(deps), filePath);
}

async function resolveReadableRpcPaths(deps: BrowserSocketDeps, filePath: string): Promise<{ lexicalPath: string; realPath: string }> {
  const root = activeWorkspaceRoot(deps);
  return {
    lexicalPath: assertPathInsideRoot(root, filePath),
    realPath: await resolveExistingPathInsideRoot(root, filePath),
  };
}

async function resolveWritableRpcPath(deps: BrowserSocketDeps, filePath: string): Promise<string> {
  return resolveWritablePathInsideRoot(activeWorkspaceRoot(deps), filePath);
}

function pendingCompactionTurnId(threadId: string): string {
  return `${COMPACTION_PENDING_TURN_PREFIX}${threadId}`;
}

function isPendingCompactionTurnForThread(turnId: string | null | undefined, threadId: string | null | undefined): boolean {
  return Boolean(turnId && threadId && turnId === pendingCompactionTurnId(threadId));
}

function pendingTurnStartTurnId(threadId: string): string {
  return `${TURN_START_PENDING_TURN_PREFIX}${threadId}`;
}

function isPendingTurnStartForThread(turnId: string | null | undefined, threadId: string | null | undefined): boolean {
  return Boolean(turnId && threadId && turnId === pendingTurnStartTurnId(threadId));
}

function isPendingTurnForThread(turnId: string | null | undefined, threadId: string | null | undefined): boolean {
  return isPendingCompactionTurnForThread(turnId, threadId) || isPendingTurnStartForThread(turnId, threadId);
}

function completionMatchesActiveTurn(
  activeTurnId: string | null | undefined,
  activeThreadId: string | null | undefined,
  completedTurnId: string | null,
  options: { allowMissingTurnId: boolean; completedThreadId?: string | null } = { allowMissingTurnId: true },
): boolean {
  if (!activeTurnId) return false;
  if (options.completedThreadId && activeThreadId && options.completedThreadId !== activeThreadId) return false;
  if (!completedTurnId) {
    if (!options.allowMissingTurnId) return false;
    if (isPendingCompactionTurnForThread(activeTurnId, activeThreadId)) return true;
    return Boolean(
      options.completedThreadId &&
        activeThreadId &&
        options.completedThreadId === activeThreadId &&
        !isPendingTurnForThread(activeTurnId, activeThreadId),
    );
  }
  if (completedTurnId === activeTurnId) return true;
  return false;
}

function isTurnStartTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out:\s*turn\/start|request timed out:\s*turn\/start/i.test(message);
}

function isTurnSteerTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out:\s*turn\/steer|request timed out:\s*turn\/steer/i.test(message);
}

function isMethodNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:method not found|unknown method|unsupported method|\b-32601\b)/i.test(message);
}

function lastNotificationSeq(params: unknown): number | null {
  if (!isRecord(params)) return null;
  const value = params.lastNotificationSeq;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function lastNotificationStreamId(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const value = params.lastNotificationStreamId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function browseBasePath(deps: BrowserSocketDeps): string {
  return deps.stateStore.read().activeCwd ?? deps.startCwd ?? process.env.HOME ?? process.cwd();
}

async function browseDirectory(deps: BrowserSocketDeps, requestedPath: string) {
  const basePath = browseBasePath(deps);
  const candidate = nodePath.isAbsolute(requestedPath) ? requestedPath : nodePath.resolve(basePath, requestedPath);
  const resolvedPath = await fs.realpath(candidate);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) throw new Error('path is not a directory');

  const entries: Array<{ name: string; path: string; isDirectory: true }> = [];
  const directory = await fs.opendir(resolvedPath);
  let truncated = false;
  for await (const entry of directory) {
    const entryPath = nodePath.join(resolvedPath, entry.name);
    if (!(await isBrowsableDirectoryEntry(entry, entryPath))) continue;
    if (entries.length >= BROWSE_DIRECTORY_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({ name: entry.name, path: entryPath, isDirectory: true });
  }
  return {
    path: resolvedPath,
    parent: nodePath.dirname(resolvedPath),
    truncated,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function browseWorkspaceDirectory(deps: BrowserSocketDeps, requestedPath: string) {
  const root = activeWorkspaceRoot(deps);
  const lexicalRoot = nodePath.resolve(root);
  const lexicalResolvedPath = assertPathInsideRoot(root, requestedPath);
  const [realRoot, realResolvedPath] = await Promise.all([fs.realpath(root), resolveExistingPathInsideRoot(root, lexicalResolvedPath)]);
  const stats = await fs.stat(realResolvedPath);
  if (!stats.isDirectory()) throw new Error('path is not a directory');

  const entries: Array<{ name: string; path: string; isDirectory: true }> = [];
  const directory = await fs.opendir(realResolvedPath);
  let truncated = false;
  for await (const entry of directory) {
    const realEntryPath = nodePath.join(realResolvedPath, entry.name);
    if (!(await isBrowsableWorkspaceDirectoryEntry(realRoot, entry, realEntryPath))) continue;
    if (entries.length >= BROWSE_DIRECTORY_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({ name: entry.name, path: nodePath.join(lexicalResolvedPath, entry.name), isDirectory: true });
  }

  const parent = nodePath.dirname(lexicalResolvedPath);
  return {
    path: lexicalResolvedPath,
    parent: isPathInsideRoot(lexicalRoot, parent) ? parent : lexicalResolvedPath,
    truncated,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function readDirectory(deps: BrowserSocketDeps, requestedPath: string) {
  const { lexicalPath, realPath } = await resolveReadableRpcPaths(deps, requestedPath);
  const stats = await fs.stat(realPath);
  if (!stats.isDirectory()) throw new Error('path is not a directory');

  const entries: Array<{ fileName: string; name: string; path: string; isDirectory: boolean; isFile: boolean }> = [];
  const directory = await fs.opendir(realPath);
  let truncated = false;
  for await (const entry of directory) {
    const realEntryPath = nodePath.join(realPath, entry.name);
    const lexicalEntryPath = nodePath.join(lexicalPath, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink() || (!isDirectory && !isFile)) {
      try {
        const entryStats = await fs.stat(realEntryPath);
        isDirectory = entryStats.isDirectory();
        isFile = entryStats.isFile();
      } catch {
        continue;
      }
    }

    if (entries.length >= BROWSE_DIRECTORY_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({ fileName: entry.name, name: entry.name, path: lexicalEntryPath, isDirectory, isFile });
  }

  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName));
  return { entries, truncated };
}

async function readFile(deps: BrowserSocketDeps, requestedPath: string) {
  const opened = await openExistingFileInsideRoot(activeWorkspaceRoot(deps), requestedPath);
  try {
    if (opened.stats.size > LEGACY_READ_FILE_MAX_BYTES) {
      throw new Error(`file is too large to read via legacy RPC (max ${LEGACY_READ_FILE_MAX_BYTES} bytes)`);
    }
    const data = await readOpenedFileFully(opened.handle, opened.stats.size);
    return { dataBase64: data.toString('base64') };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function writeFile(deps: BrowserSocketDeps, requestedPath: string, dataBase64: string) {
  await writeFileInsideRoot(activeWorkspaceRoot(deps), requestedPath, Buffer.from(dataBase64, 'base64'));
  return {};
}

async function createDirectory(deps: BrowserSocketDeps, requestedPath: string) {
  const resolvedPath = await resolveWritableRpcPath(deps, requestedPath);
  await fs.mkdir(resolvedPath);
  return {};
}

async function createBrowseDirectory(deps: BrowserSocketDeps, requestedPath: string) {
  const basePath = browseBasePath(deps);
  const candidate = nodePath.isAbsolute(requestedPath) ? requestedPath : nodePath.resolve(basePath, requestedPath);
  const targetParent = await fs.realpath(nodePath.dirname(candidate));
  const targetName = nodePath.basename(candidate);
  if (!targetName || targetName === '.' || targetName === '..') throw new Error('directory name is required');
  const resolvedPath = nodePath.join(targetParent, targetName);
  await fs.mkdir(resolvedPath);
  return { path: resolvedPath };
}

async function getMetadata(deps: BrowserSocketDeps, requestedPath: string) {
  const { lexicalPath, realPath } = await resolveReadableRpcPaths(deps, requestedPath);
  const [stats, linkStats] = await Promise.all([fs.stat(realPath), fs.lstat(lexicalPath)]);
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymlink: linkStats.isSymbolicLink(),
    createdAtMs: stats.birthtimeMs || 0,
    modifiedAtMs: stats.mtimeMs || 0,
  };
}

async function isBrowsableDirectoryEntry(entry: fsSync.Dirent, entryPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return (await fs.stat(entryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isBrowsableWorkspaceDirectoryEntry(realRoot: string, entry: fsSync.Dirent, entryPath: string): Promise<boolean> {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;

  try {
    const [entryStats, realEntryPath] = await Promise.all([fs.stat(entryPath), fs.realpath(entryPath)]);
    return entryStats.isDirectory() && isPathInsideRoot(realRoot, realEntryPath);
  } catch {
    return false;
  }
}

type TurnItemsView = 'notLoaded' | 'summary' | 'full';

function turnListParams(params: unknown): {
  threadId: string;
  threadPath: string | null;
  cursor: unknown;
  limit: number;
  sortDirection: string;
  itemsView: TurnItemsView;
} | string {
  if (!isRecord(params)) return 'thread list params are required';
  const threadId = getRequiredString(params, 'threadId');
  if (!threadId) return 'threadId is required';
  const threadPath = getOptionalString(params, 'threadPath');

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 50;
  const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc';
  const itemsView = enumValue(params.itemsView, TURN_ITEMS_VIEWS) ?? 'full';
  return {
    threadId,
    threadPath,
    cursor: typeof params.cursor === 'string' ? params.cursor : null,
    limit,
    sortDirection,
    itemsView,
  };
}

interface FileSnapshot {
  before: string | null;
  createdAt: number;
}

interface PatchSnapshot {
  threadId: string | null;
  turnId: string;
  patches: string[];
  bytes: number;
  updatedAt: number;
  complete: boolean;
}

interface TurnContext {
  threadId: string | null;
  threadPath: string | null;
  cwd: string | null;
  ambiguousTurnId?: string;
}

type TimedOutQueuedStart = Pick<QueuedMessage, 'id' | 'text'>;

interface FileDiffParams {
  threadId: string | null;
  threadPath: string | null;
  turnId: string | null;
  path: string;
  changes: unknown[];
}

function stringValue(value: unknown, key: string): string | null {
  if (!isRecord(value) || typeof value[key] !== 'string') return null;
  const text = value[key].trim();
  return text ? text : null;
}

function changePath(change: unknown): string | null {
  return stringValue(change, 'path') ?? stringValue(change, 'file') ?? stringValue(change, 'filePath') ?? stringValue(change, 'file_path');
}

function fileChangePaths(value: unknown): string[] {
  const paths = new Set<string>();
  const direct = changePath(value);
  if (direct) paths.add(direct);
  if (isRecord(value) && Array.isArray(value.changes)) {
    for (const change of value.changes) {
      const path = changePath(change);
      if (path) paths.add(path);
    }
  }
  return Array.from(paths);
}

function fileDiffParams(params: unknown): FileDiffParams | string {
  if (!isRecord(params)) return 'file diff params are required';
  const path = changePath(params) ?? (Array.isArray(params.changes) ? params.changes.map(changePath).find((item): item is string => Boolean(item)) : null);
  if (!path) return 'path is required';
  return {
    threadId: stringValue(params, 'threadId') ?? stringValue(params, 'thread_id'),
    threadPath: stringValue(params, 'threadPath') ?? stringValue(params, 'thread_path'),
    turnId: stringValue(params, 'turnId') ?? stringValue(params, 'turn_id'),
    path,
    changes: Array.isArray(params.changes) ? params.changes.filter(isRecord) : [],
  };
}

function snapshotKey(threadId: string | null, turnId: string | null, filePath: string): string {
  return `${threadId ?? ''}\0${turnId ?? ''}\0${filePath}`;
}

function readSnapshotFile(filePath: string): string | null {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size > FILE_DIFF_SNAPSHOT_MAX_BYTES) return null;
    return fsSync.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isPathInsideRoot(resolvedRoot: string, resolvedTarget: string): boolean {
  const relative = nodePath.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

function resolveSnapshotPathInsideRoot(root: string, target: string): string {
  const realRoot = fsSync.realpathSync(root);
  const lexicalTarget = assertPathInsideRoot(root, target);

  try {
    const realTarget = fsSync.realpathSync(lexicalTarget);
    if (!isPathInsideRoot(realRoot, realTarget)) throw new Error('path is outside active workspace');
    return realTarget;
  } catch (error) {
    if (typeof error !== 'object' || error === null || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const realParent = fsSync.realpathSync(nodePath.dirname(lexicalTarget));
  if (!isPathInsideRoot(realRoot, realParent)) throw new Error('path is outside active workspace');
  return lexicalTarget;
}

async function readCurrentFileForDiff(filePath: string): Promise<string> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > FILE_DIFF_SNAPSHOT_MAX_BYTES) return '';
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function resolveDiffPathInsideRoot(root: string, filePath: string): Promise<string> {
  const resolvedPath = await resolveWritablePathInsideRoot(root, filePath);
  try {
    return await fs.realpath(resolvedPath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return resolvedPath;
    throw error;
  }
}

function normalizedAbsolutePath(filePath: string): string | null {
  return nodePath.isAbsolute(filePath) ? nodePath.resolve(filePath) : null;
}

function diffText(change: unknown): string | null {
  return getStringPath(change, ['diff']) ?? getStringPath(change, ['patch']) ?? getStringPath(change, ['unifiedDiff']) ?? getStringPath(change, ['unified_diff']);
}

function changeKindType(change: unknown): string | null {
  return getStringPath(change, ['kind', 'type']) ?? getStringPath(change, ['type']);
}

function isPatch(text: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
}

function patchContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function splitContentLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function joinContentLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function applyUnifiedPatch(content: string, patch: string): string | null {
  const source = splitContentLines(content);
  const output: string[] = [];
  let sourceIndex = 0;
  let trailingNewline = content.endsWith('\n');
  const lines = patch.split('\n');
  let index = 0;
  let applied = false;

  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    applied = true;
    const oldStart = Number(header[1]);
    const targetIndex = oldStart > 0 ? oldStart - 1 : 0;
    while (sourceIndex < targetIndex && sourceIndex < source.length) {
      output.push(source[sourceIndex]);
      sourceIndex += 1;
    }
    if (sourceIndex < targetIndex) return null;

    index += 1;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      if (line === '\\ No newline at end of file') {
        trailingNewline = false;
        index += 1;
        continue;
      }
      if (!line) {
        index += 1;
        continue;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        output.push(text);
        sourceIndex += 1;
      } else if (marker === '-') {
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(text);
        trailingNewline = true;
      }
      index += 1;
    }
  }

  if (!applied) return null;
  while (sourceIndex < source.length) {
    output.push(source[sourceIndex]);
    sourceIndex += 1;
  }
  return joinContentLines(output, trailingNewline);
}

function reverseUnifiedPatch(content: string, patch: string): string | null {
  const source = splitContentLines(content);
  const output: string[] = [];
  let sourceIndex = 0;
  let trailingNewline = content.endsWith('\n');
  const lines = patch.split('\n');
  let index = 0;
  let applied = false;

  while (index < lines.length) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    applied = true;
    const newStart = Number(header[1]);
    const targetIndex = newStart > 0 ? newStart - 1 : 0;
    if (targetIndex < sourceIndex) return null;
    while (sourceIndex < targetIndex && sourceIndex < source.length) {
      output.push(source[sourceIndex]);
      sourceIndex += 1;
    }
    if (sourceIndex < targetIndex) return null;

    index += 1;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      if (line === '\\ No newline at end of file') {
        trailingNewline = false;
        index += 1;
        continue;
      }
      if (!line) {
        index += 1;
        continue;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        if (source[sourceIndex] !== text) return null;
        output.push(text);
        sourceIndex += 1;
      } else if (marker === '+') {
        if (source[sourceIndex] !== text) return null;
        sourceIndex += 1;
      } else if (marker === '-') {
        output.push(text);
        trailingNewline = true;
      } else {
        return null;
      }
      index += 1;
    }
  }

  if (!applied) return null;
  while (sourceIndex < source.length) {
    output.push(source[sourceIndex]);
    sourceIndex += 1;
  }
  return joinContentLines(output, trailingNewline);
}

function reconstructAddedFileDiff(changes: unknown[]): { before: string; after: string } | null {
  const first = changes[0];
  const firstDiff = diffText(first);
  if (changeKindType(first) !== 'add' || firstDiff === null || isPatch(firstDiff)) return null;

  let after = firstDiff;
  for (const change of changes.slice(1)) {
    const patch = diffText(change);
    if (!patch || !isPatch(patch)) continue;
    const next = applyUnifiedPatch(after, patch);
    if (next === null) return null;
    after = next;
  }

  return { before: '', after };
}

function firstTextAt(change: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const value = getStringPath(change, [key]);
    if (value !== null) return value;
  }
  return null;
}

function explicitBeforeAfterDiff(changes: unknown[]): { before: string; after: string } | null {
  const beforeKeys = ['before', 'oldText', 'old_text', 'previousText', 'previous_text', 'original', 'beforeContent', 'before_content'];
  const afterKeys = ['after', 'newText', 'new_text', 'updatedText', 'updated_text', 'modified', 'afterContent', 'after_content'];
  const first = changes.find((change) => firstTextAt(change, beforeKeys) !== null);
  const last = [...changes].reverse().find((change) => firstTextAt(change, afterKeys) !== null);
  if (!first || !last) return null;
  const before = firstTextAt(first, beforeKeys);
  const after = firstTextAt(last, afterKeys);
  return before !== null && after !== null ? { before, after } : null;
}

function patchSnippetDiff(changes: unknown[]): { before: string; after: string } | null {
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  for (const change of changes) {
    const patch = diffText(change);
    if (!patch || !isPatch(patch)) continue;
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const line of patch.split('\n')) {
      if (!line || line.startsWith('@@ ') || line === '\\ No newline at end of file') continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ' || marker === '-') beforeLines.push(text);
      if (marker === ' ' || marker === '+') afterLines.push(text);
    }
    beforeParts.push(beforeLines.join('\n'));
    afterParts.push(afterLines.join('\n'));
  }

  if (beforeParts.length === 0 && afterParts.length === 0) return null;
  return { before: beforeParts.join('\n~~~ ... ~~~\n'), after: afterParts.join('\n~~~ ... ~~~\n') };
}

function extractResolvedRequestId(message: { method: string; params?: unknown }): number | string | null {
  if (!/request.*resolved|serverRequest.*resolved/i.test(message.method)) return null;
  if (!isRecord(message.params)) return null;
  const requestId = message.params.requestId ?? message.params.request_id ?? message.params.id;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}

function shouldClearActiveTurnAfterInterruptFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|closed|exited|not found|no active|unknown.*turn|turn.*unknown|thread.*unknown/i.test(message);
}

function patchApplyPayload(message: { params?: unknown; payload?: unknown }): Record<string, unknown> | null {
  const payload = notificationPayload(message);
  return isRecord(payload) && getStringPath(payload, ['type']) === 'patch_apply_end' ? payload : null;
}

export function attachBrowserSocket(server: http.Server, deps: BrowserSocketDeps): BrowserSocketCleanup {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const responsiveBrowserClients = new WeakSet<WebSocket>();
  const heartbeatIntervalMs = deps.browserHeartbeatIntervalMs ?? BROWSER_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    const sentAt = Date.now();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!responsiveBrowserClients.has(client)) {
        client.terminate();
        continue;
      }
      responsiveBrowserClients.delete(client);
      try {
        client.ping();
        send(client, { type: 'server/heartbeat', sentAt });
      } catch (error) {
        logWarn('Browser WebSocket heartbeat failed', error);
        client.terminate();
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();
  let closed = false;
  let queuedStartInFlight: { threadId: string; queuedMessage: QueuedMessage } | null = null;
  let queuedSteerInFlight: QueuedSteerInFlight | null = null;
  let bangCommandInFlight = false;
  const notificationStreamId = randomUUID();
  const pendingTurnStartContexts: TurnContext[] = [];
  const pendingServerRequests = new Map<string, JsonRpcServerRequest>();
  const resumedThreadIds = new Set<string>();
  const startedPendingRolloutThreadIds = new Set<string>();
  const resumeThreadPromises = new Map<string, Promise<void>>();
  const knownThreadPaths = new Map<string, string>();
  let appServerGeneration = 0;
  let runtimeSettingsConfirmation: RuntimeSettingsConfirmation | null = null;
  let runtimeSettingsUpdateWaiter: RuntimeSettingsUpdateWaiter | null = null;
  let restartInFlight: Promise<unknown> | null = null;
  let sessionChangeInFlight = false;
  let modelCapacityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let modelCapacityReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  const currentGenerationCapacityRetryOperations = new Set<string>();
  const legacyModelCapacityFailureKeys = new Set<string>();
  const timedOutQueuedStarts = new Map<string, TimedOutQueuedStart>();
  const retainedDirectStartContexts = new Map<string, TurnContext>();
  let directStartContextGeneration = 0;

  const clearRetainedDirectStartContexts = (threadId?: string): HostRuntimeState => {
    const threadIds = threadId ? [threadId] : Array.from(retainedDirectStartContexts.keys());
    const recoveries: Array<{ threadId: string; recovery: TimedOutQueuedStart }> = [];
    for (const retainedThreadId of threadIds) {
      if (!retainedDirectStartContexts.delete(retainedThreadId)) continue;
      const recovery = timedOutQueuedStarts.get(retainedThreadId);
      if (!recovery) continue;
      timedOutQueuedStarts.delete(retainedThreadId);
      recoveries.push({ threadId: retainedThreadId, recovery });
    }
    if (recoveries.length === 0) return deps.stateStore.read();
    return deps.stateStore.update((current) => ({
      ...current,
      queue: current.queue.map((message) => (
        recoveries.some(({ threadId: owner, recovery }) => (
          message.threadId === owner && message.id === recovery.id && message.text === recovery.text
        ))
          ? { ...message, deliveryState: 'maybeSent' as const }
          : message
      )),
    }));
  };

  const invalidateRetainedDirectStartContexts = (threadId?: string): HostRuntimeState => {
    directStartContextGeneration += 1;
    return clearRetainedDirectStartContexts(threadId);
  };

  const retainDirectStartContext = (context: TurnContext): void => {
    if (!context.threadId) return;
    retainedDirectStartContexts.delete(context.threadId);
    retainedDirectStartContexts.set(context.threadId, context);
    const limit = normalizeQueueLimit(deps.config.queueLimit);
    while (retainedDirectStartContexts.size > limit) {
      const oldestThreadId = retainedDirectStartContexts.keys().next().value;
      if (typeof oldestThreadId !== 'string') break;
      clearRetainedDirectStartContexts(oldestThreadId);
    }
  };
  const recentNotifications: Array<{ seq: number; message: unknown; bytes: number }> = [];
  let recentNotificationSeq = 0;
  let recentNotificationBytes = 0;
  const fileSnapshots = new Map<string, FileSnapshot>();
  const patchSnapshots = new Map<string, PatchSnapshot>();
  const incompletePatchTurnKeys = new Set<string>();
  let patchCaptureChain: Promise<void> = Promise.resolve();
  let patchCaptureQueueDepth = 0;
  const completingTurnKeys = new Set<string>();
  const terminalTurnKeys = new Set<string>();
  const terminalTurnDispositions = new Map<string, TerminalDisposition>();
  const completedTurnKeys = new Set<string>();
  const cancelledTurnKeys = new Set<string>();
  const verifyingUnscopedTerminalKeys = new Map<string, number>();
  const autonomousSuccessorTurnIds = new Map<string, string>();
  const observedTurnStartKeys = new Set<string>();
  const runtimeOptionUpdates = new Set<string>();
  const goalUpdates = new Set<string>();
  let goalMutationGeneration = 0;
  const suppressedGoalQueueStarts = new Set<string>();
  const suppressedGoalQueueSteers = new Set<string>();
  let compactionGeneration = 0;
  const compactionsInFlight = new Map<string, { generation: number; turnId: string | null }>();
  const turnThreadPaths = new Map<string, string>();
  const turnCwds = new Map<string, string>();
  const livePatchTurnKeys = new Set<string>();
  const capturedPatchEventKeys = new Set<string>();

  const modelCapacityRetryForThread = (state: HostRuntimeState, threadId?: string | null): ModelCapacityRetry | null => {
    const retry = state.modelCapacityRetry;
    if (!retry) return null;
    if (threadId && retry.threadId !== threadId) return null;
    return retry;
  };

  const codexBusy = (state: HostRuntimeState, threadId?: string | null): boolean =>
    Boolean(state.activeTurnId || modelCapacityRetryForThread(state, threadId));

  const clearModelCapacityTimers = (): void => {
    if (modelCapacityRetryTimer) clearTimeout(modelCapacityRetryTimer);
    if (modelCapacityReconcileTimer) clearTimeout(modelCapacityReconcileTimer);
    modelCapacityRetryTimer = null;
    modelCapacityReconcileTimer = null;
  };

  const recordRuntimeSettingsConfirmation = (
    threadId: string | null,
    runtimeStatus: Pick<HostRuntimeState, 'model' | 'effort'>,
    source: RuntimeSettingsConfirmation['source'],
  ): void => {
    runtimeSettingsConfirmation = threadId && runtimeStatus.model
      ? {
          threadId,
          model: runtimeStatus.model,
          effort: runtimeStatus.effort,
          source,
          confirmedAt: new Date().toISOString(),
        }
      : null;
  };

  const settleRuntimeSettingsUpdateWaiter = (
    waiter: RuntimeSettingsUpdateWaiter,
    result: { confirmed: true } | { confirmed: false; error: Error },
  ): void => {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (runtimeSettingsUpdateWaiter === waiter) runtimeSettingsUpdateWaiter = null;
    waiter.resolve(result);
  };

  const cancelRuntimeSettingsUpdateWaiter = (waiter: RuntimeSettingsUpdateWaiter, error: Error): void => {
    if (runtimeSettingsUpdateWaiter !== waiter) return;
    settleRuntimeSettingsUpdateWaiter(waiter, { confirmed: false, error });
  };

  const createRuntimeSettingsUpdateWaiter = (
    threadId: string,
    model: string | undefined,
    effort: string | null | undefined,
  ): RuntimeSettingsUpdateWaiter => {
    if (runtimeSettingsUpdateWaiter) throw new Error('a runtime settings confirmation is already pending');
    let resolve!: RuntimeSettingsUpdateWaiter['resolve'];
    const promise = new Promise<{ confirmed: true } | { confirmed: false; error: Error }>((settle) => {
      resolve = settle;
    });
    const waiter: RuntimeSettingsUpdateWaiter = {
      threadId,
      model,
      effort,
      generation: appServerGeneration,
      promise,
      resolve,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      cancelRuntimeSettingsUpdateWaiter(waiter, new Error('timed out waiting for Codex to confirm model and effort update'));
    }, RUNTIME_SETTINGS_CONFIRMATION_TIMEOUT_MS);
    runtimeSettingsUpdateWaiter = waiter;
    return waiter;
  };

  const runtimeSettingsMatchWaiter = (
    waiter: RuntimeSettingsUpdateWaiter,
    settings: RuntimeSettingsNotification,
  ): boolean =>
    waiter.generation === appServerGeneration &&
    waiter.threadId === settings.threadId &&
    (waiter.model === undefined || waiter.model === settings.model) &&
    (waiter.effort === undefined || waiter.effort === settings.effort);

  const resolveMatchingRuntimeSettingsUpdateWaiter = (settings: RuntimeSettingsNotification): void => {
    const waiter = runtimeSettingsUpdateWaiter;
    if (!waiter || !runtimeSettingsMatchWaiter(waiter, settings)) return;
    settleRuntimeSettingsUpdateWaiter(waiter, { confirmed: true });
  };

  const turnKey = (threadId: string | null, turnId: string): string => `${threadId ?? ''}\0${turnId}`;

  const openFileEditStore = (threadPath: string | null, options: { readonly?: boolean } = {}): FileEditStore | null => {
    if (!threadPath || !nodePath.isAbsolute(threadPath)) return null;
    const dbPath = sessionFileEditDbPath(threadPath);
    if (options.readonly && !fsSync.existsSync(dbPath)) return null;
    try {
      return new FileEditStore(dbPath, options);
    } catch (error) {
      logWarn('Failed to open file edit store', error);
      return null;
    }
  };

  const rememberKnownThreadPath = (threadId: string | null, threadPath: string | null) => {
    if (!threadId || !threadPath || !nodePath.isAbsolute(threadPath)) return;
    knownThreadPaths.set(threadId, threadPath);
    while (knownThreadPaths.size > 200) {
      const oldest = knownThreadPaths.keys().next().value;
      if (typeof oldest !== 'string') break;
      knownThreadPaths.delete(oldest);
    }
  };

  const rememberKnownThreadPathsFromList = (result: unknown) => {
    const threads = isRecord(result) && Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : [];
    for (const thread of threads) rememberKnownThreadPath(extractThreadId(thread), extractThreadPath(thread));
  };

  const invalidateResumedThreads = () => {
    appServerGeneration += 1;
    invalidateRetainedDirectStartContexts();
    runtimeSettingsConfirmation = null;
    if (runtimeSettingsUpdateWaiter) {
      cancelRuntimeSettingsUpdateWaiter(
        runtimeSettingsUpdateWaiter,
        new Error('Codex app-server changed before confirming model and effort update'),
      );
    }
    resumedThreadIds.clear();
    resumeThreadPromises.clear();
    currentGenerationCapacityRetryOperations.clear();
    compactionsInFlight.clear();
    suppressedGoalQueueStarts.clear();
    suppressedGoalQueueSteers.clear();
  };

  const validatedThreadPath = (
    state: HostRuntimeState,
    threadId: string | null,
    turnId: string | null,
    threadPath: string | null,
  ): string | null => {
    if (!threadPath || !nodePath.isAbsolute(threadPath)) return null;
    if (threadId && knownThreadPaths.get(threadId) === threadPath) return threadPath;
    if (turnId && turnThreadPaths.get(turnKey(threadId, turnId)) === threadPath) return threadPath;
    if ((!threadId || threadId === state.activeThreadId) && threadPath === state.activeThreadPath) return threadPath;
    return null;
  };

  const resumePathForThread = (threadId: string, requestedThreadPath?: string | null): string | null => {
    const state = deps.stateStore.read();
    const requested = requestedThreadPath && nodePath.isAbsolute(requestedThreadPath)
      ? validatedThreadPath(state, threadId, null, requestedThreadPath)
      : null;
    if (requested) return requested;
    const known = knownThreadPaths.get(threadId);
    if (known) return known;
    if (state.activeThreadId === threadId && state.activeThreadPath && nodePath.isAbsolute(state.activeThreadPath)) {
      return state.activeThreadPath;
    }
    return null;
  };

  const trustedDiffRoot = (state: HostRuntimeState, threadId: string | null, threadPath: string | null): string | null => {
    if (!state.activeCwd) return null;
    if (threadId && threadId !== state.activeThreadId) return null;
    if (threadPath && threadPath !== state.activeThreadPath) return null;
    return state.activeCwd;
  };

  const rememberTerminalTurnKey = (key: string, disposition: TerminalDisposition) => {
    terminalTurnKeys.add(key);
    terminalTurnDispositions.set(key, disposition);
    while (terminalTurnKeys.size > 200) {
      const oldest = terminalTurnKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      terminalTurnKeys.delete(oldest);
      terminalTurnDispositions.delete(oldest);
    }
  };

  const rememberCompletedTurnKey = (key: string) => {
    completedTurnKeys.add(key);
    while (completedTurnKeys.size > 200) {
      const oldest = completedTurnKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      completedTurnKeys.delete(oldest);
    }
  };

  const rememberCancelledTurn = (threadId: string | null, turnId: string): void => {
    cancelledTurnKeys.add(turnKey(threadId, turnId));
    while (cancelledTurnKeys.size > 200) {
      const oldest = cancelledTurnKeys.values().next().value;
      if (typeof oldest !== 'string') break;
      cancelledTurnKeys.delete(oldest);
    }
  };

  const hasCompletedTurn = (threadId: string | null, turnId: string | null): boolean => {
    if (!turnId) return false;
    return (
      terminalTurnKeys.has(turnKey(threadId, turnId)) ||
      terminalTurnKeys.has(turnKey(null, turnId)) ||
      completedTurnKeys.has(turnKey(threadId, turnId)) ||
      completedTurnKeys.has(turnKey(null, turnId))
    );
  };

  const rememberAutonomousSuccessor = (threadId: string, predecessorTurnId: string, successorTurnId: string): void => {
    const predecessorKey = turnKey(threadId, predecessorTurnId);
    if (autonomousSuccessorTurnIds.has(predecessorKey)) return;
    autonomousSuccessorTurnIds.set(predecessorKey, successorTurnId);
    while (autonomousSuccessorTurnIds.size > 200) {
      const oldest = autonomousSuccessorTurnIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      autonomousSuccessorTurnIds.delete(oldest);
    }
  };

  const terminalDispositionForTurn = (threadId: string, turnId: string): TerminalDisposition | null =>
    terminalTurnDispositions.get(turnKey(threadId, turnId)) ??
    terminalTurnDispositions.get(turnKey(null, turnId)) ??
    null;

  const appendAutonomousSuccessor = (threadId: string, rootTurnId: string, successorTurnId: string): void => {
    let predecessorTurnId = rootTurnId;
    const visited = new Set<string>();
    while (!visited.has(predecessorTurnId)) {
      if (predecessorTurnId === successorTurnId || terminalDispositionForTurn(threadId, predecessorTurnId) === 'barrier') return;
      visited.add(predecessorTurnId);
      const existingSuccessor = autonomousSuccessorTurnIds.get(turnKey(threadId, predecessorTurnId));
      if (!existingSuccessor) {
        rememberAutonomousSuccessor(threadId, predecessorTurnId, successorTurnId);
        return;
      }
      predecessorTurnId = existingSuccessor;
    }
  };

  const autonomousSuccessorDisposition = (
    steer: Pick<QueuedSteerClaim, 'threadId' | 'turnId'>,
  ): TerminalDisposition | null => {
    let predecessorTurnId = steer.turnId;
    let lastDisposition: TerminalDisposition | null = null;
    const visited = new Set<string>();
    while (!visited.has(predecessorTurnId)) {
      visited.add(predecessorTurnId);
      const successorTurnId = autonomousSuccessorTurnIds.get(turnKey(steer.threadId, predecessorTurnId));
      if (!successorTurnId) return lastDisposition;
      const disposition = terminalDispositionForTurn(steer.threadId, successorTurnId);
      if (disposition === 'barrier') return disposition;
      lastDisposition = disposition;
      predecessorTurnId = successorTurnId;
    }
    return 'barrier';
  };

  const isTerminalOrCompletingTurn = (threadId: string | null, turnId: string | null): boolean => {
    if (!turnId) return false;
    return (
      hasCompletedTurn(threadId, turnId) ||
      completingTurnKeys.has(turnKey(threadId, turnId)) ||
      completingTurnKeys.has(turnKey(null, turnId)) ||
      verifyingUnscopedTerminalKeys.has(turnKey(threadId, turnId)) ||
      verifyingUnscopedTerminalKeys.has(turnKey(null, turnId))
    );
  };

  const rememberTurnThreadPath = (threadId: string | null, turnId: string | null, threadPath: string | null) => {
    if (!turnId || !threadPath) return;
    turnThreadPaths.set(turnKey(threadId, turnId), threadPath);
    while (turnThreadPaths.size > 200) {
      const oldest = turnThreadPaths.keys().next().value;
      if (typeof oldest !== 'string') break;
      turnThreadPaths.delete(oldest);
      turnCwds.delete(oldest);
    }
  };

  const rememberTurnCwd = (threadId: string | null, turnId: string | null, cwd: string | null) => {
    if (!turnId || !cwd) return;
    turnCwds.set(turnKey(threadId, turnId), cwd);
    while (turnCwds.size > 200) {
      const oldest = turnCwds.keys().next().value;
      if (typeof oldest !== 'string') break;
      turnCwds.delete(oldest);
      turnThreadPaths.delete(oldest);
    }
  };

  const findTurnContext = (preferredThreadId: string | null, turnId: string, state: HostRuntimeState): TurnContext => {
    const exactKey = turnKey(preferredThreadId, turnId);
    let threadId = preferredThreadId;
    let threadPath = turnThreadPaths.get(exactKey) ?? null;
    let cwd = turnCwds.get(exactKey) ?? null;

    if (!threadPath || !cwd) {
      const suffix = `\0${turnId}`;
      for (const key of new Set([...turnThreadPaths.keys(), ...turnCwds.keys()])) {
        if (!key.endsWith(suffix)) continue;
        const matchedThreadId = key.slice(0, -suffix.length) || null;
        threadId = threadId ?? matchedThreadId;
        threadPath = threadPath ?? turnThreadPaths.get(key) ?? null;
        cwd = cwd ?? turnCwds.get(key) ?? null;
        if (threadPath && cwd) break;
      }
    }

    const activeTurn = state.activeTurnId === turnId && (!threadId || threadId === state.activeThreadId);
    if (activeTurn) {
      threadId = threadId ?? state.activeThreadId;
      threadPath = threadPath ?? state.activeThreadPath;
      cwd = cwd ?? state.activeCwd;
    }

    return { threadId, threadPath, cwd };
  };

  const pruneFileSnapshots = () => {
    const now = Date.now();
    for (const [key, snapshot] of fileSnapshots) {
      if (now - snapshot.createdAt > FILE_DIFF_SNAPSHOT_TTL_MS) fileSnapshots.delete(key);
    }
    while (fileSnapshots.size > FILE_DIFF_SNAPSHOT_MAX_ENTRIES) {
      const oldest = fileSnapshots.keys().next().value;
      if (typeof oldest !== 'string') break;
      fileSnapshots.delete(oldest);
    }
  };

  const prunePatchSnapshots = () => {
    const now = Date.now();
    const incompleteSnapshots: PatchSnapshot[] = [];
    for (const snapshot of patchSnapshots.values()) {
      if (now - snapshot.updatedAt > FILE_DIFF_SNAPSHOT_TTL_MS) {
        incompleteSnapshots.push(snapshot);
      }
    }
    for (const snapshot of incompleteSnapshots) markPatchTurnIncomplete(snapshot.threadId, snapshot.turnId);
    while (patchSnapshots.size > FILE_DIFF_SNAPSHOT_MAX_ENTRIES) {
      const oldest = patchSnapshots.values().next().value;
      if (!oldest) break;
      markPatchTurnIncomplete(oldest.threadId, oldest.turnId);
    }
  };

  function isPatchTurnIncomplete(threadId: string | null, turnId: string): boolean {
    return incompletePatchTurnKeys.has(turnKey(threadId, turnId)) || incompletePatchTurnKeys.has(turnKey(null, turnId));
  }

  function markPatchTurnIncomplete(threadId: string | null, turnId: string): void {
    const scoped = `${threadId ?? ''}\0${turnId}\0`;
    const unscoped = `\0${turnId}\0`;
    for (const key of patchSnapshots.keys()) {
      if (key.startsWith(scoped) || key.startsWith(unscoped)) patchSnapshots.delete(key);
    }
    const key = turnKey(threadId, turnId);
    incompletePatchTurnKeys.add(key);
    livePatchTurnKeys.delete(key);
    livePatchTurnKeys.delete(turnKey(null, turnId));
    while (incompletePatchTurnKeys.size > FILE_DIFF_PATCH_MAX_INCOMPLETE_TURNS) {
      const oldest = incompletePatchTurnKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      incompletePatchTurnKeys.delete(oldest);
      livePatchTurnKeys.delete(oldest);
      const separator = oldest.indexOf('\0');
      if (separator >= 0) livePatchTurnKeys.delete(turnKey(null, oldest.slice(separator + 1)));
    }
  }

  const appendTurnPatch = (threadId: string | null, turnId: string, key: string, patch: string, complete: boolean): PatchSnapshot | null => {
    prunePatchSnapshots();
    if (isPatchTurnIncomplete(threadId, turnId)) return null;
    const patchBytes = Buffer.byteLength(patch, 'utf8');
    if (patchBytes > FILE_DIFF_PATCH_MAX_BYTES_PER_FILE) {
      markPatchTurnIncomplete(threadId, turnId);
      return null;
    }

    const snapshot = patchSnapshots.get(key) ?? { threadId, turnId, patches: [], bytes: 0, updatedAt: Date.now(), complete };
    if (
      snapshot.patches.length >= FILE_DIFF_PATCH_MAX_PATCHES_PER_FILE ||
      snapshot.bytes + patchBytes > FILE_DIFF_PATCH_MAX_BYTES_PER_FILE
    ) {
      markPatchTurnIncomplete(threadId, turnId);
      return null;
    }

    snapshot.patches.push(patch);
    snapshot.bytes += patchBytes;
    snapshot.updatedAt = Date.now();
    snapshot.complete = snapshot.complete && complete;
    patchSnapshots.set(key, snapshot);
    return snapshot;
  };

  const beforeFromTurnPatches = (snapshot: PatchSnapshot, after: string): string | null => {
    let before = after;
    for (const candidate of [...snapshot.patches].reverse()) {
      const previous = reverseUnifiedPatch(before, candidate);
      if (previous === null) return null;
      before = previous;
    }
    return before;
  };

  const rememberLivePatchTurn = (threadId: string | null, turnId: string | null) => {
    if (!turnId) return;
    livePatchTurnKeys.add(turnKey(threadId, turnId));
    while (livePatchTurnKeys.size > 200) {
      const oldest = livePatchTurnKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      livePatchTurnKeys.delete(oldest);
    }
  };

  const rememberObservedTurnStart = (threadId: string | null, turnId: string | null) => {
    if (!turnId) return;
    observedTurnStartKeys.add(turnKey(threadId, turnId));
    while (observedTurnStartKeys.size > 200) {
      const oldest = observedTurnStartKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      observedTurnStartKeys.delete(oldest);
    }
  };

  const hasObservedTurnStart = (threadId: string | null, turnId: string | null): boolean =>
    Boolean(turnId && (observedTurnStartKeys.has(turnKey(threadId, turnId)) || observedTurnStartKeys.has(turnKey(null, turnId))));

  const patchEventKey = (threadId: string | null, turnId: string, filePath: string, patch: string): string =>
    `${turnKey(threadId, turnId)}\0${filePath}\0${patchContentHash(patch)}`;

  const rememberCapturedPatchEvent = (key: string): void => {
    capturedPatchEventKeys.add(key);
    while (capturedPatchEventKeys.size > 1000) {
      const oldest = capturedPatchEventKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      capturedPatchEventKeys.delete(oldest);
    }
  };

  const hasCapturedPatchEvent = (key: string): boolean => capturedPatchEventKeys.has(key);

  const startContextForThread = (threadId: string): TurnContext => {
    const state = deps.stateStore.read();
    if (state.activeThreadId === threadId) {
      return { threadId, threadPath: state.activeThreadPath, cwd: state.activeCwd };
    }
    return { threadId, threadPath: knownThreadPaths.get(threadId) ?? null, cwd: null };
  };

  const pendingTurnStartContext = (threadId: string | null): TurnContext | null => {
    if (!threadId) return pendingTurnStartContexts[0] ?? null;
    return pendingTurnStartContexts.find((context) => context.threadId === threadId) ?? null;
  };

  const takePendingTurnStartContext = (threadId: string | null): TurnContext | null => {
    const context = pendingTurnStartContext(threadId);
    if (!context) return null;
    const index = pendingTurnStartContexts.indexOf(context);
    if (index < 0) return null;
    pendingTurnStartContexts.splice(index, 1);
    return context;
  };

  const captureFileChangeSnapshots = (params: unknown, requestId: number | string) => {
    const state = deps.stateStore.read();
    if (!state.activeCwd) return;
    pruneFileSnapshots();
    rememberKnownThreadPath(state.activeThreadId, state.activeThreadPath);
    const store = state.activeTurnId ? openFileEditStore(state.activeThreadPath) : null;
    let storedAny = false;

    try {
      for (const filePath of fileChangePaths(params)) {
        let resolvedPath: string;
        try {
          resolvedPath = resolveSnapshotPathInsideRoot(state.activeCwd, filePath);
        } catch {
          continue;
        }
        const key = snapshotKey(state.activeThreadId, state.activeTurnId, resolvedPath);
        const before = readSnapshotFile(resolvedPath);
        if (!fileSnapshots.has(key) && fileSnapshots.size < FILE_DIFF_SNAPSHOT_MAX_ENTRIES) {
          fileSnapshots.set(key, { before, createdAt: Date.now() });
        }
        if (store && state.activeTurnId) {
          rememberTurnThreadPath(state.activeThreadId, state.activeTurnId, state.activeThreadPath);
          rememberTurnCwd(state.activeThreadId, state.activeTurnId, state.activeCwd);
          store.recordSnapshot({
            turnId: state.activeTurnId,
            itemId: String(requestId),
            path: resolvedPath,
            before: before ?? '',
          });
          storedAny = true;
        }
      }
    } finally {
      store?.close();
    }

    if (storedAny && state.activeThreadId && state.activeTurnId) {
      broadcastFileChangeSummaryChanged(state.activeThreadId, state.activeTurnId);
    }
  };

  const capturePatchChangeEntries = async (
    turnContext: TurnContext,
    turnId: string,
    itemId: string | null,
    entries: Array<{ filePath: string; rawChange: Record<string, unknown> }>,
  ): Promise<boolean> => {
    const store = openFileEditStore(turnContext.threadPath);
    if (!store) return false;

    let storedAny = false;
    try {
      for (const { filePath, rawChange } of entries) {
        const patch = getStringPath(rawChange, ['unified_diff']) ?? diffText(rawChange);
        if (!patch) continue;

        let resolvedPath: string;
        try {
          resolvedPath = turnContext.cwd ? resolveSnapshotPathInsideRoot(turnContext.cwd, filePath) : (normalizedAbsolutePath(filePath) ?? '');
          if (!resolvedPath) continue;
        } catch {
          continue;
        }
        const eventKey = patchEventKey(turnContext.threadId, turnId, resolvedPath, patch);
        if (hasCapturedPatchEvent(eventKey)) continue;

        const key = snapshotKey(turnContext.threadId, turnId, resolvedPath);
        const completePatchSequence = livePatchTurnKeys.has(turnKey(turnContext.threadId, turnId));
        const patchSnapshot = isPatch(patch) ? appendTurnPatch(turnContext.threadId, turnId, key, patch, completePatchSequence) : null;
        const after = await readCurrentFileForDiff(resolvedPath);
        const changeType = changeKindType(rawChange);
        const existingSnapshot = store.getSnapshot(turnId, resolvedPath);
        const patchBefore = patchSnapshot ? beforeFromTurnPatches(patchSnapshot, after) : null;
        if (patchSnapshot && patchBefore === null) {
          if (existingSnapshot?.source === 'patch') store.discardPatchDiff({ turnId, path: resolvedPath });
          continue;
        }
        const replacePatchBaseline = Boolean(patchSnapshot?.complete && (!existingSnapshot || existingSnapshot.source === 'patch'));
        const before = replacePatchBaseline
          ? patchBefore
          : existingSnapshot
            ? existingSnapshot.before
            : changeType === 'add'
              ? ''
              : null;
        if (before === null) continue;

        store.recordPatchSnapshot({
          turnId,
          itemId,
          path: resolvedPath,
          before,
          replaceBefore: replacePatchBaseline,
        });
        store.finalizeFile({ turnId, path: resolvedPath, after });
        rememberCapturedPatchEvent(eventKey);
        rememberKnownThreadPath(turnContext.threadId, turnContext.threadPath);
        rememberTurnThreadPath(turnContext.threadId, turnId, turnContext.threadPath);
        rememberTurnCwd(turnContext.threadId, turnId, turnContext.cwd);
        storedAny = true;
      }
    } finally {
      store.close();
    }

    return storedAny;
  };

  const capturePatchApplyPayload = async (payload: Record<string, unknown>) => {
    if (!isRecord(payload.changes)) return;
    const state = deps.stateStore.read();
    const turnId = getStringPath(payload, ['turn_id']) ?? getStringPath(payload, ['turnId']);
    if (!turnId) return;

    const activeThreadId = state.activeTurnId === turnId ? state.activeThreadId : null;
    const turnContext = findTurnContext(activeThreadId, turnId, state);
    const entries = Object.entries(payload.changes)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([filePath, rawChange]) => ({ filePath, rawChange }));
    const storedAny = await capturePatchChangeEntries(turnContext, turnId, getStringPath(payload, ['call_id']) ?? null, entries);
    if (storedAny && turnContext.threadId) broadcastFileChangeSummaryChanged(turnContext.threadId, turnId);
  };

  const captureStructuredFileChange = async (message: { params?: unknown; payload?: unknown }) => {
    if (!isRecord(message.params) || !isRecord(message.params.item)) return;
    const item = message.params.item;
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) return;
    const turnId = notificationTurnId(message);
    if (!turnId) return;

    const state = deps.stateStore.read();
    const turnContext = findTurnContext(notificationThreadId(message), turnId, state);
    const entries = item.changes
      .filter(isRecord)
      .map((rawChange) => {
        const filePath = changePath(rawChange);
        return filePath ? { filePath, rawChange } : null;
      })
      .filter((entry): entry is { filePath: string; rawChange: Record<string, unknown> } => entry !== null);
    const storedAny = await capturePatchChangeEntries(turnContext, turnId, stringValue(item, 'id'), entries);
    if (storedAny && turnContext.threadId) broadcastFileChangeSummaryChanged(turnContext.threadId, turnId);
  };

  const enqueuePatchApplyEnd = (message: { params?: unknown; payload?: unknown }) => {
    const payload = patchApplyPayload(message);
    if (!payload) return;
    const turnId = getStringPath(payload, ['turn_id']) ?? getStringPath(payload, ['turnId']);
    if (!turnId) return;

    if (patchCaptureQueueDepth >= FILE_DIFF_PATCH_MAX_PENDING_NOTIFICATIONS) {
      const state = deps.stateStore.read();
      const activeThreadId = state.activeTurnId === turnId ? state.activeThreadId : null;
      const turnContext = findTurnContext(activeThreadId, turnId, state);
      markPatchTurnIncomplete(turnContext.threadId, turnId);
      return;
    }

    patchCaptureQueueDepth += 1;
    patchCaptureChain = patchCaptureChain
      .catch(() => undefined)
      .then(() => capturePatchApplyPayload(payload))
      .catch((error) => logWarn('Failed to capture patch apply notification', error))
      .finally(() => {
        patchCaptureQueueDepth -= 1;
      });
  };

  const enqueueStructuredFileChange = (message: { params?: unknown; payload?: unknown }) => {
    if (!isRecord(message.params) || !isRecord(message.params.item)) return;
    const item = message.params.item;
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) return;
    const turnId = notificationTurnId(message);
    if (!turnId) return;

    if (patchCaptureQueueDepth >= FILE_DIFF_PATCH_MAX_PENDING_NOTIFICATIONS) {
      const state = deps.stateStore.read();
      markPatchTurnIncomplete(findTurnContext(notificationThreadId(message), turnId, state).threadId, turnId);
      return;
    }

    patchCaptureQueueDepth += 1;
    patchCaptureChain = patchCaptureChain
      .catch(() => undefined)
      .then(() => captureStructuredFileChange(message))
      .catch((error) => logWarn('Failed to capture structured file change notification', error))
      .finally(() => {
        patchCaptureQueueDepth -= 1;
      });
  };

  const findFileSnapshot = (threadId: string | null, turnId: string | null, filePath: string): FileSnapshot | null => {
    pruneFileSnapshots();
    return (
      fileSnapshots.get(snapshotKey(threadId, turnId, filePath)) ??
      fileSnapshots.get(snapshotKey(null, turnId, filePath)) ??
      fileSnapshots.get(snapshotKey(threadId, null, filePath)) ??
      fileSnapshots.get(snapshotKey(null, null, filePath)) ??
      null
    );
  };

  const buildFileChangeDiff = async (params: FileDiffParams) => {
    const state = deps.stateStore.read();
    const root = trustedDiffRoot(state, params.threadId, params.threadPath);
    const resolvedPath = root ? await resolveDiffPathInsideRoot(root, params.path) : normalizedAbsolutePath(params.path);
    const validatedPath = validatedThreadPath(state, params.threadId, params.turnId, params.threadPath);
    const store = params.turnId && resolvedPath ? openFileEditStore(validatedPath, { readonly: true }) : null;
    try {
      if (store && params.turnId && resolvedPath) {
        const stored = store.getDiff(params.turnId, resolvedPath);
        if (stored) {
          return {
            path: stored.path,
            before: stored.before,
            after: stored.after,
            source: 'stored',
          };
        }

        const storedSnapshot = store.getSnapshot(params.turnId, resolvedPath);
        if (storedSnapshot && root) {
          const after = await readCurrentFileForDiff(storedSnapshot.path);
          return {
            path: storedSnapshot.path,
            before: storedSnapshot.before,
            after,
            source: 'snapshot',
          };
        }
      }
    } finally {
      store?.close();
    }

    const snapshot = resolvedPath ? findFileSnapshot(params.threadId, params.turnId, resolvedPath) : null;
    if (snapshot && root && resolvedPath) {
      return {
        path: resolvedPath,
        before: snapshot.before ?? '',
        after: await readCurrentFileForDiff(resolvedPath),
        source: 'snapshot',
      };
    }

    const reconstructed = explicitBeforeAfterDiff(params.changes) ?? reconstructAddedFileDiff(params.changes) ?? patchSnippetDiff(params.changes);
    if (reconstructed) {
      return { path: resolvedPath ?? params.path, ...reconstructed, source: 'reconstructed' };
    }

    if (!root || !resolvedPath) {
      return {
        path: resolvedPath ?? params.path,
        before: '',
        after: '',
        source: 'current',
      };
    }

    return {
      path: resolvedPath,
      before: '',
      after: await readCurrentFileForDiff(resolvedPath),
      source: 'current',
    };
  };

  const listStoredTurnFiles = (turnId: string, threadId: string | null, threadPath: string | null) => {
    const store = openFileEditStore(validatedThreadPath(deps.stateStore.read(), threadId, turnId, threadPath), { readonly: true });
    if (!store) return [];
    try {
      return store.listTurnFiles(turnId);
    } finally {
      store.close();
    }
  };

  const webuiFileChangeSummaryItem = (turnId: string, files: ReturnType<FileEditStore['listTurnFiles']>) => ({
    type: 'webuiFileChangeSummary',
    id: `webui-file-summary:${turnId}`,
    files: files.map((file) => ({ path: file.path, editCount: file.editCount, hasDiff: file.hasDiff, updatedAtMs: file.updatedAtMs })),
  });

  const augmentTurnWithStoredFileSummary = (turn: unknown, listFiles: (turnId: string) => ReturnType<FileEditStore['listTurnFiles']>): unknown => {
    if (!isRecord(turn)) return turn;
    const turnId = getStringPath(turn, ['id']);
    const status = getStringPath(turn, ['status']);
    if (!turnId || status === 'inProgress') return turn;
    const items = Array.isArray(turn.items) ? turn.items : [];
    if (items.some((item) => isRecord(item) && item.type === 'webuiFileChangeSummary')) return turn;

    const files = listFiles(turnId);
    if (files.length === 0) return turn;
    return { ...turn, items: [...items, webuiFileChangeSummaryItem(turnId, files)] };
  };

  const augmentTurnListWithStoredFileSummaries = (result: unknown, threadId: string): unknown => {
    const state = deps.stateStore.read();
    const threadPath = knownThreadPaths.get(threadId) ?? (state.activeThreadId === threadId ? state.activeThreadPath : null);
    const validatedPath = validatedThreadPath(state, threadId, null, threadPath);
    const store = openFileEditStore(validatedPath, { readonly: true });
    if (!store) return result;

    try {
      const augmentTurns = (turns: unknown[]) => turns.map((turn) => augmentTurnWithStoredFileSummary(turn, (turnId) => store.listTurnFiles(turnId)));

      if (Array.isArray(result)) return augmentTurns(result);
      if (!isRecord(result)) return result;

      let next: Record<string, unknown> = result;
      if (Array.isArray(result.data)) next = { ...next, data: augmentTurns(result.data) };
      if (Array.isArray(result.turns)) next = { ...next, turns: augmentTurns(result.turns) };
      if (isRecord(result.thread) && Array.isArray(result.thread.turns)) {
        next = { ...next, thread: { ...result.thread, turns: augmentTurns(result.thread.turns) } };
      }
      return next;
    } finally {
      store.close();
    }
  };

  const drainPatchCaptureQueue = (): Promise<void> | null => {
    if (patchCaptureQueueDepth === 0) return null;
    return patchCaptureChain.catch((error) => {
      logWarn('Failed to drain file edit capture queue', error);
    });
  };

  const finalizeTurnFileDiffs = (threadPath: string | null, turnId: string): boolean | Promise<boolean> => {
    if (!threadPath || !nodePath.isAbsolute(threadPath) || !fsSync.existsSync(sessionFileEditDbPath(threadPath))) return false;
    const store = openFileEditStore(threadPath);
    if (!store) return false;

    let files: ReturnType<FileEditStore['listTurnFiles']>;
    try {
      files = store.listTurnFiles(turnId);
      if (files.length === 0) {
        store.close();
        return false;
      }
    } catch (error) {
      store.close();
      throw error;
    }

    const finalize = async () => {
      try {
        for (const file of files) {
          const after = await readCurrentFileForDiff(file.path);
          store.finalizeFile({ turnId, path: file.path, after });
        }
        return true;
      } finally {
        store.close();
      }
    };

    return finalize();
  };

  const finalizeTurnFileSummary = async (threadId: string | null, turnId: string, threadPath: string | null) => {
    const drain = drainPatchCaptureQueue();
    if (drain) await drain;
    const state = deps.stateStore.read();
    const key = turnKey(threadId, turnId);
    const finalizeThreadPath =
      threadPath ??
      turnThreadPaths.get(key) ??
      turnThreadPaths.get(turnKey(null, turnId)) ??
      (!threadId || threadId === state.activeThreadId ? state.activeThreadPath : null);
    const finalized = finalizeTurnFileDiffs(finalizeThreadPath, turnId);
    const hasChanges = typeof finalized === 'boolean' ? finalized : await finalized;
    const broadcastThreadId = threadId ?? (state.activeTurnId === turnId ? state.activeThreadId : null);
    if (hasChanges && broadcastThreadId) broadcastFileChangeSummaryChanged(broadcastThreadId, turnId);
    return hasChanges;
  };

  const finalizeActiveTurnBeforeClear = async (threadId: string | null, turnId: string, threadPath: string | null) => {
    try {
      return await finalizeTurnFileSummary(threadId, turnId, threadPath);
    } catch (error) {
      logWarn('Failed to finalize stopped file edit diffs', error);
      return false;
    }
  };

  const broadcastHello = (state: HostRuntimeState = deps.stateStore.read()) => {
    for (const client of wss.clients) {
      sendHello(client, state);
    }
  };

  const clientState = (state: HostRuntimeState): HostRuntimeState => ({
    ...state,
    activeGoal: state.activeGoal?.threadId === state.activeThreadId ? state.activeGoal : null,
    queue: queueForThread(state.queue, state.activeThreadId),
  });

  const sendHello = (client: WebSocket, state: HostRuntimeState = deps.stateStore.read()) => {
    send(client, {
      type: 'server/hello',
      hostname: deps.config.hostname,
      startCwd: deps.startCwd ?? null,
      notificationStreamId,
      state: clientState(state),
      appServerHealth: deps.codex.health(),
      requests: Array.from(pendingServerRequests.values()),
    });
  };

  const setActiveGoalForThread = (goal: ThreadGoal): HostRuntimeState | null => {
    const next = deps.stateStore.update((state) => (state.activeThreadId === goal.threadId ? { ...state, activeGoal: goal } : state));
    return next.activeThreadId === goal.threadId ? next : null;
  };

  const clearActiveGoalForThread = (threadId: string | null): HostRuntimeState | null => {
    let clearedThreadId: string | null = null;
    const next = deps.stateStore.update((state) => {
      if (!state.activeGoal) return state;
      const targetThreadId = threadId ?? state.activeGoal.threadId;
      if (state.activeThreadId !== targetThreadId || state.activeGoal.threadId !== targetThreadId) return state;
      clearedThreadId = targetThreadId;
      return { ...state, activeGoal: null };
    });
    return clearedThreadId && next.activeThreadId === clearedThreadId ? next : null;
  };

  const handleGoalNotification = (message: { method?: unknown; params?: unknown; payload?: unknown }): HostRuntimeState | null => {
    if (message.method === 'thread/goal/updated') {
      const goal = threadGoalFromNotification(message);
      if (!goal) return null;
      goalMutationGeneration += 1;
      return setActiveGoalForThread(goal);
    }
    if (message.method === 'thread/goal/cleared') {
      goalMutationGeneration += 1;
      return clearActiveGoalForThread(notificationThreadId(message));
    }
    return null;
  };

  const notificationByteLength = (message: unknown): number => {
    try {
      return Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch {
      return RECENT_NOTIFICATION_SINGLE_MAX_BYTES + 1;
    }
  };

  const rememberNotification = (message: unknown): number => {
    const seq = (recentNotificationSeq += 1);
    const bytes = notificationByteLength(message);
    if (bytes > RECENT_NOTIFICATION_SINGLE_MAX_BYTES) return seq;

    recentNotifications.push({ seq, message, bytes });
    recentNotificationBytes += bytes;
    while (recentNotifications.length > RECENT_NOTIFICATION_MAX_ENTRIES || recentNotificationBytes > RECENT_NOTIFICATION_MAX_BYTES) {
      const removed = recentNotifications.shift();
      if (!removed) break;
      recentNotificationBytes -= removed.bytes;
    }
    return seq;
  };

  const sendNotification = (client: WebSocket, seq: number, message: unknown) => {
    send(client, { type: 'codex/notification', streamId: notificationStreamId, seq, message });
  };

  const broadcastNotification = (message: unknown) => {
    const seq = rememberNotification(message);
    for (const client of wss.clients) sendNotification(client, seq, message);
  };

  const replayNotifications = (client: WebSocket, requestedStreamId: string | null, afterSeq: number | null) => {
    if (requestedStreamId === null && afterSeq === null) return;
    const sameStream = requestedStreamId === notificationStreamId;
    const effectiveAfterSeq = sameStream ? afterSeq : null;
    const replay = recentNotifications.filter((notification) => effectiveAfterSeq === null || notification.seq > effectiveAfterSeq);

    if (!sameStream) {
      send(client, {
        type: 'codex/replayGap',
        streamId: notificationStreamId,
        requestedAfterSeq: afterSeq,
        firstAvailableSeq: replay[0]?.seq ?? null,
        latestSeq: recentNotificationSeq,
      });
    } else {
      const validationAfterSeq = effectiveAfterSeq ?? 0;
      let expectedSeq = validationAfterSeq + 1;
      let hasGap = validationAfterSeq > recentNotificationSeq;
      for (const notification of replay) {
        if (notification.seq !== expectedSeq) hasGap = true;
        expectedSeq = notification.seq + 1;
      }
      if (expectedSeq <= recentNotificationSeq) hasGap = true;
      if (hasGap) {
        send(client, {
          type: 'codex/replayGap',
          streamId: notificationStreamId,
          requestedAfterSeq: afterSeq,
          firstAvailableSeq: replay[0]?.seq ?? null,
          latestSeq: recentNotificationSeq,
        });
      }
    }

    for (const notification of replay) {
      sendNotification(client, notification.seq, notification.message);
    }
  };

  const clearActiveTurn = (
    expected: { threadId?: string | null; turnId?: string | null } = {},
    options: { broadcast?: boolean } = {},
  ): HostRuntimeState => {
    const current = deps.stateStore.read();
    if (!current.activeTurnId) return current;
    if ('threadId' in expected && current.activeThreadId !== expected.threadId) return current;
    if ('turnId' in expected && current.activeTurnId !== expected.turnId) return current;
    if (current.activeThreadId && isPendingTurnStartForThread(current.activeTurnId, current.activeThreadId)) {
      invalidateRetainedDirectStartContexts(current.activeThreadId);
    }

    const next = deps.stateStore.update((state) => {
      if (!state.activeTurnId) return state;
      if ('threadId' in expected && state.activeThreadId !== expected.threadId) return state;
      if ('turnId' in expected && state.activeTurnId !== expected.turnId) return state;
      return { ...state, activeTurnId: null };
    });
    if (options.broadcast !== false) broadcastHello(next);
    return next;
  };

  const isMissingThreadError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /no rollout found for thread id|failed to resolve rollout path|thread .* is not materialized yet|thread not found|thread .* not found/i.test(message);
  };

  const noRolloutThreadIdFromError = (error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String(error);
    return /no rollout found for thread id\s+([^\s'",}]+)/i.exec(message)?.[1] ?? null;
  };

  const rolloutPathThreadIdFromError = (error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String(error);
    return /rollout-[^/\\`'"]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i.exec(message)?.[1] ?? null;
  };

  const unmaterializedThreadIdFromError = (error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String(error);
    return /thread\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+is not materialized yet/i.exec(message)?.[1] ?? null;
  };

  const missingRolloutThreadIdFromError = (error: unknown): string | null =>
    noRolloutThreadIdFromError(error) ?? rolloutPathThreadIdFromError(error) ?? unmaterializedThreadIdFromError(error);

  const isNoRolloutFoundError = (error: unknown, threadId?: string): boolean => {
    const noRolloutThreadId = missingRolloutThreadIdFromError(error);
    if (!noRolloutThreadId) return false;
    return threadId === undefined || noRolloutThreadId === threadId;
  };

  const shouldReturnEmptyTurnsForPendingRolloutThread = (threadId: string): boolean => {
    const state = deps.stateStore.read();
    return startedPendingRolloutThreadIds.has(threadId) && state.activeThreadId === threadId;
  };

  const markThreadRolloutObserved = (threadId: string | null | undefined): void => {
    if (threadId) startedPendingRolloutThreadIds.delete(threadId);
  };

  const clearMissingActiveThread = (threadId: string, error: unknown): HostRuntimeState => {
    invalidateRetainedDirectStartContexts(threadId);
    resumedThreadIds.delete(threadId);
    startedPendingRolloutThreadIds.delete(threadId);
    resumeThreadPromises.delete(threadId);
    knownThreadPaths.delete(threadId);
    if (runtimeSettingsConfirmation?.threadId === threadId) runtimeSettingsConfirmation = null;
    if (runtimeSettingsUpdateWaiter?.threadId === threadId) {
      cancelRuntimeSettingsUpdateWaiter(runtimeSettingsUpdateWaiter, new Error('active thread disappeared before confirming model and effort update'));
    }
    const current = deps.stateStore.read();
    if (current.activeThreadId !== threadId) return current;

    const next = deps.stateStore.update((state) => {
      if (state.activeThreadId !== threadId) return state;
      return {
        ...state,
        activeThreadId: null,
        activeThreadPath: null,
        activeTurnId: null,
        activeGoal: null,
        modelCapacityRetry: null,
        model: null,
        effort: null,
        mode: null,
        sandbox: null,
      };
    });
    logWarn('Cleared missing active Codex thread', {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    broadcastHello(next);
    return next;
  };

  const stateBeforeAttachActiveTurnClear = deps.stateStore.read();
  const shouldDrainQueueAfterAttachActiveTurnClear = Boolean(
    stateBeforeAttachActiveTurnClear.activeThreadId &&
      stateBeforeAttachActiveTurnClear.activeTurnId &&
      !stateBeforeAttachActiveTurnClear.modelCapacityRetry &&
      queueForThread(stateBeforeAttachActiveTurnClear.queue, stateBeforeAttachActiveTurnClear.activeThreadId).length > 0,
  );
  const attachActiveThreadIdAfterClear = clearActiveTurn({}, { broadcast: false }).activeThreadId;

  const broadcastRequestResolved = (requestId: number | string) => {
    for (const client of wss.clients) {
      send(client, { type: 'codex/requestResolved', requestId });
    }
  };

  const broadcastFileChangeSummaryChanged = (threadId: string, turnId: string) => {
    broadcastNotification({
      jsonrpc: '2.0',
      method: 'webui/fileChange/summaryChanged',
      params: { threadId, turnId },
    });
  };

  const ensureCodexStarted = (): Promise<void> | null => {
    const health = deps.codex.health();
    if (health.connected && !health.dead) return null;
    invalidateResumedThreads();
    return deps.codex.start().then(() => {
      const appServerUrl = deps.codex.getUrl();
      const appServerPid = deps.codex.getPid();
      const current = deps.stateStore.read();
      if (current.appServerUrl === appServerUrl && current.appServerPid === appServerPid) {
        broadcastHello(current);
        return;
      }
      const next = deps.stateStore.update((state) => ({ ...state, appServerUrl, appServerPid }));
      broadcastHello(next);
    });
  };

  const requestCodex = <T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    const call = () => (timeoutMs === undefined ? deps.codex.request<T>(method, params) : deps.codex.request<T>(method, params, timeoutMs));
    const starting = ensureCodexStarted();
    return starting ? starting.then(call) : call();
  };

  const verifyUnscopedActiveCompletionTarget = async (target: ActiveCompletionTarget): Promise<boolean> => {
    try {
      const result = await requestCodex(
        'thread/turns/list',
        { threadId: target.threadId, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded' },
        UNSCOPED_TERMINAL_VERIFY_RPC_TIMEOUT_MS,
      );
      return turnListShowsTerminalTurn(result, target.turnId);
    } catch (error) {
      logWarn('Failed to verify unscoped terminal turn state', error);
      return false;
    }
  };

  const ensureThreadResumed = (threadId: string, requestedThreadPath?: string | null): Promise<void> => {
    if (resumedThreadIds.has(threadId)) return Promise.resolve();
    const existing = resumeThreadPromises.get(threadId);
    if (existing) return existing;

    const resumePath = resumePathForThread(threadId, requestedThreadPath);
    let generation: number | null = null;
    let resumePromise: Promise<void>;
    resumePromise = (async () => {
      const starting = ensureCodexStarted();
      if (starting) await starting;
      generation = appServerGeneration;
      const result = await deps.codex.request(
        'thread/resume',
        {
          threadId,
          ...(resumePath ? { path: resumePath } : {}),
          experimentalRawEvents: true,
          persistExtendedHistory: true,
          excludeTurns: true,
        },
        THREAD_TURNS_LIST_RPC_TIMEOUT_MS,
      );
      const activeCwd = extractThreadCwd(result);
      const activeThreadPath = extractThreadPath(result) ?? resumePath;
      const runtimeStatus = runtimeStatusFromThreadResult(result);
      rememberKnownThreadPath(threadId, activeThreadPath);
      let updatedActiveThread = false;
      const nextState = deps.stateStore.update((state) => {
        if (state.activeThreadId !== threadId) return state;
        updatedActiveThread = true;
        return {
          ...state,
          activeCwd: activeCwd ?? state.activeCwd,
          activeThreadPath: activeThreadPath ?? state.activeThreadPath,
          recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
          ...runtimeStatus,
        };
      });
      if (updatedActiveThread) {
        if (generation === appServerGeneration) recordRuntimeSettingsConfirmation(threadId, runtimeStatus, 'threadResume');
        broadcastHello(nextState);
      }
      const health = deps.codex.health();
      if (generation === appServerGeneration && health.connected && !health.dead) {
        resumedThreadIds.add(threadId);
      }
    })()
      .catch((error) => {
        if (isNoRolloutFoundError(error, threadId) && shouldReturnEmptyTurnsForPendingRolloutThread(threadId)) {
          logWarn('Continuing newly started active Codex thread without rollout during resume', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (isMissingThreadError(error) && !(isNoRolloutFoundError(error, threadId) && shouldReturnEmptyTurnsForPendingRolloutThread(threadId))) {
          clearMissingActiveThread(threadId, error);
        }
        throw error;
      })
      .finally(() => {
        if ((generation === null || generation === appServerGeneration) && resumeThreadPromises.get(threadId) === resumePromise) {
          resumeThreadPromises.delete(threadId);
        }
      });
    resumeThreadPromises.set(threadId, resumePromise);
    return resumePromise;
  };

  const startTurn = async ({ threadId, text, options, clientUserMessageId }: TurnStartParams, onContext?: (context: TurnContext) => void) => {
    await ensureThreadResumed(threadId);
    const context = startContextForThread(threadId);
    onContext?.(context);
    pendingTurnStartContexts.push(context);
    try {
      const result = await requestCodex<{ turn: { id: string } }>(
        'turn/start',
        applyTurnRunOptions(
          {
            threadId,
            ...(clientUserMessageId ? { clientUserMessageId } : {}),
            input: [{ type: 'text', text, text_elements: [] }],
          },
          options,
          context.cwd,
        ),
        TURN_START_RPC_TIMEOUT_MS,
      );
      const health = deps.codex.health();
      if (health.connected && !health.dead) resumedThreadIds.add(threadId);
      return result;
    } finally {
      const index = pendingTurnStartContexts.indexOf(context);
      if (index >= 0) pendingTurnStartContexts.splice(index, 1);
    }
  };

  const scheduledModelCapacityRetry = (
    threadId: string,
    failedTurnId: string,
    attempt: number,
    options: CodexRunOptions | undefined,
  ): ModelCapacityRetry => ({
    status: 'scheduled',
    threadId,
    failedTurnId,
    attempt,
    retryAt: Date.now() + modelCapacityRetryDelayMs(attempt, deps.modelCapacityRetryDelayMs),
    claimedAt: null,
    operationId: randomUUID(),
    retryTurnId: null,
    reconcileCursor: null,
    cancelRequested: false,
    ...(options ? { options } : {}),
  });

  const clearModelCapacityRetry = (operationId?: string): HostRuntimeState | null => {
    let changed = false;
    let clearedOperationId: string | null = null;
    const state = deps.stateStore.update((current) => {
      const retry = current.modelCapacityRetry;
      if (!retry || (operationId && retry.operationId !== operationId)) return current;
      changed = true;
      clearedOperationId = retry.operationId;
      return { ...current, modelCapacityRetry: null };
    });
    if (clearedOperationId) {
      clearModelCapacityTimers();
      currentGenerationCapacityRetryOperations.delete(clearedOperationId);
    }
    return changed ? state : null;
  };

  const scheduleModelCapacityRetry = (
    threadId: string,
    failedTurnId: string,
    attempt: number,
    options: CodexRunOptions | undefined,
    expectedOperationId?: string,
  ): HostRuntimeState | null => {
    const scheduled = scheduledModelCapacityRetry(threadId, failedTurnId, attempt, options);
    let changed = false;
    let replacedOperationId: string | null = null;
    const state = deps.stateStore.update((current) => {
      if (current.activeThreadId !== threadId || current.activeTurnId) return current;
      const existing = current.modelCapacityRetry;
      if (expectedOperationId && existing?.operationId !== expectedOperationId) return current;
      if (existing?.cancelRequested) return { ...current, modelCapacityRetry: null };
      if (!expectedOperationId && existing) return current;
      changed = true;
      replacedOperationId = existing?.operationId ?? null;
      return { ...current, modelCapacityRetry: scheduled };
    });
    if (!changed) return null;
    if (replacedOperationId) currentGenerationCapacityRetryOperations.delete(replacedOperationId);
    broadcastHello(state);
    armModelCapacityRetry(state.modelCapacityRetry);
    return state;
  };

  const scheduleModelCapacityReconciliation = (retry: ModelCapacityRetry): void => {
    if (modelCapacityReconcileTimer) clearTimeout(modelCapacityReconcileTimer);
    const delay = deps.modelCapacityReconcileDelayMs ?? MODEL_CAPACITY_RECONCILE_DELAY_MS;
    modelCapacityReconcileTimer = setTimeout(() => {
      modelCapacityReconcileTimer = null;
      void reconcilePersistedModelCapacityRetry(retry.operationId);
    }, Math.max(0, delay));
    modelCapacityReconcileTimer.unref?.();
  };

  const rescheduleModelCapacityRetry = (retry: ModelCapacityRetry, failedTurnId = retry.failedTurnId): void => {
    const state = deps.stateStore.read();
    const current = state.modelCapacityRetry;
    if (!current || current.operationId !== retry.operationId) return;
    if (current.cancelRequested) {
      const cleared = clearModelCapacityRetry(retry.operationId);
      if (cleared) broadcastHello(cleared);
      return;
    }
    const cleared = deps.stateStore.update((latest) => (
      latest.modelCapacityRetry?.operationId === retry.operationId
        ? { ...latest, activeTurnId: null }
        : latest
    ));
    currentGenerationCapacityRetryOperations.delete(retry.operationId);
    scheduleModelCapacityRetry(retry.threadId, failedTurnId, retry.attempt + 1, retry.options, retry.operationId);
    if (cleared.modelCapacityRetry?.operationId !== retry.operationId) broadcastHello(cleared);
  };

  const markModelCapacityRetryCancelled = (operationId: string): ModelCapacityRetry | null => {
    let marked: ModelCapacityRetry | null = null;
    const state = deps.stateStore.update((current) => {
      const retry = current.modelCapacityRetry;
      if (!retry || retry.operationId !== operationId) return current;
      marked = retry.cancelRequested ? retry : { ...retry, cancelRequested: true };
      return retry.cancelRequested ? current : { ...current, modelCapacityRetry: marked };
    });
    if (marked) broadcastHello(state);
    return marked;
  };

  const interruptAcceptedModelCapacityRetry = async (retry: ModelCapacityRetry): Promise<void> => {
    const turnId = retry.retryTurnId;
    if (!turnId) return;
    try {
      await ensureThreadResumed(retry.threadId);
      await requestCodex('turn/interrupt', { threadId: retry.threadId, turnId });
    } catch (error) {
      if (!shouldClearActiveTurnAfterInterruptFailure(error)) {
        logWarn('Failed to interrupt cancelled model-capacity retry turn', error);
        scheduleModelCapacityReconciliation(retry);
        return;
      }
    }
    await finalizeActiveTurnBeforeClear(retry.threadId, turnId, deps.stateStore.read().activeThreadPath);
    const cleared = clearModelCapacityRetry(retry.operationId);
    const state = deps.stateStore.update((current) => (
      current.activeTurnId === turnId ? { ...current, activeTurnId: null } : current
    ));
    if (cleared || state.activeTurnId !== turnId) broadcastHello(state);
  };

  const runModelCapacityRetry = async (retry: ModelCapacityRetry): Promise<void> => {
    try {
      const result = await startTurn({
        threadId: retry.threadId,
        text: MODEL_CAPACITY_RETRY_PROMPT,
        options: retry.options,
        clientUserMessageId: retry.operationId,
      });
      const turnId = extractTurnId(result);
      if (!turnId) {
        logWarn('Model-capacity retry turn/start returned no turn id; reconciling by client message id');
        scheduleModelCapacityReconciliation(retry);
        return;
      }
      const alreadyCompleted = hasCompletedTurn(retry.threadId, turnId);
      const state = deps.stateStore.update((current) => {
        const live = current.modelCapacityRetry;
        if (!live || live.operationId !== retry.operationId) return current;
        const acceptedRetry: ModelCapacityRetry = {
          ...live,
          status: 'inFlight',
          retryAt: null,
          claimedAt: live.claimedAt ?? Date.now(),
          retryTurnId: turnId,
          reconcileCursor: null,
        };
        return {
          ...current,
          activeTurnId: alreadyCompleted ? null : turnId,
          modelCapacityRetry: alreadyCompleted && !live.cancelRequested ? live : acceptedRetry,
        };
      });
      const acceptedRetry = state.modelCapacityRetry?.operationId === retry.operationId
        ? state.modelCapacityRetry
        : null;
      if (state.activeThreadId === retry.threadId && state.activeTurnId === turnId) {
        rememberTurnThreadPath(retry.threadId, turnId, state.activeThreadPath);
        rememberTurnCwd(retry.threadId, turnId, state.activeCwd);
        rememberLivePatchTurn(retry.threadId, turnId);
        rememberObservedTurnStart(retry.threadId, turnId);
      }
      broadcastHello(state);
      if (alreadyCompleted && acceptedRetry) {
        scheduleModelCapacityReconciliation(acceptedRetry);
      } else if (acceptedRetry?.cancelRequested) {
        void interruptAcceptedModelCapacityRetry(acceptedRetry);
      } else if (!alreadyCompleted) {
        maybeSteerQueuedMessage();
      }
    } catch (error) {
      if (isTurnStartTimeout(error)) {
        scheduleModelCapacityReconciliation(retry);
        return;
      }
      logWarn('Failed to start model-capacity retry turn', error);
      rescheduleModelCapacityRetry(retry);
    }
  };

  function armModelCapacityRetry(retry: ModelCapacityRetry | null): void {
    if (modelCapacityRetryTimer) clearTimeout(modelCapacityRetryTimer);
    modelCapacityRetryTimer = null;
    if (!retry || retry.status !== 'scheduled' || retry.cancelRequested || retry.retryAt === null) return;
    const remainingDelayMs = retry.retryAt - Date.now();
    if (remainingDelayMs > MAX_TIMER_DELAY_MS) {
      modelCapacityRetryTimer = setTimeout(() => {
        modelCapacityRetryTimer = null;
        armModelCapacityRetry(deps.stateStore.read().modelCapacityRetry);
      }, MAX_TIMER_DELAY_MS);
      modelCapacityRetryTimer.unref?.();
      return;
    }
    modelCapacityRetryTimer = setTimeout(() => {
      modelCapacityRetryTimer = null;
      const health = deps.codex.health();
      const state = deps.stateStore.update((current) => {
        const live = current.modelCapacityRetry;
        if (
          !live ||
          live.operationId !== retry.operationId ||
          live.status !== 'scheduled' ||
          live.cancelRequested ||
          current.activeThreadId !== live.threadId ||
          current.activeTurnId ||
          !health.connected ||
          health.dead ||
          sessionChangeInFlight ||
          runtimeOptionUpdates.has(live.threadId) ||
          goalUpdates.has(live.threadId)
        ) {
          return current;
        }
        const claimedRetry: ModelCapacityRetry = {
          ...live,
          status: 'starting',
          retryAt: null,
          claimedAt: Date.now(),
          retryTurnId: null,
          reconcileCursor: null,
        };
        return { ...current, activeTurnId: pendingTurnStartTurnId(live.threadId), modelCapacityRetry: claimedRetry };
      });
      const claimed = state.modelCapacityRetry?.operationId === retry.operationId && state.modelCapacityRetry.status === 'starting'
        ? state.modelCapacityRetry
        : null;
      if (!claimed) {
        const live = state.modelCapacityRetry;
        if (live?.operationId === retry.operationId && live.status === 'scheduled') {
          const deferredRetry: ModelCapacityRetry = {
            ...live,
            retryAt: Math.max(Date.now() + 1_000, live.retryAt ?? 0),
          };
          const deferred = deps.stateStore.update((current) => (
            current.modelCapacityRetry?.operationId === live.operationId
              ? { ...current, modelCapacityRetry: deferredRetry }
              : current
          ));
          armModelCapacityRetry(deferred.modelCapacityRetry);
        }
        return;
      }
      currentGenerationCapacityRetryOperations.add(claimed.operationId);
      broadcastHello(state);
      void runModelCapacityRetry(claimed);
    }, Math.max(0, remainingDelayMs));
    modelCapacityRetryTimer.unref?.();
  }

  const reconcilePersistedModelCapacityRetry = async (operationId: string): Promise<void> => {
    const retry = deps.stateStore.read().modelCapacityRetry;
    if (!retry || retry.operationId !== operationId || retry.status === 'scheduled') return;
    if (retry.cancelRequested && retry.status === 'inFlight' && retry.retryTurnId) {
      void interruptAcceptedModelCapacityRetry(retry);
      return;
    }
    try {
      await ensureThreadResumed(retry.threadId);
      const sameGenerationAmbiguousStart = currentGenerationCapacityRetryOperations.has(retry.operationId);
      let cursor: string | null = sameGenerationAmbiguousStart ? null : retry.reconcileCursor;
      const seenCursors = new Set<string>(cursor ? [cursor] : []);
      let authoritative = false;
      let matchedTurn: unknown = null;
      for (let page = 0; page < MODEL_CAPACITY_RECONCILE_MAX_PAGES; page += 1) {
        const result: unknown = await requestCodex('thread/turns/list', {
          threadId: retry.threadId,
          cursor,
          limit: MODEL_CAPACITY_RECONCILE_PAGE_LIMIT,
          sortDirection: 'desc',
          itemsView: 'summary',
        }, THREAD_TURNS_LIST_RPC_TIMEOUT_MS);
        const turns = turnsFromTurnListResult(result);
        matchedTurn = turns.find((turn) => turnUserMessageClientId(turn) === retry.operationId) ?? null;
        if (matchedTurn) {
          authoritative = true;
          break;
        }
        const nextCursor: string | null = getStringPath(result, ['nextCursor']) ?? getStringPath(result, ['next_cursor']);
        const crossedBoundary = turns.some((turn) => {
          const startedAt = finiteNumber(getValuePath(turn, ['startedAt']) ?? getValuePath(turn, ['started_at']));
          return startedAt !== null && retry.claimedAt !== null && startedAt * 1000 < retry.claimedAt - 2_000;
        });
        if (!nextCursor || crossedBoundary) {
          authoritative = true;
          break;
        }
        if (seenCursors.has(nextCursor)) {
          logWarn('Model-capacity retry reconciliation returned a repeated cursor', {
            threadId: retry.threadId,
            operationId: retry.operationId,
          });
          scheduleModelCapacityReconciliation(retry);
          return;
        }
        seenCursors.add(nextCursor);
        if (page === MODEL_CAPACITY_RECONCILE_MAX_PAGES - 1) {
          if (!sameGenerationAmbiguousStart) {
            deps.stateStore.update((current) => (
              current.modelCapacityRetry?.operationId === retry.operationId
                ? { ...current, modelCapacityRetry: { ...current.modelCapacityRetry, reconcileCursor: nextCursor } }
                : current
            ));
          }
          scheduleModelCapacityReconciliation(retry);
          return;
        }
        cursor = nextCursor;
      }
      if (!authoritative) {
        scheduleModelCapacityReconciliation(retry);
        return;
      }
      if (!matchedTurn) {
        if (sameGenerationAmbiguousStart) {
          scheduleModelCapacityReconciliation(retry);
        } else if (retry.cancelRequested) {
          const cleared = clearModelCapacityRetry(retry.operationId);
          if (cleared) broadcastHello(cleared);
        } else {
          rescheduleModelCapacityRetry(retry);
        }
        return;
      }
      const matchedTurnId = turnRecordId(matchedTurn);
      const status = turnStatusText(getValuePath(matchedTurn, ['status']) ?? getValuePath(matchedTurn, ['state']));
      if (status === 'inProgress' && matchedTurnId && currentGenerationCapacityRetryOperations.has(retry.operationId)) {
        const adopted = deps.stateStore.update((current) => {
          const live = current.modelCapacityRetry;
          if (!live || live.operationId !== retry.operationId) return current;
          return {
            ...current,
            activeTurnId: matchedTurnId,
            modelCapacityRetry: {
              ...live,
              status: 'inFlight',
              retryAt: null,
              claimedAt: live.claimedAt ?? Date.now(),
              retryTurnId: matchedTurnId,
              reconcileCursor: null,
            },
          };
        });
        broadcastHello(adopted);
        const adoptedRetry = adopted.modelCapacityRetry;
        if (adoptedRetry?.operationId === retry.operationId && adoptedRetry.cancelRequested) {
          void interruptAcceptedModelCapacityRetry(adoptedRetry);
        }
        return;
      }
      if (retry.cancelRequested) {
        const cleared = clearModelCapacityRetry(retry.operationId);
        if (cleared) broadcastHello(cleared);
        return;
      }
      if (status === 'failed' && isModelCapacityError(getValuePath(matchedTurn, ['error']))) {
        rescheduleModelCapacityRetry(retry, matchedTurnId ?? retry.failedTurnId);
        return;
      }
      if (status === 'inProgress') {
        rescheduleModelCapacityRetry(retry, matchedTurnId ?? retry.failedTurnId);
        return;
      }
      const cleared = clearModelCapacityRetry(retry.operationId);
      if (cleared) broadcastHello(cleared);
    } catch (error) {
      logWarn('Failed to reconcile persisted model-capacity retry', error);
      scheduleModelCapacityReconciliation(retry);
    }
  };

  const steerTurn = async ({ threadId, turnId, queuedMessage }: QueuedSteerClaim) => {
    await ensureThreadResumed(threadId);
    const current = deps.stateStore.read();
    if (current.activeThreadId !== threadId || current.activeTurnId !== turnId || isTerminalOrCompletingTurn(threadId, turnId)) {
      throw new Error('active turn is no longer steerable');
    }
    return requestCodex(
      'turn/steer',
      {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: queuedMessage.text, text_elements: [] }],
      },
      TURN_STEER_RPC_TIMEOUT_MS,
    );
  };

  const interruptActiveTurnForThread = async (threadId: string): Promise<HostRuntimeState | null> => {
    const state = deps.stateStore.read();
    if (state.activeThreadId !== threadId || !state.activeTurnId) return null;

    const activeTurnId = state.activeTurnId;
    const activeThreadPath = state.activeThreadPath;
    rememberCancelledTurn(threadId, activeTurnId);
    const health = deps.codex.health();
    if (!health.connected || health.dead) {
      await finalizeActiveTurnBeforeClear(threadId, activeTurnId, activeThreadPath);
      return clearActiveTurn({ threadId, turnId: activeTurnId }, { broadcast: false });
    }

    try {
      await ensureThreadResumed(threadId);
      await requestCodex('turn/interrupt', { threadId, turnId: activeTurnId });
    } catch (error) {
      if (!shouldClearActiveTurnAfterInterruptFailure(error)) throw error;
    }
    await finalizeActiveTurnBeforeClear(threadId, activeTurnId, activeThreadPath);
    return clearActiveTurn({ threadId, turnId: activeTurnId }, { broadcast: false });
  };

  const shouldInterruptActiveGoalTurn = (threadId: string): boolean => {
    const state = deps.stateStore.read();
    return state.activeThreadId === threadId && state.activeGoal?.threadId === threadId && state.activeGoal.status === 'active' && Boolean(state.activeTurnId);
  };

  const turnStartInFlightForThread = (threadId: string): boolean => {
    if (pendingTurnStartContexts.some((context) => context.threadId === threadId)) return true;
    const state = deps.stateStore.read();
    return state.activeThreadId === threadId && isPendingTurnStartForThread(state.activeTurnId, threadId);
  };

  const compactionInFlightForThread = (threadId: string): boolean => {
    return compactionsInFlight.has(threadId);
  };

  const pruneTimedOutQueuedStarts = (queue: QueuedMessage[]): void => {
    for (const [threadId, recovery] of timedOutQueuedStarts) {
      const stillQueued = queue.some((message) => (
        message.threadId === threadId && message.id === recovery.id && message.text === recovery.text
      ));
      if (!stillQueued) timedOutQueuedStarts.delete(threadId);
    }
  };

  const markTimedOutRecoveryMaybeSent = (threadId: string, recovery: TimedOutQueuedStart): HostRuntimeState => {
    const state = deps.stateStore.update((current) => ({
      ...current,
      queue: current.queue.map((message) => (
        message.threadId === threadId && message.id === recovery.id && message.text === recovery.text
          ? { ...message, deliveryState: 'maybeSent' as const }
          : message
      )),
    }));
    pruneTimedOutQueuedStarts(state.queue);
    return state;
  };

  const removeTimedOutRecovery = (threadId: string, recovery: TimedOutQueuedStart): HostRuntimeState => {
    const state = deps.stateStore.update((current) => ({
      ...current,
      queue: current.queue.filter((message) => (
        message.threadId !== threadId || message.id !== recovery.id || message.text !== recovery.text
      )),
    }));
    pruneTimedOutQueuedStarts(state.queue);
    return state;
  };

  const restoreQueuedMessageToFront = (threadId: string, queuedMessage: QueuedMessage): HostRuntimeState => {
    const state = deps.stateStore.update((current) => {
      const queue = prependQueuedMessagesForThread(current.queue, threadId, [queuedMessage], deps.config.queueLimit);
      return {
        ...current,
        queue,
      };
    });
    pruneTimedOutQueuedStarts(state.queue);
    return state;
  };

  const startQueuedTurnFromIdle = (threadId: string, queuedMessage: QueuedMessage): void => {
    if (queuedStartInFlight) return;
    queuedStartInFlight = { threadId, queuedMessage };

    void (async () => {
      let completedBeforeStartReturned = false;
      try {
        const result = await startTurn({ threadId, text: queuedMessage.text, options: queuedMessage.options });
        const nextTurnId = extractTurnId(result);
        timedOutQueuedStarts.delete(threadId);
        const alreadyCompleted = hasCompletedTurn(threadId, nextTurnId);
        completedBeforeStartReturned = alreadyCompleted;
        const next = deps.stateStore.update((current) => {
          if (current.activeThreadId !== threadId) return current;
          if (alreadyCompleted && (current.activeTurnId === nextTurnId || isPendingTurnStartForThread(current.activeTurnId, threadId))) {
            return applyRunOptionsToRuntimeState({ ...current, activeTurnId: null }, queuedMessage.options);
          }
          if (current.activeTurnId === nextTurnId) return applyRunOptionsToRuntimeState(current, queuedMessage.options);
          if (isPendingTurnStartForThread(current.activeTurnId, threadId)) {
            return applyRunOptionsToRuntimeState({ ...current, activeTurnId: nextTurnId }, queuedMessage.options);
          }
          return current;
        });
        if (next.activeThreadId === threadId) {
          rememberTurnThreadPath(threadId, nextTurnId, next.activeThreadPath);
          rememberTurnCwd(threadId, nextTurnId, next.activeCwd);
          rememberLivePatchTurn(threadId, nextTurnId);
          rememberObservedTurnStart(threadId, nextTurnId);
        }
        broadcastHello(next);
      } catch (error) {
        logWarn('Failed to start queued turn', error);
        if (isTurnStartTimeout(error)) {
          let restoredQueuedMessage = false;
          const next = deps.stateStore.update((current) => {
            if (current.activeThreadId !== threadId || !isPendingTurnStartForThread(current.activeTurnId, threadId)) return current;
            restoredQueuedMessage = true;
            return {
              ...current,
              activeTurnId: null,
              queue: prependQueuedMessagesForThread(current.queue, threadId, [queuedMessage], deps.config.queueLimit),
            };
          });
          pruneTimedOutQueuedStarts(next.queue);
          if (
            restoredQueuedMessage &&
            next.queue.some((message) => message.threadId === threadId && message.id === queuedMessage.id && message.text === queuedMessage.text)
          ) {
            timedOutQueuedStarts.set(threadId, { id: queuedMessage.id, text: queuedMessage.text });
          }
          broadcastHello(next);
          return;
        }
        const next = deps.stateStore.update((current) => {
          if (current.activeThreadId !== threadId || !isPendingTurnStartForThread(current.activeTurnId, threadId)) return current;
          return {
            ...current,
            activeTurnId: null,
            queue: prependQueuedMessagesForThread(current.queue, threadId, [queuedMessage], deps.config.queueLimit),
          };
        });
        pruneTimedOutQueuedStarts(next.queue);
        broadcastHello(next);
      } finally {
        queuedStartInFlight = null;
        if (!completedBeforeStartReturned || !maybeStartQueuedTurnFromIdle(threadId)) maybeSteerQueuedMessage();
      }
    })();
  };

  const maybeStartQueuedTurnFromIdle = (threadId: string): boolean => {
    if (queuedStartInFlight || runtimeOptionUpdates.has(threadId)) return false;
    if (goalUpdates.has(threadId)) {
      const current = deps.stateStore.read();
      if (
        current.activeThreadId === threadId &&
        !current.activeTurnId &&
        queueForThread(current.queue, threadId, { runnableOnly: true }).length > 0
      ) {
        suppressedGoalQueueStarts.add(threadId);
      }
      return false;
    }
    let claim: QueuedTurnClaim | null = null;
    const claimed = deps.stateStore.update((current) => {
      if (modelCapacityRetryForThread(current, threadId)) return current;
      if (current.activeThreadId !== threadId || current.activeTurnId || !current.activeThreadId) return current;
      const shifted = shiftQueuedMessage(current.queue, threadId, { runnableOnly: true });
      if (!shifted.next) return current;
      claim = { threadId: current.activeThreadId, queuedMessage: shifted.next };
      return applyRunOptionsToRuntimeState(
        { ...current, activeTurnId: pendingTurnStartTurnId(current.activeThreadId), queue: shifted.queue },
        shifted.next.options,
      );
    });
    pruneTimedOutQueuedStarts(claimed.queue);

    const claimToStart = claim as QueuedTurnClaim | null;
    if (!claimToStart) return false;
    broadcastHello(claimed);
    startQueuedTurnFromIdle(claimToStart.threadId, claimToStart.queuedMessage);
    return true;
  };

  if (shouldDrainQueueAfterAttachActiveTurnClear && attachActiveThreadIdAfterClear) {
    queueMicrotask(() => {
      maybeStartQueuedTurnFromIdle(attachActiveThreadIdAfterClear);
    });
  }

  const maybeSteerQueuedMessage = (): void => {
    if (queuedSteerInFlight || queuedStartInFlight) return;

    let claim: QueuedSteerClaim | null = null;
    const claimed = deps.stateStore.update((current) => {
      if (modelCapacityRetryForThread(current, current.activeThreadId)) return current;
      if (!current.activeThreadId || !current.activeTurnId) return current;
      if (goalUpdates.has(current.activeThreadId)) {
        const nextQueuedMessage = queueForThread(current.queue, current.activeThreadId, { runnableOnly: true })[0];
        if (
          current.activeTurnId &&
          !isPendingTurnForThread(current.activeTurnId, current.activeThreadId) &&
          !isTerminalOrCompletingTurn(current.activeThreadId, current.activeTurnId) &&
          nextQueuedMessage &&
          queuedRunOptionsMatchActiveTurn(current, nextQueuedMessage)
        ) {
          suppressedGoalQueueSteers.add(current.activeThreadId);
        }
        return current;
      }
      if (isPendingTurnForThread(current.activeTurnId, current.activeThreadId)) return current;
      if (isTerminalOrCompletingTurn(current.activeThreadId, current.activeTurnId)) return current;
      const nextQueuedMessage = queueForThread(current.queue, current.activeThreadId, { runnableOnly: true })[0];
      if (!nextQueuedMessage || !queuedRunOptionsMatchActiveTurn(current, nextQueuedMessage)) return current;
      const shifted = shiftQueuedMessage(current.queue, current.activeThreadId, { runnableOnly: true });
      if (!shifted.next) return current;
      claim = { threadId: current.activeThreadId, turnId: current.activeTurnId, queuedMessage: shifted.next };
      return { ...current, queue: shifted.queue };
    });
    pruneTimedOutQueuedStarts(claimed.queue);

    const claimToSteer = claim as QueuedSteerClaim | null;
    if (!claimToSteer) return;
    const inFlight: QueuedSteerInFlight = { ...claimToSteer, terminalDisposition: null, settled: false, timedOut: false };
    queuedSteerInFlight = inFlight;
    broadcastHello(claimed);

    void (async () => {
      let followUp: 'drain-active-turn' | 'start-next-turn' | null = null;
      try {
        await steerTurn(claimToSteer);
        inFlight.settled = true;
        const terminalDisposition = inFlight.terminalDisposition;
        if (terminalDisposition === 'barrier') {
          const restored = restoreQueuedMessageToFront(claimToSteer.threadId, claimToSteer.queuedMessage);
          if (restored) broadcastHello(restored);
        } else if (terminalDisposition === 'advance-queue') {
          const current = deps.stateStore.read();
          if (autonomousSuccessorDisposition(claimToSteer) === 'barrier') {
            followUp = null;
          } else if (
            current.activeThreadId === claimToSteer.threadId &&
            current.activeTurnId &&
            current.activeTurnId !== claimToSteer.turnId
          ) {
            followUp = 'drain-active-turn';
          } else if (current.activeThreadId !== claimToSteer.threadId || current.activeTurnId !== claimToSteer.turnId) {
            followUp = 'start-next-turn';
          }
        } else {
          const current = deps.stateStore.read();
          if (current.activeThreadId === claimToSteer.threadId && current.activeTurnId === claimToSteer.turnId) {
            followUp = 'drain-active-turn';
          }
        }
      } catch (error) {
        logWarn('Failed to steer queued message into active turn', error);
        inFlight.settled = true;
        const timedOut = isTurnSteerTimeout(error);
        inFlight.timedOut = timedOut;
        const terminalDisposition = inFlight.terminalDisposition;
        const restoredMessage: QueuedMessage =
          terminalDisposition === 'advance-queue' && timedOut
            ? { ...claimToSteer.queuedMessage, deliveryState: 'maybeSent' }
            : claimToSteer.queuedMessage;
        const restored = restoreQueuedMessageToFront(claimToSteer.threadId, restoredMessage);
        if (restored) broadcastHello(restored);
        if (terminalDisposition === 'advance-queue') {
          const current = deps.stateStore.read();
          if (autonomousSuccessorDisposition(claimToSteer) === 'barrier') {
            followUp = null;
          } else if (
            current.activeThreadId === claimToSteer.threadId &&
            current.activeTurnId &&
            current.activeTurnId !== claimToSteer.turnId
          ) {
            followUp = 'drain-active-turn';
          } else if (current.activeThreadId !== claimToSteer.threadId || current.activeTurnId !== claimToSteer.turnId) {
            followUp = 'start-next-turn';
          }
        }
      } finally {
        if (queuedSteerInFlight === inFlight) queuedSteerInFlight = null;
      }
      if (followUp === 'start-next-turn') {
        maybeStartQueuedTurnFromIdle(claimToSteer.threadId);
      } else if (followUp === 'drain-active-turn') {
        maybeSteerQueuedMessage();
      }
    })();
  };

  const wakeQueuedWorkAfterGoalUpdate = (
    threadId: string,
    options: { allowStart: boolean; allowSteer: boolean },
  ): void => {
    queueMicrotask(() => {
      if (goalUpdates.has(threadId)) return;
      const startWasSuppressed = suppressedGoalQueueStarts.delete(threadId);
      const steerWasSuppressed = suppressedGoalQueueSteers.delete(threadId);
      if (options.allowSteer && steerWasSuppressed) maybeSteerQueuedMessage();
      if (options.allowStart && startWasSuppressed) maybeStartQueuedTurnFromIdle(threadId);
    });
  };

  const markQueuedMessageMaybeSent = (threadId: string, queuedMessageId: string): HostRuntimeState | null => {
    let changed = false;
    const next = deps.stateStore.update((state) => {
      const queue = state.queue.map((message) => {
        if (message.id !== queuedMessageId || message.threadId !== threadId) return message;
        if (message.deliveryState === 'maybeSent') return message;
        changed = true;
        return { ...message, deliveryState: 'maybeSent' as const };
      });
      return changed ? { ...state, queue } : state;
    });
    return changed ? next : null;
  };

  const resumeQueuedWorkAfterSettledCompletionSteer = (steer: QueuedSteerInFlight): void => {
    if (steer.timedOut) {
      const next = markQueuedMessageMaybeSent(steer.threadId, steer.queuedMessage.id);
      if (next) broadcastHello(next);
    }
    if (autonomousSuccessorDisposition(steer) === 'barrier') return;
    const current = deps.stateStore.read();
    if (current.activeThreadId === steer.threadId && current.activeTurnId && current.activeTurnId !== steer.turnId) {
      maybeSteerQueuedMessage();
      return;
    }
    maybeStartQueuedTurnFromIdle(steer.threadId);
  };

  const handleTurnCompleted = async (message: { method?: unknown; params?: unknown; payload?: unknown }, disposition: TerminalDisposition) => {
    const advanceQueue = disposition === 'advance-queue';
    const allowMissingTurnId = advanceQueue;
    const completedThreadId = notificationThreadId(message);
    const completedTurnId = notificationTurnId(message);
    const receiptState = deps.stateStore.read();
    const legacyCapacityKey = completedTurnId ? turnKey(completedThreadId, completedTurnId) : null;
    const cancelledCapacityTurn = Boolean(
      completedTurnId &&
      (
        cancelledTurnKeys.has(turnKey(completedThreadId, completedTurnId)) ||
        cancelledTurnKeys.has(turnKey(receiptState.activeThreadId, completedTurnId)) ||
        cancelledTurnKeys.has(turnKey(null, completedTurnId))
      ),
    );
    if (completedTurnId) {
      cancelledTurnKeys.delete(turnKey(completedThreadId, completedTurnId));
      cancelledTurnKeys.delete(turnKey(receiptState.activeThreadId, completedTurnId));
      cancelledTurnKeys.delete(turnKey(null, completedTurnId));
    }
    const failedTurnCompleted =
      message.method === 'turn/completed' && getStringPath(message.params, ['turn', 'status']) === 'failed';
    const capacityFailure =
      !cancelledCapacityTurn &&
      (
        isFailedModelCapacityCompletion(message) ||
        Boolean(failedTurnCompleted && legacyCapacityKey && legacyModelCapacityFailureKeys.has(legacyCapacityKey))
      );
    if (legacyCapacityKey) legacyModelCapacityFailureKeys.delete(legacyCapacityKey);
    const noTurnActiveTarget: ActiveCompletionTarget | null =
      advanceQueue &&
      !completedTurnId &&
      receiptState.activeThreadId &&
      receiptState.activeTurnId &&
      !isPendingTurnForThread(receiptState.activeTurnId, receiptState.activeThreadId) &&
      ((completedThreadId && completedThreadId === receiptState.activeThreadId) ||
        (!completedThreadId && hasObservedTurnStart(receiptState.activeThreadId, receiptState.activeTurnId)))
        ? { threadId: receiptState.activeThreadId, turnId: receiptState.activeTurnId }
        : null;
    const noTurnVerificationKey = noTurnActiveTarget ? turnKey(noTurnActiveTarget.threadId, noTurnActiveTarget.turnId) : null;
    const steerAtReceipt = queuedSteerInFlight;
    const retryAtReceipt = receiptState.modelCapacityRetry;
    let resumeSteeringAfterIgnoredNoTurn = false;
    if (noTurnVerificationKey) {
      verifyingUnscopedTerminalKeys.set(
        noTurnVerificationKey,
        (verifyingUnscopedTerminalKeys.get(noTurnVerificationKey) ?? 0) + 1,
      );
    }

    try {
      let verifiedNoTurnActiveTarget: ActiveCompletionTarget | null = null;
      if (noTurnActiveTarget) {
        const verified = await verifyUnscopedActiveCompletionTarget(noTurnActiveTarget);
        if (verified) {
          verifiedNoTurnActiveTarget = noTurnActiveTarget;
        } else {
          resumeSteeringAfterIgnoredNoTurn = true;
          return;
        }
      }

      const current = verifiedNoTurnActiveTarget ? deps.stateStore.read() : receiptState;
      const pendingCompactionNoTurnCompletion = Boolean(
        message.method === 'thread/compacted' &&
          advanceQueue &&
          !completedTurnId &&
          completedThreadId &&
          completedThreadId === current.activeThreadId &&
          isPendingCompactionTurnForThread(current.activeTurnId, current.activeThreadId),
      );
      const completingSteer: QueuedSteerInFlight | null =
        verifiedNoTurnActiveTarget &&
        steerAtReceipt &&
        steerAtReceipt.threadId === verifiedNoTurnActiveTarget.threadId &&
          steerAtReceipt.turnId === verifiedNoTurnActiveTarget.turnId
          ? steerAtReceipt
          : !verifiedNoTurnActiveTarget &&
              queuedSteerInFlight &&
              (!completedThreadId || completedThreadId === queuedSteerInFlight.threadId) &&
              completionMatchesActiveTurn(queuedSteerInFlight.turnId, queuedSteerInFlight.threadId, completedTurnId, {
                allowMissingTurnId,
                completedThreadId,
              })
            ? queuedSteerInFlight
            : null;
    if (completingSteer) completingSteer.terminalDisposition = disposition;

    const matchedCurrentActiveTurnAtReceipt =
      Boolean(current.activeTurnId) &&
      (
        pendingCompactionNoTurnCompletion ||
        (completedTurnId !== null &&
          (!completedThreadId || completedThreadId === current.activeThreadId) &&
          completionMatchesActiveTurn(current.activeTurnId, current.activeThreadId, completedTurnId, {
            allowMissingTurnId,
            completedThreadId,
          }))
      );
    const activeCompletionTarget = verifiedNoTurnActiveTarget ?? (matchedCurrentActiveTurnAtReceipt
      ? { threadId: current.activeThreadId, turnId: current.activeTurnId }
      : null);
    const turnIdToFinalize = completedTurnId ?? activeCompletionTarget?.turnId ?? null;
    const threadIdToFinalize = completedThreadId ?? activeCompletionTarget?.threadId ?? null;
    const activeStateMatchesCompletionTarget = (state: HostRuntimeState): boolean => {
      if (!activeCompletionTarget?.turnId || !state.activeTurnId) return false;
      if (activeCompletionTarget.threadId && activeCompletionTarget.threadId !== state.activeThreadId) return false;
      if (state.activeTurnId === activeCompletionTarget.turnId) return true;
      return Boolean(
        completedTurnId &&
          isPendingCompactionTurnForThread(activeCompletionTarget.turnId, activeCompletionTarget.threadId) &&
          state.activeTurnId === completedTurnId,
      );
    };
    const completionKey = turnIdToFinalize ? turnKey(threadIdToFinalize, turnIdToFinalize) : null;
    if (completionKey && (completingTurnKeys.has(completionKey) || completedTurnKeys.has(completionKey))) return;
    if (completionKey) {
      completingTurnKeys.add(completionKey);
      rememberTerminalTurnKey(completionKey, disposition);
    }
    let finalizedForCompletionKey = false;

    if (turnIdToFinalize) {
      try {
        const finalizeThreadPath =
          (completionKey ? turnThreadPaths.get(completionKey) : null) ??
          (!threadIdToFinalize || threadIdToFinalize === current.activeThreadId ? current.activeThreadPath : null);
        await finalizeTurnFileSummary(threadIdToFinalize, turnIdToFinalize, finalizeThreadPath);
        finalizedForCompletionKey = true;
      } catch (error) {
        logWarn('Failed to finalize file edit diffs', error);
      }
    } else {
      finalizedForCompletionKey = true;
    }

    const afterFinalize = deps.stateStore.read();
    const activeCompletion = activeStateMatchesCompletionTarget(afterFinalize);

    const matchingCapacityRetry =
      retryAtReceipt &&
      retryAtReceipt.threadId === (threadIdToFinalize ?? receiptState.activeThreadId) &&
      (retryAtReceipt.retryTurnId === turnIdToFinalize ||
        (retryAtReceipt.status === 'starting' && receiptState.activeTurnId === turnIdToFinalize))
        ? retryAtReceipt
        : null;
    if (matchingCapacityRetry && (!capacityFailure || matchingCapacityRetry.cancelRequested)) {
      const clearedRetry = clearModelCapacityRetry(matchingCapacityRetry.operationId);
      if (clearedRetry) broadcastHello(clearedRetry);
    }

    const scheduleCapacityRetryAfterClear = (): void => {
      if (!capacityFailure || !activeCompletionTarget?.threadId || !turnIdToFinalize) return;
      if (matchingCapacityRetry) {
        if (matchingCapacityRetry.cancelRequested) return;
        scheduleModelCapacityRetry(
          matchingCapacityRetry.threadId,
          turnIdToFinalize,
          matchingCapacityRetry.attempt + 1,
          matchingCapacityRetry.options,
          matchingCapacityRetry.operationId,
        );
        return;
      }
      scheduleModelCapacityRetry(
        activeCompletionTarget.threadId,
        turnIdToFinalize,
        1,
        runOptionsFromRuntimeState(receiptState),
      );
    };

    if (!activeCompletion) {
      if (advanceQueue && !afterFinalize.activeThreadId && afterFinalize.activeTurnId) {
        const cleared = deps.stateStore.update((state) => ({ ...state, activeTurnId: null }));
        broadcastHello(cleared);
      }
      if (completionKey) {
        completingTurnKeys.delete(completionKey);
        if (finalizedForCompletionKey) {
          rememberCompletedTurnKey(completionKey);
        }
      }
      if (completingSteer && advanceQueue && completingSteer.settled) {
        resumeQueuedWorkAfterSettledCompletionSteer(completingSteer);
      }
      return;
    }

    if (queuedStartInFlight || queuedSteerInFlight || completingSteer || !advanceQueue) {
      const cleared = deps.stateStore.update((current) => {
        const stillActiveCompletion = activeStateMatchesCompletionTarget(current);
        return stillActiveCompletion ? { ...current, activeTurnId: null } : current;
      });
      broadcastHello(cleared);
      if (!advanceQueue) scheduleCapacityRetryAfterClear();
      if (completionKey) {
        completingTurnKeys.delete(completionKey);
        if (finalizedForCompletionKey) {
          rememberCompletedTurnKey(completionKey);
        }
      }
      if (completingSteer && advanceQueue && completingSteer.settled) {
        resumeQueuedWorkAfterSettledCompletionSteer(completingSteer);
      }
      return;
    }

    let claim: QueuedTurnClaim | null = null;
    const claimed = deps.stateStore.update((current) => {
      const stillActiveCompletion = activeStateMatchesCompletionTarget(current);
      if (!stillActiveCompletion) return current;
      if (!current.activeThreadId) return { ...current, activeTurnId: null };

      const shifted = shiftQueuedMessage(current.queue, current.activeThreadId, { runnableOnly: true });
      if (!shifted.next) return { ...current, activeTurnId: null };

      claim = { threadId: current.activeThreadId, queuedMessage: shifted.next };
      return applyRunOptionsToRuntimeState(
        { ...current, activeTurnId: pendingTurnStartTurnId(current.activeThreadId), queue: shifted.queue },
        shifted.next.options,
      );
    });
    pruneTimedOutQueuedStarts(claimed.queue);
    broadcastHello(claimed);

    const claimToStart = claim as QueuedTurnClaim | null;
    if (!claimToStart) {
      if (completionKey) {
        completingTurnKeys.delete(completionKey);
        if (finalizedForCompletionKey) {
          rememberCompletedTurnKey(completionKey);
        }
      }
      return;
    }

    if (completionKey) {
      completingTurnKeys.delete(completionKey);
      if (finalizedForCompletionKey) {
        rememberCompletedTurnKey(completionKey);
      }
    }
    startQueuedTurnFromIdle(claimToStart.threadId, claimToStart.queuedMessage);
    } finally {
      if (noTurnVerificationKey) {
        const remainingOwners = (verifyingUnscopedTerminalKeys.get(noTurnVerificationKey) ?? 1) - 1;
        if (remainingOwners > 0) verifyingUnscopedTerminalKeys.set(noTurnVerificationKey, remainingOwners);
        else verifyingUnscopedTerminalKeys.delete(noTurnVerificationKey);
      }
      if (resumeSteeringAfterIgnoredNoTurn && (!steerAtReceipt || !steerAtReceipt.timedOut)) maybeSteerQueuedMessage();
      const compactedThreadId = completedThreadId ?? receiptState.activeThreadId;
      const compaction = compactedThreadId ? compactionsInFlight.get(compactedThreadId) : null;
      if (compactedThreadId && compaction) {
        const matchingTurn = Boolean(completedTurnId && compaction.turnId === completedTurnId);
        const boundNoIdCompactedNotification =
          message.method === 'thread/compacted' &&
          !completedTurnId &&
          !resumeSteeringAfterIgnoredNoTurn &&
          compaction.turnId !== null &&
          receiptState.activeThreadId === compactedThreadId &&
          receiptState.activeTurnId === compaction.turnId;
        const unboundNoIdCompactedNotification =
          message.method === 'thread/compacted' &&
          !completedTurnId &&
          compaction.turnId === null &&
          receiptState.activeThreadId === compactedThreadId &&
          isPendingCompactionTurnForThread(receiptState.activeTurnId, compactedThreadId);
        if (matchingTurn || boundNoIdCompactedNotification || unboundNoIdCompactedNotification) {
          if (compactionsInFlight.get(compactedThreadId)?.generation === compaction.generation) {
            compactionsInFlight.delete(compactedThreadId);
          }
        }
      }
    }
  };

  const handleTaskStarted = (message: { params?: unknown; payload?: unknown }) => {
    const turnId = notificationTurnId(message);
    if (!turnId) return;

    const notifiedThreadId = notificationThreadId(message);
    const pendingContextCandidate = pendingTurnStartContext(notifiedThreadId);
    const retainedContextCandidate = pendingContextCandidate
      ? null
      : notifiedThreadId
        ? retainedDirectStartContexts.get(notifiedThreadId) ?? null
        : retainedDirectStartContexts.values().next().value ?? null;
    const contextCandidate = pendingContextCandidate ?? retainedContextCandidate;
    const candidateThreadId = notifiedThreadId ?? contextCandidate?.threadId ?? null;
    const timedOutQueuedStart = candidateThreadId ? timedOutQueuedStarts.get(candidateThreadId) : undefined;
    const ambiguousTimedOutStart = Boolean(timedOutQueuedStart && pendingContextCandidate);
    const pendingContext = ambiguousTimedOutStart || retainedContextCandidate ? null : takePendingTurnStartContext(notifiedThreadId);
    let current = deps.stateStore.read();
    const threadId = notifiedThreadId ?? pendingContext?.threadId ?? contextCandidate?.threadId ?? null;
    if (!threadId) return;
    const capacityRetry = current.modelCapacityRetry;
    if (capacityRetry?.threadId === threadId) {
      clearModelCapacityTimers();
      const reconciled = deps.stateStore.update((state) => {
        const live = state.modelCapacityRetry;
        if (!live || live.operationId !== capacityRetry.operationId) return state;
        if (live.status === 'scheduled') return { ...state, modelCapacityRetry: null };
        if (live.status !== 'starting' && live.retryTurnId !== turnId) return state;
        const acceptedRetry: ModelCapacityRetry = {
          ...live,
          status: 'inFlight',
          retryAt: null,
          claimedAt: live.claimedAt ?? Date.now(),
          retryTurnId: turnId,
          reconcileCursor: null,
        };
        return { ...state, activeTurnId: turnId, modelCapacityRetry: acceptedRetry };
      });
      const acceptedRetry = reconciled.modelCapacityRetry?.operationId === capacityRetry.operationId
        ? reconciled.modelCapacityRetry
        : null;
      current = reconciled;
      broadcastHello(reconciled);
      if (acceptedRetry?.cancelRequested) void interruptAcceptedModelCapacityRetry(acceptedRetry);
    }
    const compaction = compactionsInFlight.get(threadId);
    if (compaction && isPendingCompactionTurnForThread(current.activeTurnId, threadId)) compaction.turnId = turnId;
    const threadPath =
      pendingContext?.threadPath ??
      contextCandidate?.threadPath ??
      (threadId && threadId === current.activeThreadId ? current.activeThreadPath : threadId ? knownThreadPaths.get(threadId) ?? null : null);
    const cwd = pendingContext?.cwd ?? contextCandidate?.cwd ?? (threadId && threadId === current.activeThreadId ? current.activeCwd : null);

    rememberKnownThreadPath(threadId, threadPath);
    rememberTurnThreadPath(threadId, turnId, threadPath);
    rememberTurnCwd(threadId, turnId, cwd);
    rememberLivePatchTurn(threadId, turnId);
    rememberObservedTurnStart(threadId, turnId);
    const alreadyCompleted = hasCompletedTurn(threadId, turnId);

    if (retainedContextCandidate) {
      if (timedOutQueuedStart) markTimedOutRecoveryMaybeSent(threadId, timedOutQueuedStart);
      timedOutQueuedStarts.delete(threadId);
      retainedDirectStartContexts.delete(threadId);
      const reconciled = deps.stateStore.update((state) => (
        state.activeThreadId === threadId && isPendingTurnStartForThread(state.activeTurnId, threadId)
          ? {
              ...state,
              activeTurnId: alreadyCompleted ? null : turnId,
              activeThreadPath: threadPath ?? state.activeThreadPath,
              activeCwd: cwd ?? state.activeCwd,
            }
          : state
      ));
      broadcastHello(reconciled);
      return;
    }

    if (timedOutQueuedStart) {
      if (ambiguousTimedOutStart) {
        const recovered = markTimedOutRecoveryMaybeSent(threadId, timedOutQueuedStart);
        if (pendingContextCandidate) pendingContextCandidate.ambiguousTurnId = turnId;
        broadcastHello(recovered);
        return;
      }
      timedOutQueuedStarts.delete(threadId);
      removeTimedOutRecovery(threadId, timedOutQueuedStart);
    }

    if (!threadId || current.activeThreadId !== threadId || current.activeTurnId === turnId) return;
    const canAdoptTurn = (state: HostRuntimeState): boolean => {
      if (state.activeThreadId !== threadId) return false;
      if (!state.activeTurnId || state.activeTurnId === turnId || isPendingTurnForThread(state.activeTurnId, threadId)) return true;
      const activeTurnKey = turnKey(threadId, state.activeTurnId);
      return completingTurnKeys.has(activeTurnKey) || verifyingUnscopedTerminalKeys.has(activeTurnKey);
    };
    if (!canAdoptTurn(current)) return;

    let adopted = false;
    let adoptedPredecessorTurnId: string | null = null;
    const terminalPredecessorTurnId =
      queuedSteerInFlight?.threadId === threadId &&
      queuedSteerInFlight.turnId !== turnId &&
      queuedSteerInFlight.terminalDisposition === 'advance-queue'
        ? queuedSteerInFlight.turnId
        : null;
    const next = deps.stateStore.update((state) => {
      if (!canAdoptTurn(state)) return state;
      adopted = true;
      if (state.activeTurnId && state.activeTurnId !== turnId && !isPendingTurnForThread(state.activeTurnId, threadId)) {
        adoptedPredecessorTurnId = state.activeTurnId;
      }
      return {
        ...state,
        activeTurnId: alreadyCompleted ? null : turnId,
        activeThreadPath: threadPath ?? state.activeThreadPath,
        activeCwd: cwd ?? state.activeCwd,
      };
    });
    if (adopted && adoptedPredecessorTurnId) {
      rememberAutonomousSuccessor(threadId, adoptedPredecessorTurnId, turnId);
    } else if (adopted && terminalPredecessorTurnId) {
      appendAutonomousSuccessor(threadId, terminalPredecessorTurnId, turnId);
    }
    broadcastHello(next);
    if (adopted) maybeSteerQueuedMessage();
  };

  const handleRuntimeSettingsNotification = (
    message: { method?: unknown; params?: unknown },
  ): { state: HostRuntimeState; settings: RuntimeSettingsNotification } | null => {
    const settings = runtimeSettingsFromNotification(message);
    if (!settings || deps.stateStore.read().activeThreadId !== settings.threadId) return null;
    const waiter = runtimeSettingsUpdateWaiter;
    if (
      waiter &&
      waiter.generation === appServerGeneration &&
      waiter.threadId === settings.threadId &&
      !runtimeSettingsMatchWaiter(waiter, settings)
    ) {
      return null;
    }

    let applied = false;
    const state = deps.stateStore.update((current) => {
      if (current.activeThreadId !== settings.threadId) return current;
      applied = true;
      return { ...current, model: settings.model, effort: settings.effort };
    });
    if (!applied) return null;
    recordRuntimeSettingsConfirmation(settings.threadId, settings, 'settingsUpdated');
    return { state, settings };
  };

  const unsubscribeNotification = deps.codex.onNotification((message) => {
    if (isTerminalModelCapacityErrorNotification(message)) {
      const threadId = notificationThreadId(message);
      const turnId = notificationTurnId(message);
      if (turnId) {
        legacyModelCapacityFailureKeys.add(turnKey(threadId, turnId));
        while (legacyModelCapacityFailureKeys.size > 200) {
          const oldest = legacyModelCapacityFailureKeys.values().next().value;
          if (typeof oldest !== 'string') break;
          legacyModelCapacityFailureKeys.delete(oldest);
        }
      }
    }
    const forwardToBrowser = !UNFORWARDED_BROWSER_NOTIFICATION_METHODS.has(message.method);
    const seq = forwardToBrowser ? rememberNotification(message) : null;
    const isTaskStart = message.method === 'turn/started' || (message.method === 'event_msg' && isTaskStartedEvent(message));
    if (isTaskStart) handleTaskStarted(message);
    const goalState = handleGoalNotification(message);
    if (goalState) broadcastHello(goalState);
    const runtimeSettings = handleRuntimeSettingsNotification(message);
    if (runtimeSettings) {
      broadcastHello(runtimeSettings.state);
      resolveMatchingRuntimeSettingsUpdateWaiter(runtimeSettings.settings);
    }
    if (message.method === 'model/safetyBuffering/updated' && isRecord(message.params) && typeof message.params.showBufferingUi === 'boolean') {
      logInfo('Codex model safety buffering updated', {
        threadId: notificationThreadId(message),
        turnId: notificationTurnId(message),
        model: getStringPath(message.params, ['model']),
        showBufferingUi: message.params.showBufferingUi,
        fasterModel: getStringPath(message.params, ['fasterModel']),
      });
    }

    if (seq !== null) {
      for (const client of wss.clients) sendNotification(client, seq, message);
    }
    const resolvedRequestId = extractResolvedRequestId(message);
    if (resolvedRequestId !== null && pendingServerRequests.delete(requestKey(resolvedRequestId))) {
      broadcastRequestResolved(resolvedRequestId);
    }
    if (message.method === 'event_msg') {
      enqueuePatchApplyEnd(message);
    }
    if (message.method === 'item/completed') enqueueStructuredFileChange(message);
    const terminalDisposition = notificationTerminalDisposition(message);
    if (terminalDisposition) void handleTurnCompleted(message, terminalDisposition);
  });

  const unsubscribeServerRequest = deps.codex.onServerRequest((message) => {
    if (message.method === 'item/fileChange/requestApproval') {
      captureFileChangeSnapshots(message.params, message.id);
    }
    pendingServerRequests.set(requestKey(message.id), message);
    for (const client of wss.clients) send(client, { type: 'codex/request', message });
  });

  const unsubscribeHealthChange = deps.codex.onHealthChange(() => {
    const health = deps.codex.health();
    if (!health.connected || health.dead) {
      clearModelCapacityTimers();
      invalidateResumedThreads();
      pendingServerRequests.clear();
      const current = deps.stateStore.read();
      if (current.activeTurnId) {
        const { activeThreadId, activeThreadPath, activeTurnId } = current;
        void finalizeActiveTurnBeforeClear(activeThreadId, activeTurnId, activeThreadPath).finally(() => {
          clearActiveTurn({ threadId: activeThreadId, turnId: activeTurnId }, { broadcast: true });
        });
        return;
      }
    } else {
      const retry = deps.stateStore.read().modelCapacityRetry;
      if (retry?.status === 'scheduled') armModelCapacityRetry(retry);
      else if (retry) scheduleModelCapacityReconciliation(retry);
    }
    broadcastHello();
  });

  const persistedModelCapacityRetry = deps.stateStore.read().modelCapacityRetry;
  if (persistedModelCapacityRetry?.status === 'scheduled') {
    armModelCapacityRetry(persistedModelCapacityRetry);
  } else if (persistedModelCapacityRetry) {
    queueMicrotask(() => void reconcilePersistedModelCapacityRetry(persistedModelCapacityRetry.operationId));
  }

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearModelCapacityTimers();
    invalidateRetainedDirectStartContexts();
    compactionsInFlight.clear();
    suppressedGoalQueueStarts.clear();
    suppressedGoalQueueSteers.clear();
    runtimeSettingsConfirmation = null;
    if (runtimeSettingsUpdateWaiter) {
      cancelRuntimeSettingsUpdateWaiter(runtimeSettingsUpdateWaiter, new Error('browser socket server closed before confirming model and effort update'));
    }
    unsubscribeNotification();
    unsubscribeServerRequest();
    unsubscribeHealthChange();
    for (const client of wss.clients) closeClient(client);
    wss.close();
  };

  server.on('close', close);

  wss.on('error', (err) => {
    logWarn('Browser WebSocket server error', err);
  });

  wss.on('connection', (ws, req) => {
    responsiveBrowserClients.add(ws);
    ws.on('pong', () => responsiveBrowserClients.add(ws));
    ws.on('error', (err) => {
      logWarn('Browser WebSocket client error', err);
    });

    const url = new URL(req.url ?? '/ws', 'http://localhost');
    if (!authorized(deps, url.searchParams.get('token'), req.headers.cookie, req.headers.host)) {
      send(ws, { type: 'auth/error' });
      ws.close(1008, 'unauthorized');
      return;
    }

    sendHello(ws);

    ws.on('message', async (raw) => {
      const request = parseBrowserRequest(raw);
      if (!request) return;

      if (request.type === 'client/hello') {
        sendHello(ws);
        replayNotifications(ws, lastNotificationStreamId(request.params), lastNotificationSeq(request.params));
        return;
      }

      if (
        request.type !== 'rpc' ||
        typeof request.method !== 'string' ||
        typeof request.id !== 'number' ||
        !Number.isFinite(request.id)
      ) {
        return;
      }

      try {
        if (request.method === 'webui/codex/restart') {
          if (runtimeOptionUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'model or effort update is in progress' });
            return;
          }
          const current = deps.stateStore.read();
          const cancelledCapacityRetry = current.modelCapacityRetry?.cancelRequested === true;
          if (codexBusy(current) && !cancelledCapacityRetry) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cannot restart Codex while a turn is active' });
            return;
          }

          if (restartInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'Codex restart is already in progress' });
            return;
          }

          const operation = (async () => {
            const activeThreadId = current.activeThreadId;
            const activeThreadPath = current.activeThreadPath;
            const options = runOptionsFromRuntimeState(current);
            const resumePath = activeThreadId ? resumePathForThread(activeThreadId, activeThreadPath) : null;

            if (cancelledCapacityRetry) clearModelCapacityTimers();
            pendingServerRequests.clear();
            invalidateResumedThreads();
            await deps.codex.restart();

            let state = deps.stateStore.update((state) => ({
              ...state,
              ...(cancelledCapacityRetry ? { activeTurnId: null, modelCapacityRetry: null } : {}),
              appServerUrl: deps.codex.getUrl(),
              appServerPid: deps.codex.getPid(),
            }));
            broadcastHello(state);

            let resumeResult: unknown = null;
            if (activeThreadId) {
              let skippedPendingRolloutResume = false;
              const params = applyThreadRunOptions<SessionResumeParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
                threadId: activeThreadId,
                ...(resumePath ? { path: resumePath } : {}),
                experimentalRawEvents: true,
                persistExtendedHistory: true,
                excludeTurns: true,
              }, options);
              const generation = appServerGeneration;
              resumeResult = await Promise.resolve(deps.codex.request('thread/resume', params, THREAD_TURNS_LIST_RPC_TIMEOUT_MS)).catch((error) => {
                if (isNoRolloutFoundError(error, activeThreadId) && shouldReturnEmptyTurnsForPendingRolloutThread(activeThreadId)) {
                  logWarn('Preserving newly started active Codex thread without rollout after app-server restart', {
                    threadId: activeThreadId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  skippedPendingRolloutResume = true;
                  return null;
                }
                if (isMissingThreadError(error)) clearMissingActiveThread(activeThreadId, error);
                throw error;
              });
              const health = deps.codex.health();
              const authoritativeResume =
                !skippedPendingRolloutResume && generation === appServerGeneration && health.connected && !health.dead;
              if (authoritativeResume) resumedThreadIds.add(activeThreadId);

              const activeCwd = extractThreadCwd(resumeResult) ?? current.activeCwd;
              const resultThreadPath = extractThreadPath(resumeResult);
              const nextThreadPath = resultThreadPath ?? resumePath ?? activeThreadPath;
              const runtimeStatus = runtimeStatusFromThreadResult(resumeResult, options);
              rememberKnownThreadPath(activeThreadId, nextThreadPath);
              state = deps.stateStore.update((state) =>
                state.activeThreadId === activeThreadId
                  ? {
                      ...state,
                      activeThreadPath: nextThreadPath,
                      activeTurnId: null,
                      ...(cancelledCapacityRetry ? { modelCapacityRetry: null } : {}),
                      activeCwd,
                      ...runtimeStatus,
                      recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
                    }
                  : state,
              );
              if (authoritativeResume && state.activeThreadId === activeThreadId) {
                recordRuntimeSettingsConfirmation(activeThreadId, runtimeStatus, 'threadResume');
              }
              broadcastHello(state);
            }

            return {
              ok: true,
              resumedThreadId: activeThreadId,
              thread: sanitizeThreadHistory(resumeResult),
              appServerHealth: deps.codex.health(),
            };
          })();

          restartInFlight = operation;
          try {
            send(ws, { type: 'rpc/result', id: request.id, result: await operation });
          } finally {
            if (restartInFlight === operation) restartInFlight = null;
          }
          return;
        }

        if (restartInFlight) {
          send(ws, { type: 'rpc/error', id: request.id, error: 'Codex restart is in progress' });
          return;
        }

        if (request.method === 'webui/model/list') {
          const data: unknown[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | null = null;
          for (let page = 0; page < 20; page += 1) {
            const result: unknown = await requestCodex('model/list', { cursor, limit: 100, includeHidden: false });
            const pageData = getValuePath(result, ['data']);
            if (Array.isArray(pageData)) data.push(...pageData);
            const nextCursor: string | null = getStringPath(result, ['nextCursor']) ?? getStringPath(result, ['next_cursor']);
            if (!nextCursor) {
              send(ws, { type: 'rpc/result', id: request.id, result: { data, nextCursor: null } });
              return;
            }
            if (seenCursors.has(nextCursor)) throw new Error('model catalog returned a repeated cursor');
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
          throw new Error('model catalog exceeded 20 pages');
        }

        if (request.method === 'webui/session/list') {
          const result = await requestCodex('thread/list', {
            limit: 50,
            cursor: null,
            sortDirection: 'desc',
            sortKey: 'updated_at',
          });
          rememberKnownThreadPathsFromList(result);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/session/start') {
          if (runtimeOptionUpdates.size > 0 || goalUpdates.size > 0 || sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session, runtime settings, or goal update is in progress' });
            return;
          }
          const cwd = getRequiredString(request.params, 'cwd');
          if (!cwd) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cwd is required' });
            return;
          }

          const retryBeforeSessionStart = deps.stateStore.read().modelCapacityRetry;
          if (retryBeforeSessionStart && retryBeforeSessionStart.status !== 'scheduled') {
            send(ws, { type: 'rpc/error', id: request.id, error: 'stop the model-capacity retry before changing sessions' });
            return;
          }

          const options = runOptionsFromParams(request.params);
          const params = applyThreadRunOptions<SessionStartParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
            cwd,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
          }, options);
          let result: unknown;
          let generation = appServerGeneration;
          let sessionStarted = false;
          sessionChangeInFlight = true;
          if (retryBeforeSessionStart) clearModelCapacityTimers();
          try {
            const starting = ensureCodexStarted();
            if (starting) await starting;
            generation = appServerGeneration;
            result = await deps.codex.request('thread/start', params);
            const health = deps.codex.health();
            if (generation !== appServerGeneration || !health.connected || health.dead) {
              throw new Error('Codex app-server changed while starting session');
            }
            sessionStarted = true;
          } finally {
            sessionChangeInFlight = false;
            if (!sessionStarted && retryBeforeSessionStart) armModelCapacityRetry(deps.stateStore.read().modelCapacityRetry);
          }
          invalidateRetainedDirectStartContexts();
          const activeCwd = extractThreadCwd(result) ?? cwd;
          const activeThreadId = extractThreadId(result);
          const activeThreadPath = extractThreadPath(result);
          const runtimeStatus = runtimeStatusFromThreadResult(result, options);
          rememberKnownThreadPath(activeThreadId, activeThreadPath);
          if (activeThreadId) {
            resumedThreadIds.add(activeThreadId);
            startedPendingRolloutThreadIds.add(activeThreadId);
          }
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId,
            activeThreadPath,
            activeTurnId: null,
            activeGoal: null,
            modelCapacityRetry: null,
            activeCwd,
            ...runtimeStatus,
            recentCwds: rememberCwd(state.recentCwds, activeCwd),
          }));
          recordRuntimeSettingsConfirmation(activeThreadId, runtimeStatus, 'threadStart');
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/session/resume') {
          if (runtimeOptionUpdates.size > 0 || goalUpdates.size > 0 || sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session, runtime settings, or goal update is in progress' });
            return;
          }
          const threadId = getRequiredString(request.params, 'threadId');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          const requestedThreadPath = getOptionalString(request.params, 'threadPath');

          const retryBeforeSessionResume = deps.stateStore.read().modelCapacityRetry;
          if (retryBeforeSessionResume && retryBeforeSessionResume.status !== 'scheduled') {
            send(ws, { type: 'rpc/error', id: request.id, error: 'stop the model-capacity retry before changing sessions' });
            return;
          }

          const options = runOptionsFromParams(request.params);
          const resumePath = resumePathForThread(threadId, requestedThreadPath);
          const params = applyThreadRunOptions<SessionResumeParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
            threadId,
            ...(resumePath ? { path: resumePath } : {}),
            experimentalRawEvents: true,
            persistExtendedHistory: true,
            excludeTurns: true,
          }, options);
          let result: unknown;
          let generation = appServerGeneration;
          let sessionResumed = false;
          sessionChangeInFlight = true;
          if (retryBeforeSessionResume) clearModelCapacityTimers();
          try {
            const starting = ensureCodexStarted();
            if (starting) await starting;
            generation = appServerGeneration;
            result = await deps.codex.request('thread/resume', params).catch((error) => {
              if (isMissingThreadError(error)) clearMissingActiveThread(threadId, error);
              throw error;
            });
            sessionResumed = true;
          } finally {
            sessionChangeInFlight = false;
            if (!sessionResumed && retryBeforeSessionResume) armModelCapacityRetry(deps.stateStore.read().modelCapacityRetry);
          }
          invalidateRetainedDirectStartContexts();
          const health = deps.codex.health();
          const authoritativeResume = generation === appServerGeneration && health.connected && !health.dead;
          if (authoritativeResume) resumedThreadIds.add(threadId);
          const activeCwd = extractThreadCwd(result) ?? deps.stateStore.read().activeCwd;
          const resultThreadPath = extractThreadPath(result);
          const activeThreadPath =
            resultThreadPath ?? resumePath ?? (requestedThreadPath && knownThreadPaths.get(threadId) === requestedThreadPath ? requestedThreadPath : null);
          const runtimeStatus = runtimeStatusFromThreadResult(result, options);
          rememberKnownThreadPath(threadId, activeThreadPath);
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: threadId,
            activeThreadPath,
            activeTurnId: null,
            activeGoal: state.activeGoal?.threadId === threadId ? state.activeGoal : null,
            modelCapacityRetry: null,
            activeCwd,
            ...runtimeStatus,
            recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
          }));
          runtimeSettingsConfirmation = null;
          if (authoritativeResume) recordRuntimeSettingsConfirmation(threadId, runtimeStatus, 'threadResume');
          send(ws, { type: 'rpc/result', id: request.id, result: sanitizeThreadHistory(result) });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/thread/status') {
          const threadId = getRequiredString(request.params, 'threadId');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }

          const statusState = deps.stateStore.read();
          if (statusState.activeThreadId !== threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'thread is not the active session' });
            return;
          }
          const statusThreadPath = statusState.activeThreadPath;
          const statusGeneration = appServerGeneration;

          let lastTurn: TurnRuntimeContextLookup;
          try {
            lastTurn = await readLatestTurnRuntimeContext(statusThreadPath);
          } catch (error) {
            lastTurn = {
              status: 'unavailable',
              context: null,
              scannedBytes: 0,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
          if (
            startedPendingRolloutThreadIds.has(threadId) &&
            lastTurn.status === 'unavailable' &&
            /ENOENT|no such file/i.test(lastTurn.detail ?? '')
          ) {
            lastTurn = { status: 'none', context: null, scannedBytes: lastTurn.scannedBytes };
          }

          const latest = deps.stateStore.read();
          if (latest.activeThreadId !== threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'thread is not the active session' });
            return;
          }
          if (latest.activeThreadPath !== statusThreadPath || appServerGeneration !== statusGeneration) {
            send(ws, {
              type: 'rpc/error',
              id: request.id,
              error: 'thread status changed while reading runtime context; retry',
            });
            return;
          }
          if (runtimeSettingsConfirmation && runtimeSettingsConfirmation.threadId !== threadId) {
            runtimeSettingsConfirmation = null;
          }
          const confirmation = runtimeSettingsConfirmation;
          const confirmed = Boolean(
            confirmation &&
              confirmation.threadId === threadId &&
              confirmation.model === latest.model &&
              confirmation.effort === latest.effort,
          );

          send(ws, {
            type: 'rpc/result',
            id: request.id,
            result: {
              hostname: deps.config.hostname,
              threadId,
              cwd: latest.activeCwd,
              activeTurnId: latest.activeTurnId,
              model: latest.model,
              effort: latest.effort,
              mode: latest.mode,
              sandbox: latest.sandbox,
              confirmed,
              confirmationSource: confirmation?.source ?? null,
              confirmedAt: confirmation?.confirmedAt ?? null,
              lastTurn,
            },
          });
          return;
        }

        if (request.method === 'webui/thread/runtime-options/set') {
          const threadId = getRequiredString(request.params, 'threadId');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }

          const current = deps.stateStore.read();
          if (current.activeThreadId !== threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'thread is not the active session' });
            return;
          }
          if (codexBusy(current, threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cannot change model or effort while Codex is working' });
            return;
          }
          if (sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session change is in progress' });
            return;
          }
          if (goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'goal update is in progress' });
            return;
          }
          if (runtimeOptionUpdates.has(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'model or effort update is already in progress' });
            return;
          }

          const paramsRecord = isRecord(request.params) ? request.params : null;
          const model = getOptionalString(request.params, 'model');
          const hasEffort = Boolean(paramsRecord && hasOwn(paramsRecord, 'effort'));
          const mode = getOptionalEnum(request.params, 'mode', COLLABORATION_MODES);
          const sandbox = getOptionalEnum(request.params, 'sandbox', SANDBOX_MODES);
          let effort: string | null | undefined;
          if (hasEffort) {
            const rawEffort = paramsRecord?.effort;
            if (rawEffort === null) {
              effort = null;
            } else if (typeof rawEffort === 'string' && rawEffort.trim()) {
              effort = rawEffort.trim();
              if (effort.length > 64) {
                send(ws, { type: 'rpc/error', id: request.id, error: 'effort must be at most 64 characters' });
                return;
              }
            } else {
              send(ws, { type: 'rpc/error', id: request.id, error: 'effort must be a non-empty string or null' });
              return;
            }
          }
          if (!model && !hasEffort && !mode && !sandbox) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'a runtime option is required' });
            return;
          }
          const nextModel = model ?? current.model;
          const nextEffort = hasEffort ? (effort ?? null) : current.effort;
          if (mode && !nextModel) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'model is required before changing mode' });
            return;
          }

          runtimeOptionUpdates.add(threadId);
          let confirmationWaiter: RuntimeSettingsUpdateWaiter | null = null;
          try {
            const settingsParams = {
              threadId,
              ...(model ? { model } : {}),
              ...(hasEffort ? { effort } : {}),
              ...(mode ? { collaborationMode: collaborationMode({ model: nextModel!, effort: nextEffort ?? undefined, mode }) } : {}),
              ...(sandbox ? { sandboxPolicy: sandboxPolicy(sandbox, current.activeCwd) } : {}),
            };
            let activeCwd = current.activeCwd;
            let activeThreadPath = current.activeThreadPath;
            let runtimeStatus: Pick<HostRuntimeState, 'model' | 'effort' | 'mode' | 'sandbox'> = {
              model: nextModel,
              effort: nextEffort,
              mode: mode ?? current.mode,
              sandbox: sandbox ?? current.sandbox,
            };
            let usedResumeFallback = false;

            const starting = ensureCodexStarted();
            if (starting) await starting;
            confirmationWaiter = createRuntimeSettingsUpdateWaiter(
              threadId,
              model ?? undefined,
              hasEffort ? nextEffort : undefined,
            );
            try {
              await deps.codex.request('thread/settings/update', settingsParams);
            } catch (error) {
              if (isMissingThreadError(error)) {
                resumedThreadIds.delete(threadId);
                await ensureThreadResumed(threadId);
                if (runtimeSettingsUpdateWaiter !== confirmationWaiter) {
                  confirmationWaiter = createRuntimeSettingsUpdateWaiter(
                    threadId,
                    model ?? undefined,
                    hasEffort ? nextEffort : undefined,
                  );
                }
                await deps.codex.request('thread/settings/update', settingsParams);
              } else if (isMethodNotFoundError(error)) {
                cancelRuntimeSettingsUpdateWaiter(
                  confirmationWaiter,
                  new Error('thread/settings/update is unavailable; using authoritative thread/resume fallback'),
                );
                if (hasEffort && effort === null) {
                  throw new Error('This Codex app-server version cannot clear reasoning effort; update Codex');
                }
                usedResumeFallback = true;
                const fallbackOptions: CodexRunOptions = {};
                if (model) fallbackOptions.model = model;
                if (typeof effort === 'string') fallbackOptions.effort = effort;
                if (mode && nextModel) {
                  fallbackOptions.model = nextModel;
                  fallbackOptions.mode = mode;
                }
                if (sandbox) fallbackOptions.sandbox = sandbox;
                const resumePath = resumePathForThread(threadId, current.activeThreadPath);
                const resumeParams = applyThreadRunOptions<SessionResumeParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
                  threadId,
                  ...(resumePath ? { path: resumePath } : {}),
                  experimentalRawEvents: true,
                  persistExtendedHistory: true,
                  excludeTurns: true,
                }, fallbackOptions);
                const generation = appServerGeneration;
                const result = await requestCodex('thread/resume', resumeParams, THREAD_TURNS_LIST_RPC_TIMEOUT_MS).catch((resumeError) => {
                  if (isMissingThreadError(resumeError)) clearMissingActiveThread(threadId, resumeError);
                  throw resumeError;
                });
                const health = deps.codex.health();
                const authoritativeResume = generation === appServerGeneration && health.connected && !health.dead;
                if (!authoritativeResume) throw new Error('Codex app-server changed before thread/resume confirmed model and effort');
                resumedThreadIds.add(threadId);
                activeCwd = extractThreadCwd(result) ?? current.activeCwd;
                activeThreadPath = extractThreadPath(result) ?? resumePath ?? current.activeThreadPath;
                runtimeStatus = runtimeStatusFromThreadResult(result, {
                  ...runOptionsFromRuntimeState(current),
                  ...fallbackOptions,
                });
                rememberKnownThreadPath(threadId, activeThreadPath);
              } else {
                cancelRuntimeSettingsUpdateWaiter(
                  confirmationWaiter,
                  error instanceof Error ? error : new Error(String(error)),
                );
                throw error;
              }
            }

            if (!usedResumeFallback) {
              const confirmationResult = await confirmationWaiter.promise;
              if (!confirmationResult.confirmed) throw confirmationResult.error;
            }

            let applied = false;
            const state = deps.stateStore.update((latest) => {
              if (latest.activeThreadId !== threadId || latest.activeTurnId) return latest;
              applied = true;
              return {
                ...latest,
                activeThreadPath,
                activeCwd,
                model: usedResumeFallback ? runtimeStatus.model : latest.model,
                effort: usedResumeFallback ? runtimeStatus.effort : latest.effort,
                mode: runtimeStatus.mode,
                sandbox: runtimeStatus.sandbox,
                recentCwds: activeCwd ? rememberCwd(latest.recentCwds, activeCwd) : latest.recentCwds,
              };
            });
            if (!applied) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'thread state changed while updating model or effort' });
              return;
            }
            if (usedResumeFallback) recordRuntimeSettingsConfirmation(threadId, runtimeStatus, 'threadResume');
            send(ws, {
              type: 'rpc/result',
              id: request.id,
              result: { model: state.model, effort: state.effort },
            });
            broadcastHello(state);
          } finally {
            if (confirmationWaiter) {
              cancelRuntimeSettingsUpdateWaiter(
                confirmationWaiter,
                new Error('model and effort update ended before Codex confirmation'),
              );
            }
            runtimeOptionUpdates.delete(threadId);
            maybeStartQueuedTurnFromIdle(threadId);
          }
          return;
        }

        if (request.method === 'webui/queue/enqueue') {
          const text = getRequiredString(request.params, 'text');
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const requestedThreadId = getOptionalString(request.params, 'threadId');
          const activeThreadId = deps.stateStore.read().activeThreadId;
          const threadId = requestedThreadId ?? activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: enqueueMessage(current.queue, text, deps.config.queueLimit, runOptionsFromParams(request.params), threadId),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: queueForThread(state.queue, threadId) });
          broadcastHello(state);
          if (state.activeThreadId === threadId) maybeSteerQueuedMessage();
          return;
        }

        if (request.method === 'webui/bang/run') {
          const command = getRequiredString(request.params, 'command');
          if (!command) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'command is required' });
            return;
          }

          const state = deps.stateStore.read();
          if (state.activeTurnId) {
            throw new Error('! commands are disabled while Codex is working');
          }
          if (!state.activeCwd) {
            throw new Error('no active cwd');
          }
          if (isInteractiveCommandBlocked(command)) {
            throw new Error('interactive commands are not supported');
          }
          if (bangCommandInFlight) {
            throw new Error('A command is already running');
          }

          bangCommandInFlight = true;
          try {
            const result = await runBangCommand(command, state.activeCwd, deps.config.commandTimeoutMs, deps.config.commandOutputBytes);
            send(ws, { type: 'rpc/result', id: request.id, result });
          } finally {
            bangCommandInFlight = false;
          }
          return;
        }

        if (request.method === 'webui/thread/compact/start') {
          if (runtimeOptionUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'model or effort update is in progress' });
            return;
          }
          if (goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'goal update is in progress' });
            return;
          }
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (compactionsInFlight.has(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'compaction is already in progress' });
            return;
          }
          if (state.activeThreadId === threadId && codexBusy(state, threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cannot compact while Codex is working' });
            return;
          }

          const pendingTurnId = pendingCompactionTurnId(threadId);
          const compaction = { generation: (compactionGeneration += 1), turnId: null as string | null };
          compactionsInFlight.set(threadId, compaction);
          const markedState = deps.stateStore.update((current) =>
            current.activeThreadId === threadId && !current.activeTurnId ? { ...current, activeTurnId: pendingTurnId } : current,
          );
          if (markedState.activeThreadId === threadId && markedState.activeTurnId === pendingTurnId) broadcastHello(markedState);

          try {
            await ensureThreadResumed(threadId);
            const result = await requestCodex('thread/compact/start', { threadId });
            send(ws, { type: 'rpc/result', id: request.id, result });
          } catch (error) {
            if (compactionsInFlight.get(threadId)?.generation === compaction.generation) compactionsInFlight.delete(threadId);
            const cleared = clearActiveTurn({ threadId, turnId: pendingTurnId }, { broadcast: false });
            broadcastHello(cleared);
            throw error;
          }
          return;
        }

        if (request.method === 'webui/thread/goal/get') {
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }

          const readGeneration = goalMutationGeneration;
          const cacheEligibleAtStart = goalUpdates.size === 0;
          const result = await requestCodex('thread/goal/get', { threadId });
          const goal = threadGoalFromResult(result);
          if (cacheEligibleAtStart && readGeneration === goalMutationGeneration && goalUpdates.size === 0) {
            const next = goal ? setActiveGoalForThread(goal) : clearActiveGoalForThread(threadId);
            if (next) broadcastHello(next);
          }
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/thread/goal/set') {
          if (sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session change is in progress' });
            return;
          }
          if (runtimeOptionUpdates.size > 0 || goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'runtime settings or goal update is in progress' });
            return;
          }
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (turnStartInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'turn start is in progress' });
            return;
          }
          if (compactionInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'compaction is in progress' });
            return;
          }

          const params: Record<string, unknown> = { threadId };
          if (isRecord(request.params) && hasOwn(request.params, 'objective')) {
            const objective = getOptionalString(request.params, 'objective');
            if (!objective) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'objective is required' });
              return;
            }
            if (objective.length > 4000) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'objective must be 4,000 characters or fewer' });
              return;
            }
            params.objective = objective;
          }

          const status = getOptionalEnum(request.params, 'status', GOAL_STATUSES);
          if (status) params.status = status;

          const capacityRetryToCancel = modelCapacityRetryForThread(state, threadId);
          if (capacityRetryToCancel) {
            const cancelsScheduledRetry =
              capacityRetryToCancel.status === 'scheduled' &&
              (status === 'paused' || status === 'complete' || status === 'blocked');
            if (!cancelsScheduledRetry) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'stop the model-capacity retry before changing the goal' });
              return;
            }
          }

          if (isRecord(request.params) && hasOwn(request.params, 'tokenBudget')) {
            const tokenBudget = request.params.tokenBudget;
            if (tokenBudget !== null && (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget))) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'tokenBudget must be a number or null' });
              return;
            }
            params.tokenBudget = tokenBudget;
          }

          if (!hasOwn(params, 'objective') && !hasOwn(params, 'status') && !hasOwn(params, 'tokenBudget')) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'objective, status, or tokenBudget is required' });
            return;
          }

          let result: unknown;
          let goalSetSucceeded = false;
          goalUpdates.add(threadId);
          goalMutationGeneration += 1;
          const lifecycleBarrier = params.status === 'paused' || params.status === 'complete' || params.status === 'blocked';
          const shouldInterruptGoalTurn = lifecycleBarrier && shouldInterruptActiveGoalTurn(threadId);
          if (capacityRetryToCancel) clearModelCapacityTimers();
          try {
            if (shouldInterruptGoalTurn) {
              const interrupted = await interruptActiveTurnForThread(threadId);
              if (interrupted) broadcastHello(interrupted);
            }
            result = await requestCodex('thread/goal/set', params);
            goalSetSucceeded = true;
          } finally {
            goalUpdates.delete(threadId);
            if (!goalSetSucceeded && capacityRetryToCancel) armModelCapacityRetry(deps.stateStore.read().modelCapacityRetry);
            wakeQueuedWorkAfterGoalUpdate(threadId, {
              allowSteer: !shouldInterruptGoalTurn,
              allowStart:
                !shouldInterruptGoalTurn &&
                !lifecycleBarrier &&
                params.status !== 'active' &&
                !hasOwn(params, 'objective') &&
                state.activeGoal?.status !== 'active',
            });
          }
          if (capacityRetryToCancel) {
            const cleared = clearModelCapacityRetry(capacityRetryToCancel.operationId);
            if (cleared) broadcastHello(cleared);
          }
          const goal = threadGoalFromResult(result);
          const next = goal ? setActiveGoalForThread(goal) : null;
          if (next) broadcastHello(next);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/thread/goal/replace' || request.method === 'webui/thread/goal/edit') {
          if (sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session change is in progress' });
            return;
          }
          if (runtimeOptionUpdates.size > 0 || goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'runtime settings or goal update is in progress' });
            return;
          }
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (modelCapacityRetryForThread(state, threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'stop the model-capacity retry before changing the goal' });
            return;
          }
          if (turnStartInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'turn start is in progress' });
            return;
          }
          if (compactionInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'compaction is in progress' });
            return;
          }
          const objective = getRequiredString(request.params, 'objective');
          if (!objective) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'objective is required' });
            return;
          }
          if (objective.length > 4000) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'objective must be 4,000 characters or fewer' });
            return;
          }
          const expected = expectedGoalFromParams(request.params, request.method === 'webui/thread/goal/replace');
          if ('error' in expected) {
            send(ws, { type: 'rpc/error', id: request.id, error: expected.error });
            return;
          }
          if (request.method === 'webui/thread/goal/edit' && expected.value === null) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'an existing goal is required to edit' });
            return;
          }

          goalUpdates.add(threadId);
          goalMutationGeneration += 1;
          let wakeIdleAfterEdit = false;
          try {
            const readGoal = async (): Promise<ThreadGoal | null> => {
              const currentResult = await requestCodex('thread/goal/get', { threadId });
              const currentGoal = threadGoalFromResult(currentResult);
              const next = currentGoal ? setActiveGoalForThread(currentGoal) : clearActiveGoalForThread(threadId);
              if (next) broadcastHello(next);
              return currentGoal;
            };
            const reconcileGoal = async (shouldRetry: (goal: ThreadGoal | null) => boolean): Promise<ThreadGoal | null> => {
              let reconciled: ThreadGoal | null = null;
              for (let attempt = 0; attempt < 3; attempt += 1) {
                if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
                reconciled = await readGoal();
                if (!shouldRetry(reconciled)) break;
              }
              return reconciled;
            };
            const currentGoal = await readGoal();
            wakeIdleAfterEdit = request.method === 'webui/thread/goal/edit' && currentGoal?.status !== 'active';
            if (!goalMatchesFingerprint(currentGoal, expected.value)) {
              const action = request.method === 'webui/thread/goal/edit' ? 'editing it' : 'replacing it';
              throw new Error(`goal changed; review the latest goal before ${action}`);
            }
            const validateReplacementGoal = (candidate: ThreadGoal | null, requireNewIdentity: boolean): ThreadGoal => {
              if (!candidate) throw new Error('goal replacement is incomplete; no goal is currently set');
              if (requireNewIdentity && currentGoal && candidate.createdAt === currentGoal.createdAt) {
                throw new Error('goal replacement did not reset the existing goal');
              }
              if (candidate.objective !== objective || candidate.status !== 'active') {
                throw new Error('goal replacement conflicted with a different goal');
              }
              return candidate;
            };

            let result: unknown;
            if (request.method === 'webui/thread/goal/edit') {
              try {
                result = await requestCodex('thread/goal/set', { threadId, objective });
              } catch {
                const reconciled = await reconcileGoal((goal) =>
                  goal === null || (goal.createdAt === expected.value?.createdAt && goal.objective !== objective),
                );
                if (!reconciled) throw new Error('goal edit failed because the goal no longer exists');
                if (reconciled.createdAt !== expected.value?.createdAt) throw new Error('goal edit conflicted with a different goal');
                if (reconciled.objective !== objective) throw new Error('goal edit was not applied; the existing goal remains');
                result = { goal: reconciled };
              }
            } else {
              if (currentGoal) {
                if (shouldInterruptActiveGoalTurn(threadId)) {
                  const interrupted = await interruptActiveTurnForThread(threadId);
                  if (interrupted) broadcastHello(interrupted);
                }
                try {
                  await requestCodex('thread/goal/clear', { threadId });
                  const next = clearActiveGoalForThread(threadId);
                  if (next) broadcastHello(next);
                } catch {
                  const reconciled = await reconcileGoal((goal) => Boolean(goal && goalMatchesFingerprint(goal, expected.value)));
                  if (reconciled && goalMatchesFingerprint(reconciled, expected.value)) {
                    throw new Error('goal replacement was not applied; the existing goal remains');
                  }
                  if (reconciled) throw new Error('goal replacement conflicted with a different goal');
                }
              }
              try {
                result = await requestCodex('thread/goal/set', { threadId, objective, status: 'active' });
              } catch {
                const reconciled = await reconcileGoal((goal) =>
                  goal === null || Boolean(currentGoal && goal.createdAt === currentGoal.createdAt),
                );
                result = { goal: validateReplacementGoal(reconciled, true) };
              }
            }

            let goal = threadGoalFromResult(result);
            if (request.method === 'webui/thread/goal/replace' && !goal) {
              goal = await readGoal();
              result = { goal };
            }
            const next = goal ? setActiveGoalForThread(goal) : null;
            if (next) broadcastHello(next);
            if (request.method === 'webui/thread/goal/replace') validateReplacementGoal(goal, false);
            send(ws, { type: 'rpc/result', id: request.id, result });
          } finally {
            goalUpdates.delete(threadId);
            wakeQueuedWorkAfterGoalUpdate(threadId, {
              allowSteer: request.method === 'webui/thread/goal/edit' || request.method === 'webui/thread/goal/replace',
              allowStart: wakeIdleAfterEdit,
            });
          }
          return;
        }

        if (request.method === 'webui/thread/goal/clear') {
          if (sessionChangeInFlight) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'session change is in progress' });
            return;
          }
          if (runtimeOptionUpdates.size > 0 || goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'runtime settings or goal update is in progress' });
            return;
          }
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          const capacityRetryToCancel = modelCapacityRetryForThread(state, threadId);
          if (capacityRetryToCancel) {
            if (capacityRetryToCancel.status !== 'scheduled') {
              send(ws, { type: 'rpc/error', id: request.id, error: 'stop the model-capacity retry before changing the goal' });
              return;
            }
          }
          if (turnStartInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'turn start is in progress' });
            return;
          }
          if (compactionInFlightForThread(threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'compaction is in progress' });
            return;
          }

          goalUpdates.add(threadId);
          goalMutationGeneration += 1;
          let goalClearSucceeded = false;
          if (capacityRetryToCancel) clearModelCapacityTimers();
          try {
            const shouldInterruptGoalTurn = shouldInterruptActiveGoalTurn(threadId);
            if (shouldInterruptGoalTurn) {
              const interrupted = await interruptActiveTurnForThread(threadId);
              if (interrupted) broadcastHello(interrupted);
            }
            const result = await requestCodex('thread/goal/clear', { threadId });
            goalClearSucceeded = true;
            if (capacityRetryToCancel) {
              const clearedRetry = clearModelCapacityRetry(capacityRetryToCancel.operationId);
              if (clearedRetry) broadcastHello(clearedRetry);
            }
            const next = clearActiveGoalForThread(threadId);
            if (next) broadcastHello(next);
            send(ws, { type: 'rpc/result', id: request.id, result });
          } finally {
            goalUpdates.delete(threadId);
            if (!goalClearSucceeded && capacityRetryToCancel) armModelCapacityRetry(deps.stateStore.read().modelCapacityRetry);
            wakeQueuedWorkAfterGoalUpdate(threadId, { allowSteer: false, allowStart: false });
          }
          return;
        }

        if (request.method === 'webui/approval/respond') {
          const params = approvalRespondParams(request.params);
          if (typeof params === 'string') {
            send(ws, { type: 'rpc/error', id: request.id, error: params });
            return;
          }

          const pendingRequest = pendingServerRequests.get(requestKey(params.requestId));
          if (!pendingRequest) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'approval request is no longer pending' });
            return;
          }
          const response = approvalResponseForDecision(pendingRequest.method, params.decision, pendingRequest.params);
          deps.codex.respond(pendingRequest.id, response);
          pendingServerRequests.delete(requestKey(params.requestId));
          send(ws, { type: 'rpc/result', id: request.id, result: { ok: true } });
          broadcastRequestResolved(pendingRequest.id);
          return;
        }

        if (request.method === 'webui/fs/browseDirectory') {
          const filePath = getRequiredString(request.params, 'path') ?? browseBasePath(deps);
          const result = await browseDirectory(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/browseWorkspaceDirectory') {
          let filePath = activeWorkspaceRoot(deps);
          if (isRecord(request.params) && hasOwn(request.params, 'path')) {
            const value = request.params.path;
            if (typeof value !== 'string' || value.trim().length === 0) {
              send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
              return;
            }
            filePath = value;
          }
          const result = await browseWorkspaceDirectory(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/repos/list') {
          const result = await listGitRepos(deps.stateStore.read());
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/repos/add') {
          const repoPath = getRequiredString(request.params, 'path');
          if (!repoPath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await addGitRepo(deps.stateStore.read(), deps.stateStore, repoPath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/repos/remove') {
          const repoId = getRequiredString(request.params, 'repoId');
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }

          const result = removeGitRepo(deps.stateStore.read(), deps.stateStore, repoId);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/status') {
          const repoId = getRequiredString(request.params, 'repoId');
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }

          const result = await gitStatusForRepo(deps.stateStore.read(), repoId);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/diff') {
          const repoId = getRequiredString(request.params, 'repoId');
          const filePath = getRequiredRawString(request.params, 'path');
          const scope = getOptionalEnum(request.params, 'scope', GIT_DIFF_SCOPES);
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }
          if (!scope) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'scope is required' });
            return;
          }

          const originalPath = getOptionalRawString(request.params, 'originalPath');
          const result = await gitDiffForRepo(deps.stateStore.read(), { repoId, path: filePath, originalPath, scope });
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/stage') {
          assertNoActiveTurnForGitMutation(deps);
          const repoId = getRequiredString(request.params, 'repoId');
          const paths = getRequiredStringArray(request.params, 'paths');
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }
          if (!paths) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'paths are required' });
            return;
          }

          const result = await gitStagePaths(deps.stateStore.read(), { repoId, paths }, deps.stateStore.read.bind(deps.stateStore));
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/unstage') {
          assertNoActiveTurnForGitMutation(deps);
          const repoId = getRequiredString(request.params, 'repoId');
          const paths = getRequiredStringArray(request.params, 'paths');
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }
          if (!paths) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'paths are required' });
            return;
          }

          const result = await gitUnstagePaths(deps.stateStore.read(), { repoId, paths }, deps.stateStore.read.bind(deps.stateStore));
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/git/commit') {
          assertNoActiveTurnForGitMutation(deps);
          const repoId = getRequiredString(request.params, 'repoId');
          const message = getString(request.params, 'message');
          if (!repoId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'repoId is required' });
            return;
          }
          if (message === null) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'message is required' });
            return;
          }

          const result = await gitCommit(deps.stateStore.read(), { repoId, message }, deps.stateStore.read.bind(deps.stateStore));
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/readDirectory') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await readDirectory(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/readFile') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await readFile(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/writeFile') {
          const filePath = getRequiredString(request.params, 'path');
          const dataBase64 = getString(request.params, 'dataBase64');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }
          if (dataBase64 === null) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'dataBase64 is required' });
            return;
          }

          const result = await writeFile(deps, filePath, dataBase64);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/createDirectory') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await createDirectory(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/createBrowseDirectory') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await createBrowseDirectory(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/createFile') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await writeFile(deps, filePath, '');
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fs/getMetadata') {
          const filePath = getRequiredString(request.params, 'path');
          if (!filePath) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'path is required' });
            return;
          }

          const result = await getMetadata(deps, filePath);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fileChange/diff') {
          const params = fileDiffParams(request.params);
          if (typeof params === 'string') {
            send(ws, { type: 'rpc/error', id: request.id, error: params });
            return;
          }

          const result = await buildFileChangeDiff(params);
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/fileChange/summary') {
          const turnId = getRequiredString(request.params, 'turnId') ?? deps.stateStore.read().activeTurnId;
          if (!turnId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'turnId is required' });
            return;
          }
          const threadId = getOptionalString(request.params, 'threadId');
          const threadPath = getOptionalString(request.params, 'threadPath');

          {
            const drain = drainPatchCaptureQueue();
            if (drain) await drain;
          }
          send(ws, { type: 'rpc/result', id: request.id, result: { turnId, files: listStoredTurnFiles(turnId, threadId, threadPath) } });
          return;
        }

        if (request.method === 'thread/turns/list') {
          const params = turnListParams(request.params);
          if (typeof params === 'string') {
            send(ws, { type: 'rpc/error', id: request.id, error: params });
            return;
          }

          let result: unknown;
          try {
            await ensureThreadResumed(params.threadId, params.threadPath);
            const codexParams = {
              threadId: params.threadId,
              cursor: params.cursor,
              limit: params.limit,
              sortDirection: params.sortDirection,
              itemsView: params.itemsView,
            };
            result = await requestCodex('thread/turns/list', codexParams, THREAD_TURNS_LIST_RPC_TIMEOUT_MS);
            markThreadRolloutObserved(params.threadId);
            const drain = drainPatchCaptureQueue();
            if (drain) await drain;
            result = augmentTurnListWithStoredFileSummaries(result, params.threadId);
          } catch (error) {
            if (
              isNoRolloutFoundError(error, params.threadId) &&
              shouldReturnEmptyTurnsForPendingRolloutThread(params.threadId)
            ) {
              result = { data: [], nextCursor: null };
              logWarn('Treating missing rollout for newly started empty thread as empty history', {
                threadId: params.threadId,
                error: error instanceof Error ? error.message : String(error),
              });
              send(ws, { type: 'rpc/result', id: request.id, result });
              return;
            }
            resumedThreadIds.delete(params.threadId);
            resumeThreadPromises.delete(params.threadId);
            if (isMissingThreadError(error)) clearMissingActiveThread(params.threadId, error);
            throw error;
          }
          send(ws, { type: 'rpc/result', id: request.id, result });
          return;
        }

        if (request.method === 'webui/queue/remove') {
          const id = getRequiredString(request.params, 'id');
          if (!id) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'id is required' });
            return;
          }
          const includeStatus = isRecord(request.params) && request.params.includeStatus === true;

          let removed = false;
          const state = deps.stateStore.update((current) => {
            removed = queueForThread(current.queue, current.activeThreadId).some((message) => message.id === id);
            return {
              ...current,
              queue: removed ? removeQueuedMessage(current.queue, id, current.activeThreadId) : current.queue,
            };
          });
          pruneTimedOutQueuedStarts(state.queue);
          const visibleQueue = queueForThread(state.queue, state.activeThreadId);
          send(ws, { type: 'rpc/result', id: request.id, result: includeStatus ? { queue: visibleQueue, removed } : visibleQueue });
          broadcastHello(state);
          maybeSteerQueuedMessage();
          return;
        }

        if (request.method === 'webui/queue/update') {
          const id = getRequiredString(request.params, 'id');
          const text = getRequiredString(request.params, 'text');
          if (!id) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'id is required' });
            return;
          }
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: updateQueuedMessage(current.queue, id, text, current.activeThreadId),
          }));
          pruneTimedOutQueuedStarts(state.queue);
          send(ws, { type: 'rpc/result', id: request.id, result: queueForThread(state.queue, state.activeThreadId) });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/turn/start') {
          const threadId = getRequiredString(request.params, 'threadId');
          const text = getRequiredString(request.params, 'text');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }
          if (runtimeOptionUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'model or effort update is in progress; retry the message' });
            return;
          }
          if (goalUpdates.size > 0) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'goal update is in progress; retry the message' });
            return;
          }
          const currentState = deps.stateStore.read();
          if (currentState.activeThreadId === threadId && codexBusy(currentState, threadId)) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'Codex is already working; queue the message instead' });
            return;
          }

          const options = runOptionsFromParams(request.params);
          const pendingTurnId = pendingTurnStartTurnId(threadId);
          const pendingState = deps.stateStore.update((current) =>
            current.activeThreadId === threadId && !current.activeTurnId
              ? applyRunOptionsToRuntimeState({ ...current, activeTurnId: pendingTurnId }, options)
              : current,
          );
          if (pendingState.activeThreadId === threadId && pendingState.activeTurnId === pendingTurnId) {
            rememberTurnThreadPath(threadId, pendingTurnId, pendingState.activeThreadPath);
            rememberTurnCwd(threadId, pendingTurnId, pendingState.activeCwd);
            broadcastHello(pendingState);
          }

          const directStartContext = { current: null as TurnContext | null };
          const contextGeneration = directStartContextGeneration;
          let result: { turn: { id: string } };
          try {
            result = await startTurn({ threadId, text, options }, (context) => {
              directStartContext.current = context;
            });
          } catch (error) {
            const ambiguousTurnId = directStartContext.current?.ambiguousTurnId;
            if (ambiguousTurnId) {
              const timedOutQueuedStart = timedOutQueuedStarts.get(threadId);
              if (timedOutQueuedStart) markTimedOutRecoveryMaybeSent(threadId, timedOutQueuedStart);
              timedOutQueuedStarts.delete(threadId);
              const reconciled = deps.stateStore.update((current) => (
                current.activeThreadId === threadId && current.activeTurnId === pendingTurnId
                  ? { ...current, activeTurnId: ambiguousTurnId }
                  : current
              ));
              broadcastHello(reconciled);
            } else if (isTurnStartTimeout(error)) {
              const context = directStartContext.current;
              const timedOutQueuedStart = timedOutQueuedStarts.get(threadId);
              if (context && timedOutQueuedStart && contextGeneration === directStartContextGeneration) {
                retainDirectStartContext(context);
              } else if (timedOutQueuedStart) {
                markTimedOutRecoveryMaybeSent(threadId, timedOutQueuedStart);
                timedOutQueuedStarts.delete(threadId);
              }
            } else {
              const cleared = clearActiveTurn({ threadId, turnId: pendingTurnId }, { broadcast: false });
              broadcastHello(cleared);
            }
            throw error;
          }

          const nextTurnId = extractTurnId(result);
          const timedOutQueuedStart = timedOutQueuedStarts.get(threadId);
          if (timedOutQueuedStart) {
            if (directStartContext.current?.ambiguousTurnId && directStartContext.current.ambiguousTurnId !== nextTurnId) {
              removeTimedOutRecovery(threadId, timedOutQueuedStart);
            } else {
              markTimedOutRecoveryMaybeSent(threadId, timedOutQueuedStart);
            }
            timedOutQueuedStarts.delete(threadId);
          }
          const alreadyCompleted = hasCompletedTurn(threadId, nextTurnId);
          const state = deps.stateStore.update((current) => {
            if (current.activeThreadId !== threadId) return current;
            if (alreadyCompleted && (current.activeTurnId === nextTurnId || current.activeTurnId === pendingTurnId)) {
              return applyRunOptionsToRuntimeState({ ...current, activeTurnId: null }, options);
            }
            if (current.activeTurnId === nextTurnId) return applyRunOptionsToRuntimeState(current, options);
            if (current.activeTurnId === pendingTurnId) return applyRunOptionsToRuntimeState({ ...current, activeTurnId: nextTurnId }, options);
            return current;
          });
          if (state.activeThreadId === threadId && state.activeTurnId === nextTurnId) {
            rememberTurnThreadPath(threadId, nextTurnId, state.activeThreadPath);
            rememberTurnCwd(threadId, nextTurnId, state.activeCwd);
            rememberLivePatchTurn(threadId, nextTurnId);
            rememberObservedTurnStart(threadId, nextTurnId);
          }
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
          if (!alreadyCompleted || !maybeStartQueuedTurnFromIdle(threadId)) maybeSteerQueuedMessage();
          return;
        }

        if (request.method === 'webui/turn/interrupt') {
          const state = deps.stateStore.read();
          const capacityRetry = modelCapacityRetryForThread(state, state.activeThreadId);
          if (capacityRetry?.status === 'scheduled') {
            const next = clearModelCapacityRetry(capacityRetry.operationId) ?? deps.stateStore.read();
            send(ws, { type: 'rpc/result', id: request.id, result: { ok: true, cancelledModelCapacityRetry: true } });
            broadcastHello(next);
            return;
          }
          if (capacityRetry?.status === 'starting') {
            markModelCapacityRetryCancelled(capacityRetry.operationId);
            scheduleModelCapacityReconciliation({ ...capacityRetry, cancelRequested: true });
            send(ws, { type: 'rpc/result', id: request.id, result: { ok: true, cancellationPending: true } });
            return;
          }
          if (capacityRetry?.status === 'inFlight') {
            const cancelled = markModelCapacityRetryCancelled(capacityRetry.operationId);
            if (cancelled) await interruptAcceptedModelCapacityRetry(cancelled);
            send(ws, { type: 'rpc/result', id: request.id, result: { ok: true, cancelledModelCapacityRetry: true } });
            return;
          }
          if (!state.activeTurnId) {
            throw new Error('no active turn to interrupt');
          }
          if (!state.activeThreadId) {
            await finalizeActiveTurnBeforeClear(null, state.activeTurnId, state.activeThreadPath);
            const next = clearActiveTurn({ turnId: state.activeTurnId }, { broadcast: false });
            send(ws, { type: 'rpc/result', id: request.id, result: { ok: false, cleared: true, error: 'active turn has no thread' } });
            broadcastHello(next);
            return;
          }

          const activeThreadId = state.activeThreadId;
          const activeTurnId = state.activeTurnId;
          const activeThreadPath = state.activeThreadPath;
          rememberCancelledTurn(activeThreadId, activeTurnId);
          const health = deps.codex.health();
          if (!health.connected || health.dead) {
            await finalizeActiveTurnBeforeClear(activeThreadId, activeTurnId, activeThreadPath);
            const next = clearActiveTurn({ threadId: activeThreadId, turnId: activeTurnId }, { broadcast: false });
            send(ws, {
              type: 'rpc/result',
              id: request.id,
              result: { ok: false, cleared: true, error: health.error ?? 'Codex app-server is not connected' },
            });
            broadcastHello(next);
            return;
          }

          try {
            await ensureThreadResumed(activeThreadId);
            const result = await requestCodex('turn/interrupt', {
              threadId: activeThreadId,
              turnId: activeTurnId,
            });
            await finalizeActiveTurnBeforeClear(activeThreadId, activeTurnId, activeThreadPath);
            const next = clearActiveTurn({ threadId: activeThreadId, turnId: activeTurnId }, { broadcast: false });
            send(ws, { type: 'rpc/result', id: request.id, result });
            broadcastHello(next);
          } catch (error) {
            if (!shouldClearActiveTurnAfterInterruptFailure(error)) throw error;
            await finalizeActiveTurnBeforeClear(activeThreadId, activeTurnId, activeThreadPath);
            const next = clearActiveTurn({ threadId: activeThreadId, turnId: activeTurnId }, { broadcast: false });
            send(ws, {
              type: 'rpc/result',
              id: request.id,
              result: { ok: false, cleared: true, error: error instanceof Error ? error.message : String(error) },
            });
            broadcastHello(next);
          }
          return;
        }

        send(ws, { type: 'rpc/error', id: request.id, error: `unsupported RPC method: ${request.method}` });
      } catch (err) {
        send(ws, { type: 'rpc/error', id: request.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return { close };
}
