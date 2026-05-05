import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileContentHandler, FILE_CONTENT_CSP } from '../../server/fileContent.js';

const hasMkfifo = spawnSync('sh', ['-c', 'command -v mkfifo >/dev/null 2>&1']).status === 0;

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function listen(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function makeApp(options: { root: string | null; authorized?: boolean }) {
  const app = express();
  const handler = createFileContentHandler({
    authorized: () => options.authorized ?? true,
    getActiveCwd: () => options.root,
  });
  app.head('/api/file/content', handler);
  app.get('/api/file/content', handler);
  return app;
}

describe('file content endpoint', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace() {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-webui-content-'));
    cleanupPaths.push(tmp);
    const root = join(tmp, 'root');
    const outside = join(tmp, 'outside');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'src', 'app.py'), 'print("hello")\n');
    writeFileSync(join(root, 'src', '💥.txt'), 'unicode name\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    return { root, outside };
  }

  it('requires auth before streaming content', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root, authorized: false }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2Fapp.py`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('requires an active workspace', async () => {
    const server = await listen(makeApp({ root: null }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2Fapp.py`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'no active cwd' });
    } finally {
      await server.close();
    }
  });

  it('rejects traversal through symlinks outside the active workspace', async () => {
    const { root, outside } = makeWorkspace();
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=outside-link%2Fsecret.txt`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is outside active workspace' });
    } finally {
      await server.close();
    }
  });

  it('rejects directories', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is not a file' });
    } finally {
      await server.close();
    }
  });

  it.runIf(hasMkfifo)('rejects FIFOs without waiting for a writer', async () => {
    const { root } = makeWorkspace();
    const fifoPath = join(root, 'src', 'pipe');
    const result = spawnSync('mkfifo', [fifoPath]);
    expect(result.status).toBe(0);
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2Fpipe`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is not a file' });
    } finally {
      await server.close();
    }
  });

  it('streams file bytes with safe headers', async () => {
    const { root } = makeWorkspace();
    const expected = 'print("hello")\n';
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2Fapp.py`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/octet-stream');
      expect(response.headers.get('content-security-policy')).toBe(FILE_CONTENT_CSP);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-codex-file-size')).toBe(String(Buffer.byteLength(expected)));
      expect(response.headers.get('x-codex-file-modified-at-ms')).toMatch(/^\d+(\.\d+)?$/);
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(expected)));
      expect(response.headers.get('last-modified')).toBeTruthy();
      expect(await response.text()).toBe(expected);
    } finally {
      await server.close();
    }
  });

  it('uses an ASCII-safe content disposition for Unicode filenames', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2F%F0%9F%92%A5.txt`);
      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition');
      expect(disposition).toContain('inline; filename=');
      expect(disposition).toContain("filename*=UTF-8''%F0%9F%92%A5.txt");
      expect(disposition && /^[\x00-\x7f]*$/.test(disposition)).toBe(true);
      expect(await response.text()).toBe('unicode name\n');
    } finally {
      await server.close();
    }
  });

  it('supports HEAD without a body', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/content?path=src%2Fapp.py`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('print("hello")\n')));
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    } finally {
      await server.close();
    }
  });
});
