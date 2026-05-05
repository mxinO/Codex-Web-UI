import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileContentTooLargeError, fileContentUrl, readTextFileStream } from '../../src/lib/fileContent';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('file content client helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds normalized content URLs', () => {
    expect(fileContentUrl('/repo/src/app.py:12')).toBe('/api/file/content?path=%2Frepo%2Fsrc%2Fapp.py');
  });

  it('streams text chunks and returns metadata headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(streamFromChunks(['hello ', 'world']), {
          status: 200,
          headers: {
            'x-codex-file-size': '11',
            'x-codex-file-modified-at-ms': '1234',
          },
        }),
      ),
    );

    const progress: string[] = [];
    const result = await readTextFileStream('/repo/file.txt', { onChunk: (chunk) => progress.push(chunk) });

    expect(fetch).toHaveBeenCalledWith('/api/file/content?path=%2Frepo%2Ffile.txt', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(result).toEqual({ content: 'hello world', sizeBytes: 11, modifiedAtMs: 1234, truncated: false });
    expect(progress).toEqual(['hello ', 'world']);
  });

  it('throws useful errors for HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'path is outside active workspace' }), { status: 400 })));

    await expect(readTextFileStream('/outside.txt')).rejects.toThrow('path is outside active workspace');
  });

  it('aborts when the client cap is exceeded while streaming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamFromChunks(['abcd', 'efgh']), { status: 200 })));

    await expect(readTextFileStream('/repo/big.txt', { maxBytes: 5 })).rejects.toBeInstanceOf(FileContentTooLargeError);
  });

  it('cancels the response body when headers already prove the file is too large', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('content'));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'x-codex-file-size': '99' },
        }),
      ),
    );

    await expect(readTextFileStream('/repo/big.txt', { maxBytes: 5 })).rejects.toBeInstanceOf(FileContentTooLargeError);
    expect(cancel).toHaveBeenCalled();
  });

  it('fails closed when the browser cannot expose a streaming reader', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'x-codex-file-size': '4' }),
        body: null,
      } as Response),
    );

    await expect(readTextFileStream('/repo/file.txt')).rejects.toThrow('Streaming file reads are not supported');
  });
});
