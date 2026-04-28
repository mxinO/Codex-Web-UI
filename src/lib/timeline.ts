import type { CodexItem, CodexTurn } from '../types/codex';

export type TimelineItem =
  | { id: string; kind: 'user'; timestamp: number; text: string }
  | { id: string; kind: 'assistant'; timestamp: number; text: string; phase: string | null }
  | { id: string; kind: 'command'; timestamp: number; command: string; cwd: string; output: string; status: string; exitCode: number | null }
  | { id: string; kind: 'fileChange'; timestamp: number; item: CodexItem }
  | { id: string; kind: 'tool'; timestamp: number; item: CodexItem }
  | { id: string; kind: 'notice'; timestamp: number; text: string }
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

function userText(item: Extract<CodexItem, { type: 'userMessage' }>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => part.text ?? part.path ?? part.url ?? '').join('');
}

function safeItemId(turn: CodexTurn, item: CodexItem, index: number): string {
  return `${turn.id}:${item.id ?? index}`;
}

export function turnToTimelineItems(turn: CodexTurn): TimelineItem[] {
  const timestamp = (turn.startedAt ?? 0) * 1000;
  const items = Array.isArray(turn.items) ? turn.items : [];

  return items.map((item, index) => {
    const id = safeItemId(turn, item, index);
    if (item.type === 'userMessage') return { id, kind: 'user', timestamp, text: userText(item) };
    if (item.type === 'agentMessage') return { id, kind: 'assistant', timestamp, text: item.text, phase: item.phase };
    if (item.type === 'commandExecution') {
      return {
        id,
        kind: 'command',
        timestamp,
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? '',
        status: item.status,
        exitCode: item.exitCode,
      };
    }
    if (item.type === 'fileChange') return { id, kind: 'fileChange', timestamp, item };
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      return { id, kind: 'notice', timestamp, text: [...summary, ...content].join('\n') };
    }
    if (item.type === 'plan') return { id, kind: 'notice', timestamp, text: item.text };
    return { id, kind: 'tool', timestamp, item };
  });
}

export function trimTimelineWindow<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
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
