import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { turnToTimelineItems, type TimelineItem } from '../lib/timeline';
import type { CodexItem, CodexTurn } from '../types/codex';

const PAGE_SIZE = 50;
const WINDOW_TURN_LIMIT = 200;

interface TurnListResult {
  data?: CodexTurn[];
  turns?: CodexTurn[];
  thread?: { turns?: CodexTurn[] };
  nextCursor?: string | null;
  next_cursor?: string | null;
}

function getNextCursor(result: TurnListResult): string | null {
  return result.nextCursor ?? result.next_cursor ?? null;
}

function normalizeTurns(turns: CodexTurn[]): TimelineItem[] {
  return turns.flatMap(turnToTimelineItems);
}

function trimNewestTurnWindow(turns: CodexTurn[], limit: number): CodexTurn[] {
  return turns.length <= limit ? turns : turns.slice(turns.length - limit);
}

function trimOldestTurnWindow(turns: CodexTurn[], limit: number): CodexTurn[] {
  return turns.length <= limit ? turns : turns.slice(0, limit);
}

function itemMergeKey(item: CodexItem, index: number): string {
  return typeof item.id === 'string' && item.id.trim() ? `id:${item.id}` : `index:${index}`;
}

function mergeTurnItems(current: CodexItem[], latest: CodexItem[], options: { replaceExisting: boolean }): CodexItem[] {
  if (current.length === 0) return latest;
  if (latest.length === 0) return current;

  const indexes = new Map<string, number>();
  const merged = [...current];
  merged.forEach((item, index) => indexes.set(itemMergeKey(item, index), index));

  latest.forEach((item, index) => {
    const key = itemMergeKey(item, index);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(item);
      return;
    }
    if (options.replaceExisting) merged[existingIndex] = item;
  });

  return merged;
}

function mergeTurn(current: CodexTurn, latest: CodexTurn): CodexTurn {
  const currentIsTerminal = current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted';
  const latestRegressedFromTerminal = currentIsTerminal && latest.status === 'inProgress';
  return {
    ...current,
    ...latest,
    status: latestRegressedFromTerminal ? current.status : latest.status,
    startedAt: latest.startedAt ?? current.startedAt,
    completedAt: latest.completedAt ?? current.completedAt,
    items: mergeTurnItems(current.items, latest.items, { replaceExisting: !latestRegressedFromTerminal }),
  };
}

function resultTurns(result: TurnListResult): CodexTurn[] {
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.turns)) return result.turns;
  if (Array.isArray(result.thread?.turns)) return result.thread.turns;
  return [];
}

function mergeLatestTurns(current: CodexTurn[], latest: CodexTurn[], limit: number): CodexTurn[] {
  if (latest.length === 0) return current;
  if (current.length === 0) return trimNewestTurnWindow(latest, limit);

  const indexes = new Map<string, number>();
  const next = [...current];
  next.forEach((turn, index) => indexes.set(turn.id, index));

  for (const turn of latest) {
    const existingIndex = indexes.get(turn.id);
    if (existingIndex === undefined) {
      indexes.set(turn.id, next.length);
      next.push(turn);
    } else {
      next[existingIndex] = mergeTurn(next[existingIndex], turn);
    }
  }

  return trimNewestTurnWindow(next, limit);
}

function mergeOlderTurns(current: CodexTurn[], older: CodexTurn[], limit: number): CodexTurn[] {
  if (older.length === 0) return current;
  const currentIds = new Set(current.map((turn) => turn.id));
  const merged = [...older.filter((turn) => !currentIds.has(turn.id)), ...current];
  return trimOldestTurnWindow(merged, limit);
}

export function useThreadTimeline(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>) {
  const activeThreadRef = useRef(activeThreadId);
  const requestGenerationRef = useRef(0);
  const [turns, setTurns] = useState<CodexTurn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isViewingLatest, setIsViewingLatest] = useState(true);
  activeThreadRef.current = activeThreadId;
  const items = useMemo<TimelineItem[]>(() => normalizeTurns(turns), [turns]);

  const isCurrentRequest = useCallback((threadId: string, generation: number) => {
    return activeThreadRef.current === threadId && requestGenerationRef.current === generation;
  }, []);

  const fetchLatest = useCallback(async (mode: 'merge' | 'replace') => {
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
      setTurns((current) => (mode === 'replace' ? latest : mergeLatestTurns(current, latest, WINDOW_TURN_LIMIT)));
      const nextCursor = getNextCursor(result);
      setCursor((currentCursor) => (mode === 'replace' || isViewingLatest ? nextCursor : currentCursor));
      if (mode === 'replace') setIsViewingLatest(true);
    } catch {
      if (!isCurrentRequest(threadId, generation)) return;
      // Keep the last successfully rendered timeline during transient transport or app-server failures.
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, isCurrentRequest, isViewingLatest, rpc]);

  const reload = useCallback(() => fetchLatest('merge'), [fetchLatest]);
  const jumpToLatest = useCallback(() => fetchLatest('replace'), [fetchLatest]);

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
      setTurns((current) => mergeOlderTurns(current, older, WINDOW_TURN_LIMIT));
      setCursor(getNextCursor(result));
      setIsViewingLatest(false);
    } catch {
      if (!isCurrentRequest(threadId, generation)) return;
      // Keep the current cursor so a transient older-page failure does not strand pagination.
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, cursor, isCurrentRequest, loading, rpc]);

  useEffect(() => {
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;
    setTurns([]);
    setCursor(null);
    setIsViewingLatest(true);

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
        setTurns(latest);
        setCursor(getNextCursor(result));
        setIsViewingLatest(true);
      })
      .catch(() => {
        if (!isCurrentRequest(threadId, generation)) return;
        // Initial load already reset this thread's display. Do not clear a newer successful result.
      })
      .finally(() => {
        if (isCurrentRequest(threadId, generation)) setLoading(false);
      });

    return () => {
      requestGenerationRef.current += 1;
    };
  }, [activeThreadId, isCurrentRequest, rpc]);

  return { items, loadOlder, hasOlder: Boolean(cursor), loading, reload, jumpToLatest, isViewingLatest };
}
