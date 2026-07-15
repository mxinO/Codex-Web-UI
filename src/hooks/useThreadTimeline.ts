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

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stableJson((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function itemId(item: CodexItem): string | null {
  return typeof item.id === 'string' && item.id.trim() ? item.id : null;
}

function stringFieldFromItem(item: CodexItem, key: string): string {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function assistantMergePhase(item: CodexItem): string {
  const phase = (item as Record<string, unknown>).phase;
  if (phase === null || phase === 'final_answer' || phase === 'final') return 'final';
  return typeof phase === 'string' ? phase : '';
}

function semanticItemIdentity(item: CodexItem): string {
  if (item.type === 'agentMessage') {
    return `agent:${assistantMergePhase(item)}\0${normalizedMessageText(stringFieldFromItem(item, 'text'))}`;
  }
  if (item.type === 'commandExecution') {
    return `command:${stringFieldFromItem(item, 'cwd')}\0${stringFieldFromItem(item, 'command')}`;
  }
  if (item.type === 'mcpToolCall') {
    return `mcp:${stringFieldFromItem(item, 'server')}\0${stringFieldFromItem(item, 'tool')}\0${JSON.stringify(stableJson((item as Record<string, unknown>).arguments))}`;
  }
  if (item.type === 'fileChange') {
    return `fileChange:${JSON.stringify(stableJson((item as Record<string, unknown>).changes))}`;
  }
  return `${item.type}:${JSON.stringify(stableJson(item))}`;
}

interface TerminalMergeEntry {
  item: CodexItem;
  identity: string;
}

function terminalMergeEntries(items: CodexItem[], duplicateIds: ReadonlySet<string>): TerminalMergeEntry[] {
  return items.map((item) => {
    const id = itemId(item);
    return {
      item,
      identity: id && !duplicateIds.has(id) ? `id:${id}` : id ? `id:${id}\0${semanticItemIdentity(item)}` : `semantic:${semanticItemIdentity(item)}`,
    };
  });
}

function duplicatedItemIds(...groups: CodexItem[][]): Set<string> {
  const duplicates = new Set<string>();
  for (const items of groups) {
    const counts = new Map<string, number>();
    for (const item of items) {
      const id = itemId(item);
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) duplicates.add(id);
    }
  }
  return duplicates;
}

function identityCounts(entries: TerminalMergeEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.identity, (counts.get(entry.identity) ?? 0) + 1);
  return counts;
}

function entriesCoverIdentities(currentEntries: TerminalMergeEntry[], latestEntries: TerminalMergeEntry[]): boolean {
  const currentCounts = identityCounts(currentEntries);
  const latestCounts = identityCounts(latestEntries);
  for (const [identity, currentCount] of currentCounts) {
    if ((latestCounts.get(identity) ?? 0) < currentCount) return false;
  }
  return true;
}

function exactTerminalEntryMatches(currentEntries: TerminalMergeEntry[], latestEntries: TerminalMergeEntry[]): Map<number, number> {
  const currentCount = currentEntries.length;
  const latestCount = latestEntries.length;
  const lengths = Array.from({ length: currentCount + 1 }, () => new Array<number>(latestCount + 1).fill(0));

  for (let currentIndex = currentCount - 1; currentIndex >= 0; currentIndex -= 1) {
    for (let latestIndex = latestCount - 1; latestIndex >= 0; latestIndex -= 1) {
      if (currentEntries[currentIndex].identity === latestEntries[latestIndex].identity) {
        lengths[currentIndex][latestIndex] = lengths[currentIndex + 1][latestIndex + 1] + 1;
      } else {
        lengths[currentIndex][latestIndex] = Math.max(lengths[currentIndex + 1][latestIndex], lengths[currentIndex][latestIndex + 1]);
      }
    }
  }

  const matches = new Map<number, number>();
  let currentIndex = 0;
  let latestIndex = 0;
  while (currentIndex < currentCount && latestIndex < latestCount) {
    if (lengths[currentIndex + 1][latestIndex] === lengths[currentIndex][latestIndex]) {
      currentIndex += 1;
    } else if (
      currentEntries[currentIndex].identity === latestEntries[latestIndex].identity &&
      lengths[currentIndex + 1][latestIndex + 1] + 1 === lengths[currentIndex][latestIndex]
    ) {
      matches.set(currentIndex, latestIndex);
      currentIndex += 1;
      latestIndex += 1;
    } else {
      latestIndex += 1;
    }
  }

  return matches;
}

function addRemainingExactTerminalMatches(
  currentEntries: TerminalMergeEntry[],
  latestEntries: TerminalMergeEntry[],
  currentToLatest: Map<number, number>,
): void {
  const usedLatestIndexes = new Set(currentToLatest.values());
  for (const [currentIndex, currentEntry] of currentEntries.entries()) {
    if (currentToLatest.has(currentIndex)) continue;
    const latestIndex = latestEntries.findIndex((entry, index) => !usedLatestIndexes.has(index) && entry.identity === currentEntry.identity);
    if (latestIndex < 0) continue;
    currentToLatest.set(currentIndex, latestIndex);
    usedLatestIndexes.add(latestIndex);
  }
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

function finalAgentMessagesEqual(a: CodexItem, b: CodexItem): boolean {
  if (!isAgentMessageItem(a) || !isFinalAgentMessageItem(a)) return false;
  if (!isAgentMessageItem(b) || !isFinalAgentMessageItem(b)) return false;
  return normalizedMessageText(a.text) === normalizedMessageText(b.text);
}

function coveredAssistantMatches(
  currentEntries: TerminalMergeEntry[],
  latestEntries: TerminalMergeEntry[],
  currentToLatest: Map<number, number>,
): Map<number, number> {
  const latestUsed = new Set(currentToLatest.values());
  const matches = new Map<number, number>();

  for (const [currentIndex, currentEntry] of currentEntries.entries()) {
    if (currentToLatest.has(currentIndex)) continue;
    const candidates = latestEntries
      .map((entry, latestIndex) => ({ entry, latestIndex }))
      .filter(({ entry, latestIndex }) => !latestUsed.has(latestIndex) && finalAgentMessageCovers(currentEntry.item, entry.item));
    const exactCandidate = candidates.find(({ entry }) => finalAgentMessagesEqual(currentEntry.item, entry.item));
    const candidate = exactCandidate ?? candidates[0];
    if (!candidate) continue;
    latestUsed.add(candidate.latestIndex);
    matches.set(currentIndex, candidate.latestIndex);
  }

  return matches;
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

  if (options.replaceExisting && options.removeCurrentCoveredByLatest) {
    const duplicateIds = duplicatedItemIds(current, latest);
    const latestEntries = terminalMergeEntries(latest, duplicateIds);
    const currentEntries = terminalMergeEntries(current, duplicateIds);
    if (entriesCoverIdentities(currentEntries, latestEntries)) return latest;

    const currentToLatest = exactTerminalEntryMatches(currentEntries, latestEntries);
    addRemainingExactTerminalMatches(currentEntries, latestEntries, currentToLatest);
    for (const [currentIndex, latestIndex] of coveredAssistantMatches(currentEntries, latestEntries, currentToLatest)) {
      currentToLatest.set(currentIndex, latestIndex);
    }

    const matchedLatestIndexes = new Set(currentToLatest.values());
    const emittedLatestIndexes = new Set<number>();
    const merged: CodexItem[] = [];

    const emitLatest = (latestIndex: number) => {
      if (emittedLatestIndexes.has(latestIndex)) return;
      emittedLatestIndexes.add(latestIndex);
      const item = latestEntries[latestIndex]?.item;
      if (!item) return;
      if (options.skipLatestCoveredByCurrent && latestItemCoveredByCurrent(item, current)) return;
      merged.push(item);
    };

    const emitUnmatchedLatestBefore = (limitIndex: number) => {
      for (let latestIndex = 0; latestIndex < limitIndex; latestIndex += 1) {
        if (matchedLatestIndexes.has(latestIndex)) continue;
        emitLatest(latestIndex);
      }
    };

    currentEntries.forEach((entry, currentIndex) => {
      const latestIndex = currentToLatest.get(currentIndex);
      if (latestIndex === undefined) {
        merged.push(entry.item);
        return;
      }
      emitUnmatchedLatestBefore(latestIndex);
      emitLatest(latestIndex);
    });

    latestEntries.forEach((_, latestIndex) => emitLatest(latestIndex));

    return merged;
  }

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
  const replacingLatestRef = useRef(false);
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
  const [replacingLatest, setReplacingLatest] = useState(false);
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
    if (!activeThreadId) return false;
    if (mode === 'merge' && replacingLatestRef.current) return false;
    const threadId = activeThreadId;
    const generation = ++requestGenerationRef.current;

    clearInitialRetryTimer();
    setLoading(true);
    setLoadError(null);
    setRetryScheduled(false);
    if (mode === 'replace') {
      replacingLatestRef.current = true;
      setIsViewingLatest(true);
      setReplacingLatest(true);
    }
    try {
      const result = await fetchLatestPage(threadId);
      if (!isCurrentRequest(threadId, generation)) return false;
      const latest = [...resultTurns(result)].reverse();
      setTurns((current) => (mode === 'replace' ? latest : mergeLatestTurns(current, latest, WINDOW_TURN_LIMIT)));
      setLoadedThreadId(threadId);
      const nextCursor = getNextCursor(result);
      setCursor((currentCursor) => (mode === 'replace' || isViewingLatestRef.current ? nextCursor : currentCursor));
      setLoadError(null);
      return true;
    } catch (error) {
      if (!isCurrentRequest(threadId, generation)) return false;
      setLoadError(errorMessage(error));
      if (mode === 'replace') setIsViewingLatest(false);
      // Keep the last successfully rendered timeline during transient transport or app-server failures.
      return false;
    } finally {
      if (isCurrentRequest(threadId, generation)) {
        setLoading(false);
        if (mode === 'replace') {
          replacingLatestRef.current = false;
          setReplacingLatest(false);
        }
      }
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
    replacingLatestRef.current = false;
    setReplacingLatest(false);

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
    replacingLatest,
  };
}
