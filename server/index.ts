import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { CodexAppServer } from './appServer.js';
import {
  createAuthToken,
  authCookie,
  authScopeFromHostHeader,
  hashToken,
  isTokenValid,
  parseTokenFromCookieScopes,
} from './auth.js';
import { attachBrowserSocket } from './browserSocket.js';
import { readConfig } from './config.js';
import { createFilePreviewHandler } from './filePreview.js';
import { resolveExistingPathInsideRoot, resolveWritablePathInsideRoot } from './fileTransfer.js';
import { HostStateStore } from './hostState.js';
import { configureLogger, logError, logInfo, logWarn } from './logger.js';
import { resolvePackageRoot, resolveStartCwd } from './paths.js';

const config = readConfig();
const packageRoot = resolvePackageRoot();
const startCwd = resolveStartCwd();
const safeHostname = config.hostname.replace(/[^A-Za-z0-9_.-]/g, '_');
const logFilePath = path.join(config.stateDir, `${safeHostname}.log`);
configureLogger({ filePath: logFilePath });
logInfo('Starting Codex Web UI server', {
  pid: process.pid,
  hostname: config.hostname,
  host: config.host,
  port: config.port,
  stateDir: config.stateDir,
  startCwd,
  logFilePath,
});

const app = express();
const server = http.createServer(app);
const stateStore = new HostStateStore(config.stateDir, config.hostname);
const token = createAuthToken();
const tokenHash = hashToken(token);
const fallbackAuthScope = `${config.hostname}:${config.port}`;

stateStore.update((state) => ({ ...state, authTokenHash: tokenHash }));

const codex = new CodexAppServer({ cwd: startCwd, mock: config.mock });
try {
  await codex.start();
} catch (error) {
  logError('Failed to start initial Codex app-server', error);
  throw error;
}
stateStore.update((state) => ({
  ...state,
  appServerUrl: codex.getUrl(),
  appServerPid: codex.getPid(),
}));

function authScopesForRequest(req: express.Request): string[] {
  const requestScope = authScopeFromHostHeader(req.headers.host, fallbackAuthScope) ?? fallbackAuthScope;
  return requestScope === fallbackAuthScope ? [fallbackAuthScope] : [requestScope, fallbackAuthScope];
}

function primaryAuthScopeForRequest(req: express.Request): string {
  return authScopesForRequest(req)[0];
}

function authorized(req: express.Request): boolean {
  if (config.noAuth) return true;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const cookieToken = parseTokenFromCookieScopes(req.headers.cookie, authScopesForRequest(req));
  return isTokenValid(token, queryToken) || isTokenValid(token, cookieToken);
}

function getQueryPath(req: express.Request): string | null {
  return typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : null;
}

function getActiveCwd(): string | null {
  return stateStore.read().activeCwd;
}

app.get('/api/file', createFilePreviewHandler({ authorized, getActiveCwd }));

app.get('/api/download', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const activeCwd = getActiveCwd();
  if (!activeCwd) return res.status(409).json({ error: 'no active cwd' });
  const filePath = getQueryPath(req);
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  try {
    const resolved = await resolveExistingPathInsideRoot(activeCwd, filePath);
    return res.download(resolved);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const activeCwd = getActiveCwd();
  if (!activeCwd) return res.status(409).json({ error: 'no active cwd' });
  const filePath = getQueryPath(req);
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  try {
    const resolved = await resolveWritablePathInsideRoot(activeCwd, filePath);
    await fs.promises.writeFile(resolved, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.use(express.json({ limit: '2mb' }));

app.get('/api/auth', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ authenticated: false });
  res.setHeader('Set-Cookie', authCookie(token, primaryAuthScopeForRequest(req)));
  res.json({ authenticated: true, hostname: config.hostname });
});

app.get('/api/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const appServerHealth = codex.health();
  res.json({
    hostname: config.hostname,
    appServerPid: codex.getPid(),
    appServerHealth,
    activeThreadId: stateStore.read().activeThreadId,
    noAuth: config.noAuth,
  });
});

const dist = path.join(packageRoot, 'dist');
const indexHtml = path.join(dist, 'index.html');
app.use(express.static(dist));
app.get('*', (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res.status(503).type('text/plain').send('Client bundle is missing. Run npm run build before serving UI routes.');
  }
  return res.sendFile(indexHtml);
});

const browserSockets = attachBrowserSocket(server, { config, codex, stateStore, token, authCookieScope: fallbackAuthScope, startCwd });

server.on('error', (err) => {
  logError('Browser server failed', err);
  browserSockets.close();
  codex.stop();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? (address as AddressInfo).port : config.port;
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  const url = `http://${host}:${port}${config.noAuth ? '' : `?token=${token}`}`;
  console.log(`[info] Open in browser: ${url}`);
  logInfo('Open in browser URL printed to stdout', { host: config.host, port, auth: config.noAuth ? 'disabled' : 'token-required' });
  logInfo('Codex Web UI server listening', { host: config.host, port, logFilePath });
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logWarn('Received shutdown signal', { signal, pid: process.pid });
  browserSockets.close();
  codex.stop();
  server.close(() => {
    logInfo('Browser server closed', { signal });
    process.exit(0);
  });
  setTimeout(() => {
    logWarn('Shutdown timed out', { signal });
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  }, 5000).unref();
}

process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection', reason);
});
process.on('exit', (code) => {
  logInfo('Codex Web UI process exiting', { code, pid: process.pid });
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
