import type { RuntimeLastTurn, RuntimeStatusConfirmationSource, RuntimeStatusResult, RuntimeTurnContext } from '../types/ui';

const STRING_LIMITS = {
  hostname: 255,
  id: 512,
  cwd: 8192,
  model: 512,
  option: 128,
  timestamp: 128,
  detail: 2048,
} as const;

const CONFIRMATION_SOURCES = new Set<RuntimeStatusConfirmationSource>(['threadStart', 'threadResume', 'settingsUpdated']);
const LAST_TURN_STATUSES = new Set(['found', 'none', 'unavailable', 'scanLimit']);

type UnknownRecord = Record<string, unknown>;

function invalid(field: string): never {
  throw new Error(`Invalid runtime status: ${field}`);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as UnknownRecord;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(field);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) invalid(field);
  return normalized;
}

function nullableString(record: UnknownRecord, key: string, maxLength: number): string | null {
  const value = record[key];
  return value === null ? null : boundedString(value, key, maxLength);
}

function scannedBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('lastTurn.scannedBytes');
  return value as number;
}

function parseTurnContext(value: unknown): RuntimeTurnContext {
  const context = asRecord(value, 'lastTurn.context');
  return {
    turnId: nullableString(context, 'turnId', STRING_LIMITS.id),
    model: boundedString(context.model, 'lastTurn.context.model', STRING_LIMITS.model),
    effort: nullableString(context, 'effort', STRING_LIMITS.option),
    recordedAt: nullableString(context, 'recordedAt', STRING_LIMITS.timestamp),
  };
}

function parseLastTurn(value: unknown): RuntimeLastTurn {
  const lastTurn = asRecord(value, 'lastTurn');
  const status = boundedString(lastTurn.status, 'lastTurn.status', 32);
  if (!LAST_TURN_STATUSES.has(status)) invalid('lastTurn.status');
  const bytes = scannedBytes(lastTurn.scannedBytes);

  if (status === 'found') {
    return {
      status,
      context: parseTurnContext(lastTurn.context),
      scannedBytes: bytes,
    };
  }

  if (lastTurn.context !== null) invalid('lastTurn.context');
  let detail: string | undefined;
  if (lastTurn.detail !== undefined) {
    detail = boundedString(lastTurn.detail, 'lastTurn.detail', STRING_LIMITS.detail);
  }
  return {
    status: status as Exclude<RuntimeLastTurn['status'], 'found'>,
    context: null,
    scannedBytes: bytes,
    ...(detail ? { detail } : {}),
  };
}

export function parseRuntimeStatusResult(value: unknown, expectedThreadId: string): RuntimeStatusResult {
  const result = asRecord(value, 'result');
  const threadId = boundedString(result.threadId, 'threadId', STRING_LIMITS.id);
  const normalizedExpectedThreadId = boundedString(expectedThreadId, 'expectedThreadId', STRING_LIMITS.id);
  if (threadId !== normalizedExpectedThreadId) {
    throw new Error('Runtime status thread does not match the active thread');
  }

  const confirmationSource = nullableString(result, 'confirmationSource', 32);
  if (confirmationSource !== null && !CONFIRMATION_SOURCES.has(confirmationSource as RuntimeStatusConfirmationSource)) {
    invalid('confirmationSource');
  }
  if (typeof result.confirmed !== 'boolean') invalid('confirmed');

  return {
    hostname: boundedString(result.hostname, 'hostname', STRING_LIMITS.hostname),
    threadId,
    cwd: nullableString(result, 'cwd', STRING_LIMITS.cwd),
    activeTurnId: nullableString(result, 'activeTurnId', STRING_LIMITS.id),
    model: nullableString(result, 'model', STRING_LIMITS.model),
    effort: nullableString(result, 'effort', STRING_LIMITS.option),
    mode: nullableString(result, 'mode', STRING_LIMITS.option),
    sandbox: nullableString(result, 'sandbox', STRING_LIMITS.option),
    confirmed: result.confirmed,
    confirmationSource: confirmationSource as RuntimeStatusConfirmationSource | null,
    confirmedAt: nullableString(result, 'confirmedAt', STRING_LIMITS.timestamp),
    lastTurn: parseLastTurn(result.lastTurn),
  };
}
