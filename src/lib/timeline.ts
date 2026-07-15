import type { CodexItem, CodexTurn } from '../types/codex';
import type { CodexRunOptions, RuntimeStatusResult } from '../types/ui';

type TimelineItemOrder = { sortOrder?: number | null };

export type TimelineItem = TimelineItemOrder & (
  | { id: string; kind: 'user'; timestamp: number; text: string; turnId?: string | null }
  | {
      id: string;
      kind: 'assistant';
      timestamp: number;
      text: string;
      phase: string | null;
      turnId?: string | null;
      sourceId?: string | null;
      liveSource?: 'event_msg' | 'item_completed';
    }
  | { id: string; kind: 'command'; timestamp: number; command: string; cwd: string; output: string; status: string; exitCode: number | null; turnId?: string | null }
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
  | { id: string; kind: 'tool'; timestamp: number; item: CodexItem; turnId?: string | null }
  | { id: string; kind: 'notice'; timestamp: number; text: string; turnId?: string | null }
  | { id: string; kind: 'warning'; timestamp: number; text: string; turnId?: string | null }
  | { id: string; kind: 'error'; timestamp: number; text: string; turnId?: string | null }
  | { id: string; kind: 'runtimeStatus'; timestamp: number; status: RuntimeStatusResult }
  | { id: string; kind: 'queued'; timestamp: number; message: { id: string; text: string; createdAt: number; deliveryState?: 'maybeSent'; options?: Partial<CodexRunOptions> } }
  | { id: string; kind: 'streaming'; timestamp: number; text: string; active: boolean; turnId?: string | null; sourceId?: string | null }
  | { id: string; kind: 'approval'; timestamp: number; requestId: number | string; method: string; params: unknown }
);

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

interface VisibleLiveTurnOptions {
  allowAssistantTextMatchAcrossSources?: boolean;
}

export interface TimelineNotificationMeta {
  order: number;
  receivedAt: number;
  streamId?: string | null;
  seq?: number | null;
}

const NOTIFICATION_META_KEY = '__codexWebUiNotificationMeta';
const SYNTHETIC_PENDING_TURN_PREFIXES = ['turn-start-pending:', 'compact-pending:'];
const TERMINAL_EVENT_TYPES = new Set(['task_complete', 'task_failed', 'task_interrupted']);
const TERMINAL_NOTIFICATION_METHODS = new Set(['turn/completed', 'turn/failed', 'turn/interrupted', 'thread/compacted']);
const LIVE_WARNING_NOTIFICATION_METHODS = new Set(['warning', 'guardianWarning', 'configWarning', 'deprecationNotice']);
const CLAIMED_QUEUED_USER_ITEM_LIMIT = 50;

export function withTimelineNotificationMeta(notification: unknown, meta: TimelineNotificationMeta): unknown {
  if (!isRecord(notification)) return notification;
  const next = { ...notification };
  Object.defineProperty(next, NOTIFICATION_META_KEY, {
    configurable: false,
    enumerable: false,
    value: meta,
    writable: false,
  });
  return next;
}

export function timelineNotificationMeta(notification: unknown): TimelineNotificationMeta | null {
  if (!isRecord(notification)) return null;
  const meta = notification[NOTIFICATION_META_KEY];
  if (!isRecord(meta)) return null;
  const order = meta.order;
  const receivedAt = meta.receivedAt;
  if (typeof order !== 'number' || !Number.isFinite(order)) return null;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return null;
  return {
    order,
    receivedAt,
    streamId: typeof meta.streamId === 'string' ? meta.streamId : null,
    seq: typeof meta.seq === 'number' && Number.isFinite(meta.seq) ? meta.seq : null,
  };
}

function notificationTimestamp(notification: unknown, fallback: number): number {
  return timelineNotificationMeta(notification)?.receivedAt ?? fallback;
}

function notificationSortOrder(notification: unknown): number | null {
  return timelineNotificationMeta(notification)?.order ?? null;
}

export function isSyntheticPendingTurnId(turnId: string | null | undefined): boolean {
  return typeof turnId === 'string' && SYNTHETIC_PENDING_TURN_PREFIXES.some((prefix) => turnId.startsWith(prefix));
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
  if (isRecord(notification.payload)) return notification.payload;
  if (isRecord(params)) return params;
  return null;
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
    TERMINAL_NOTIFICATION_METHODS.has(notification.method) ||
    (notification.method === 'event_msg' && isRecord(payload) && typeof payload.type === 'string' && TERMINAL_EVENT_TYPES.has(payload.type));
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

function positiveCountField(value: unknown, key: string): number | null {
  const candidate = numberOrNullField(value, key);
  return candidate !== null && candidate > 0 ? candidate : null;
}

function syntheticFileChangeSummaryItem(turn: CodexTurn, items: CodexItem[], timestamp: number): TimelineItem | null {
  let summaryFiles: Array<{ path: string; changeCount: number }> | null = null;

  for (const item of items) {
    if (item.type !== 'webuiFileChangeSummary') continue;
    const files = (item as Record<string, unknown>).files;
    if (!Array.isArray(files)) continue;

    const orderedFiles = new Map<string, { path: string; changeCount: number; order: number }>();
    for (const file of files) {
      const path = changePath(file);
      if (!path) continue;
      const changeCount = positiveCountField(file, 'changeCount') ?? positiveCountField(file, 'editCount') ?? 1;
      const existing = orderedFiles.get(path);
      if (existing) {
        existing.changeCount += changeCount;
        continue;
      }
      orderedFiles.set(path, { path, changeCount, order: orderedFiles.size });
    }

    summaryFiles = Array.from(orderedFiles.values())
      .sort((a, b) => a.order - b.order)
      .map(({ path, changeCount }) => ({ path, changeCount }));
  }

  if (!summaryFiles || summaryFiles.length === 0) return null;
  return {
    id: `${turn.id}:file-summary`,
    kind: 'fileChangeSummary',
    timestamp,
    turnId: turn.id,
    files: summaryFiles,
  };
}

function isTurnActivityItem(item: TimelineItem): boolean {
  return (
    item.kind === 'command' ||
    item.kind === 'fileChange' ||
    item.kind === 'fileChangeSummary' ||
    item.kind === 'tool' ||
    item.kind === 'notice' ||
    item.kind === 'warning' ||
    item.kind === 'error'
  );
}

function isFinalAssistantTimelineItem(item: TimelineItem): item is Extract<TimelineItem, { kind: 'assistant' }> {
  return item.kind === 'assistant' && (item.phase === null || item.phase === 'final_answer' || item.phase === 'final');
}

function finalAssistantAfterLaterActivity(items: TimelineItem[]): TimelineItem[] {
  const firstFinalIndex = items.findIndex(isFinalAssistantTimelineItem);
  if (firstFinalIndex < 0) return items;
  if (!items.slice(firstFinalIndex + 1).some(isTurnActivityItem)) return items;

  const finals: TimelineItem[] = [];
  const others: TimelineItem[] = [];
  for (const item of items) {
    if (isFinalAssistantTimelineItem(item)) finals.push(item);
    else others.push(item);
  }
  return [...others, ...finals];
}

export function turnToTimelineItems(turn: CodexTurn): TimelineItem[] {
  const timestamp = (turn.startedAt ?? 0) * 1000;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const timelineItems = items.flatMap((item, index): TimelineItem[] => {
    const id = safeItemId(turn, item, index);
    if (item.type === 'webuiFileChangeSummary') return [];
    if (item.type === 'fileChange') return fileChangeItemsForTurnItem({ ...turn, items }, item, index, timestamp);
    if (item.type === 'userMessage') return [{ id, kind: 'user', timestamp, text: userText(item), turnId: turn.id }];
    if (item.type === 'agentMessage') {
      return [{
        id,
        kind: 'assistant',
        timestamp,
        text: stringField(item, 'text'),
        phase: nullableStringField(item, 'phase'),
        turnId: turn.id,
        sourceId: typeof item.id === 'string' ? item.id : null,
      }];
    }
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
        turnId: turn.id,
      }];
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === 'string') : [];
      const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === 'string') : [];
      return [{ id, kind: 'notice', timestamp, text: [...summary, ...content].join('\n'), turnId: turn.id }];
    }
    if (item.type === 'plan') return [{ id, kind: 'notice', timestamp, text: stringField(item, 'text'), turnId: turn.id }];
    if (item.type === 'warning') {
      return [{ id, kind: 'warning', timestamp, text: stringField(item, 'message') || stringField(item, 'text') || item.type, turnId: turn.id }];
    }
    if (item.type === 'error') {
      return [{ id, kind: 'error', timestamp, text: stringField(item, 'message') || stringField(item, 'text') || item.type, turnId: turn.id }];
    }
    return [{ id, kind: 'tool', timestamp, item, turnId: turn.id }];
  });
  const summary = syntheticFileChangeSummaryItem(turn, items, timestamp) ?? fileChangeSummaryItem({ ...turn, items }, timestamp);
  return finalAssistantAfterLaterActivity(summary ? [...timelineItems, summary] : timelineItems);
}

export function trimTimelineWindow<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

function itemWithoutOrderingMetadata(item: TimelineItem): unknown {
  const { timestamp: _timestamp, sortOrder: _sortOrder, ...content } = item;
  return content;
}

function occurrenceContentKey(item: TimelineItem): string {
  return JSON.stringify(itemWithoutOrderingMetadata(item));
}

function syntheticUserMatchesPersisted(previous: Extract<TimelineItem, { kind: 'user' }>, candidate: TimelineItem): boolean {
  if (candidate.kind !== 'user' || candidate.text.trim() !== previous.text.trim()) return false;
  if (!previous.id.startsWith('claimed-queued:user:') && !previous.id.startsWith('pending:user:')) return false;
  if (previous.turnId && !isSyntheticPendingTurnId(previous.turnId)) return candidate.turnId === previous.turnId;
  return Boolean(candidate.turnId);
}

function liveAssistantMatchesPersisted(
  previous: Extract<TimelineItem, { kind: 'assistant' | 'streaming' }>,
  candidate: TimelineItem,
): boolean {
  const isLive = previous.kind === 'streaming' || previous.id.startsWith('live:') || Boolean(previous.liveSource);
  if (!isLive || candidate.kind !== 'assistant') return false;
  const previousTurnId = timelineItemTurnId(previous);
  const candidateTurnId = timelineItemTurnId(candidate);
  if (previousTurnId && candidateTurnId !== previousTurnId) return false;
  if (previous.kind === 'streaming' && !previous.active && !previous.sourceId && isFinalAssistantTimelineItem(candidate)) return true;
  return messageLikelyCovers(previous.text, candidate.text) || messageLikelyCovers(candidate.text, previous.text);
}

function isSemanticReplacement(previous: TimelineItem, candidate: TimelineItem): boolean {
  if (previous.kind === 'user') return syntheticUserMatchesPersisted(previous, candidate);
  if (previous.kind === 'assistant' || previous.kind === 'streaming') return liveAssistantMatchesPersisted(previous, candidate);
  return false;
}

function orderingTurnId(item: TimelineItem): string | null {
  if ('turnId' in item && typeof item.turnId === 'string' && item.turnId) return item.turnId;
  return null;
}

function initialTimelineOrder(items: TimelineItem[]): TimelineItem[] {
  const itemsByTurn = new Map<string, TimelineItem[]>();
  const turnOrder: string[] = [];
  const scopedPositions: number[] = [];
  items.forEach((item, index) => {
    const turnId = orderingTurnId(item);
    if (!turnId) return;
    scopedPositions.push(index);
    const turnItems = itemsByTurn.get(turnId);
    if (turnItems) turnItems.push(item);
    else {
      itemsByTurn.set(turnId, [item]);
      turnOrder.push(turnId);
    }
  });

  const orderedScopedItems = turnOrder.flatMap((turnId) => finalAssistantAfterLaterActivity(itemsByTurn.get(turnId) ?? []));
  const ordered = [...items];
  scopedPositions.forEach((position, index) => {
    ordered[position] = orderedScopedItems[index];
  });
  return ordered;
}

export function reconcileTimelineItemsByArrival(previousItems: TimelineItem[], candidateItems: TimelineItem[]): TimelineItem[] {
  if (previousItems.length === 0) return initialTimelineOrder(candidateItems);
  if (candidateItems.length === 0) return [];

  const matches = new Map<number, number>();
  const consumedCandidates = new Set<number>();
  const matchRemainingByKey = (keyForItem: (item: TimelineItem) => string | null) => {
    const candidatesByKey = new Map<string, { indexes: number[]; offset: number }>();
    candidateItems.forEach((candidate, candidateIndex) => {
      if (consumedCandidates.has(candidateIndex)) return;
      const key = keyForItem(candidate);
      if (key === null) return;
      const entries = candidatesByKey.get(key);
      if (entries) entries.indexes.push(candidateIndex);
      else candidatesByKey.set(key, { indexes: [candidateIndex], offset: 0 });
    });
    previousItems.forEach((previous, previousIndex) => {
      if (matches.has(previousIndex)) return;
      const key = keyForItem(previous);
      if (key === null) return;
      const entries = candidatesByKey.get(key);
      if (!entries || entries.offset >= entries.indexes.length) return;
      const candidateIndex = entries.indexes[entries.offset];
      entries.offset += 1;
      matches.set(previousIndex, candidateIndex);
      consumedCandidates.add(candidateIndex);
    });
  };

  const idKindCounts = new Map<string, number>();
  for (const item of [...previousItems, ...candidateItems]) {
    const key = `${item.id}\0${item.kind}`;
    idKindCounts.set(key, (idKindCounts.get(key) ?? 0) + 1);
  }
  matchRemainingByKey(
    (item) => {
      const idKind = `${item.id}\0${item.kind}`;
      return (idKindCounts.get(idKind) ?? 0) > 2 ? `${idKind}\0${occurrenceContentKey(item)}` : null;
    },
  );
  matchRemainingByKey((item) => `${item.id}\0${item.kind}`);
  matchRemainingByKey((item) => item.id);
  previousItems.forEach((previous, previousIndex) => {
    if (matches.has(previousIndex)) return;
    let candidateIndex = -1;
    const start = previous.kind === 'user' ? candidateItems.length - 1 : 0;
    const end = previous.kind === 'user' ? -1 : candidateItems.length;
    const step = previous.kind === 'user' ? -1 : 1;
    for (let index = start; index !== end; index += step) {
      if (!consumedCandidates.has(index) && isSemanticReplacement(previous, candidateItems[index])) {
        candidateIndex = index;
        break;
      }
    }
    if (candidateIndex < 0) return;
    matches.set(previousIndex, candidateIndex);
    consumedCandidates.add(candidateIndex);
  });

  const reconciled: TimelineItem[] = [];
  previousItems.forEach((_, previousIndex) => {
    const candidateIndex = matches.get(previousIndex);
    if (candidateIndex !== undefined) reconciled.push(candidateItems[candidateIndex]);
  });
  candidateItems.forEach((candidate, index) => {
    if (!consumedCandidates.has(index)) reconciled.push(candidate);
  });
  return reconciled;
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

function messageLikelyCovers(candidateText: string, coveringText: string): boolean {
  const candidate = normalizedMessageBlock(candidateText);
  const covering = normalizedMessageBlock(coveringText);
  if (!candidate || !covering) return false;
  if (candidate === covering) return true;
  return candidate.length >= 12 && covering.length > candidate.length && covering.startsWith(candidate);
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

export function notificationCountBeforeTurnStart(
  notifications: unknown[],
  totalCount: number,
  scope: TimelineNotificationScope,
): number | null {
  if (!scope.activeTurnId) return null;
  const firstNotificationCount = totalCount - notifications.length + 1;
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (!isRecord(notification) || notification.method !== 'turn/started') continue;
    if (!notificationMatchesActiveTurn(notification, scope)) continue;
    if (notificationTurnId(notification) !== scope.activeTurnId) continue;
    return firstNotificationCount + index - 1;
  }
  return null;
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

function notificationAllowedInLiveWindow(notification: unknown, scope: TimelineNotificationScope, acceptUnscoped: boolean): boolean {
  const hasScopeId = Boolean(notificationThreadId(notification) || notificationTurnId(notification));
  if (hasScopeId) return notificationMatchesActiveTurn(notification, scope);
  return acceptUnscoped;
}

function notificationMessagePhase(notification: unknown): string | null {
  const params = notificationParams(notification);
  const payload = notificationPayload(notification);
  return stringAtPath(payload, ['phase']) ?? stringAtPath(params, ['phase']);
}

function notificationMessageSourceId(notification: unknown): string | null {
  const params = notificationParams(notification);
  const payload = notificationPayload(notification);
  return (
    stringAtPath(payload, ['id']) ??
    stringAtPath(payload, ['itemId']) ??
    stringAtPath(payload, ['item_id']) ??
    stringAtPath(payload, ['messageId']) ??
    stringAtPath(payload, ['message_id']) ??
    stringAtPath(params, ['id']) ??
    stringAtPath(params, ['itemId']) ??
    stringAtPath(params, ['item_id']) ??
    stringAtPath(params, ['messageId']) ??
    stringAtPath(params, ['message_id'])
  );
}

function notificationAgentMessage(notification: unknown): string | null {
  const payload = notificationPayload(notification);
  if (!isRecord(payload) || payload.type !== 'agent_message') return null;
  const message = payload.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

function completedAgentMessage(notification: unknown): CodexItem | null {
  if (!isRecord(notification) || notification.method !== 'item/completed') return null;
  if (!isRecord(notification.params) || !isRecord(notification.params.item)) return null;
  const item = notification.params.item as CodexItem;
  return item.type === 'agentMessage' ? item : null;
}

function activityItemsFromLifecycleNotification(
  notification: unknown,
  scope: TimelineNotificationScope,
  timestamp: number,
  sortOrder: number | null,
  fallbackKey: string,
): TimelineItem[] {
  if (!isRecord(notification) || (notification.method !== 'item/started' && notification.method !== 'item/completed')) return [];
  if (!isRecord(notification.params) || !isRecord(notification.params.item)) return [];

  const rawItem = notification.params.item as CodexItem;
  if (rawItem.type === 'agentMessage' || rawItem.type === 'userMessage') return [];
  if (notification.method === 'item/started' && rawItem.type === 'fileChange') return [];

  const turnId = notificationTurnId(notification) ?? scope.activeTurnId ?? 'live';
  const converted = turnToTimelineItems({
    id: turnId,
    status: 'inProgress',
    startedAt: timestamp / 1000,
    completedAt: null,
    items: [rawItem],
  }).filter(
    (item) => item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'tool' || item.kind === 'warning' || item.kind === 'error',
  );
  const ordered = sortOrder === null ? converted : converted.map((item) => ({ ...item, sortOrder }) as TimelineItem);
  if (typeof rawItem.id === 'string' && rawItem.id.trim()) return ordered;
  return ordered.map((item, index) => ({ ...item, id: `${item.id}:live:${fallbackKey}:${index}` }) as TimelineItem);
}

function shouldReplaceLiveAssistantSnapshot(
  previous: TimelineItem,
  text: string,
  phase: string | null,
  turnId: string | null,
  sourceId: string | null,
): boolean {
  if (previous.kind !== 'assistant') return false;
  if ((previous.turnId ?? null) !== turnId) return false;
  const previousText = normalizedMessageBlock(previous.text);
  const nextText = normalizedMessageBlock(text);
  if (sourceId || previous.sourceId) return previous.sourceId === sourceId;
  if (nextText === previousText) return true;
  return false;
}

function assistantItemsByTurn(items: TimelineItem[]): Map<string, Extract<TimelineItem, { kind: 'assistant' }>[]> {
  const byTurn = new Map<string, Extract<TimelineItem, { kind: 'assistant' }>[]>();
  for (const item of items) {
    if (item.kind !== 'assistant') continue;
    const turnId = timelineItemTurnId(item);
    if (!turnId) continue;
    const text = normalizedMessageBlock(item.text);
    if (!text) continue;
    const current = byTurn.get(turnId) ?? [];
    current.push(item);
    byTurn.set(turnId, current);
  }
  return byTurn;
}

function assistantIsFinal(item: Extract<TimelineItem, { kind: 'assistant' }>): boolean {
  return item.phase === null || item.phase === 'final_answer' || item.phase === 'final';
}

function assistantPhaseGroup(phase: string | null): string {
  return phase === null || phase === 'final_answer' || phase === 'final' ? 'final' : phase;
}

function assistantTextKey(turnId: string, phase: string | null, text: string): string {
  return `${turnId}\0${assistantPhaseGroup(phase)}\0${text}`;
}

function liveAssistantItemId(turnId: string | null, sourceId: string | null, sequence: number): string {
  return sourceId && turnId ? `${turnId}:${sourceId}` : `live:assistant:${turnId ?? 'unscoped'}:${sequence}`;
}

function liveStreamingItemId(turnId: string | null, sourceId: string | null, sequence: number): string {
  return sourceId && turnId ? `${turnId}:${sourceId}` : `live:streaming:${turnId ?? 'unscoped'}:${sequence}`;
}

function liveStreamingMessageKey(turnId: string | null, sourceId: string | null): string {
  return sourceId ? `source:${turnId ?? 'unscoped'}:${sourceId}` : `turn:${turnId ?? 'unscoped'}`;
}

export interface LiveTurnAccumulator {
  items: TimelineItem[];
  itemIndexes: Map<string, number>;
  streamingIndexes: Map<string, number>;
  sequence: number;
  deltaIndex: number | null;
  notificationCount: number;
}

export function createLiveTurnAccumulator(): LiveTurnAccumulator {
  return {
    items: [],
    itemIndexes: new Map(),
    streamingIndexes: new Map(),
    sequence: 0,
    deltaIndex: null,
    notificationCount: 0,
  };
}

export function appendLiveTurnNotifications(
  current: LiveTurnAccumulator,
  notifications: unknown[],
  scope: TimelineNotificationScope,
  now = Date.now(),
  options: { acceptUnscoped?: boolean } = {},
): LiveTurnAccumulator {
  if (notifications.length === 0) return current;
  const acceptUnscoped = options.acceptUnscoped ?? Boolean(scope.activeTurnId);
  const next: LiveTurnAccumulator = {
    items: [...current.items],
    itemIndexes: new Map(current.itemIndexes),
    streamingIndexes: new Map(current.streamingIndexes),
    sequence: current.sequence,
    deltaIndex: current.deltaIndex,
    notificationCount: current.notificationCount,
  };

  const rememberItem = (item: TimelineItem): number => {
    const existingIndex = next.itemIndexes.get(item.id);
    if (existingIndex !== undefined) {
      const previous = next.items[existingIndex];
      next.items[existingIndex] = { ...item, timestamp: previous.timestamp, sortOrder: previous.sortOrder } as TimelineItem;
      return existingIndex;
    }
    next.itemIndexes.set(item.id, next.items.length);
    next.items.push(item);
    return next.items.length - 1;
  };

  const pushAssistant = (
    text: string,
    phase: string | null,
    turnId: string | null,
    sourceId: string | null = null,
    liveSource: Extract<TimelineItem, { kind: 'assistant' }>['liveSource'] = undefined,
    timestamp = now,
    sortOrder: number | null = null,
  ) => {
    const clearCompletedStreaming = () => {
      next.streamingIndexes.delete(liveStreamingMessageKey(turnId, null));
      if (sourceId) next.streamingIndexes.delete(liveStreamingMessageKey(turnId, sourceId));
      next.deltaIndex = null;
    };
    const previous = next.items.at(-1);
    if (previous?.kind === 'assistant' && shouldReplaceLiveAssistantSnapshot(previous, text, phase, turnId, sourceId)) {
      next.items[next.items.length - 1] = { ...previous, text, phase, turnId, sourceId, liveSource };
      clearCompletedStreaming();
      return;
    }

    next.sequence += 1;
    const id = liveAssistantItemId(turnId, sourceId, next.sequence);
    rememberItem({
      id,
      kind: 'assistant',
      timestamp,
      sortOrder,
      text,
      phase,
      turnId,
      sourceId,
      liveSource,
    });
    clearCompletedStreaming();
  };

  const appendDelta = (delta: string, turnId: string | null, sourceId: string | null, timestamp: number, sortOrder: number | null) => {
    const streamingKey = liveStreamingMessageKey(turnId, sourceId);
    const existingIndex = next.streamingIndexes.get(streamingKey) ?? (sourceId ? null : next.deltaIndex);
    if (existingIndex !== null && existingIndex !== undefined) {
      const previous = next.items[existingIndex];
      if (previous?.kind === 'streaming' && (previous.turnId ?? 'unscoped') === (turnId ?? 'unscoped') && (previous.sourceId ?? null) === sourceId) {
        next.items[existingIndex] = { ...previous, text: `${previous.text}${delta}`, turnId: previous.turnId ?? turnId, sourceId: previous.sourceId ?? sourceId };
        next.deltaIndex = existingIndex;
        return;
      }
    }

    next.sequence += 1;
    const id = liveStreamingItemId(turnId, sourceId, next.sequence);
    const existingById = next.itemIndexes.get(id);
    if (existingById !== undefined && next.items[existingById]?.kind === 'assistant') return;
    rememberItem({
      id,
      kind: 'streaming',
      timestamp,
      sortOrder,
      text: delta,
      active: false,
      turnId,
      sourceId,
    });
    const index = next.itemIndexes.get(id);
    if (index !== undefined) {
      next.deltaIndex = index;
      next.streamingIndexes.set(streamingKey, index);
    }
  };

  for (const notification of notifications) {
    const notificationIndex = next.notificationCount;
    next.notificationCount += 1;
    if (!isRecord(notification) || typeof notification.method !== 'string') continue;
    const timestamp = notificationTimestamp(notification, now);
    const sortOrder = notificationSortOrder(notification);

    if (TERMINAL_NOTIFICATION_METHODS.has(notification.method)) {
      if (notificationMatchesActiveTurn(notification, scope)) next.deltaIndex = null;
      continue;
    }

    if (notification.method === 'item/agentMessage/delta' && isRecord(notification.params)) {
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const delta = notification.params.delta;
      if (typeof delta === 'string') {
        appendDelta(delta, notificationTurnId(notification) ?? scope.activeTurnId, notificationMessageSourceId(notification), timestamp, sortOrder);
      }
      continue;
    }

    if (LIVE_WARNING_NOTIFICATION_METHODS.has(notification.method)) {
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const params = notificationParams(notification);
      if (!isRecord(params)) continue;
      const summary = stringField(params, 'message') || stringField(params, 'summary');
      const details = nullableStringField(params, 'details');
      const text = [summary, details && details !== summary ? details : null].filter((part): part is string => Boolean(part)).join('\n');
      if (text) {
        rememberItem({
          id: `live:warning:${notificationTurnId(notification) ?? scope.activeTurnId ?? 'unscoped'}:${notificationIndex}`,
          kind: 'warning',
          timestamp,
          sortOrder,
          text,
          turnId: notificationTurnId(notification) ?? scope.activeTurnId ?? undefined,
        });
      }
      next.deltaIndex = null;
      continue;
    }

    if (notification.method === 'model/safetyBuffering/updated') {
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const params = notificationParams(notification);
      if (!isRecord(params) || typeof params.showBufferingUi !== 'boolean') continue;
      const turnId = notificationTurnId(notification) ?? scope.activeTurnId;
      const id = `live:model-safety-buffering:${turnId ?? 'unscoped'}`;
      if (!params.showBufferingUi && !next.itemIndexes.has(id)) continue;
      const model = stringField(params, 'model', 'the selected model');
      const fasterModel = nullableStringField(params, 'fasterModel');
      const text = params.showBufferingUi
        ? `Additional safety checks are running for ${model}. Codex will continue automatically.${fasterModel ? ` To retry faster, stop this turn and select ${fasterModel} from the model menu.` : ''}`
        : `Additional safety checks completed for ${model}.`;
      rememberItem({
        id,
        kind: params.showBufferingUi ? 'warning' : 'notice',
        timestamp,
        sortOrder,
        text,
        turnId: turnId ?? undefined,
      });
      next.deltaIndex = null;
      continue;
    }

    if (notification.method === 'error') {
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const params = notificationParams(notification);
      const error = isRecord(params) && isRecord(params.error) ? params.error : null;
      const message = error ? stringField(error, 'message') : '';
      if (message) {
        rememberItem({
          id: `live:error:${notificationTurnId(notification) ?? scope.activeTurnId ?? 'unscoped'}:${notificationIndex}`,
          kind: 'error',
          timestamp,
          sortOrder,
          text: message,
          turnId: notificationTurnId(notification) ?? scope.activeTurnId ?? undefined,
        });
      }
      next.deltaIndex = null;
      continue;
    }

    if (notification.method === 'event_msg') {
      const payload = notificationPayload(notification);
      if (!isRecord(payload)) continue;
      if (typeof payload.type === 'string' && TERMINAL_EVENT_TYPES.has(payload.type)) {
        if (notificationIsTurnComplete(notification, scope)) next.deltaIndex = null;
        continue;
      }
      if (payload.type !== 'agent_message') continue;
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const message = notificationAgentMessage(notification);
      if (message) {
        pushAssistant(
          message,
          notificationMessagePhase(notification),
          notificationTurnId(notification) ?? scope.activeTurnId,
          notificationMessageSourceId(notification),
          'event_msg',
          timestamp,
          sortOrder,
        );
      }
      next.deltaIndex = null;
      next.streamingIndexes.delete(liveStreamingMessageKey(notificationTurnId(notification) ?? scope.activeTurnId, null));
      continue;
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      if (!notificationAllowedInLiveWindow(notification, scope, acceptUnscoped)) continue;
      const agentMessage = notification.method === 'item/completed' ? completedAgentMessage(notification) : null;
      if (agentMessage) {
        pushAssistant(
          stringField(agentMessage, 'text'),
          nullableStringField(agentMessage, 'phase'),
          notificationTurnId(notification) ?? scope.activeTurnId,
          typeof agentMessage.id === 'string' ? agentMessage.id : null,
          'item_completed',
          timestamp,
          sortOrder,
        );
        next.deltaIndex = null;
        continue;
      }

      for (const item of activityItemsFromLifecycleNotification(notification, scope, timestamp, sortOrder, String(notificationIndex))) rememberItem(item);
      next.deltaIndex = null;
      next.streamingIndexes.delete(liveStreamingMessageKey(notificationTurnId(notification) ?? scope.activeTurnId, null));
    }
  }

  return next;
}

export function liveTurnItemsFromAccumulator(accumulator: LiveTurnAccumulator, active: boolean): TimelineItem[] {
  let lastStreamingIndex = -1;
  for (let index = accumulator.items.length - 1; index >= 0; index -= 1) {
    if (accumulator.items[index].kind === 'streaming') {
      lastStreamingIndex = index;
      break;
    }
  }
  if (lastStreamingIndex < 0) return accumulator.items;
  const item = accumulator.items[lastStreamingIndex];
  if (item.kind !== 'streaming') return accumulator.items;
  const nextActive = active && accumulator.deltaIndex === lastStreamingIndex;
  if (item.active === nextActive) return accumulator.items;
  const items = [...accumulator.items];
  items[lastStreamingIndex] = { ...item, active: nextActive };
  return items;
}

export function liveTurnItemsFromNotifications(
  notifications: unknown[],
  scope: TimelineNotificationScope,
  active: boolean,
  now = Date.now(),
  options: { acceptUnscoped?: boolean } = {},
): TimelineItem[] {
  const accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), notifications, scope, now, {
    acceptUnscoped: options.acceptUnscoped ?? active,
  });
  return liveTurnItemsFromAccumulator(accumulator, active);
}

export function visibleLiveTurnItemsForTimeline(
  items: TimelineItem[],
  liveItems: TimelineItem[],
  options: VisibleLiveTurnOptions = {},
): TimelineItem[] {
  type AssistantTimelineItem = Extract<TimelineItem, { kind: 'assistant' }>;
  type StreamingTimelineItem = Extract<TimelineItem, { kind: 'streaming' }>;
  type PersistedAssistantEntry = {
    assistant: AssistantTimelineItem;
    key: string;
    text: string;
    turnId: string;
  };

  const persistedIds = new Set(items.map((item) => item.id));
  const persistedAssistantsByTurn = assistantItemsByTurn(items);
  const persistedAssistantEntriesByTurn = new Map<string, PersistedAssistantEntry[]>();
  let persistedAssistantEntryIndex = 0;
  for (const [turnId, assistants] of persistedAssistantsByTurn) {
    for (const assistant of assistants) {
      const text = normalizedMessageBlock(assistant.text);
      if (!text) continue;
      const entry: PersistedAssistantEntry = {
        assistant,
        key: `${turnId}\0${persistedAssistantEntryIndex}`,
        text,
        turnId,
      };
      persistedAssistantEntryIndex += 1;
      const entries = persistedAssistantEntriesByTurn.get(turnId) ?? [];
      entries.push(entry);
      persistedAssistantEntriesByTurn.set(turnId, entries);
    }
  }
  const reservedExactPersistedAssistantKeys = new Set<string>();
  const consumedPersistedAssistantKeys = new Set<string>();
  const emittedAssistantIdentityKeys = new Set<string>();
  const emittedUnidentifiedAssistantTextKeys = new Set<string>();
  const emittedIdentifiedAssistantTextSourceCounts = new Map<string, Map<string, number>>();
  const consumedIdentifiedAssistantTextSourceCounts = new Map<string, Map<string, number>>();
  const visibleAssistantIndexes = new Set<number>();
  const visibleAssistants: TimelineItem[] = [];

  const sourcesAreCompatible = (item: AssistantTimelineItem | StreamingTimelineItem, assistant: AssistantTimelineItem): boolean => {
    return !item.sourceId || !assistant.sourceId || item.sourceId === assistant.sourceId;
  };

  const consumePersistedAssistantTextMatch = (
    item: AssistantTimelineItem,
    turnId: string,
    text: string,
    consumedKeys: Set<string>,
  ): boolean => {
    const entries = persistedAssistantEntriesByTurn.get(turnId) ?? [];
    const consume = (entry: PersistedAssistantEntry): boolean => {
      if (reservedExactPersistedAssistantKeys.has(entry.key) || consumedKeys.has(entry.key)) return false;
      consumedKeys.add(entry.key);
      return true;
    };
    const compatible = entries.find((entry) => entry.text === text && sourcesAreCompatible(item, entry.assistant) && consume(entry));
    if (compatible) return true;
    if (!options.allowAssistantTextMatchAcrossSources) return false;
    return Boolean(entries.find((entry) => entry.text === text && consume(entry)));
  };

  const reserveExactPersistedAssistant = (item: AssistantTimelineItem): void => {
    const turnId = timelineItemTurnId(item);
    if (!turnId) return;
    const entries = persistedAssistantEntriesByTurn.get(turnId) ?? [];
    const entry = entries.find((candidate) => candidate.assistant.id === item.id && !reservedExactPersistedAssistantKeys.has(candidate.key));
    if (entry) reservedExactPersistedAssistantKeys.add(entry.key);
  };

  for (const item of liveItems) {
    if (item.kind === 'assistant' && persistedIds.has(item.id)) reserveExactPersistedAssistant(item);
  }

  const addIdentifiedAssistantTextSource = (textKey: string, source: string) => {
    const counts = emittedIdentifiedAssistantTextSourceCounts.get(textKey) ?? new Map<string, number>();
    counts.set(source, (counts.get(source) ?? 0) + 1);
    emittedIdentifiedAssistantTextSourceCounts.set(textKey, counts);
  };

  const consumeIdentifiedAssistantTextFromOtherSource = (textKey: string, source: string): boolean => {
    const emittedCounts = emittedIdentifiedAssistantTextSourceCounts.get(textKey);
    if (!emittedCounts) return false;
    const consumedCounts = consumedIdentifiedAssistantTextSourceCounts.get(textKey) ?? new Map<string, number>();
    for (const [otherSource, emittedCount] of emittedCounts) {
      if (otherSource === source) continue;
      const consumedCount = consumedCounts.get(otherSource) ?? 0;
      if (consumedCount >= emittedCount) continue;
      consumedCounts.set(otherSource, consumedCount + 1);
      consumedIdentifiedAssistantTextSourceCounts.set(textKey, consumedCounts);
      return true;
    }
    return false;
  };

  for (const [index, item] of liveItems.entries()) {
    if (item.kind !== 'assistant') continue;
    if (persistedIds.has(item.id)) continue;

    const turnId = timelineItemTurnId(item);
    if (!turnId) {
      visibleAssistantIndexes.add(index);
      visibleAssistants.push(item);
      continue;
    }

    const text = normalizedMessageBlock(item.text);
    if (text && consumePersistedAssistantTextMatch(item, turnId, text, consumedPersistedAssistantKeys)) continue;

    const identityKey = item.sourceId ? `${turnId}\0source:${item.sourceId}` : null;
    const textKey = assistantTextKey(turnId, item.phase, text);
    if (identityKey && emittedAssistantIdentityKeys.has(identityKey)) continue;
    if (identityKey && emittedUnidentifiedAssistantTextKeys.has(textKey)) continue;
    if (
      identityKey &&
      item.liveSource &&
      options.allowAssistantTextMatchAcrossSources &&
      consumeIdentifiedAssistantTextFromOtherSource(textKey, item.liveSource)
    ) {
      continue;
    }
    if (!identityKey && (emittedUnidentifiedAssistantTextKeys.has(textKey) || emittedIdentifiedAssistantTextSourceCounts.has(textKey))) continue;
    if (identityKey) {
      emittedAssistantIdentityKeys.add(identityKey);
      if (item.liveSource) addIdentifiedAssistantTextSource(textKey, item.liveSource);
    } else {
      emittedUnidentifiedAssistantTextKeys.add(textKey);
    }
    visibleAssistantIndexes.add(index);
    visibleAssistants.push(item);
  }

  const visibleAssistantsByTurn = assistantItemsByTurn(visibleAssistants);
  const consumedStreamingCoveringAssistants = new Set<string>();
  const consumedSourceLessFinalFallbackAssistants = new Set<string>();

  const streamingCoveringAssistantKey = (assistant: AssistantTimelineItem): string => {
    return `${timelineItemTurnId(assistant) ?? 'unscoped'}\0${assistant.id}`;
  };

  const consumeStreamingCoveringAssistant = (item: StreamingTimelineItem): boolean => {
    const turnId = timelineItemTurnId(item);
    if (!turnId) return false;
    const assistants = [...(persistedAssistantsByTurn.get(turnId) ?? []), ...(visibleAssistantsByTurn.get(turnId) ?? [])];
    for (const assistant of assistants) {
      const sameSource = Boolean(item.sourceId && assistant.sourceId && item.sourceId === assistant.sourceId);
      const sourceLessFinalFallback = !item.sourceId && !sameSource && !item.active && assistantIsFinal(assistant);
      if (sourceLessFinalFallback) {
        const key = streamingCoveringAssistantKey(assistant);
        if (consumedSourceLessFinalFallbackAssistants.has(key)) continue;
        consumedSourceLessFinalFallbackAssistants.add(key);
        return true;
      }

      const textIsCovered = messageLikelyCovers(item.text, assistant.text);
      const textCoverAllowed =
        textIsCovered && (sameSource || !item.sourceId || !assistant.sourceId || options.allowAssistantTextMatchAcrossSources);
      const covered =
        (sameSource && ((!item.active && assistantIsFinal(assistant)) || textIsCovered)) ||
        (textCoverAllowed && assistantIsFinal(assistant));
      if (!covered) continue;

      const key = streamingCoveringAssistantKey(assistant);
      if (consumedStreamingCoveringAssistants.has(key)) continue;
      consumedStreamingCoveringAssistants.add(key);
      return true;
    }
    return false;
  };

  const isCoveredByLaterStreaming = (item: StreamingTimelineItem, index: number): boolean => {
    const turnId = timelineItemTurnId(item);
    if (!turnId) return false;
    for (const candidate of liveItems.slice(index + 1)) {
      if (candidate.kind !== 'streaming') return false;
      if (timelineItemTurnId(candidate) !== turnId) return false;
      if ((item.sourceId || candidate.sourceId) && item.sourceId !== candidate.sourceId) return false;
      if (messageLikelyCovers(item.text, candidate.text)) return true;
    }
    return false;
  };

  return liveItems.filter((item, index) => {
    if (item.kind === 'assistant') return visibleAssistantIndexes.has(index);
    if (persistedIds.has(item.id)) {
      if (item.kind === 'streaming') consumeStreamingCoveringAssistant(item);
      return false;
    }
    if (item.kind !== 'streaming') return true;
    if (item.kind === 'streaming' && isCoveredByLaterStreaming(item, index)) return false;
    if (consumeStreamingCoveringAssistant(item)) return false;
    return true;
  });
}

function isRetainedActivityOrderAnchor(item: TimelineItem): boolean {
  return isTurnActivityItem(item);
}

function retainedActivityTurnIdsMissingFromHistory(historyItems: TimelineItem[], retainedItems: TimelineItem[]): Set<string> {
  const historyIds = new Set(historyItems.map((item) => item.id));
  const turnIds = new Set<string>();
  for (const item of retainedItems) {
    if (!isRetainedActivityOrderAnchor(item)) continue;
    if (historyIds.has(item.id)) continue;
    const turnId = timelineItemTurnId(item);
    if (turnId) turnIds.add(turnId);
  }
  return turnIds;
}

function retainedAssistantOverlayCounts(historyItems: TimelineItem[], retainedItems: TimelineItem[]): Map<string, number> {
  const orderSensitiveTurnIds = retainedActivityTurnIdsMissingFromHistory(historyItems, retainedItems);
  const counts = new Map<string, number>();
  if (orderSensitiveTurnIds.size === 0) return counts;

  for (const item of retainedItems) {
    if (item.kind !== 'assistant') continue;
    const turnId = timelineItemTurnId(item);
    if (!turnId || !orderSensitiveTurnIds.has(turnId)) continue;
    const text = normalizedMessageBlock(item.text);
    if (!text) continue;
    const key = assistantTextKey(turnId, item.phase, text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

export function timelineItemsWithRetainedLiveTurnOverlay(historyItems: TimelineItem[], retainedItems: TimelineItem[]): TimelineItem[] {
  const counts = retainedAssistantOverlayCounts(historyItems, retainedItems);
  if (counts.size === 0) return historyItems;

  let changed = false;
  const filtered = historyItems.filter((item) => {
    if (item.kind !== 'assistant') return true;
    const turnId = timelineItemTurnId(item);
    if (!turnId) return true;
    const text = normalizedMessageBlock(item.text);
    if (!text) return true;
    const key = assistantTextKey(turnId, item.phase, text);
    const count = counts.get(key) ?? 0;
    if (count <= 0) return true;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
    changed = true;
    return false;
  });

  return changed ? filtered : historyItems;
}

export function visibleRetainedLiveTurnItemsForTimeline(
  historyItems: TimelineItem[],
  currentLiveItems: TimelineItem[],
  retainedItems: TimelineItem[],
): TimelineItem[] {
  const currentLiveKeys = new Set(currentLiveItems.map(liveCurrentDuplicateKey));
  const currentAssistantItems = currentLiveItems.filter((item): item is Extract<TimelineItem, { kind: 'assistant' }> => item.kind === 'assistant');
  const historyWithRetainedOverlay = timelineItemsWithRetainedLiveTurnOverlay([...historyItems, ...currentAssistantItems], retainedItems);
  return visibleLiveTurnItemsForTimeline(historyWithRetainedOverlay, retainedItems, {
    allowAssistantTextMatchAcrossSources: true,
  }).filter((item) => !currentLiveKeys.has(liveCurrentDuplicateKey(item)));
}

export function pendingUserItemsWithoutHistory<T extends Extract<TimelineItem, { kind: 'user' }>>(historyItems: TimelineItem[], pendingItems: T[]): T[] {
  return pendingItems.filter(
    (pending) =>
      !historyItems.some(
        (item) =>
          item.kind === 'user' &&
          item.text.trim() === pending.text.trim() &&
          Boolean(pending.turnId && !isSyntheticPendingTurnId(pending.turnId) && item.turnId === pending.turnId),
      ),
  );
}

export function claimedQueuedUserItemsWithoutHistory<T extends Extract<TimelineItem, { kind: 'user' }>>(historyItems: TimelineItem[], pendingItems: T[]): T[] {
  const visible = pendingItems.filter(
    (pending) =>
      !historyItems.some(
        (item) =>
          item.kind === 'user' &&
          item.text.trim() === pending.text.trim() &&
          Boolean(pending.turnId && !isSyntheticPendingTurnId(pending.turnId) && item.turnId === pending.turnId),
      ),
  );
  return visible.length > CLAIMED_QUEUED_USER_ITEM_LIMIT ? visible.slice(-CLAIMED_QUEUED_USER_ITEM_LIMIT) : visible;
}

export function retargetSyntheticUserItemsToTurn<T extends Extract<TimelineItem, { kind: 'user' }>>(items: T[], turnId: string | null | undefined): T[] {
  if (!turnId || isSyntheticPendingTurnId(turnId)) return items;
  let changed = false;
  const next = items.map((item) => {
    if (!item.turnId || !isSyntheticPendingTurnId(item.turnId)) return item;
    changed = true;
    return { ...item, turnId };
  });
  return changed ? next : items;
}

function liveCurrentDuplicateKey(item: TimelineItem): string {
  const turnId = timelineItemTurnId(item) ?? 'unscoped';
  if (item.kind === 'assistant' || item.kind === 'streaming') {
    if (item.sourceId) return `message:${turnId}:source:${item.sourceId}`;
    return `message:${turnId}:${item.kind}:${item.id}:${normalizedMessageBlock(item.text)}`;
  }
  return `${item.kind}:${item.id}:${turnId}`;
}

type QueuedTimelineMessage = Extract<TimelineItem, { kind: 'queued' }>['message'];

function claimedQueuedUserItemId(messageId: string): string {
  return `claimed-queued:user:${messageId}`;
}

export function claimedQueuedMessageIdFromPendingUserItem(item: Extract<TimelineItem, { kind: 'user' }>): string | null {
  const prefix = 'claimed-queued:user:';
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : null;
}

export function claimedQueuedUserItemsFromQueueTransition(
  previousQueue: QueuedTimelineMessage[],
  currentQueue: QueuedTimelineMessage[],
  previousScope: TimelineNotificationScope,
  currentScope: TimelineNotificationScope,
  sortOrderForId: (id: string) => number,
  claimedAt: number,
  options: { ignoredRemovedMessageIds?: ReadonlySet<string> } = {},
): Extract<TimelineItem, { kind: 'user' }>[] {
  const previousTurnId = previousScope.activeTurnId;
  const currentTurnId = currentScope.activeTurnId;
  if (!currentTurnId) return [];
  if (previousScope.activeThreadId !== currentScope.activeThreadId) return [];
  if (previousTurnId === currentTurnId) {
    if (!previousTurnId || isSyntheticPendingTurnId(previousTurnId)) return [];
  } else {
    if (isSyntheticPendingTurnId(previousTurnId)) return [];
    if (!previousTurnId && isSyntheticPendingTurnId(currentTurnId)) return [];
  }

  const currentIds = new Set(currentQueue.map((message) => message.id));
  const claimedMessages: QueuedTimelineMessage[] = [];
  const allowMultipleClaims = previousTurnId === currentTurnId;
  for (const message of previousQueue) {
    if (currentIds.has(message.id)) {
      if (message.deliveryState === 'maybeSent') continue;
      break;
    }
    if (options.ignoredRemovedMessageIds?.has(message.id)) continue;
    claimedMessages.push(message);
    if (!allowMultipleClaims) break;
  }
  if (claimedMessages.length === 0) return [];

  return claimedMessages.map((message) => {
    const id = claimedQueuedUserItemId(message.id);
    return {
      id,
      kind: 'user',
      timestamp: claimedAt,
      sortOrder: sortOrderForId(id),
      text: message.text,
      turnId: currentTurnId,
    };
  });
}

function liveRetentionKey(item: TimelineItem): string {
  const turnId = timelineItemTurnId(item) ?? 'unscoped';
  if (item.kind === 'assistant' && item.sourceId) return `assistant:${turnId}:source:${item.sourceId}`;
  if (item.kind === 'assistant') return `assistant:${turnId}:${item.phase ?? ''}:${normalizedMessageBlock(item.text)}`;
  if (item.kind === 'streaming' && item.sourceId) return `streaming:${turnId}:source:${item.sourceId}`;
  if (item.kind === 'streaming') return `streaming:${turnId}:${normalizedMessageBlock(item.text)}`;
  return `${item.kind}:${item.id}`;
}

export function mergeRetainedLiveTurnItems(
  historyItems: TimelineItem[],
  retainedItems: TimelineItem[],
  additions: TimelineItem[],
  limit = 200,
): TimelineItem[] {
  const overlayItems = [...retainedItems, ...additions];
  const historyWithRetainedOverlay = timelineItemsWithRetainedLiveTurnOverlay(historyItems, overlayItems);
  const retained = visibleLiveTurnItemsForTimeline(historyWithRetainedOverlay, retainedItems, { allowAssistantTextMatchAcrossSources: true });
  const visibleAdditions = visibleLiveTurnItemsForTimeline(historyWithRetainedOverlay, additions, { allowAssistantTextMatchAcrossSources: true }).filter(
    (item) => !(item.kind === 'streaming' && item.active),
  );
  if (retained.length === 0 && visibleAdditions.length === 0) return [];

  const keys = new Set(retained.map(liveRetentionKey));
  const merged = [...retained];
  for (const item of visibleAdditions) {
    const key = liveRetentionKey(item);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(item);
  }

  const finalHistoryWithRetainedOverlay = timelineItemsWithRetainedLiveTurnOverlay(historyItems, merged);
  return trimTimelineWindow(visibleLiveTurnItemsForTimeline(finalHistoryWithRetainedOverlay, merged, { allowAssistantTextMatchAcrossSources: true }), limit);
}

export function timelineItemsWithLiveTurnOverlay(items: TimelineItem[], liveItems: TimelineItem[], activeTurnId: string | null | undefined): TimelineItem[] {
  if (!activeTurnId || liveItems.length === 0) return items;

  const liveIds = new Set(liveItems.map((item) => item.id));
  const liveAssistantSourceIds = new Set<string>();
  const liveUnidentifiedAssistantTexts = new Set<string>();
  for (const item of liveItems) {
    if (item.kind !== 'assistant') continue;
    if (item.sourceId) {
      liveAssistantSourceIds.add(item.sourceId);
      continue;
    }
    const text = normalizedMessageBlock(item.text);
    if (text) liveUnidentifiedAssistantTexts.add(text);
  }

  return items.filter((item) => {
    if (timelineItemTurnId(item) !== activeTurnId) return true;
    if (liveIds.has(item.id)) return false;
    if (item.kind === 'assistant') {
      if (item.sourceId && liveAssistantSourceIds.has(item.sourceId)) return false;
      if (!item.sourceId && liveUnidentifiedAssistantTexts.has(normalizedMessageBlock(item.text))) return false;
    }
    return true;
  });
}

export function nextLiveNotificationWindow(
  current: LiveNotificationWindow,
  scope: TimelineNotificationScope,
  notificationCount: number,
  options: { pendingStartCount?: number | null; turnStartCount?: number | null } = {},
): LiveNotificationWindow {
  const pendingStartCount = typeof options.pendingStartCount === 'number' ? options.pendingStartCount : null;
  const turnStartCount = typeof options.turnStartCount === 'number' ? options.turnStartCount : null;
  const newWindowStartCount = pendingStartCount ?? turnStartCount ?? notificationCount;

  if (current.activeThreadId !== scope.activeThreadId) {
    return { ...scope, startCount: newWindowStartCount };
  }
  if (pendingStartCount !== null && !scope.activeTurnId) {
    return { ...scope, startCount: pendingStartCount };
  }
  if (scope.activeTurnId && current.activeTurnId !== scope.activeTurnId) {
    const keepCurrentStart = current.activeTurnId === null || isSyntheticPendingTurnId(current.activeTurnId);
    return { ...scope, startCount: keepCurrentStart ? current.startCount : newWindowStartCount };
  }
  if (scope.activeTurnId && current.activeTurnId === scope.activeTurnId && turnStartCount !== null && turnStartCount !== current.startCount) {
    return { ...current, startCount: turnStartCount };
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
  let streamOpen = false;
  const acceptUnscoped = options.acceptUnscoped ?? active;

  for (const notification of notifications) {
    if (!isRecord(notification) || typeof notification.method !== 'string') continue;

    if (TERMINAL_NOTIFICATION_METHODS.has(notification.method)) {
      if (notificationMatchesActiveTurn(notification, scope)) {
        turnId = notificationTurnId(notification) ?? turnId;
        streamOpen = false;
      }
      continue;
    }

    if (notification.method === 'item/agentMessage/delta' && isRecord(notification.params)) {
      if (!notificationMatchesActiveTurn(notification, scope)) continue;
      const delta = notification.params.delta;
      if (typeof delta === 'string') text += delta;
      turnId = notificationTurnId(notification) ?? turnId;
      streamOpen = true;
      continue;
    }

    if (notification.method !== 'event_msg') continue;
    const payload = notificationPayload(notification);
    if (!isRecord(payload)) continue;
    if (typeof payload.type === 'string' && TERMINAL_EVENT_TYPES.has(payload.type)) {
      if (notificationIsTurnComplete(notification, scope)) {
        turnId = notificationTurnId(notification) ?? turnId;
        streamOpen = false;
      }
      continue;
    }
    if (payload.type !== 'agent_message') continue;
    const hasScopeId = Boolean(notificationThreadId(notification) || notificationTurnId(notification));
    if (hasScopeId && !notificationMatchesActiveTurn(notification, scope)) continue;
    if (!hasScopeId && !acceptUnscoped) continue;
    const message = payload.message;
    if (typeof message === 'string' && message.trim()) text = text ? `${text}\n\n${message}` : message;
    turnId = notificationTurnId(notification) ?? turnId;
    streamOpen = true;
  }

  if (!text && !active) return null;

  return {
    id: 'live:streaming-assistant',
    kind: 'streaming',
    timestamp: now,
    text,
    active: active && streamOpen,
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
