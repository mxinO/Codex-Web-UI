import type { TimelineItem } from './timeline';

export const BANG_COMMAND_RPC_TIMEOUT_MS = 35_000;
const MAX_EPHEMERAL_BANG_ITEMS = 50;

export interface ParsedBangCommand {
  command: string;
}

export interface BangCommandOutputDetail {
  command: string;
  cwd: string;
  threadId: string | null;
  result: unknown;
}

export function parseBangCommand(input: string): ParsedBangCommand | null {
  if (!input.startsWith('!')) return null;
  const command = input.slice(1).trim();
  return command ? { command } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

function getStringPath(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function getNumberPath(value: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function bangOutputFromResult(result: unknown): string {
  const stdout = getStringPath(result, [
    ['stdout'],
    ['data', 'stdout'],
  ]);
  const stderr = getStringPath(result, [
    ['stderr'],
    ['data', 'stderr'],
  ]);
  if (stdout !== null || stderr !== null) {
    return [stdout, stderr].filter(Boolean).join('');
  }

  const output = getStringPath(result, [
    ['output'],
    ['aggregatedOutput'],
    ['data', 'output'],
    ['data', 'aggregatedOutput'],
  ]);
  if (output !== null) return output;

  if (typeof result === 'string') return result;
  if (result === null || typeof result === 'undefined') return '';

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function bangStatusFromResult(result: unknown, exitCode: number | null): string {
  if (exitCode !== null) return exitCode === 0 ? 'completed' : 'failed';

  const status = getStringPath(result, [
    ['status'],
    ['data', 'status'],
  ]);
  if (status === 'failed') return 'failed';
  return 'completed';
}

function bangExitCodeFromResult(result: unknown): number | null {
  return getNumberPath(result, [
    ['exitCode'],
    ['data', 'exitCode'],
  ]);
}

export function getBangCommandOutputDetail(event: Event): BangCommandOutputDetail | null {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail) || typeof event.detail.command !== 'string') return null;
  return {
    command: event.detail.command,
    cwd: typeof event.detail.cwd === 'string' ? event.detail.cwd : '',
    threadId: typeof event.detail.threadId === 'string' ? event.detail.threadId : null,
    result: event.detail.result,
  };
}

export function bangOutputEventToTimelineItem(
  detail: BangCommandOutputDetail,
  activeThreadId: string | null,
  timestamp: number,
  counter: number,
): TimelineItem | null {
  if (detail.threadId && detail.threadId !== activeThreadId) return null;

  const exitCode = bangExitCodeFromResult(detail.result);
  return {
    id: `bang:${timestamp}:${counter}`,
    kind: 'command',
    timestamp,
    command: detail.command,
    cwd: detail.cwd,
    output: bangOutputFromResult(detail.result),
    status: bangStatusFromResult(detail.result, exitCode),
    exitCode,
  };
}

export function appendEphemeralBangItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  return [...items, item].slice(-MAX_EPHEMERAL_BANG_ITEMS);
}
