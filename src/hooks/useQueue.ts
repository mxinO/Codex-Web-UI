import { useCallback, useMemo, useState } from 'react';

export interface ClientQueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

export function useQueue(rpc: <T>(method: string, params?: unknown) => Promise<T>, initialQueue: ClientQueuedMessage[] = []) {
  const [queue, setQueue] = useState<ClientQueuedMessage[]>(initialQueue);

  const enqueue = useCallback(
    async (text: string) => {
      const next = await rpc<ClientQueuedMessage[]>('webui/queue/enqueue', { text });
      setQueue(next);
    },
    [rpc],
  );

  const remove = useCallback(
    async (id: string) => {
      const next = await rpc<ClientQueuedMessage[]>('webui/queue/remove', { id });
      setQueue(next);
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
