import { useCallback, useMemo, useState } from 'react';
import type { CodexRunOptions } from '../types/ui';

export interface ClientQueuedMessage {
  id: string;
  threadId?: string;
  text: string;
  createdAt: number;
  deliveryState?: 'maybeSent';
  options?: Partial<CodexRunOptions>;
}

export interface QueueRemoveResult {
  queue: ClientQueuedMessage[];
  removed: boolean;
}

export function useQueue(rpc: <T>(method: string, params?: unknown) => Promise<T>, initialQueue: ClientQueuedMessage[] = []) {
  const [queue, setQueue] = useState<ClientQueuedMessage[]>(initialQueue);

  const enqueue = useCallback(
    async (text: string, options?: CodexRunOptions, threadId?: string | null) => {
      const next = await rpc<ClientQueuedMessage[]>('webui/queue/enqueue', { text, options, threadId });
      setQueue(next);
    },
    [rpc],
  );

  const remove = useCallback(
    async (id: string, beforeReplace?: (result: QueueRemoveResult) => void) => {
      const result = await rpc<QueueRemoveResult>('webui/queue/remove', { id, includeStatus: true });
      beforeReplace?.(result);
      setQueue(result.queue);
      return result;
    },
    [rpc],
  );

  const update = useCallback(
    async (id: string, text: string) => {
      const next = await rpc<ClientQueuedMessage[]>('webui/queue/update', { id, text });
      setQueue(next);
    },
    [rpc],
  );

  const replace = useCallback((next: ClientQueuedMessage[]) => setQueue(next), []);

  return useMemo(() => ({ queue, enqueue, remove, update, replace }), [enqueue, queue, remove, replace, update]);
}
