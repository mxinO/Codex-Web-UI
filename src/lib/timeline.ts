import type { CodexItem, CodexTurn } from '../types/codex';
import type { CodexRunOptions } from '../types/ui';

export type TimelineItem =
  | { id: string; kind: 'user'; timestamp: number; text: string }
  | { id: string; kind: 'assistant'; timestamp: number; text: string; phase: string | null }
  | { id: string; kind: 'command'; timestamp: number; command: string; cwd: string; output: string; status: string; exitCode: number | null }
  | { id: string; kind: 'bangCommand'; timestamp: number; command: string; cwd: string; output: string; status: string; exitCode: number | null }
  | {
      id: string;
      kind: 'fileChange';
      timestamp: number;
      turnId?: string;
      item: CodexItem;
      filePath?: string | null;
      changeCount?: number;
      resolvedDiff?: { before: string; after: string; path?: string | null };
      diffLoading?: boolean;
      diffError?: string;
    }
  | {
      id: string;
      kind: 'fileChangeSummary';
      timestamp: number;
      turnId: string;
      files: Array<{ path: string; changeCount: number }>;
    }
  | { id: string; kind: 'tool'; timestamp: number; item: CodexItem }
  | { id: string; kind: 'notice'; timestamp: number; text: string }
  | { id: string; kind: 'warning'; timestamp: number; text: string }
  | { id: string; kind: 'error'; timestamp: number; text: string }
  | { id: string; kind: 'queued'; timestamp: number; message: { id: string; text: string; createdAt: number; options?: Partial<CodexRunOptions> } }
  | { id: string; kind: 'streaming'; timestamp: number; text: string; active: boolean; turnId?: string | null }
  | { id: string; kind: 'approval'; timestamp: number; requestId: number | string; method: string; params: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

export interface TimelineNotificationScope {
  activeThreadId: string | null;
  activeTurnId: string | null;
}

export interface LiveNotificationWindow {
  activeThreadId: string | null;
  activeTurnId: string | null;
  startCount: number;
}

function stringAtPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current.trim().length > 0 ? current : null;
}

function notificationParams(notification: unknown): unknown {
  return isRecord(notification) ? notification.params : null;
}

function notificationPayload(notification: unknown): unknown {
  if (!isRecord(notification)) return null;
  const params = notification.params;
  if (isRecord(params) && isRecord(params.payload)) return params.payload;
  if (isRecord(params)) return params;
  const payload = notification.payload;
  return isRecord(payload) ? payload : null;
}

export function notificationThreadId(notification: unknown): string | null {
  const params = notificationParams(notification);
  const payload = notificationPayload(notification);
  return (
    stringAtPath(params, ['threadId']) ??
    stringAtPath(params, ['thread_id']) ??
    stringAtPath(params, ['thread', 'id']) ??
    stringAtPath(params, ['thread', 'threadId']) ??
    stringAtPath(params, ['thread', 'thread_id']) ??
    stringAtPath(params, ['turn', 'threadId']) ??
    stringAtPath(params, ['turn', 'thread_id']) ??
    stringAtPath(params, ['turn', 'thread', 'id']) ??
    stringAtPath(payload, ['threadId']) ??
    stringAtPath(payload, ['thread_id']) ??
    stringAtPath(payload, ['thread', 'id']) ??
    stringAtPath(payload, ['turn', 'threadId']) ??
    stringAtPath(payload, ['turn', 'thread_id'])
  );
}

export function notificationTurnId(notification: unknown): string | null {
  const params = notificationParams(notification);
  const payload = notificationPayload(notification);
  return (
    stringAtPath(params, ['turnId']) ??
    stringAtPath(params, ['turn_id']) ??
    stringAtPath(params, ['turn', 'id']) ??
    stringAtPath(payload, ['turnId']) ??
    stringAtPath(payload, ['turn_id']) ??
    stringAtPath(payload, ['turn', 'id'])
  );
}

export function notificationMatchesActiveTurn(notification: unknown, scope: TimelineNotificationScope): boolean {
  const threadId = notificationThreadId(notification);
  const turnId = notificationTurnId(notification);

  if (threadId && scope.activeThreadId && threadId !== scope.activeThreadId) return false;
  if (turnId && scope.activeTurnId && turnId !== scope.activeTurnId) return false;
  if (threadId && scope.activeThreadId && threadId === scope.activeThreadId) return true;
  if (turnId && scope.activeTurnId && turnId === scope.activeTurnId) return true;
  if (!scope.activeThreadId && !scope.activeTurnId) return true;
  return false;
}

export function notificationIsTurnComplete(notification: unknown, scope: TimelineNotificationScope): boolean {
  if (!isRecord(notification) || typeof notification.method !== 'string') return false;
  const payload = notificationPayload(notification);
  const isComplete =
    notification.method === 'turn/completed' ||
    (notification.method === 'event_msg' && isRecord(payload) && payload.type === 'task_complete');
  if (!isComplete) return false;

  const threadId = notificationThreadId(notification);
  const turnId = notificationTurnId(notification);
  if (threadId && scope.activeThreadId && threadId !== scope.activeThreadId) return false;
  if (turnId && scope.activeTurnId && turnId !== scope.activeTurnId) return false;
  return true;
}

function stringField(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : fallback;
}

function nullableStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : null;
}

function numberOrNullField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function userText(item: CodexItem): string {
  const content: unknown[] = isRecord(item) && Array.isArray((item as Record<string, unknown>).content) ? ((item as Record<string, unknown>).content as unknown[]) : [];
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      return stringField(part, 'text') || stringField(part, 'path') || stringField(part, 'url');
    })
    .join('');
}

function safeItemId(turn: CodexTurn, item: CodexItem, index: number): string {
  return `${turn.id}:${item.id ?? index}`;
}

function itemChanges(item: CodexItem): unknown[] {
  const changes = (item as Record<string, unknown>).changes;
  if (Array.isArray(changes)) return changes.length > 0 ? changes : [item];
  return [item];
}

function changePath(change: unknown): string | null {
  return (
    stringField(change, 'path') ||
    stringField(change, 'file') ||
    stringField(change, 'filePath') ||
    stringField(change, 'file_path') ||
    null
  );
}

function fileChangeItemsForTurnItem(turn: CodexTurn, item: CodexItem, index: number, timestamp: number): TimelineItem[] {
  const itemId = safeItemId(turn, item, index);
  const changes = itemChanges(item);
  return changes.map((change, changeIndex) => {
    const filePath = changePath(change);
    const rawItemId = item.id ?? `${index}`;
    const rawItem: CodexItem = {
      ...item,
      id: changes.length === 1 ? rawItemId : `${rawItemId}:${changeIndex}`,
      type: 'fileChange',
      changes: [change],
      status: stringField(item, 'status', 'updated'),
    };
    return {
      id: changes.length === 1 ? itemId : `${itemId}:edit:${changeIndex}`,
      kind: 'fileChange',
      timestamp,
      turnId: turn.id,
      item: rawItem,
      filePath,
      changeCount: 1,
    } satisfies TimelineItem;
  });
}

function fileChangeSummaryItem(turn: CodexTurn, timestamp: number): TimelineItem | null {
  if (turn.status === 'inProgress') return null;

  const files = new Map<string, { path: string; changeCount: number; order: number }>();
  let order = 0;
  for (const item of turn.items) {
    if (item.type !== 'fileChange') continue;
    for (const change of itemChanges(item)) {
      const filePath = changePath(change);
      if (!filePath) continue;
      const existing = files.get(filePath);
      if (existing) {
        existing.changeCount += 1;
        continue;
      }
      files.set(filePath, { path: filePath, changeCount: 1, order: order++ });
    }
  }

  if (files.size === 0) return null;
  return {
    id: `${turn.id}:file-summary`,
    kind: 'fileChangeSummary',
    timestamp,
    turnId: turn.id,
    files: Array.from(files.values())
      .sort((a, b) => a.order - b.order)
      .map(({ path, changeCount }) => ({ path, changeCount })),
  };
}

export function turnToTimelineItems(turn: CodexTurn): TimelineItem[] {
  const timestamp = (turn.startedAt ?? 0) * 1000;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const timelineItems = items.flatMap((item, index): TimelineItem[] => {
    const id = safeItemId(turn, item, index);
    if (item.type === 'fileChange') return fileChangeItemsForTurnItem({ ...turn, items }, item, index, timestamp);
    if (item.type === 'userMessage') return [{ id, kind: 'user', timestamp, text: userText(item) }];
    if (item.type === 'agentMessage') return [{ id, kind: 'assistant', timestamp, text: stringField(item, 'text'), phase: nullableStringField(item, 'phase') }];
    if (item.type === 'commandExecution') {
      return [{
        id,
        kind: 'command',
        timestamp,
        command: stringField(item, 'command'),
        cwd: stringField(item, 'cwd'),
        output: stringField(item, 'aggregatedOutput'),
        status: stringField(item, 'status', 'unknown'),
        exitCode: numberOrNullField(item, 'exitCode'),
      }];
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === 'string') : [];
      const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === 'string') : [];
      return [{ id, kind: 'notice', timestamp, text: [...summary, ...content].join('\n') }];
    }
    if (item.type === 'plan') return [{ id, kind: 'notice', timestamp, text: stringField(item, 'text') }];
    if (item.type === 'warning') return [{ id, kind: 'warning', timestamp, text: stringField(item, 'message') || stringField(item, 'text') || item.type }];
    if (item.type === 'error') return [{ id, kind: 'error', timestamp, text: stringField(item, 'message') || stringField(item, 'text') || item.type }];
    return [{ id, kind: 'tool', timestamp, item }];
  });
  const summary = fileChangeSummaryItem({ ...turn, items }, timestamp);
  return summary ? [...timelineItems, summary] : timelineItems;
}

export function trimTimelineWindow<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

export function mergeTimelineItemsByTimestamp(items: TimelineItem[]): TimelineItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTime = Number.isFinite(a.item.timestamp) ? a.item.timestamp : 0;
      const bTime = Number.isFinite(b.item.timestamp) ? b.item.timestamp : 0;
      return aTime - bTime || a.index - b.index;
    })
    .map(({ item }) => item);
}

export function timelineItemTurnId(item: TimelineItem): string | null {
  if ('turnId' in item && typeof item.turnId === 'string') return item.turnId;
  const separator = item.id.indexOf(':');
  return separator > 0 ? item.id.slice(0, separator) : null;
}

function hasStringAtPath(value: unknown, path: string[]): boolean {
  return stringAtPath(value, path) !== null;
}

export function fileChangeHasInlineDiff(item: Extract<TimelineItem, { kind: 'fileChange' }>): boolean {
  const itemRecord = item.item as Record<string, unknown>;
  const changes: unknown[] = Array.isArray(itemRecord.changes) ? itemRecord.changes : [item.item];
  return changes.some((change) =>
    hasStringAtPath(change, ['diff']) ||
    hasStringAtPath(change, ['patch']) ||
    hasStringAtPath(change, ['unifiedDiff']) ||
    hasStringAtPath(change, ['unified_diff']) ||
    hasStringAtPath(change, ['before']) ||
    hasStringAtPath(change, ['after']) ||
    hasStringAtPath(change, ['oldText']) ||
    hasStringAtPath(change, ['newText']) ||
    hasStringAtPath(change, ['old_text']) ||
    hasStringAtPath(change, ['new_text']) ||
    hasStringAtPath(change, ['beforeContent']) ||
    hasStringAtPath(change, ['afterContent']) ||
    hasStringAtPath(change, ['before_content']) ||
    hasStringAtPath(change, ['after_content'])
  );
}

export function shouldShowLiveStreamingItem(items: TimelineItem[], liveItem: Extract<TimelineItem, { kind: 'streaming' }> | null): boolean {
  if (!liveItem) return false;
  if (liveItem.active || !liveItem.turnId) return true;
  return !items.some(
    (item) =>
      item.kind === 'assistant' &&
      timelineItemTurnId(item) === liveItem.turnId &&
      (item.phase === null || item.phase === 'final_answer' || item.phase === 'final'),
  );
}

function normalizedMessageBlock(text: string): string {
  return text.trim().replace(/\r\n/g, '\n');
}

export function liveStreamingItemForTimeline(
  items: TimelineItem[],
  liveItem: Extract<TimelineItem, { kind: 'streaming' }> | null,
): Extract<TimelineItem, { kind: 'streaming' }> | null {
  if (!shouldShowLiveStreamingItem(items, liveItem)) return null;
  if (!liveItem?.turnId || !liveItem.text) return liveItem;

  const persistedCommentary = new Set(
    items
      .filter(
        (item): item is Extract<TimelineItem, { kind: 'assistant' }> =>
          item.kind === 'assistant' &&
          timelineItemTurnId(item) === liveItem.turnId &&
          item.phase !== null &&
          item.phase !== 'final_answer' &&
          item.phase !== 'final' &&
          normalizedMessageBlock(item.text).length > 0,
      )
      .map((item) => normalizedMessageBlock(item.text)),
  );
  if (persistedCommentary.size === 0) return liveItem;

  const text = liveItem.text
    .split(/\n{2,}/)
    .filter((block) => !persistedCommentary.has(normalizedMessageBlock(block)))
    .join('\n\n');
  if (!text && !liveItem.active) return null;
  return { ...liveItem, text };
}

export function notificationsSinceCount<T>(notifications: T[], totalCount: number, startCount: number): T[] {
  const retainedAfterStart = Math.max(0, totalCount - startCount);
  const firstRetainedAfterStart = Math.max(0, notifications.length - retainedAfterStart);
  return notifications.slice(firstRetainedAfterStart);
}

export function latestCompletionNotificationCount(
  notifications: unknown[],
  totalCount: number,
  scope: TimelineNotificationScope,
): number | null {
  const firstNotificationCount = totalCount - notifications.length + 1;
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (notificationIsTurnComplete(notifications[index], scope)) return firstNotificationCount + index;
  }
  return null;
}

export function liveTimelineItemsFromNotifications(
  notifications: unknown[],
  scope: TimelineNotificationScope,
  now = Date.now(),
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const seenIds = new Set<string>();

  for (const notification of notifications) {
    if (!isRecord(notification) || notification.method !== 'item/completed') continue;
    if (!notificationMatchesActiveTurn(notification, scope)) continue;
    if (!isRecord(notification.params) || !isRecord(notification.params.item)) continue;

    const rawItem = notification.params.item as CodexItem;
    if (rawItem.type === 'agentMessage' || rawItem.type === 'userMessage') continue;

    const turnId = notificationTurnId(notification) ?? scope.activeTurnId ?? 'live';
    const converted = turnToTimelineItems({
      id: turnId,
      status: 'inProgress',
      startedAt: now / 1000,
      completedAt: null,
      items: [rawItem],
    });
    items.push(
      ...converted.filter(
        (item) => {
          if (item.kind !== 'command' && item.kind !== 'fileChange' && item.kind !== 'tool' && item.kind !== 'warning' && item.kind !== 'error') {
            return false;
          }
          if (seenIds.has(item.id)) return false;
          seenIds.add(item.id);
          return true;
        },
      ),
    );
  }

  return items;
}

export function nextLiveNotificationWindow(
  current: LiveNotificationWindow,
  scope: TimelineNotificationScope,
  notificationCount: number,
): LiveNotificationWindow {
  if (current.activeThreadId !== scope.activeThreadId) {
    return { ...scope, startCount: notificationCount };
  }
  if (scope.activeTurnId && current.activeTurnId !== scope.activeTurnId) {
    return { ...scope, startCount: notificationCount };
  }
  if (!current.activeTurnId && !scope.activeTurnId) {
    return { ...scope, startCount: notificationCount };
  }
  return current;
}

export function liveStreamingItemFromNotifications(
  notifications: unknown[],
  scope: TimelineNotificationScope,
  active: boolean,
  now = Date.now(),
  options: { acceptUnscoped?: boolean } = {},
): Extract<TimelineItem, { kind: 'streaming' }> | null {
  let text = '';
  let turnId: string | null = null;
  const acceptUnscoped = options.acceptUnscoped ?? active;

  for (const notification of notifications) {
    if (!isRecord(notification) || typeof notification.method !== 'string') continue;

    if (notification.method === 'turn/completed') {
      if (notificationMatchesActiveTurn(notification, scope)) turnId = notificationTurnId(notification) ?? turnId;
      continue;
    }

    if (notification.method === 'item/agentMessage/delta' && isRecord(notification.params)) {
      if (!notificationMatchesActiveTurn(notification, scope)) continue;
      const delta = notification.params.delta;
      if (typeof delta === 'string') text += delta;
      turnId = notificationTurnId(notification) ?? turnId;
      continue;
    }

    if (notification.method !== 'event_msg') continue;
    const payload = notificationPayload(notification);
    if (!isRecord(payload)) continue;
    if (payload.type === 'task_complete') {
      if (notificationIsTurnComplete(notification, scope)) turnId = notificationTurnId(notification) ?? turnId;
      continue;
    }
    if (payload.type !== 'agent_message') continue;
    const hasScopeId = Boolean(notificationThreadId(notification) || notificationTurnId(notification));
    if (hasScopeId && !notificationMatchesActiveTurn(notification, scope)) continue;
    if (!hasScopeId && !acceptUnscoped) continue;
    const message = payload.message;
    if (typeof message === 'string' && message.trim()) text = text ? `${text}\n\n${message}` : message;
    turnId = notificationTurnId(notification) ?? turnId;
  }

  if (!text && !active) return null;

  return {
    id: 'live:streaming-assistant',
    kind: 'streaming',
    timestamp: now,
    text,
    active,
    turnId,
  };
}

export function approvalItemsFromRequests(requests: unknown[], answeredRequestIds: ReadonlySet<string>, now = Date.now()): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();

  for (const request of requests) {
    if (!isRecord(request) || typeof request.method !== 'string') continue;
    const requestId = request.id;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') continue;

    const key = requestKey(requestId);
    if (answeredRequestIds.has(key)) continue;

    byId.set(key, {
      id: `approval:${key}`,
      kind: 'approval',
      timestamp: now,
      requestId,
      method: request.method,
      params: request.params,
    });
  }

  return Array.from(byId.values());
}
