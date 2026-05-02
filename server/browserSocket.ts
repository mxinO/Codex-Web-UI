import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type http from 'node:http';
import nodePath from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isTokenValid, parseTokenFromCookie } from './auth.js';
import type { CodexAppServer } from './appServer.js';
import { isInteractiveCommandBlocked, runBangCommand } from './bangCommand.js';
import type { ServerConfig } from './config.js';
import { FileEditStore, sessionFileEditDbPath } from './fileEditStore.js';
import { assertPathInsideRoot, resolveExistingPathInsideRoot, resolveWritablePathInsideRoot } from './fileTransfer.js';
import type { HostStateStore } from './hostState.js';
import type { JsonRpcServerRequest } from './jsonRpc.js';
import { logWarn } from './logger.js';
import { enqueueMessage, removeQueuedMessage, shiftQueuedMessage, updateQueuedMessage } from './queue.js';
import type { CodexCollaborationMode, CodexReasoningEffort, CodexRunOptions, CodexSandboxMode, HostRuntimeState, QueuedMessage } from './types.js';

interface BrowserSocketDeps {
  config: ServerConfig;
  codex: CodexAppServer;
  stateStore: HostStateStore;
  token: string;
  startCwd?: string;
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

function authorized(deps: BrowserSocketDeps, queryToken: string | null, cookieHeader: string | undefined): boolean {
  if (deps.config.noAuth) return true;
  return isTokenValid(deps.token, queryToken) || isTokenValid(deps.token, parseTokenFromCookie(cookieHeader));
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

const REASONING_EFFORTS = new Set<CodexReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SANDBOX_MODES = new Set<CodexSandboxMode>(['read-only', 'workspace-write', 'danger-full-access']);
const COLLABORATION_MODES = new Set<CodexCollaborationMode>(['default', 'plan']);
const BROWSE_DIRECTORY_LIMIT = 500;
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
const TURN_START_RPC_TIMEOUT_MS = 10 * 60 * 1000;
const RECENT_NOTIFICATION_MAX_ENTRIES = 500;
const RECENT_NOTIFICATION_MAX_BYTES = 2 * 1024 * 1024;
const RECENT_NOTIFICATION_SINGLE_MAX_BYTES = 256 * 1024;

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

  const effort = getOptionalEnum(source, 'effort', REASONING_EFFORTS);
  if (effort) options.effort = effort;

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
  const effort =
    enumValue(getValuePath(result, ['reasoningEffort']), REASONING_EFFORTS) ??
    enumValue(getValuePath(result, ['reasoning_effort']), REASONING_EFFORTS) ??
    enumValue(getValuePath(result, ['effort']), REASONING_EFFORTS) ??
    fallback?.effort ??
    null;
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

type TerminalDisposition = 'advance-queue' | 'barrier';

function taskTerminalDisposition(message: { method?: unknown; params?: unknown; payload?: unknown }): TerminalDisposition | null {
  if (message.method !== 'event_msg') return null;
  const payload = notificationPayload(message);
  const type = getStringPath(payload, ['type']);
  if (type === 'task_complete') return 'advance-queue';
  if (type === 'task_failed' || type === 'task_interrupted') return 'barrier';
  return null;
}

function notificationTerminalDisposition(message: { method?: unknown; params?: unknown; payload?: unknown }): TerminalDisposition | null {
  if (message.method === 'turn/completed' || message.method === 'thread/compacted') return 'advance-queue';
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
  options: { allowMissingTurnId: boolean } = { allowMissingTurnId: true },
): boolean {
  if (!activeTurnId) return false;
  if (!completedTurnId) return options.allowMissingTurnId && isPendingCompactionTurnForThread(activeTurnId, activeThreadId);
  if (completedTurnId === activeTurnId) return true;
  return isPendingCompactionTurnForThread(activeTurnId, activeThreadId);
}

function isTurnStartTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out:\s*turn\/start|request timed out:\s*turn\/start/i.test(message);
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
  const resolvedPath = await resolveReadableRpcPath(deps, requestedPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) throw new Error('path is not a file');
  const data = await fs.readFile(resolvedPath);
  return { dataBase64: data.toString('base64') };
}

async function writeFile(deps: BrowserSocketDeps, requestedPath: string, dataBase64: string) {
  const resolvedPath = await resolveWritableRpcPath(deps, requestedPath);
  await fs.writeFile(resolvedPath, Buffer.from(dataBase64, 'base64'));
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

function turnListParams(params: unknown): { threadId: string; cursor: unknown; limit: number; sortDirection: string } | string {
  if (!isRecord(params)) return 'thread list params are required';
  const threadId = getRequiredString(params, 'threadId');
  if (!threadId) return 'threadId is required';

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 50;
  const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc';
  return {
    threadId,
    cursor: typeof params.cursor === 'string' ? params.cursor : null,
    limit,
    sortDirection,
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
}

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
  let closed = false;
  let queuedStartInFlight: { threadId: string; queuedMessage: QueuedMessage } | null = null;
  let bangCommandInFlight = false;
  const notificationStreamId = randomUUID();
  const pendingTurnStartContexts: TurnContext[] = [];
  const pendingServerRequests = new Map<string, JsonRpcServerRequest>();
  const resumedThreadIds = new Set<string>();
  const resumeThreadPromises = new Map<string, Promise<void>>();
  const knownThreadPaths = new Map<string, string>();
  const timedOutQueuedStarts = new Map<string, QueuedMessage>();
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
  const completedTurnKeys = new Set<string>();
  const turnThreadPaths = new Map<string, string>();
  const turnCwds = new Map<string, string>();
  const livePatchTurnKeys = new Set<string>();
  const capturedPatchEventKeys = new Set<string>();

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

  const trustedDiffRoot = (state: HostRuntimeState, threadId: string | null, threadPath: string | null): string | null => {
    if (!state.activeCwd) return null;
    if (threadId && threadId !== state.activeThreadId) return null;
    if (threadPath && threadPath !== state.activeThreadPath) return null;
    return state.activeCwd;
  };

  const rememberTerminalTurnKey = (key: string) => {
    terminalTurnKeys.add(key);
    while (terminalTurnKeys.size > 200) {
      const oldest = terminalTurnKeys.keys().next().value;
      if (typeof oldest !== 'string') break;
      terminalTurnKeys.delete(oldest);
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

  const hasCompletedTurn = (threadId: string | null, turnId: string | null): boolean => {
    if (!turnId) return false;
    return (
      terminalTurnKeys.has(turnKey(threadId, turnId)) ||
      terminalTurnKeys.has(turnKey(null, turnId)) ||
      completedTurnKeys.has(turnKey(threadId, turnId)) ||
      completedTurnKeys.has(turnKey(null, turnId))
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

  const takePendingTurnStartContext = (threadId: string | null): TurnContext | null => {
    const index = threadId ? pendingTurnStartContexts.findIndex((context) => context.threadId === threadId) : 0;
    if (index < 0) return null;
    const [context] = pendingTurnStartContexts.splice(index, 1);
    return context ?? null;
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

  const sendHello = (client: WebSocket, state: HostRuntimeState = deps.stateStore.read()) => {
    send(client, {
      type: 'server/hello',
      hostname: deps.config.hostname,
      startCwd: deps.startCwd ?? null,
      notificationStreamId,
      state,
      appServerHealth: deps.codex.health(),
      requests: Array.from(pendingServerRequests.values()),
    });
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
    const effectiveAfterSeq = requestedStreamId === notificationStreamId ? afterSeq : null;
    for (const notification of recentNotifications) {
      if (effectiveAfterSeq === null || notification.seq > effectiveAfterSeq) sendNotification(client, notification.seq, notification.message);
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
    return /no rollout found for thread id|thread not found|thread .* not found/i.test(message);
  };

  const clearMissingActiveThread = (threadId: string, error: unknown): HostRuntimeState => {
    resumedThreadIds.delete(threadId);
    resumeThreadPromises.delete(threadId);
    knownThreadPaths.delete(threadId);
    const current = deps.stateStore.read();
    if (current.activeThreadId !== threadId) return current;

    const next = deps.stateStore.update((state) => {
      if (state.activeThreadId !== threadId) return state;
      return {
        ...state,
        activeThreadId: null,
        activeThreadPath: null,
        activeTurnId: null,
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

  clearActiveTurn({}, { broadcast: false });

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
    resumedThreadIds.clear();
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

  const ensureThreadResumed = (threadId: string): Promise<void> => {
    if (resumedThreadIds.has(threadId)) return Promise.resolve();
    const existing = resumeThreadPromises.get(threadId);
    if (existing) return existing;

    let resumePromise: Promise<void>;
    resumePromise = requestCodex('thread/resume', { threadId, experimentalRawEvents: true, persistExtendedHistory: true, excludeTurns: true })
      .then((result) => {
        const activeCwd = extractThreadCwd(result);
        const activeThreadPath = extractThreadPath(result);
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
        if (updatedActiveThread) broadcastHello(nextState);
        resumedThreadIds.add(threadId);
      })
      .catch((error) => {
        if (isMissingThreadError(error)) clearMissingActiveThread(threadId, error);
        throw error;
      })
      .finally(() => {
        if (resumeThreadPromises.get(threadId) === resumePromise) {
          resumeThreadPromises.delete(threadId);
        }
      });
    resumeThreadPromises.set(threadId, resumePromise);
    return resumePromise;
  };

  const startTurn = async ({ threadId, text, options }: TurnStartParams) => {
    await ensureThreadResumed(threadId);
    const context = startContextForThread(threadId);
    pendingTurnStartContexts.push(context);
    try {
      return await requestCodex<{ turn: { id: string } }>(
        'turn/start',
        applyTurnRunOptions(
          {
            threadId,
            input: [{ type: 'text', text, text_elements: [] }],
          },
          options,
          context.cwd,
        ),
        TURN_START_RPC_TIMEOUT_MS,
      );
    } finally {
      const index = pendingTurnStartContexts.indexOf(context);
      if (index >= 0) pendingTurnStartContexts.splice(index, 1);
    }
  };

  const handleTurnCompleted = async (message: { method?: unknown; params?: unknown; payload?: unknown }, disposition: TerminalDisposition) => {
    const advanceQueue = disposition === 'advance-queue';
    const allowMissingTurnId = advanceQueue;
    const completedThreadId = notificationThreadId(message);
    const completedTurnId = notificationTurnId(message);
    const current = deps.stateStore.read();

    const missingTurnIdCanMatch =
      allowMissingTurnId && isPendingCompactionTurnForThread(current.activeTurnId, current.activeThreadId);
    const turnIdToFinalize = completedTurnId ?? (missingTurnIdCanMatch ? current.activeTurnId : null);
    const threadIdToFinalize = completedThreadId ?? (turnIdToFinalize === current.activeTurnId ? current.activeThreadId : null);
    const completionKey = turnIdToFinalize ? turnKey(threadIdToFinalize, turnIdToFinalize) : null;
    if (completionKey && (completingTurnKeys.has(completionKey) || completedTurnKeys.has(completionKey))) return;
    if (completionKey) {
      completingTurnKeys.add(completionKey);
      rememberTerminalTurnKey(completionKey);
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
    const activeCompletion =
      Boolean(afterFinalize.activeTurnId) &&
      (!completedThreadId || completedThreadId === afterFinalize.activeThreadId) &&
      completionMatchesActiveTurn(afterFinalize.activeTurnId, afterFinalize.activeThreadId, completedTurnId, { allowMissingTurnId });

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
      return;
    }

    if (queuedStartInFlight || !advanceQueue) {
      const cleared = deps.stateStore.update((current) => {
        const stillActiveCompletion =
          Boolean(current.activeTurnId) &&
          (!completedThreadId || completedThreadId === current.activeThreadId) &&
          completionMatchesActiveTurn(current.activeTurnId, current.activeThreadId, completedTurnId, { allowMissingTurnId });
        return stillActiveCompletion ? { ...current, activeTurnId: null } : current;
      });
      broadcastHello(cleared);
      if (completionKey) {
        completingTurnKeys.delete(completionKey);
        if (finalizedForCompletionKey) {
          rememberCompletedTurnKey(completionKey);
        }
      }
      return;
    }

    const claim: { threadId?: string; queuedMessage?: QueuedMessage } = {};

    const claimed = deps.stateStore.update((current) => {
      const stillActiveCompletion =
        Boolean(current.activeThreadId && current.activeTurnId) &&
        (!completedThreadId || completedThreadId === current.activeThreadId) &&
        completionMatchesActiveTurn(current.activeTurnId, current.activeThreadId, completedTurnId, { allowMissingTurnId });
      if (!stillActiveCompletion) return current;

      if (!current.activeThreadId) {
        return { ...current, activeTurnId: null };
      }

      const shifted = shiftQueuedMessage(current.queue);
      if (!shifted.next) {
        return { ...current, activeTurnId: null };
      }

      claim.threadId = current.activeThreadId;
      claim.queuedMessage = shifted.next;
      return applyRunOptionsToRuntimeState(
        { ...current, activeTurnId: pendingTurnStartTurnId(current.activeThreadId), queue: shifted.queue },
        shifted.next.options,
      );
    });
    broadcastHello(claimed);

    const { threadId, queuedMessage } = claim;
    if (!threadId || !queuedMessage) {
      if (completionKey) {
        completingTurnKeys.delete(completionKey);
        if (finalizedForCompletionKey) {
          rememberCompletedTurnKey(completionKey);
        }
      }
      return;
    }

    queuedStartInFlight = { threadId, queuedMessage };
    if (completionKey) {
      completingTurnKeys.delete(completionKey);
      if (finalizedForCompletionKey) {
        rememberCompletedTurnKey(completionKey);
      }
    }

    try {
      const result = await startTurn({ threadId, text: queuedMessage.text, options: queuedMessage.options });
      const nextTurnId = extractTurnId(result);
      timedOutQueuedStarts.delete(threadId);
      const alreadyCompleted = hasCompletedTurn(threadId, nextTurnId);
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
            queue: current.queue.some((message) => message.id === queuedMessage.id)
              ? current.queue
              : [queuedMessage, ...current.queue].slice(0, deps.config.queueLimit),
          };
        });
        if (restoredQueuedMessage) timedOutQueuedStarts.set(threadId, queuedMessage);
        broadcastHello(next);
        return;
      }
      const next = deps.stateStore.update((current) => {
        if (current.activeThreadId !== threadId || !isPendingTurnStartForThread(current.activeTurnId, threadId)) return current;
        return {
          ...current,
          activeTurnId: null,
          queue: current.queue.some((message) => message.id === queuedMessage.id)
            ? current.queue
            : [queuedMessage, ...current.queue].slice(0, deps.config.queueLimit),
        };
      });
      broadcastHello(next);
    } finally {
      queuedStartInFlight = null;
    }
  };

  const handleTaskStarted = (message: { params?: unknown; payload?: unknown }) => {
    const turnId = notificationTurnId(message);
    if (!turnId) return;

    const notifiedThreadId = notificationThreadId(message);
    const pendingContext = takePendingTurnStartContext(notifiedThreadId);
    const current = deps.stateStore.read();
    const threadId = notifiedThreadId ?? pendingContext?.threadId ?? current.activeThreadId;
    const threadPath =
      pendingContext?.threadPath ??
      (threadId && threadId === current.activeThreadId ? current.activeThreadPath : threadId ? knownThreadPaths.get(threadId) ?? null : null);
    const cwd = pendingContext?.cwd ?? (threadId && threadId === current.activeThreadId ? current.activeCwd : null);

    rememberKnownThreadPath(threadId, threadPath);
    rememberTurnThreadPath(threadId, turnId, threadPath);
    rememberTurnCwd(threadId, turnId, cwd);
    rememberLivePatchTurn(threadId, turnId);
    const alreadyCompleted = hasCompletedTurn(threadId, turnId);

    const timedOutQueuedStart = threadId ? timedOutQueuedStarts.get(threadId) : null;
    if (threadId && timedOutQueuedStart) {
      timedOutQueuedStarts.delete(threadId);
      deps.stateStore.update((state) =>
        state.activeThreadId === threadId
          ? {
              ...state,
              queue: state.queue.filter((message) => message.id !== timedOutQueuedStart.id || message.text !== timedOutQueuedStart.text),
            }
          : state,
      );
    }

    if (!threadId || current.activeThreadId !== threadId || current.activeTurnId === turnId) return;
    if (current.activeTurnId && current.activeTurnId !== turnId && !isPendingTurnForThread(current.activeTurnId, threadId)) return;

    const next = deps.stateStore.update((state) => ({
      ...state,
      activeTurnId: state.activeThreadId === threadId ? (alreadyCompleted ? null : turnId) : state.activeTurnId,
      activeThreadPath: state.activeThreadId === threadId ? (threadPath ?? state.activeThreadPath) : state.activeThreadPath,
      activeCwd: state.activeThreadId === threadId ? (cwd ?? state.activeCwd) : state.activeCwd,
    }));
    broadcastHello(next);
  };

  const unsubscribeNotification = deps.codex.onNotification((message) => {
    const seq = rememberNotification(message);
    const isTaskStart = message.method === 'turn/started' || (message.method === 'event_msg' && isTaskStartedEvent(message));
    if (isTaskStart) handleTaskStarted(message);

    for (const client of wss.clients) sendNotification(client, seq, message);
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
      resumedThreadIds.clear();
      resumeThreadPromises.clear();
      pendingServerRequests.clear();
      const current = deps.stateStore.read();
      if (current.activeTurnId) {
        const { activeThreadId, activeThreadPath, activeTurnId } = current;
        void finalizeActiveTurnBeforeClear(activeThreadId, activeTurnId, activeThreadPath).finally(() => {
          clearActiveTurn({ threadId: activeThreadId, turnId: activeTurnId }, { broadcast: true });
        });
        return;
      }
    }
    broadcastHello();
  });

  const close = () => {
    if (closed) return;
    closed = true;
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
    ws.on('error', (err) => {
      logWarn('Browser WebSocket client error', err);
    });

    const url = new URL(req.url ?? '/ws', 'http://localhost');
    if (!authorized(deps, url.searchParams.get('token'), req.headers.cookie)) {
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
          const cwd = getRequiredString(request.params, 'cwd');
          if (!cwd) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cwd is required' });
            return;
          }

          const options = runOptionsFromParams(request.params);
          const params = applyThreadRunOptions<SessionStartParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
            cwd,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
          }, options);
          const result = await requestCodex('thread/start', params);
          const activeCwd = extractThreadCwd(result) ?? cwd;
          const activeThreadId = extractThreadId(result);
          const activeThreadPath = extractThreadPath(result);
          const runtimeStatus = runtimeStatusFromThreadResult(result, options);
          rememberKnownThreadPath(activeThreadId, activeThreadPath);
          if (activeThreadId) resumedThreadIds.add(activeThreadId);
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId,
            activeThreadPath,
            activeTurnId: null,
            activeCwd,
            ...runtimeStatus,
            recentCwds: rememberCwd(state.recentCwds, activeCwd),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/session/resume') {
          const threadId = getRequiredString(request.params, 'threadId');
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          const requestedThreadPath = getOptionalString(request.params, 'threadPath');

          const options = runOptionsFromParams(request.params);
          const params = applyThreadRunOptions<SessionResumeParams & { experimentalRawEvents: boolean; persistExtendedHistory: boolean; [key: string]: unknown }>({
            threadId,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
            excludeTurns: true,
          }, options);
          const result = await requestCodex('thread/resume', params).catch((error) => {
            if (isMissingThreadError(error)) clearMissingActiveThread(threadId, error);
            throw error;
          });
          resumedThreadIds.add(threadId);
          const activeCwd = extractThreadCwd(result) ?? deps.stateStore.read().activeCwd;
          const resultThreadPath = extractThreadPath(result);
          const activeThreadPath =
            resultThreadPath ?? (requestedThreadPath && knownThreadPaths.get(threadId) === requestedThreadPath ? requestedThreadPath : null);
          const runtimeStatus = runtimeStatusFromThreadResult(result, options);
          rememberKnownThreadPath(threadId, activeThreadPath);
          const state = deps.stateStore.update((state) => ({
            ...state,
            activeThreadId: threadId,
            activeThreadPath,
            activeTurnId: null,
            activeCwd,
            ...runtimeStatus,
            recentCwds: activeCwd ? rememberCwd(state.recentCwds, activeCwd) : state.recentCwds,
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: sanitizeThreadHistory(result) });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/queue/enqueue') {
          const text = getRequiredString(request.params, 'text');
          if (!text) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'text is required' });
            return;
          }

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: enqueueMessage(current.queue, text, deps.config.queueLimit, runOptionsFromParams(request.params)),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
          broadcastHello(state);
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
          const state = deps.stateStore.read();
          const threadId = getRequiredString(request.params, 'threadId') ?? state.activeThreadId;
          if (!threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'threadId is required' });
            return;
          }
          if (state.activeTurnId && state.activeThreadId === threadId) {
            send(ws, { type: 'rpc/error', id: request.id, error: 'cannot compact while Codex is working' });
            return;
          }

          const pendingTurnId = pendingCompactionTurnId(threadId);
          const markedState = deps.stateStore.update((current) =>
            current.activeThreadId === threadId && !current.activeTurnId ? { ...current, activeTurnId: pendingTurnId } : current,
          );
          if (markedState.activeThreadId === threadId && markedState.activeTurnId === pendingTurnId) broadcastHello(markedState);

          try {
            await ensureThreadResumed(threadId);
            const result = await requestCodex('thread/compact/start', { threadId });
            send(ws, { type: 'rpc/result', id: request.id, result });
          } catch (error) {
            const cleared = clearActiveTurn({ threadId, turnId: pendingTurnId }, { broadcast: false });
            broadcastHello(cleared);
            throw error;
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
            await ensureThreadResumed(params.threadId);
            result = await requestCodex('thread/turns/list', params, THREAD_TURNS_LIST_RPC_TIMEOUT_MS);
            const drain = drainPatchCaptureQueue();
            if (drain) await drain;
            result = augmentTurnListWithStoredFileSummaries(result, params.threadId);
          } catch (error) {
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

          const state = deps.stateStore.update((current) => ({
            ...current,
            queue: removeQueuedMessage(current.queue, id),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
          broadcastHello(state);
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
            queue: updateQueuedMessage(current.queue, id, text),
          }));
          send(ws, { type: 'rpc/result', id: request.id, result: state.queue });
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
          const currentState = deps.stateStore.read();
          if (currentState.activeThreadId === threadId && currentState.activeTurnId) {
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

          let result: { turn: { id: string } };
          try {
            result = await startTurn({ threadId, text, options });
          } catch (error) {
            if (!isTurnStartTimeout(error)) {
              const cleared = clearActiveTurn({ threadId, turnId: pendingTurnId }, { broadcast: false });
              broadcastHello(cleared);
            }
            throw error;
          }

          const nextTurnId = extractTurnId(result);
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
          }
          send(ws, { type: 'rpc/result', id: request.id, result });
          broadcastHello(state);
          return;
        }

        if (request.method === 'webui/turn/interrupt') {
          const state = deps.stateStore.read();
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
