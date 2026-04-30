import fs from 'node:fs';
import path from 'node:path';

let filePath: string | null = null;
let fileLoggingFailed = false;

export function configureLogger(options: { filePath?: string | null }): void {
  filePath = options.filePath ?? null;
  fileLoggingFailed = false;

  if (!filePath) return;

  try {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const fd = fs.openSync(filePath, 'a', 0o600);
    fs.closeSync(fd);
    fs.chmodSync(filePath, 0o600);
    appendLogFile('info', 'Logger initialized', { filePath });
  } catch (error) {
    fileLoggingFailed = true;
    console.warn('[warn] Failed to initialize log file', error);
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(codex_web_ui_token=)[^;\s"']+/gi, '$1<redacted>')
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1<redacted>');
}

function normalizeMeta(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
      stack: value.stack ? redactSecrets(value.stack) : value.stack,
      cause: value.cause === undefined ? undefined : normalizeMeta(value.cause),
    };
  }

  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeMeta);
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = /token|authorization|cookie/i.test(key) ? '<redacted>' : normalizeMeta(entry);
    }
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
  const line = `[${new Date().toISOString()}] [${level}] ${redactSecrets(message)}${suffix}\n`;
  try {
    fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
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
