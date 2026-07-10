import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { normalizeQueueLimit } from './queue.js';
export function resolveCodexSqliteHome(stateDir, hostname, env = process.env) {
    const override = env.CODEX_WEB_UI_CODEX_SQLITE_HOME?.trim();
    const readableHostname = hostname.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'host';
    const hostnameDigest = createHash('sha256').update(hostname).digest('hex').slice(0, 16);
    return path.resolve(override || path.join(stateDir, 'codex-sqlite', `${readableHostname}-${hostnameDigest}`));
}
export function readConfig(argv = process.argv.slice(2), env = process.env) {
    const getArg = (name) => {
        const idx = argv.indexOf(name);
        return idx >= 0 ? argv[idx + 1] ?? null : null;
    };
    return {
        host: getArg('--host') ?? env.HOST ?? '127.0.0.1',
        port: Number(getArg('--port') ?? env.PORT ?? 3001),
        hostname: os.hostname(),
        stateDir: getArg('--state-dir') ?? env.CODEX_WEB_UI_STATE_DIR ?? path.join(process.cwd(), 'data'),
        noAuth: argv.includes('--no-auth'),
        mock: argv.includes('--mock'),
        queueLimit: normalizeQueueLimit(Number(env.CODEX_WEB_UI_QUEUE_LIMIT ?? 20)),
        commandTimeoutMs: Number(env.CODEX_WEB_UI_COMMAND_TIMEOUT_MS ?? 30_000),
        commandOutputBytes: Number(env.CODEX_WEB_UI_COMMAND_OUTPUT_BYTES ?? 256_000),
    };
}
