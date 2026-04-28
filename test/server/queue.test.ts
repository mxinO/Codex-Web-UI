import { describe, expect, it } from 'vitest';
import { enqueueMessage, removeQueuedMessage, shiftQueuedMessage, updateQueuedMessage } from '../../server/queue.js';

describe('queue helpers', () => {
  it('enforces queue limit', () => {
    const queue = Array.from({ length: 2 }, (_, i) => ({ id: String(i), text: String(i), createdAt: i }));
    expect(() => enqueueMessage(queue, 'next', 2)).toThrow(/queue limit/);
  });

  it('stores run options with queued messages', () => {
    const queue = enqueueMessage([], 'next', 2, { model: 'gpt-5.5', effort: 'high', sandbox: 'workspace-write' });
    expect(queue[0]).toMatchObject({
      text: 'next',
      options: { model: 'gpt-5.5', effort: 'high', sandbox: 'workspace-write' },
    });
  });

  it('removes queued message by id', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(removeQueuedMessage(queue, 'a')).toEqual([]);
  });

  it('updates queued message text', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(updateQueuedMessage(queue, 'a', 'edited')[0].text).toBe('edited');
  });

  it('shifts next queued message', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(shiftQueuedMessage(queue)).toEqual({ next: queue[0], queue: [] });
  });
});
