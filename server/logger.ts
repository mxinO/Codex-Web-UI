import fs from 'node:fs';
import path from 'node:path';

let filePath: string | null = null;
let fileLoggingFailed = false;

export function configureLogger(options: { filePath?: string | null }): void {
  filePath = options.filePath ?? null;
  fileLoggingFailed = false;

  if (!filePath) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    appendLogFile('info', 'Logger initialized', { filePath });
  } catch (error) {
    fileLoggingFailed = true;
    console.warn('[warn] Failed to initialize log file', error);
  }
}

function normalizeMeta(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : normalizeMeta(value.cause),
    };
  }

  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeMeta);
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = normalizeMeta(entry);
    return next;
  }

  return value;
}

function serializeMeta(meta: unknown): string {
  try {
    return JSON.stringify(normalizeMeta(meta));
  } catch {
    return String(meta);
  }
}

function truncate(value: string, limit = 20_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...<truncated ${value.length - limit} chars>`;
}

function appendLogFile(level: string, message: string, meta?: unknown): void {
  if (!filePath || fileLoggingFailed) return;

  const suffix = meta === undefined ? '' : ` ${truncate(serializeMeta(meta))}`;
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (error) {
    fileLoggingFailed = true;
    console.warn('[warn] Failed to write log file', error);
  }
}

export function logInfo(message: string, meta?: unknown) {
  if (meta === undefined) console.log(`[info] ${message}`);
  else console.log(`[info] ${message}`, meta);
  appendLogFile('info', message, meta);
}

export function logWarn(message: string, meta?: unknown) {
  if (meta === undefined) console.warn(`[warn] ${message}`);
  else console.warn(`[warn] ${message}`, meta);
  appendLogFile('warn', message, meta);
}

export function logError(message: string, meta?: unknown) {
  if (meta === undefined) console.error(`[error] ${message}`);
  else console.error(`[error] ${message}`, meta);
  appendLogFile('error', message, meta);
}
