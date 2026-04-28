import crypto from 'node:crypto';
import type { QueuedMessage } from './types.js';

function normalizeText(text: string): string {
  const next = text.trim();
  if (!next) throw new Error('queued message text is required');
  return next;
}

export function enqueueMessage(queue: QueuedMessage[], text: string, limit: number): QueuedMessage[] {
  if (queue.length >= limit) throw new Error(`queue limit reached (${limit})`);
  return queue.concat({ id: crypto.randomUUID(), text: normalizeText(text), createdAt: Date.now() });
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
