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
  | { id: string; kind: 'streaming'; timestamp: number; text: string; active: boolean }
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

export function notificationThreadId(notification: unknown): string | null {
  const params = notificationParams(notification);
  return (
    stringAtPath(params, ['threadId']) ??
    stringAtPath(params, ['thread_id']) ??
    stringAtPath(params, ['thread', 'id']) ??
    stringAtPath(params, ['thread', 'threadId']) ??
    stringAtPath(params, ['thread', 'thread_id']) ??
    stringAtPath(params, ['turn', 'threadId']) ??
    stringAtPath(params, ['turn', 'thread_id']) ??
    stringAtPath(params, ['turn', 'thread', 'id'])
  );
}

export function notificationTurnId(notification: unknown): string | null {
  const params = notificationParams(notification);
  return stringAtPath(params, ['turnId']) ?? stringAtPath(params, ['turn_id']) ?? stringAtPath(params, ['turn', 'id']);
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

function safePathKey(path: string | null, fallback: string): string {
  return path ?? `unknown:${fallback}`;
}

interface FileChangeGroup {
  key: string;
  firstIndex: number;
  order: number;
  filePath: string | null;
  changes: unknown[];
  itemIds: string[];
  lastStatus: string;
  firstItem: CodexItem;
}

function fileChangeItemsForTurnItem(turn: CodexTurn, item: CodexItem, index: number, timestamp: number): TimelineItem[] {
  const groups = new Map<string, FileChangeGroup>();
  let order = 0;
  const itemId = safeItemId(turn, item, index);

  for (const change of itemChanges(item)) {
    const filePath = changePath(change);
    const key = safePathKey(filePath, itemId);
    const existing = groups.get(key);
    if (existing) {
      existing.changes.push(change);
      existing.itemIds.push(item.id ?? `${index}`);
      existing.lastStatus = stringField(item, 'status', existing.lastStatus);
      continue;
    }

    groups.set(key, {
      key,
      firstIndex: index,
      order: order++,
      filePath,
      changes: [change],
      itemIds: [item.id ?? `${index}`],
      lastStatus: stringField(item, 'status', 'updated'),
      firstItem: item,
    });
  }

  const sorted = Array.from(groups.values()).sort((a, b) => a.order - b.order);
  return sorted.map((group) => {
    const item: CodexItem = {
      ...group.firstItem,
      id: group.itemIds.join('+'),
      type: 'fileChange',
      changes: group.changes,
      status: group.lastStatus,
      groupedItemIds: group.itemIds,
    };
    return {
      id: sorted.length === 1 ? itemId : `${itemId}:file:${group.key}`,
      kind: 'fileChange',
      timestamp,
      turnId: turn.id,
      item,
      filePath: group.filePath,
      changeCount: group.changes.length,
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

export function liveStreamingItemFromNotifications(
  notifications: unknown[],
  scope: TimelineNotificationScope,
  active: boolean,
  now = Date.now(),
): TimelineItem | null {
  let text = '';

  for (const notification of notifications) {
    if (!isRecord(notification) || typeof notification.method !== 'string') continue;

    if (notification.method === 'turn/completed') {
      if (notificationMatchesActiveTurn(notification, scope)) text = '';
      continue;
    }

    if (notification.method !== 'item/agentMessage/delta' || !isRecord(notification.params)) continue;
    if (!notificationMatchesActiveTurn(notification, scope)) continue;
    const delta = notification.params.delta;
    if (typeof delta === 'string') text += delta;
  }

  if (!text && !active) return null;

  return {
    id: 'live:streaming-assistant',
    kind: 'streaming',
    timestamp: now,
    text,
    active,
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
