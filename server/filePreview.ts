import type express from 'express';
import path from 'node:path';
import { resolveExistingPathInsideRoot } from './fileTransfer.js';

export const FILE_PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

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
      const resolved = await resolveInlinePreviewPath(activeCwd, filePath);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Content-Security-Policy', FILE_PREVIEW_CSP);
      return res.sendFile(resolved);
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 400;
      return res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
