import { useCallback, useEffect, useRef, useState } from 'react';
import { trimTimelineWindow, turnToTimelineItems, type TimelineItem } from '../lib/timeline';
import type { CodexTurn } from '../types/codex';

const PAGE_SIZE = 50;
const WINDOW_SIZE = 200;

interface TurnListResult {
  data: CodexTurn[];
  nextCursor?: string | null;
  next_cursor?: string | null;
}

function getNextCursor(result: TurnListResult): string | null {
  return result.nextCursor ?? result.next_cursor ?? null;
}

function normalizeTurns(turns: CodexTurn[]): TimelineItem[] {
  return turns.flatMap(turnToTimelineItems);
}

function resultTurns(result: TurnListResult): CodexTurn[] {
  return Array.isArray(result.data) ? result.data : [];
}

export function useThreadTimeline(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>) {
  const activeThreadRef = useRef(activeThreadId);
  const requestGenerationRef = useRef(0);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  activeThreadRef.current = activeThreadId;

  const isCurrentRequest = useCallback((threadId: string, generation: number) => {
    return activeThreadRef.current === threadId && requestGenerationRef.current === generation;
  }, []);

  const loadLatest = useCallback(async () => {
    if (!activeThreadId) return;
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;

    setLoading(true);
    try {
      const result = await rpc<TurnListResult>('thread/turns/list', {
        threadId,
        limit: PAGE_SIZE,
        sortDirection: 'desc',
        cursor: null,
      });
      if (!isCurrentRequest(threadId, generation)) return;
      const latest = [...resultTurns(result)].reverse();
      setItems(trimTimelineWindow(normalizeTurns(latest), WINDOW_SIZE));
      setCursor(getNextCursor(result));
    } catch {
      if (!isCurrentRequest(threadId, generation)) return;
      setItems([]);
      setCursor(null);
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, isCurrentRequest, rpc]);

  const loadOlder = useCallback(async () => {
    if (!activeThreadId || !cursor || loading) return;
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;
    const requestCursor = cursor;

    setLoading(true);
    try {
      const result = await rpc<TurnListResult>('thread/turns/list', {
        threadId,
        limit: PAGE_SIZE,
        sortDirection: 'desc',
        cursor: requestCursor,
      });
      if (!isCurrentRequest(threadId, generation)) return;
      const older = [...resultTurns(result)].reverse();
      setItems(trimTimelineWindow(normalizeTurns(older), WINDOW_SIZE));
      setCursor(getNextCursor(result));
    } catch {
      if (!isCurrentRequest(threadId, generation)) return;
      setCursor(null);
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, cursor, isCurrentRequest, loading, rpc]);

  useEffect(() => {
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;
    setItems([]);
    setCursor(null);

    if (!threadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void rpc<TurnListResult>('thread/turns/list', {
      threadId,
      limit: PAGE_SIZE,
      sortDirection: 'desc',
      cursor: null,
    })
      .then((result) => {
        if (!isCurrentRequest(threadId, generation)) return;
        const latest = [...resultTurns(result)].reverse();
        setItems(trimTimelineWindow(normalizeTurns(latest), WINDOW_SIZE));
        setCursor(getNextCursor(result));
      })
      .catch(() => {
        if (!isCurrentRequest(threadId, generation)) return;
        setItems([]);
        setCursor(null);
      })
      .finally(() => {
        if (isCurrentRequest(threadId, generation)) setLoading(false);
      });

    return () => {
      requestGenerationRef.current += 1;
    };
  }, [activeThreadId, isCurrentRequest, rpc]);

  const jumpToLatest = loadLatest;

  return { items, loadOlder, hasOlder: Boolean(cursor), loading, reload: loadLatest, jumpToLatest };
}
