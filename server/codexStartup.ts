import type { CodexAppServer } from './appServer.js';
import { isCodexBackfillBusyStartupError } from './appServer.js';
import { logWarn } from './logger.js';

const DEFAULT_BACKFILL_RETRY_DELAY_MS = 30_000;
const DEFAULT_BACKFILL_RETRY_WINDOW_MS = 20 * 60_000;

interface BackfillRetryOptions {
  retryDelayMs?: number;
  retryWindowMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function startCodexWithBackfillRetry(
  codex: Pick<CodexAppServer, 'start'>,
  options: BackfillRetryOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_BACKFILL_RETRY_DELAY_MS;
  const deadline = now() + (options.retryWindowMs ?? DEFAULT_BACKFILL_RETRY_WINDOW_MS);
  let lastBackfillError: Error | null = null;

  for (;;) {
    if (lastBackfillError && now() >= deadline) throw lastBackfillError;
    try {
      await codex.start();
      return;
    } catch (error) {
      const remainingMs = deadline - now();
      if (!isCodexBackfillBusyStartupError(error) || remainingMs <= 0) throw error;
      lastBackfillError = error;
      const delayMs = Math.min(retryDelayMs, remainingMs);
      logWarn('Codex state backfill is already running; retrying app-server startup', { delayMs, remainingMs });
      await wait(delayMs);
    }
  }
}
