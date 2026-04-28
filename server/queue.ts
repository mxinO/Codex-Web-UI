import crypto from 'node:crypto';
import type { CodexRunOptions, QueuedMessage } from './types.js';

function normalizeText(text: string): string {
  const next = text.trim();
  if (!next) throw new Error('queued message text is required');
  return next;
}

export function enqueueMessage(queue: QueuedMessage[], text: string, limit: number, options?: CodexRunOptions): QueuedMessage[] {
  if (queue.length >= limit) throw new Error(`queue limit reached (${limit})`);
  const next: QueuedMessage = { id: crypto.randomUUID(), text: normalizeText(text), createdAt: Date.now() };
  if (options && Object.keys(options).length > 0) next.options = options;
  return queue.concat(next);
}

export function removeQueuedMessage(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((message) => message.id !== id);
}

export function updateQueuedMessage(queue: QueuedMessage[], id: string, text: string): QueuedMessage[] {
  const nextText = normalizeText(text);
  return queue.map((message) => (message.id === id ? { ...message, text: nextText } : message));
}

export function shiftQueuedMessage(queue: QueuedMessage[]): { next: QueuedMessage | null; queue: QueuedMessage[] } {
  const [next, ...rest] = queue;
  return { next: next ?? null, queue: rest };
}
