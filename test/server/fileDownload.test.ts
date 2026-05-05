import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileDownloadHandler } from '../../server/fileDownload.js';

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
  const handler = createFileDownloadHandler({
    authorized: () => options.authorized ?? true,
    getActiveCwd: () => options.root,
  });
  app.head('/api/download', handler);
  app.get('/api/download', handler);
  return app;
}

describe('file download endpoint', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace() {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-webui-download-'));
    cleanupPaths.push(tmp);
    const root = join(tmp, 'root');
    const outside = join(tmp, 'outside');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'data', 'report.txt'), 'report\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    return { root, outside };
  }

  it('requires auth before serving a download', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root, authorized: false }));
    try {
      const response = await fetch(`${server.baseUrl}/api/download?path=data%2Freport.txt`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects traversal through symlinks outside the active workspace', async () => {
    const { root, outside } = makeWorkspace();
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/download?path=outside-link%2Fsecret.txt`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is outside active workspace' });
    } finally {
      await server.close();
    }
  });

  it('streams downloads with attachment headers', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/download?path=data%2Freport.txt`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(response.headers.get('content-length')).toBe('7');
      expect(await response.text()).toBe('report\n');
    } finally {
      await server.close();
    }
  });

  it('answers HEAD requests with download metadata and no body', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/download?path=data%2Freport.txt`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(response.headers.get('content-length')).toBe('7');
      expect(await response.text()).toBe('');
    } finally {
      await server.close();
    }
  });
});
