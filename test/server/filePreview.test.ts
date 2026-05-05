import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFilePreviewHandler, FILE_PREVIEW_CSP, INLINE_IMAGE_PREVIEW_MAX_BYTES } from '../../server/filePreview.js';

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
  const handler = createFilePreviewHandler({
    authorized: () => options.authorized ?? true,
    getActiveCwd: () => options.root,
  });
  app.head('/api/file', handler);
  app.get(
    '/api/file',
    handler,
  );
  return app;
}

describe('file preview endpoint', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace() {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-webui-preview-'));
    cleanupPaths.push(tmp);
    const root = join(tmp, 'root');
    const outside = join(tmp, 'outside');
    mkdirSync(join(root, 'plots'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'plots', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'notes.txt'), 'plain text');
    writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return { root, outside };
  }

  it('requires auth before serving a preview', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root, authorized: false }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=plots%2Fimage.png`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects non-image files before sending inline content', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=notes.txt`);
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'file type is not previewable' });
    } finally {
      await server.close();
    }
  });

  it('rejects traversal through symlinks outside the active workspace', async () => {
    const { root, outside } = makeWorkspace();
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=outside-link%2Fsecret.png`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'path is outside active workspace' });
    } finally {
      await server.close();
    }
  });

  it('rejects oversized image previews before streaming inline content', async () => {
    const { root } = makeWorkspace();
    const hugeImage = join(root, 'plots', 'huge.png');
    writeFileSync(hugeImage, '');
    truncateSync(hugeImage, INLINE_IMAGE_PREVIEW_MAX_BYTES + 1);
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=plots%2Fhuge.png`);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: `image preview is too large (max ${INLINE_IMAGE_PREVIEW_MAX_BYTES} bytes)` });
    } finally {
      await server.close();
    }
  });

  it('serves valid images inline with preview security headers', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=plots%2Fimage.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe('inline');
      expect(response.headers.get('content-security-policy')).toBe(FILE_PREVIEW_CSP);
      expect(response.headers.get('content-type')).toContain('image/png');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await server.close();
    }
  });

  it('answers HEAD requests with preview metadata and no body', async () => {
    const { root } = makeWorkspace();
    const server = await listen(makeApp({ root }));
    try {
      const response = await fetch(`${server.baseUrl}/api/file?path=plots%2Fimage.png`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe('inline');
      expect(response.headers.get('content-length')).toBe('4');
      expect(response.headers.get('content-security-policy')).toBe(FILE_PREVIEW_CSP);
      expect(await response.text()).toBe('');
    } finally {
      await server.close();
    }
  });
});
