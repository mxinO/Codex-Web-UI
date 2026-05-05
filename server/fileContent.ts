import type express from 'express';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { assertPathInsideRoot } from './fileTransfer.js';

export const FILE_CONTENT_CSP = "default-src 'none'";

function getQueryPath(req: express.Request): string | null {
  return typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : null;
}

function contentDispositionFilename(filePath: string): string {
  return path.basename(filePath).replace(/["\\\r\n]/g, '_') || 'file';
}

function isPathInsideRoot(resolvedRoot: string, resolvedTarget: string): boolean {
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorWithStatus(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function realPathForOpenedFile(fd: number): Promise<string> {
  const candidates = process.platform === 'linux' ? [`/proc/self/fd/${fd}`] : [`/dev/fd/${fd}`];
  for (const candidate of candidates) {
    try {
      return await fsp.realpath(candidate);
    } catch {
      // Try the next descriptor path candidate.
    }
  }
  throw errorWithStatus('descriptor validation is not supported on this platform', 501);
}

export async function openContentFile(root: string, filePath: string): Promise<{ handle: FileHandle; realPath: string; stats: fs.Stats }> {
  const realRoot = await fsp.realpath(root);
  const lexicalPath = assertPathInsideRoot(root, filePath);
  const handle = await fsp.open(lexicalPath, 'r');

  try {
    const [realPath, stats] = await Promise.all([realPathForOpenedFile(handle.fd), handle.stat()]);
    if (!isPathInsideRoot(realRoot, realPath)) throw new Error('path is outside active workspace');
    if (!stats.isFile()) throw new Error('path is not a file');
    return { handle, realPath, stats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function createFileContentHandler(options: {
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
      const { handle, realPath, stats } = await openContentFile(activeCwd, filePath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stats.size));
      res.setHeader('Last-Modified', stats.mtime.toUTCString());
      res.setHeader('X-Codex-File-Size', String(stats.size));
      res.setHeader('X-Codex-File-Modified-At-Ms', String(stats.mtimeMs || 0));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', FILE_CONTENT_CSP);
      res.setHeader('Content-Disposition', `inline; filename="${contentDispositionFilename(realPath)}"`);
      if (req.method === 'HEAD') {
        await handle.close();
        return res.end();
      }

      const stream = handle.createReadStream({ autoClose: true });
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
