import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLatestTurnRuntimeContext } from '../../server/turnRuntimeStatus.js';

const temporaryDirectories: string[] = [];

function temporaryRollout(contents: string | Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-webui-turn-runtime-'));
  temporaryDirectories.push(directory);
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, contents);
  return rolloutPath;
}

function turnContext(
  turnId: string,
  model: string,
  effort: string | null,
  timestamp: string,
): string {
  return JSON.stringify({
    timestamp,
    type: 'turn_context',
    payload: { turn_id: turnId, model, effort },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('readLatestTurnRuntimeContext', () => {
  it('returns the newest valid turn context using bounded backward reads', async () => {
    const rolloutPath = temporaryRollout([
      turnContext('turn-old', 'gpt-old', 'medium', '2026-06-30T01:00:00.000Z'),
      JSON.stringify({ type: 'event_msg', payload: { message: 'tail 界' } }),
      turnContext('turn-new', 'gpt-new', 'ultra', '2026-06-30T02:00:00.000Z'),
      JSON.stringify({ type: 'response_item', payload: { text: '最新' } }),
      '',
    ].join('\n'));

    await expect(readLatestTurnRuntimeContext(rolloutPath, { chunkBytes: 7, maxScanBytes: 4096 })).resolves.toMatchObject({
      status: 'found',
      context: {
        turnId: 'turn-new',
        model: 'gpt-new',
        effort: 'ultra',
        recordedAt: '2026-06-30T02:00:00.000Z',
      },
      scannedBytes: expect.any(Number),
    });
  });

  it('skips malformed and unrelated complete lines and ignores an incomplete tail', async () => {
    const valid = turnContext('turn-valid', 'gpt-5.5', null, '2026-06-30T03:00:00.000Z');
    const rolloutPath = temporaryRollout([
      valid,
      '{not-json}',
      JSON.stringify({ type: 'turn_context', payload: { model: 42, effort: 'high' } }),
      JSON.stringify({ type: 'event_msg', payload: { model: 'not-a-context' } }),
      turnContext('turn-incomplete', 'must-not-win', 'high', '2026-06-30T04:00:00.000Z'),
    ].join('\n'));

    await expect(readLatestTurnRuntimeContext(rolloutPath, { chunkBytes: 11 })).resolves.toMatchObject({
      status: 'found',
      context: {
        turnId: 'turn-valid',
        model: 'gpt-5.5',
        effort: null,
        recordedAt: '2026-06-30T03:00:00.000Z',
      },
    });
  });

  it('returns none without opening a file when the rollout path is null', async () => {
    await expect(readLatestTurnRuntimeContext(null)).resolves.toEqual({
      status: 'none',
      context: null,
      scannedBytes: 0,
    });
  });

  it('contains missing-file failures in an unavailable result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-webui-turn-runtime-missing-'));
    temporaryDirectories.push(directory);

    await expect(readLatestTurnRuntimeContext(join(directory, 'missing.jsonl'))).resolves.toMatchObject({
      status: 'unavailable',
      context: null,
      scannedBytes: 0,
      detail: expect.stringContaining('ENOENT'),
    });
  });

  it('fills backward chunks across legal partial file reads without skipping offsets', async () => {
    const rolloutPath = temporaryRollout([
      turnContext('turn-partial', 'gpt-partial', 'high', '2026-06-30T05:00:00.000Z'),
      JSON.stringify({ type: 'event_msg', payload: { text: 'complete tail' } }),
      '',
    ].join('\n'));
    const realHandle = await fs.open(rolloutPath, 'r');
    let closed = false;
    const partialHandle = {
      stat: () => realHandle.stat(),
      read: (buffer: Buffer, offset: number, length: number, position: number) => (
        realHandle.read(buffer, offset, Math.min(length, 3), position)
      ),
      close: async () => {
        closed = true;
        await realHandle.close();
      },
    } as unknown as Awaited<ReturnType<typeof fs.open>>;
    const openSpy = vi.spyOn(fs, 'open').mockResolvedValue(partialHandle);

    try {
      await expect(readLatestTurnRuntimeContext(rolloutPath, { chunkBytes: 32, maxScanBytes: 4096 })).resolves.toMatchObject({
        status: 'found',
        context: {
          turnId: 'turn-partial',
          model: 'gpt-partial',
          effort: 'high',
          recordedAt: '2026-06-30T05:00:00.000Z',
        },
      });
    } finally {
      openSpy.mockRestore();
      if (!closed) await realHandle.close();
    }
  });

  it('returns scanLimit when no complete context is found inside the byte bound', async () => {
    const oldContext = `${turnContext('turn-old', 'gpt-old', 'low', '2026-06-30T00:00:00.000Z')}\n`;
    const unrelatedTail = `${JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(256) } })}\n`;
    const rolloutPath = temporaryRollout(oldContext + unrelatedTail);

    await expect(readLatestTurnRuntimeContext(rolloutPath, { maxScanBytes: 64, chunkBytes: 16 })).resolves.toEqual({
      status: 'scanLimit',
      context: null,
      scannedBytes: 64,
    });
  });
});
