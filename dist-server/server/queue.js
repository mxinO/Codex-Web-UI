import crypto from 'node:crypto';
function normalizeText(text) {
    const next = text.trim();
    if (!next)
        throw new Error('queued message text is required');
    return next;
}
export function enqueueMessage(queue, text, limit, options) {
    if (queue.length >= limit)
        throw new Error(`queue limit reached (${limit})`);
    const next = { id: crypto.randomUUID(), text: normalizeText(text), createdAt: Date.now() };
    if (options && Object.keys(options).length > 0)
        next.options = options;
    return queue.concat(next);
}
export function removeQueuedMessage(queue, id) {
    return queue.filter((message) => message.id !== id);
}
export function updateQueuedMessage(queue, id, text) {
    const nextText = normalizeText(text);
    return queue.map((message) => (message.id === id ? { ...message, text: nextText } : message));
}
export function shiftQueuedMessage(queue) {
    const [next, ...rest] = queue;
    return { next: next ?? null, queue: rest };
}
