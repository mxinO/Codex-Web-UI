import type express from 'express';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { openExistingFileInsideRoot, resolveExistingPathInsideRoot, type OpenedWorkspaceFile } from './fileTransfer.js';

export const FILE_PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
export const INLINE_IMAGE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const INLINE_IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

function getQueryPath(req: express.Request): string | null {
  return typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : null;
}

export function isInlineImagePath(filePath: string): boolean {
  return INLINE_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function resolveInlinePreviewPath(root: string, filePath: string): Promise<string> {
  const resolved = await resolveExistingPathInsideRoot(root, filePath);
  if (!isInlineImagePath(resolved)) throw Object.assign(new Error('file type is not previewable'), { statusCode: 415 });
  return resolved;
}

async function openInlinePreviewFile(root: string, filePath: string): Promise<OpenedWorkspaceFile> {
  const opened = await openExistingFileInsideRoot(root, filePath);
  if (!isInlineImagePath(opened.realPath)) {
    await opened.handle.close().catch(() => undefined);
    throw Object.assign(new Error('file type is not previewable'), { statusCode: 415 });
  }
  return opened;
}

export function createFilePreviewHandler(options: {
  authorized: (req: express.Request) => boolean;
  getActiveCwd: () => string | null;
}): express.RequestHandler {
  return async (req, res) => {
    if (!options.authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const activeCwd = options.getActiveCwd();
    if (!activeCwd) return res.status(409).json({ error: 'no active cwd' });
    const filePath = getQueryPath(req);
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    try {
      const opened = await openInlinePreviewFile(activeCwd, filePath);
      if (opened.stats.size > INLINE_IMAGE_PREVIEW_MAX_BYTES) {
        await opened.handle.close().catch(() => undefined);
        throw Object.assign(new Error(`image preview is too large (max ${INLINE_IMAGE_PREVIEW_MAX_BYTES} bytes)`), { statusCode: 413 });
      }
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Content-Security-Policy', FILE_PREVIEW_CSP);
      res.setHeader('Content-Length', String(opened.stats.size));
      res.setHeader('Last-Modified', opened.stats.mtime.toUTCString());
      res.type(path.extname(opened.realPath));
      if (req.method === 'HEAD') {
        await opened.handle.close();
        return res.end();
      }
      if (opened.stats.size === 0) {
        await opened.handle.close();
        return res.end();
      }

      const stream = opened.handle.createReadStream({ autoClose: true, start: 0, end: opened.stats.size - 1 });
      res.on('close', () => {
        if (!res.writableEnded) stream.destroy();
      });
      return pipeline(stream, res, (error) => {
        if (error && !res.headersSent) {
          res.status(500).json({ error: error.message });
        }
      });
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 400;
      return res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
