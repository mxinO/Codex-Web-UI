import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileRawHandler, FILE_RAW_CSP, FILE_RAW_TRUSTED_HTML_CSP } from '../../server/fileRaw.js';

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
  const handler = createFileRawHandler({
    authorized: () => options.authorized ?? true,
    getActiveCwd: () => options.root,
  });
  app.head('/api/file/raw', handler);
  app.get('/api/file/raw', handler);
  return app;
}

describe('raw browser file endpoint', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace() {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-webui-raw-'));
    cleanupPaths.push(tmp);
    const root = join(tmp, 'root');
    const outside = join(tmp, 'outside');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'docs', 'report.html'), '<!doctype html><title>Report</title><script>alert(1)</script>');
    writeFileSync(join(root, 'docs', 'paper.pdf'), Buffer.from('%PDF-1.7\nbody\n'));
    writeFileSync(join(root, 'docs', 'notes.py'), 'print("not raw")\n');
    writeFileSync(join(outside, 'secret.html'), '<title>secret</title>');
    return { root, outside };
  }

  it('requires auth before serving a raw file', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root, authorized: false }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Freport.html`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects unsupported file types before streaming inline content', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Fnotes.py`);
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'file type is not browser-openable' });
    } finally {
      await server.close();
    }
  });

  it('rejects traversal through symlinks outside the active workspace', async () => {
    const { root, outside } = makeWorkspace();
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=outside-link%2Fsecret.html`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is outside active workspace' });
    } finally {
      await server.close();
    }
  });

  it('streams browser-openable files inline with restrictive security headers', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Freport.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('inline;');
      expect(response.headers.get('content-security-policy')).toBe(FILE_RAW_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('<title>Report</title>');
    } finally {
      await server.close();
    }
  });

  it('serves explicitly trusted HTML with sandboxed script support', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Freport.html&trusted=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(FILE_RAW_TRUSTED_HTML_CSP);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'");
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).toContain('<script>alert(1)</script>');
    } finally {
      await server.close();
    }
  });

  it('does not switch PDFs to trusted HTML mode', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Fpaper.pdf&trusted=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(FILE_RAW_CSP);
      expect(response.headers.get('content-type')).toContain('application/pdf');
    } finally {
      await server.close();
    }
  });

  it('supports range requests for browser PDF viewers', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Fpaper.pdf`, { headers: { Range: 'bytes=0-7' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-range')).toBe('bytes 0-7/14');
      expect(response.headers.get('content-length')).toBe('8');
      expect(response.headers.get('content-type')).toContain('application/pdf');
      expect(await response.text()).toBe('%PDF-1.7');
    } finally {
      await server.close();
    }
  });

  it('answers HEAD requests with raw metadata and no body', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file/raw?path=docs%2Freport.html`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('inline;');
      expect(response.headers.get('content-security-policy')).toBe(FILE_RAW_CSP);
      expect(response.headers.get('content-length')).toBe('61');
      expect(await response.text()).toBe('');
    } finally {
      await server.close();
    }
  });
});
