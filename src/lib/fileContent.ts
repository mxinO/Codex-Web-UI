export const DEFAULT_TEXT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export class FileContentTooLargeError extends Error {
  readonly sizeBytes: number | null;

  constructor(sizeBytes: number | null) {
    super(sizeBytes === null ? 'File is too large to open in the browser.' : `File is too large to open in the browser (${sizeBytes} bytes).`);
    this.name = 'FileContentTooLargeError';
    this.sizeBytes = sizeBytes;
  }
}

export interface ReadTextFileStreamOptions {
  maxBytes?: number;
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ReadTextFileStreamResult {
  content: string;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  truncated: false;
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && body.error) return new Error(body.error);
  } catch {
    // Fall through to a generic HTTP error.
  }
  return new Error(`file content request failed with HTTP ${response.status}`);
}

export function fileContentUrl(path: string): string {
  return `/api/file/content?path=${encodeURIComponent(path)}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

export async function readTextFileStream(path: string, options: ReadTextFileStreamOptions = {}): Promise<ReadTextFileStreamResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_TEXT_FILE_MAX_BYTES;
  const response = await fetch(fileContentUrl(path), { credentials: 'same-origin', cache: 'no-store', signal: options.signal });
  throwIfAborted(options.signal);
  if (!response.ok) throw await responseError(response);

  const sizeBytes = numberHeader(response.headers, 'x-codex-file-size') ?? numberHeader(response.headers, 'content-length');
  if (sizeBytes !== null && sizeBytes > maxBytes) {
    await response.body?.cancel();
    throw new FileContentTooLargeError(sizeBytes);
  }

  const modifiedAtMs = numberHeader(response.headers, 'x-codex-file-modified-at-ms');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming file reads are not supported by this browser.');

  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let receivedBytes = 0;
  const abortRead = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };

  try {
    throwIfAborted(options.signal);
    options.signal?.addEventListener('abort', abortRead, { once: true });
    while (true) {
      const { value, done } = await reader.read();
      throwIfAborted(options.signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new FileContentTooLargeError(sizeBytes ?? receivedBytes);
      }
      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
      options.onChunk?.(chunk);
    }
  } finally {
    options.signal?.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }

  throwIfAborted(options.signal);
  const finalChunk = decoder.decode();
  if (finalChunk) {
    chunks.push(finalChunk);
    options.onChunk?.(finalChunk);
  }

  return { content: chunks.join(''), sizeBytes: sizeBytes ?? receivedBytes, modifiedAtMs, truncated: false };
}
