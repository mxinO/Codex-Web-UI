import path from 'node:path';
import { pipeline } from 'node:stream';
import { openExistingFileInsideRoot } from './fileTransfer.js';
export const FILE_RAW_CSP = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
].join('; ');
export const FILE_RAW_TRUSTED_HTML_CSP = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
    "sandbox allow-scripts allow-downloads",
].join('; ');
const RAW_BROWSER_EXTENSIONS = new Set(['.htm', '.html', '.pdf']);
const RAW_TRUSTED_HTML_EXTENSIONS = new Set(['.htm', '.html']);
function getQueryPath(req) {
    return typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : null;
}
function errorWithStatus(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
}
function contentDispositionFilename(filePath) {
    return path.basename(filePath) || 'file';
}
function asciiHeaderFilename(fileName) {
    const fallback = fileName.replace(/[^\x20-\x7e]|["\\\r\n]/g, '_').trim();
    return fallback || 'file';
}
function rfc5987Filename(fileName) {
    return encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function contentDispositionHeader(filePath) {
    const fileName = contentDispositionFilename(filePath);
    return `inline; filename="${asciiHeaderFilename(fileName)}"; filename*=UTF-8''${rfc5987Filename(fileName)}`;
}
function isRawBrowserOpenablePath(filePath) {
    return RAW_BROWSER_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function isTrustedHtmlPath(filePath) {
    return RAW_TRUSTED_HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function wantsTrustedHtml(req) {
    const value = req.query.trusted;
    return value === '1' || value === 'true';
}
function parseRangeHeader(rawRange, size) {
    if (!rawRange)
        return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange.trim());
    if (!match)
        throw errorWithStatus('invalid range', 416);
    if (size === 0)
        throw errorWithStatus('invalid range', 416);
    const [, rawStart, rawEnd] = match;
    if (!rawStart && !rawEnd)
        throw errorWithStatus('invalid range', 416);
    if (!rawStart) {
        const suffixLength = Number(rawEnd);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
            throw errorWithStatus('invalid range', 416);
        return { start: Math.max(0, size - suffixLength), end: Math.max(0, size - 1) };
    }
    const start = Number(rawStart);
    const end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        throw errorWithStatus('invalid range', 416);
    }
    return { start, end: Math.min(end, size - 1) };
}
export function createFileRawHandler(options) {
    return async (req, res) => {
        if (!options.authorized(req))
            return res.status(401).json({ error: 'unauthorized' });
        const activeCwd = options.getActiveCwd();
        if (!activeCwd)
            return res.status(409).json({ error: 'no active cwd' });
        const filePath = getQueryPath(req);
        if (!filePath)
            return res.status(400).json({ error: 'path is required' });
        try {
            const opened = await openExistingFileInsideRoot(activeCwd, filePath);
            if (!isRawBrowserOpenablePath(opened.realPath)) {
                await opened.handle.close().catch(() => undefined);
                throw errorWithStatus('file type is not browser-openable', 415);
            }
            let range = null;
            try {
                range = parseRangeHeader(req.headers.range, opened.stats.size);
            }
            catch (error) {
                await opened.handle.close().catch(() => undefined);
                res.setHeader('Content-Range', `bytes */${opened.stats.size}`);
                throw error;
            }
            const start = range?.start ?? 0;
            const end = range?.end ?? Math.max(0, opened.stats.size - 1);
            const contentLength = opened.stats.size === 0 ? 0 : end - start + 1;
            const trustedHtml = wantsTrustedHtml(req) && isTrustedHtmlPath(opened.realPath);
            if (range) {
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${opened.stats.size}`);
            }
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Disposition', contentDispositionHeader(opened.realPath));
            res.setHeader('Content-Length', String(contentLength));
            res.setHeader('Content-Security-Policy', trustedHtml ? FILE_RAW_TRUSTED_HTML_CSP : FILE_RAW_CSP);
            res.setHeader('Last-Modified', opened.stats.mtime.toUTCString());
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.type(path.extname(opened.realPath));
            if (req.method === 'HEAD') {
                await opened.handle.close();
                return res.end();
            }
            if (opened.stats.size === 0) {
                await opened.handle.close();
                return res.end();
            }
            const stream = opened.handle.createReadStream({ autoClose: true, start, end });
            res.on('close', () => {
                if (!res.writableEnded)
                    stream.destroy();
            });
            return pipeline(stream, res, (error) => {
                if (error && !res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            });
        }
        catch (error) {
            const statusCode = typeof error === 'object' && error !== null && typeof error.statusCode === 'number'
                ? error.statusCode
                : 400;
            return res.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
        }
    };
}
