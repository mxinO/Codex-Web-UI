import { describe, expect, it } from 'vitest';
import { enqueueMessage, prependQueuedMessagesForThread, queueForThread, removeQueuedMessage, shiftQueuedMessage, updateQueuedMessage } from '../../server/queue.js';

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

  it('stores the owning thread with queued messages', () => {
    const queue = enqueueMessage([], 'next', 2, undefined, 'thread-1');
    expect(queue[0]).toMatchObject({ text: 'next', threadId: 'thread-1' });
  });

  it('enforces the queue limit globally across owning threads', () => {
    const queue = [
      { id: 'a', threadId: 'thread-2', text: 'other', createdAt: 1 },
      { id: 'b', threadId: 'thread-2', text: 'other again', createdAt: 2 },
    ];

    expect(() => enqueueMessage(queue, 'next', 2, undefined, 'thread-1')).toThrow(/queue limit/);
    expect(() => enqueueMessage(queue, 'blocked', 2, undefined, 'thread-2')).toThrow(/queue limit/);
  });

  it('keeps in-memory unowned queued messages compatible with the active thread', () => {
    const queue = [
      { id: 'legacy', text: 'old queued prompt', createdAt: 1 },
      { id: 'current', threadId: 'thread-1', text: 'current thread prompt', createdAt: 2 },
    ];

    expect(queueForThread(queue, 'thread-1')).toEqual(queue);
  });

  it('removes queued message by id', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(removeQueuedMessage(queue, 'a')).toEqual([]);
  });

  it('does not remove queued messages from another thread', () => {
    const queue = [
      { id: 'a', threadId: 'thread-2', text: 'other', createdAt: 1 },
      { id: 'b', threadId: 'thread-1', text: 'current', createdAt: 2 },
    ];

    expect(removeQueuedMessage(queue, 'a', 'thread-1')).toEqual(queue);
  });

  it('updates queued message text', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(updateQueuedMessage(queue, 'a', 'edited')[0].text).toBe('edited');
  });

  it('does not update queued messages from another thread', () => {
    const queue = [
      { id: 'a', threadId: 'thread-2', text: 'other', createdAt: 1 },
      { id: 'b', threadId: 'thread-1', text: 'current', createdAt: 2 },
    ];

    expect(updateQueuedMessage(queue, 'a', 'edited', 'thread-1')).toEqual(queue);
  });

  it('shifts next queued message', () => {
    const queue = [{ id: 'a', text: 'hello', createdAt: 1 }];
    expect(shiftQueuedMessage(queue)).toEqual({ next: queue[0], queue: [] });
  });

  it('shifts only messages for the requested thread', () => {
    const queue = [
      { id: 'legacy', text: 'old queued prompt', createdAt: 0 },
      { id: 'a', threadId: 'thread-2', text: 'other', createdAt: 1 },
      { id: 'b', threadId: 'thread-1', text: 'current', createdAt: 2 },
    ];

    expect(shiftQueuedMessage(queue, 'thread-1')).toEqual({
      next: queue[0],
      queue: [queue[1], queue[2]],
    });
  });

  it('keeps maybe-sent queued messages visible but skips them for runnable shifts', () => {
    const queue = [
      { id: 'maybe', threadId: 'thread-1', text: 'maybe sent', createdAt: 1, deliveryState: 'maybeSent' as const },
      { id: 'next', threadId: 'thread-1', text: 'next', createdAt: 2 },
    ];

    expect(queueForThread(queue, 'thread-1')).toEqual(queue);
    expect(queueForThread(queue, 'thread-1', { runnableOnly: true })).toEqual([queue[1]]);
    expect(shiftQueuedMessage(queue, 'thread-1', { runnableOnly: true })).toEqual({
      next: queue[1],
      queue: [queue[0]],
    });
  });

  it('makes an edited maybe-sent queued message runnable again', () => {
    const queue = [{ id: 'maybe', threadId: 'thread-1', text: 'maybe sent', createdAt: 1, deliveryState: 'maybeSent' as const }];

    expect(updateQueuedMessage(queue, 'maybe', 'send again', 'thread-1')).toEqual([
      { id: 'maybe', threadId: 'thread-1', text: 'send again', createdAt: 1, deliveryState: undefined },
    ]);
  });

  it('globally bounds prepended restored messages across owning threads', () => {
    const queue = [
      { id: 'thread-1-old', threadId: 'thread-1', text: 'old current', createdAt: 1 },
      { id: 'thread-2-a', threadId: 'thread-2', text: 'other first', createdAt: 2 },
      { id: 'thread-1-new', threadId: 'thread-1', text: 'new current', createdAt: 3 },
      { id: 'thread-2-b', threadId: 'thread-2', text: 'other second', createdAt: 4 },
    ];
    const restored = { id: 'thread-1-restored', text: 'restored current', createdAt: 5 };

    expect(prependQueuedMessagesForThread(queue, 'thread-1', [restored], 2)).toEqual([
      { ...restored, threadId: 'thread-1' },
      { id: 'thread-1-old', threadId: 'thread-1', text: 'old current', createdAt: 1 },
    ]);
  });
});
