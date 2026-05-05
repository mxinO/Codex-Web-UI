import type express from 'express';
import { pipeline } from 'node:stream';
import { openExistingFileInsideRoot } from './fileTransfer.js';

function getQueryPath(req: express.Request): string | null {
  return typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : null;
}

export function createFileDownloadHandler(options: {
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
      const opened = await openExistingFileInsideRoot(activeCwd, filePath);
      res.attachment(opened.realPath);
      res.setHeader('Content-Length', String(opened.stats.size));
      res.setHeader('Last-Modified', opened.stats.mtime.toUTCString());
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
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
