import crypto from 'node:crypto';
export const DEFAULT_QUEUE_LIMIT = 20;
export function normalizeQueueLimit(limit) {
    if (!Number.isFinite(limit) || limit <= 0)
        return DEFAULT_QUEUE_LIMIT;
    const normalized = Math.floor(limit);
    return normalized > 0 ? normalized : DEFAULT_QUEUE_LIMIT;
}
function normalizeText(text) {
    const next = text.trim();
    if (!next)
        throw new Error('queued message text is required');
    return next;
}
function queueMessageMatchesThread(message, threadId) {
    if (!threadId)
        return !message.threadId;
    return !message.threadId || message.threadId === threadId;
}
function queuedMessageMatchesFilter(message, threadId, options = {}) {
    if (!queueMessageMatchesThread(message, threadId))
        return false;
    return !options.runnableOnly || message.deliveryState !== 'maybeSent';
}
export function queueForThread(queue, threadId, options = {}) {
    return queue.filter((message) => queuedMessageMatchesFilter(message, threadId, options));
}
export function enqueueMessage(queue, text, limit, options, threadId) {
    const maxItems = normalizeQueueLimit(limit);
    if (queue.length >= maxItems)
        throw new Error(`queue limit reached (${maxItems})`);
    const next = { id: crypto.randomUUID(), text: normalizeText(text), createdAt: Date.now() };
    if (threadId)
        next.threadId = threadId;
    if (options && Object.keys(options).length > 0)
        next.options = options;
    return queue.concat(next);
}
export function removeQueuedMessage(queue, id, threadId) {
    return queue.filter((message) => message.id !== id || !queueMessageMatchesThread(message, threadId));
}
export function updateQueuedMessage(queue, id, text, threadId) {
    const nextText = normalizeText(text);
    return queue.map((message) => (message.id === id && queueMessageMatchesThread(message, threadId)
        ? { ...message, text: nextText, deliveryState: undefined }
        : message));
}
export function shiftQueuedMessage(queue, threadId, options = {}) {
    const index = queue.findIndex((message) => queuedMessageMatchesFilter(message, threadId, options));
    if (index < 0)
        return { next: null, queue };
    return { next: queue[index], queue: [...queue.slice(0, index), ...queue.slice(index + 1)] };
}
export function prependQueuedMessagesForThread(queue, threadId, messages, limit) {
    const maxItems = normalizeQueueLimit(limit);
    const existingIds = new Set(queue.map((message) => message.id));
    const restoredIds = new Set();
    const restoredMessages = messages
        .filter((message) => {
        if (existingIds.has(message.id) || restoredIds.has(message.id))
            return false;
        if (message.threadId && message.threadId !== threadId)
            return false;
        restoredIds.add(message.id);
        return true;
    })
        .map((message) => (message.threadId === threadId ? message : { ...message, threadId }));
    return [...restoredMessages, ...queue].slice(0, maxItems);
}
