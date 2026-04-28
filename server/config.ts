import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  hostname: string;
  stateDir: string;
  noAuth: boolean;
  mock: boolean;
  queueLimit: number;
  commandTimeoutMs: number;
  commandOutputBytes: number;
}

export function readConfig(argv = process.argv.slice(2), env = process.env): ServerConfig {
  const getArg = (name: string): string | null => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] ?? null : null;
  };

  return {
    host: getArg('--host') ?? env.HOST ?? '127.0.0.1',
    port: Number(getArg('--port') ?? env.PORT ?? 3001),
    hostname: os.hostname(),
    stateDir: env.CODEX_WEB_UI_STATE_DIR ?? path.join(process.cwd(), 'data'),
    noAuth: argv.includes('--no-auth'),
    mock: argv.includes('--mock'),
    queueLimit: Number(env.CODEX_WEB_UI_QUEUE_LIMIT ?? 20),
    commandTimeoutMs: Number(env.CODEX_WEB_UI_COMMAND_TIMEOUT_MS ?? 30_000),
    commandOutputBytes: Number(env.CODEX_WEB_UI_COMMAND_OUTPUT_BYTES ?? 256_000),
  };
}
