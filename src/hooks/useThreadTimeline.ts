import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { turnToTimelineItems, type TimelineItem } from '../lib/timeline';
import type { CodexItem, CodexTurn } from '../types/codex';

const PAGE_SIZE = 12;
const WINDOW_TURN_LIMIT = 120;
const THREAD_TURNS_LIST_TIMEOUT_MS = 2 * 60 * 1000;
const INITIAL_LOAD_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000];

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

function isTerminalTurnStatus(status: CodexTurn['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function isAgentMessageItem(item: CodexItem): item is Extract<CodexItem, { type: 'agentMessage' }> {
  return item.type === 'agentMessage' && typeof (item as { text?: unknown }).text === 'string';
}

function isFinalAgentMessageItem(item: CodexItem): boolean {
  if (!isAgentMessageItem(item)) return false;
  return item.phase === null || item.phase === 'final_answer' || item.phase === 'final';
}

function normalizedMessageText(text: string): string {
  return text.trim().replace(/\r\n/g, '\n');
}

function messageCovers(candidateText: string, coveringText: string): boolean {
  const candidate = normalizedMessageText(candidateText);
  const covering = normalizedMessageText(coveringText);
  if (!candidate || !covering) return false;
  if (candidate === covering) return true;
  return covering.length > candidate.length && covering.startsWith(candidate);
}

function finalAgentMessageCovers(candidate: CodexItem, covering: CodexItem): boolean {
  if (!isAgentMessageItem(candidate) || !isFinalAgentMessageItem(candidate)) return false;
  if (!isAgentMessageItem(covering) || !isFinalAgentMessageItem(covering)) return false;
  return messageCovers(candidate.text, covering.text);
}

function latestItemCoveredByCurrent(item: CodexItem, current: CodexItem[]): boolean {
  return current.some((candidate) => finalAgentMessageCovers(item, candidate));
}

function removeCurrentItemsCoveredByLatest(current: CodexItem[], latest: CodexItem[]): CodexItem[] {
  const currentKeys = new Set(current.map(itemMergeKey));
  const consumedLatestIndexes = new Set<number>();
  return current.filter((item) => {
    const coveringIndex = latest.findIndex((candidate, index) => {
      if (consumedLatestIndexes.has(index)) return false;
      if (currentKeys.has(itemMergeKey(candidate, index))) return false;
      return finalAgentMessageCovers(item, candidate);
    });
    if (coveringIndex < 0) return true;
    consumedLatestIndexes.add(coveringIndex);
    return false;
  });
}

function mergeTurnItems(
  current: CodexItem[],
  latest: CodexItem[],
  options: { replaceExisting: boolean; removeCurrentCoveredByLatest: boolean; skipLatestCoveredByCurrent: boolean },
): CodexItem[] {
  if (current.length === 0) return latest;
  if (latest.length === 0) return current;

  const indexes = new Map<string, number>();
  const baseCurrent = options.removeCurrentCoveredByLatest ? removeCurrentItemsCoveredByLatest(current, latest) : current;
  const merged = [...baseCurrent];
  merged.forEach((item, index) => indexes.set(itemMergeKey(item, index), index));

  latest.forEach((item, index) => {
    const key = itemMergeKey(item, index);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      if (options.skipLatestCoveredByCurrent && latestItemCoveredByCurrent(item, current)) return;
      indexes.set(key, merged.length);
      merged.push(item);
      return;
    }
    if (options.replaceExisting) merged[existingIndex] = item;
  });

  return merged;
}

function mergeTurn(current: CodexTurn, latest: CodexTurn): CodexTurn {
  const currentIsTerminal = isTerminalTurnStatus(current.status);
  const latestIsTerminal = isTerminalTurnStatus(latest.status);
  const latestRegressedFromTerminal = currentIsTerminal && latest.status === 'inProgress';
  return {
    ...current,
    ...latest,
    status: latestRegressedFromTerminal ? current.status : latest.status,
    startedAt: latest.startedAt ?? current.startedAt,
    completedAt: latest.completedAt ?? current.completedAt,
    items: mergeTurnItems(current.items, latest.items, {
      replaceExisting: !latestRegressedFromTerminal,
      removeCurrentCoveredByLatest: latestIsTerminal,
      skipLatestCoveredByCurrent: latestRegressedFromTerminal,
    }),
  };
}

function resultTurns(result: TurnListResult): CodexTurn[] {
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.turns)) return result.turns;
  if (Array.isArray(result.thread?.turns)) return result.thread.turns;
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnListRequestParams(threadId: string, threadPath: string | null, cursor: string | null) {
  const params: { threadId: string; threadPath?: string; limit: number; sortDirection: 'desc'; cursor: string | null } = {
    threadId,
    limit: PAGE_SIZE,
    sortDirection: 'desc',
    cursor,
  };
  if (threadPath) params.threadPath = threadPath;
  return params;
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

export function useThreadTimeline(
  activeThreadId: string | null,
  activeThreadPath: string | null,
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>,
) {
  const activeThreadRef = useRef(activeThreadId);
  const activeThreadPathRef = useRef(activeThreadPath);
  const isViewingLatestRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const initialRetryTimerRef = useRef<number | null>(null);
  const initialRetryAttemptRef = useRef(0);
  const [turns, setTurns] = useState<CodexTurn[]>([]);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryScheduled, setRetryScheduled] = useState(false);
  const [isViewingLatest, setIsViewingLatest] = useState(true);
  activeThreadRef.current = activeThreadId;
  activeThreadPathRef.current = activeThreadPath;
  isViewingLatestRef.current = isViewingLatest;
  const items = useMemo<TimelineItem[]>(
    () => (activeThreadId && loadedThreadId === activeThreadId ? normalizeTurns(turns) : []),
    [activeThreadId, loadedThreadId, turns],
  );
  const hasLoadedActiveThread = Boolean(activeThreadId && loadedThreadId === activeThreadId);
  const activeCursor = hasLoadedActiveThread ? cursor : null;
  const timelineLoading = loading || Boolean(activeThreadId && !hasLoadedActiveThread && !loadError);

  const isCurrentRequest = useCallback((threadId: string, generation: number) => {
    return activeThreadRef.current === threadId && requestGenerationRef.current === generation;
  }, []);

  const clearInitialRetryTimer = useCallback(() => {
    if (initialRetryTimerRef.current === null) return;
    window.clearTimeout(initialRetryTimerRef.current);
    initialRetryTimerRef.current = null;
  }, []);

  const fetchLatestPage = useCallback(
    (threadId: string) =>
      rpc<TurnListResult>(
        'thread/turns/list',
        turnListRequestParams(threadId, activeThreadPathRef.current, null),
        THREAD_TURNS_LIST_TIMEOUT_MS,
      ),
    [rpc],
  );

  const fetchLatest = useCallback(async (mode: 'merge' | 'replace') => {
    if (!activeThreadId) return;
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;

    clearInitialRetryTimer();
    setLoading(true);
    setLoadError(null);
    setRetryScheduled(false);
    try {
      const result = await fetchLatestPage(threadId);
      if (!isCurrentRequest(threadId, generation)) return;
      const latest = [...resultTurns(result)].reverse();
      setTurns((current) => (mode === 'replace' ? latest : mergeLatestTurns(current, latest, WINDOW_TURN_LIMIT)));
      setLoadedThreadId(threadId);
      const nextCursor = getNextCursor(result);
      setCursor((currentCursor) => (mode === 'replace' || isViewingLatestRef.current ? nextCursor : currentCursor));
      if (mode === 'replace') setIsViewingLatest(true);
      setLoadError(null);
    } catch (error) {
      if (!isCurrentRequest(threadId, generation)) return;
      setLoadError(errorMessage(error));
      // Keep the last successfully rendered timeline during transient transport or app-server failures.
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, clearInitialRetryTimer, fetchLatestPage, isCurrentRequest]);

  const reload = useCallback(() => fetchLatest('merge'), [fetchLatest]);
  const jumpToLatest = useCallback(() => fetchLatest('replace'), [fetchLatest]);

  const loadOlder = useCallback(async () => {
    if (!activeThreadId || loadedThreadId !== activeThreadId || !cursor || loading) return;
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;
    const requestCursor = cursor;

    setLoading(true);
    try {
      const result = await rpc<TurnListResult>(
        'thread/turns/list',
        turnListRequestParams(threadId, activeThreadPathRef.current, requestCursor),
        THREAD_TURNS_LIST_TIMEOUT_MS,
      );
      if (!isCurrentRequest(threadId, generation)) return;
      const older = [...resultTurns(result)].reverse();
      setTurns((current) => mergeOlderTurns(current, older, WINDOW_TURN_LIMIT));
      setLoadedThreadId(threadId);
      setCursor(getNextCursor(result));
      setIsViewingLatest(false);
    } catch {
      if (!isCurrentRequest(threadId, generation)) return;
      // Keep the current cursor so a transient older-page failure does not strand pagination.
    } finally {
      if (isCurrentRequest(threadId, generation)) setLoading(false);
    }
  }, [activeThreadId, cursor, isCurrentRequest, loadedThreadId, loading, rpc]);

  useEffect(() => {
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;
    clearInitialRetryTimer();
    initialRetryAttemptRef.current = 0;
    setTurns([]);
    setLoadedThreadId(null);
    setCursor(null);
    setLoadError(null);
    setRetryScheduled(false);
    setIsViewingLatest(true);

    if (!threadId) {
      setLoading(false);
      return;
    }

    const loadInitial = () => {
      setLoading(true);
      setRetryScheduled(false);
      void fetchLatestPage(threadId)
      .then((result) => {
        if (!isCurrentRequest(threadId, generation)) return;
        const latest = [...resultTurns(result)].reverse();
        setTurns(latest);
        setLoadedThreadId(threadId);
        setCursor(getNextCursor(result));
        setLoadError(null);
        setRetryScheduled(false);
        initialRetryAttemptRef.current = 0;
        setIsViewingLatest(true);
      })
      .catch((error) => {
        if (!isCurrentRequest(threadId, generation)) return;
        setLoadError(errorMessage(error));
        const delay = INITIAL_LOAD_RETRY_DELAYS_MS[initialRetryAttemptRef.current];
        if (delay === undefined) {
          setRetryScheduled(false);
          return;
        }
        initialRetryAttemptRef.current += 1;
        clearInitialRetryTimer();
        setRetryScheduled(true);
        initialRetryTimerRef.current = window.setTimeout(() => {
          initialRetryTimerRef.current = null;
          if (isCurrentRequest(threadId, generation)) loadInitial();
        }, delay);
      })
      .finally(() => {
        if (isCurrentRequest(threadId, generation)) setLoading(false);
      });
    };

    loadInitial();

    return () => {
      clearInitialRetryTimer();
      requestGenerationRef.current += 1;
    };
  }, [activeThreadId, clearInitialRetryTimer, fetchLatestPage, isCurrentRequest]);

  return {
    items,
    loadOlder,
    hasOlder: Boolean(activeCursor),
    loading: timelineLoading,
    loadError,
    retryScheduled,
    reload,
    jumpToLatest,
    isViewingLatest,
  };
}
