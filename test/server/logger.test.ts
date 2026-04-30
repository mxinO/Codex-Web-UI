import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, logInfo, logWarn } from '../../server/logger.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  configureLogger({ filePath: null });
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('logger', () => {
  it('creates private log files and redacts auth tokens from file logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-log-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logPath = join(dir, 'server.log');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    configureLogger({ filePath: logPath });
    logInfo('Open http://127.0.0.1:8080?token=secret-token', {
      url: 'http://127.0.0.1:8080/?mode=x&token=secret-token',
      cookie: 'codex_web_ui_token=secret-token',
    });
    logWarn('request failed', new Error('GET /?token=secret-token failed'));

    const log = readFileSync(logPath, 'utf8');
    expect(log).not.toContain('secret-token');
    expect(log).toContain('token=<redacted>');
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
