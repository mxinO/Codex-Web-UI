import { describe, expect, it } from 'vitest';
import { CodexBackfillBusyStartupError } from '../../server/appServer.js';
import { startCodexWithBackfillRetry } from '../../server/codexStartup.js';

describe('startCodexWithBackfillRetry', () => {
  it('retries only the transient Codex backfill lease failure', async () => {
    let attempts = 0;
    let elapsedMs = 0;

    await startCodexWithBackfillRetry(
      {
        start: async () => {
          attempts++;
          if (attempts < 3) throw new CodexBackfillBusyStartupError('backfill busy');
        },
      },
      {
        now: () => elapsedMs,
        sleep: async (delayMs) => {
          elapsedMs += delayMs;
        },
      },
    );

    expect(attempts).toBe(3);
    expect(elapsedMs).toBe(60_000);
  });

  it('does not retry unrelated startup failures', async () => {
    let attempts = 0;

    await expect(
      startCodexWithBackfillRetry({
        start: async () => {
          attempts++;
          throw new Error('invalid config');
        },
      }),
    ).rejects.toThrow('invalid config');

    expect(attempts).toBe(1);
  });

  it('stops retrying after the bounded recovery window', async () => {
    let elapsedMs = 0;
    let attempts = 0;

    await expect(
      startCodexWithBackfillRetry(
        {
          start: async () => {
            attempts++;
            throw new CodexBackfillBusyStartupError('backfill busy');
          },
        },
        {
          retryWindowMs: 60_000,
          now: () => elapsedMs,
          sleep: async (delayMs) => {
            elapsedMs += delayMs;
          },
        },
      ),
    ).rejects.toThrow('backfill busy');

    expect(attempts).toBe(2);
    expect(elapsedMs).toBe(60_000);
  });
});
