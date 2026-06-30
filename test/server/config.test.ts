import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../server/config.js';
import { HostStateStore } from '../../server/hostState.js';
import { enqueueMessage, prependQueuedMessagesForThread } from '../../server/queue.js';

const DEFAULT_QUEUE_LIMIT = 20;
const invalidQueueLimits = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];

function queueOfLength(length: number) {
  return Array.from({ length }, (_, index) => ({
    id: `message-${index}`,
    threadId: `thread-${index}`,
    text: `message ${index}`,
    createdAt: index,
  }));
}

describe('readConfig', () => {
  it('accepts a state directory from argv', () => {
    expect(readConfig(['--state-dir', '/tmp/codex-web-ui-state'], {}).stateDir).toBe('/tmp/codex-web-ui-state');
  });

  it('keeps the environment state directory fallback', () => {
    expect(readConfig([], { CODEX_WEB_UI_STATE_DIR: '/tmp/env-state' }).stateDir).toBe('/tmp/env-state');
  });

  it.each(['NaN', 'Infinity', '-Infinity', '0', '-1'])(
    'uses the safe default for invalid CODEX_WEB_UI_QUEUE_LIMIT=%s',
    (value) => {
      expect(readConfig([], { CODEX_WEB_UI_QUEUE_LIMIT: value }).queueLimit).toBe(DEFAULT_QUEUE_LIMIT);
    },
  );

  it('floors a positive fractional queue limit', () => {
    expect(readConfig([], { CODEX_WEB_UI_QUEUE_LIMIT: '2.9' }).queueLimit).toBe(2);
  });

  it('uses the safe default for a positive queue limit below one', () => {
    expect(readConfig([], { CODEX_WEB_UI_QUEUE_LIMIT: '0.5' }).queueLimit).toBe(DEFAULT_QUEUE_LIMIT);
  });

  it.each(invalidQueueLimits)('defensively bounds queue helpers for invalid limit %s', (limit) => {
    const fullQueue = queueOfLength(DEFAULT_QUEUE_LIMIT);

    expect(() => enqueueMessage(fullQueue, 'next', limit, undefined, 'new-thread')).toThrow(
      `queue limit reached (${DEFAULT_QUEUE_LIMIT})`,
    );
    expect(prependQueuedMessagesForThread([...fullQueue, ...queueOfLength(5)], 'new-thread', [], limit)).toHaveLength(
      DEFAULT_QUEUE_LIMIT,
    );
  });

  it('defensively floors fractional queue helper limits', () => {
    const queue = queueOfLength(2);

    expect(() => enqueueMessage(queue, 'next', 2.9, undefined, 'new-thread')).toThrow('queue limit reached (2)');
    expect(prependQueuedMessagesForThread([...queue, queueOfLength(1)[0]], 'new-thread', [], 2.9)).toEqual(queue);
  });

  it.each([...invalidQueueLimits, 0.5])('defensively defaults HostStateStore invalid maxQueueItems %s', (maxQueueItems) => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-config-'));
    try {
      const store = new HostStateStore(dir, 'login-node', { maxQueueItems });
      store.write({ ...store.read(), queue: queueOfLength(DEFAULT_QUEUE_LIMIT + 5) });

      expect(store.read().queue).toHaveLength(DEFAULT_QUEUE_LIMIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defensively floors HostStateStore fractional maxQueueItems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-config-'));
    try {
      const store = new HostStateStore(dir, 'login-node', { maxQueueItems: 2.9 });
      store.write({ ...store.read(), queue: queueOfLength(3) });

      expect(store.read().queue.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
