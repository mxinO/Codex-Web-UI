import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import DetailModal from './components/DetailModal';
import FileChangeTray, { type ActiveFileSummary } from './components/FileChangeTray';
import FileEditorModal from './components/FileEditorModal';
import FileExplorer from './components/FileExplorer';
import Header from './components/Header';
import ImageViewerModal from './components/ImageViewerModal';
import InputBox from './components/InputBox';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useQueue, type ClientQueuedMessage } from './hooks/useQueue';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import { appendEphemeralBangItem, bangOutputEventToTimelineItem, getBangCommandOutputDetail } from './lib/bangCommands';
import { isImagePath, normalizeMentionedFilePath } from './lib/filePreview';
import {
  COLLABORATION_MODES,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  effectiveMode,
  legacySandboxFromMode,
  sanitizeStoredEffort,
  sanitizeStoredMode,
  sanitizeStoredModel,
  sanitizeStoredSandbox,
} from './lib/runOptions';
import { newSessionInitialCwd } from './lib/sessionDefaults';
import { parseSlashCommand } from './lib/slashCommands';
import {
  approvalItemsFromRequests,
  claimedQueuedMessageIdFromPendingUserItem,
  claimedQueuedUserItemsWithoutHistory,
  claimedQueuedUserItemsFromQueueTransition,
  fileChangeHasInlineDiff,
  latestCompletionNotificationCount,
  isSyntheticPendingTurnId,
  liveTurnItemsFromNotifications,
  mergeRetainedLiveTurnItems,
  mergeTimelineItemsByTimestamp,
  nextLiveNotificationWindow,
  notificationsSinceCount,
  notificationMatchesActiveTurn,
  pendingUserItemsWithoutHistory,
  requestKey,
  timelineItemsWithLiveTurnOverlay,
  visibleRetainedLiveTurnItemsForTimeline,
  visibleLiveTurnItemsForTimeline,
  type TimelineItem,
} from './lib/timeline';
import type { CodexThread } from './types/codex';
import type { CodexRunOptions } from './types/ui';

interface OpenEditor {
  path: string;
  readOnly: boolean;
  content: string;
  modifiedAtMs: number | null;
}

interface OpenImage {
  path: string;
}

type UserTimelineItem = Extract<TimelineItem, { kind: 'user' }>;
type FileChangeSummaryTimelineItem = Extract<TimelineItem, { kind: 'fileChangeSummary' }>;

function decodeUtf8Base64(value: string): string {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

function localStorageValue(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function setLocalStorageValue(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; these labels are client-side UI state.
  }
}

function initialMode(): string | null {
  return sanitizeStoredMode(localStorageValue('codex-web-ui:mode'));
}

function initialSandbox(): string | null {
  return sanitizeStoredSandbox(localStorageValue('codex-web-ui:sandbox')) ?? legacySandboxFromMode(localStorageValue('codex-web-ui:mode'));
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : null;
}

function extractBase64(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const record = result as Record<string, unknown>;
  const data = getNestedRecord(result, 'data');
  const value = record.dataBase64 ?? record.contentBase64 ?? data?.dataBase64 ?? data?.contentBase64;
  return typeof value === 'string' ? value : '';
}

function extractModifiedAtMs(result: unknown): number | null {
  const readValue = (record: Record<string, unknown> | null): unknown =>
    record?.modifiedAtMs ?? record?.mtimeMs ?? record?.mtime_ms ?? record?.modifiedAt ?? record?.mtime;
  const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
  const value = readValue(record) ?? readValue(getNestedRecord(result, 'data')) ?? readValue(getNestedRecord(result, 'metadata'));
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fileChangeTurnId(item: Extract<TimelineItem, { kind: 'fileChange' }>): string | null {
  if (item.turnId) return item.turnId;
  const marker = ':file:';
  const markerIndex = item.id.indexOf(marker);
  return markerIndex > 0 ? item.id.slice(0, markerIndex) : null;
}

function fileChangeRawChanges(item: Extract<TimelineItem, { kind: 'fileChange' }>): unknown[] {
  const changes = (item.item as Record<string, unknown>).changes;
  return Array.isArray(changes) ? changes : [];
}

function sameTimelineItemList(left: TimelineItem[], right: TimelineItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    if (!other || item.id !== other.id || item.kind !== other.kind || item.timestamp !== other.timestamp) return false;
    if ((item.kind === 'assistant' || item.kind === 'streaming') && (other.kind === 'assistant' || other.kind === 'streaming')) {
      return item.text === other.text;
    }
    return true;
  });
}

function activeFileSummaryToTimelineItem(
  summary: ActiveFileSummary,
  timestamp: number,
  sortOrder?: number,
): FileChangeSummaryTimelineItem | null {
  const files = summary.files
    .filter((file) => file.path.trim().length > 0 && file.editCount > 0)
    .map((file) => ({ path: file.path, changeCount: file.editCount }));
  if (files.length === 0) return null;
  return {
    id: `${summary.turnId}:file-summary`,
    kind: 'fileChangeSummary',
    timestamp,
    sortOrder,
    turnId: summary.turnId,
    files,
  };
}

export default function App() {
  const socket = useCodexSocket();
  const { theme, setTheme } = useTheme();
  const state = socket.hello?.state;
  const activeThreadId = state?.activeThreadId ?? null;
  const activeThreadPath = state?.activeThreadPath ?? null;
  const timeline = useThreadTimeline(activeThreadId, socket.rpc);
  const { queue: queuedMessages, enqueue, remove: removeFromQueue, replace: replaceQueue } = useQueue(socket.rpc, state?.queue ?? []);
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<TimelineItem | null>(null);
  const [composerDraft, setComposerDraft] = useState<string | null>(null);
  const [editor, setEditor] = useState<OpenEditor | null>(null);
  const [imageViewer, setImageViewer] = useState<OpenImage | null>(null);
  const [activeFileSummary, setActiveFileSummary] = useState<ActiveFileSummary | null>(null);
  const [ephemeralItems, setEphemeralItems] = useState<TimelineItem[]>([]);
  const [pendingUserItems, setPendingUserItems] = useState<UserTimelineItem[]>([]);
  const [claimedQueuedUserItems, setClaimedQueuedUserItems] = useState<UserTimelineItem[]>([]);
  const [retainedLiveTurnItems, setRetainedLiveTurnItems] = useState<TimelineItem[]>([]);
  const [retainedFileSummaryItems, setRetainedFileSummaryItems] = useState<FileChangeSummaryTimelineItem[]>([]);
  const [pendingCompactionThreadId, setPendingCompactionThreadId] = useState<string | null>(null);
  const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set());
  const [model, setModelState] = useState<string | null>(() => sanitizeStoredModel(localStorageValue('codex-web-ui:model')));
  const [mode, setModeState] = useState<string | null>(initialMode);
  const [effort, setEffortState] = useState<string | null>(() => sanitizeStoredEffort(localStorageValue('codex-web-ui:effort')));
  const [sandbox, setSandboxState] = useState<string | null>(initialSandbox);
  const bangCounterRef = useRef(0);
  const pendingUserCounterRef = useRef(0);
  const ephemeralCounterRef = useRef(0);
  const localSortCounterRef = useRef(0);
  const notificationCountRef = useRef(socket.notificationCount);
  const localSortOrdersRef = useRef(new Map<string, number>());
  const [pendingTurnWindow, setPendingTurnWindow] = useState<{ id: string; threadId: string | null; startCount: number } | null>(null);
  const activeFileSummaryScopeRef = useRef({ threadId: activeThreadId, threadPath: activeThreadPath, turnId: state?.activeTurnId ?? null });
  const previousActiveTurnRef = useRef({ threadId: activeThreadId, threadPath: activeThreadPath, turnId: state?.activeTurnId ?? null });
  const previousLiveTurnSnapshotRef = useRef<{
    threadId: string | null;
    turnId: string | null;
    historyItems: TimelineItem[];
    liveItems: TimelineItem[];
  }>({ threadId: activeThreadId, turnId: state?.activeTurnId ?? null, historyItems: [], liveItems: [] });
  const previousQueueSnapshotRef = useRef({
    activeThreadId,
    activeTurnId: state?.activeTurnId ?? null,
    queue: state?.queue ?? [],
  });
  const finalizedFileSummaryFetchesRef = useRef(new Set<string>());
  const liveNotificationWindowRef = useRef({ activeThreadId, activeTurnId: state?.activeTurnId ?? null, startCount: socket.notificationCount });
  const lastHandledCompletionCountRef = useRef<number | null>(null);
  const pendingTurnStartCount = pendingTurnWindow?.threadId === activeThreadId ? pendingTurnWindow.startCount : null;
  notificationCountRef.current = socket.notificationCount;
  const localSortOrder = useCallback((key?: string) => {
    if (key) {
      const existing = localSortOrdersRef.current.get(key);
      if (existing !== undefined) return existing;
    }
    const next = notificationCountRef.current + 0.5 + (localSortCounterRef.current += 1) / 1_000_000;
    if (key) localSortOrdersRef.current.set(key, next);
    return next;
  }, []);
  liveNotificationWindowRef.current = nextLiveNotificationWindow(
    liveNotificationWindowRef.current,
    { activeThreadId, activeTurnId: state?.activeTurnId ?? null },
    socket.notificationCount,
    { pendingStartCount: pendingTurnStartCount },
  );
  const liveNotificationActiveTurnId = liveNotificationWindowRef.current.activeTurnId;
  const liveNotificationStartCount = liveNotificationWindowRef.current.startCount;
  const lastNotification = socket.notifications.at(-1);
  const liveNotificationWindowKey = `${activeThreadId ?? ''}\0${liveNotificationActiveTurnId ?? ''}\0${liveNotificationStartCount}`;
  const liveNotificationAccumulatorRef = useRef({ key: liveNotificationWindowKey, processedCount: liveNotificationStartCount });
  const [liveNotifications, setLiveNotifications] = useState<unknown[]>([]);
  useEffect(() => {
    const accumulator = liveNotificationAccumulatorRef.current;
    if (
      accumulator.key !== liveNotificationWindowKey ||
      accumulator.processedCount < liveNotificationStartCount ||
      accumulator.processedCount > socket.notificationCount
    ) {
      const retained = notificationsSinceCount(socket.notifications, socket.notificationCount, liveNotificationStartCount);
      liveNotificationAccumulatorRef.current = { key: liveNotificationWindowKey, processedCount: socket.notificationCount };
      setLiveNotifications(retained);
      return;
    }

    const additions = notificationsSinceCount(socket.notifications, socket.notificationCount, accumulator.processedCount);
    if (additions.length === 0) return;
    accumulator.processedCount = socket.notificationCount;
    setLiveNotifications((current) => [...current, ...additions]);
  }, [liveNotificationStartCount, liveNotificationWindowKey, socket.notificationCount, socket.notifications]);
  const liveTurnItems = useMemo(
    () =>
      liveTurnItemsFromNotifications(
        liveNotifications,
        { activeThreadId, activeTurnId: liveNotificationActiveTurnId },
        Boolean(state?.activeTurnId),
        Date.now(),
        { acceptUnscoped: Boolean(liveNotificationActiveTurnId) },
      ),
    [activeThreadId, liveNotificationActiveTurnId, liveNotifications, state?.activeTurnId],
  );
  const timelineItemsForChat = useMemo(
    () => timelineItemsWithLiveTurnOverlay(timeline.items, liveTurnItems, state?.activeTurnId ? liveNotificationActiveTurnId : null),
    [liveNotificationActiveTurnId, liveTurnItems, state?.activeTurnId, timeline.items],
  );
  const latestCompletionCount = useMemo(
    () =>
      latestCompletionNotificationCount(liveNotifications, socket.notificationCount, {
        activeThreadId,
        activeTurnId: liveNotificationActiveTurnId,
      }),
    [activeThreadId, liveNotificationActiveTurnId, liveNotifications, socket.notificationCount],
  );
  const visibleLiveTurnItems = useMemo(
    () => visibleLiveTurnItemsForTimeline(timelineItemsForChat, liveTurnItems),
    [liveTurnItems, timelineItemsForChat],
  );
  const visibleRetainedLiveTurnItems = useMemo(
    () => visibleRetainedLiveTurnItemsForTimeline(timelineItemsForChat, visibleLiveTurnItems, retainedLiveTurnItems),
    [retainedLiveTurnItems, timelineItemsForChat, visibleLiveTurnItems],
  );
  const historyFileSummaryTurnIds = useMemo(
    () =>
      new Set(
        timelineItemsForChat
          .filter((item): item is FileChangeSummaryTimelineItem => item.kind === 'fileChangeSummary')
          .map((item) => item.turnId),
      ),
    [timelineItemsForChat],
  );
  const visibleRetainedFileSummaryItems = useMemo(
    () => retainedFileSummaryItems.filter((item) => !historyFileSummaryTurnIds.has(item.turnId)),
    [historyFileSummaryTurnIds, retainedFileSummaryItems],
  );
  const queuedTimelineItems = useMemo<TimelineItem[]>(
    () =>
      queuedMessages.map((message) => ({
        id: `queued:${message.id}`,
        kind: 'queued',
        timestamp: message.createdAt,
        sortOrder: localSortOrder(`queued:${message.id}`),
        message,
      })),
    [localSortOrder, queuedMessages],
  );
  const approvalItems = useMemo(
    () =>
      approvalItemsFromRequests(socket.requests, answeredApprovals).map((item) => ({
        ...item,
        sortOrder: localSortOrder(item.id),
      })),
    [answeredApprovals, localSortOrder, socket.requests],
  );
  const chatItems = useMemo<TimelineItem[]>(() => {
    if (!timeline.isViewingLatest) return timeline.items;
    return mergeTimelineItemsByTimestamp([
      ...timelineItemsForChat,
      ...visibleRetainedLiveTurnItems,
      ...visibleRetainedFileSummaryItems,
      ...pendingUserItems,
      ...claimedQueuedUserItems,
      ...queuedTimelineItems,
      ...ephemeralItems,
      ...visibleLiveTurnItems,
      ...approvalItems,
    ]);
  }, [approvalItems, claimedQueuedUserItems, ephemeralItems, pendingUserItems, queuedTimelineItems, timeline.isViewingLatest, timeline.items, timelineItemsForChat, visibleLiveTurnItems, visibleRetainedFileSummaryItems, visibleRetainedLiveTurnItems]);
  const runOptions = useMemo<CodexRunOptions>(() => ({ model, mode: effectiveMode(mode, model), effort, sandbox }), [effort, mode, model, sandbox]);
  const isRunning = Boolean(state?.activeTurnId || (pendingCompactionThreadId && pendingCompactionThreadId === activeThreadId));

  const updateRetainedLiveTurnItems = useCallback((historyItems: TimelineItem[], additions: TimelineItem[] = []) => {
    setRetainedLiveTurnItems((current) => {
      const next = mergeRetainedLiveTurnItems(historyItems, current, additions);
      return sameTimelineItemList(current, next) ? current : next;
    });
  }, []);

  const appendRetainedFileSummary = useCallback((summary: ActiveFileSummary, timestamp = Date.now()) => {
    const item = activeFileSummaryToTimelineItem(summary, timestamp, localSortOrder(`${summary.turnId}:file-summary`));
    if (!item) return;
    setRetainedFileSummaryItems((current) => [...current.filter((existing) => existing.turnId !== item.turnId), item]);
  }, [localSortOrder]);

  const loadFinalizedFileSummary = useCallback(async (threadId: string | null, threadPath: string | null, turnId: string) => {
    if (!threadId || socket.connectionState !== 'connected') return;
    const key = `${threadId}\0${threadPath ?? ''}\0${turnId}`;
    if (finalizedFileSummaryFetchesRef.current.has(key)) return;
    finalizedFileSummaryFetchesRef.current.add(key);

    try {
      const result = await socket.rpc<ActiveFileSummary>('webui/fileChange/summary', { threadId, turnId, threadPath });
      const current = activeFileSummaryScopeRef.current;
      if (current.threadId !== threadId || current.threadPath !== threadPath) {
        finalizedFileSummaryFetchesRef.current.delete(key);
        return;
      }
      if (result.files.length > 0) {
        appendRetainedFileSummary({ ...result, turnId: result.turnId || turnId });
        return;
      }
      finalizedFileSummaryFetchesRef.current.delete(key);
    } catch {
      finalizedFileSummaryFetchesRef.current.delete(key);
      // Keep the retained client-side snapshot if the finalized summary is not available yet.
    }
  }, [appendRetainedFileSummary, socket.connectionState, socket.rpc]);

  useEffect(() => {
    if (!state?.queue) return;
    const nextQueue = state.queue;
    const previous = previousQueueSnapshotRef.current;
    const currentScope = { activeThreadId, activeTurnId: state.activeTurnId ?? null };
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      previous.queue,
      nextQueue,
      { activeThreadId: previous.activeThreadId, activeTurnId: previous.activeTurnId },
      currentScope,
      localSortOrder,
    );
    const nextQueueIds = new Set(nextQueue.map((message) => message.id));

    setClaimedQueuedUserItems((current) => {
      const existingIds = new Set(current.map((item) => item.id));
      const retained = claimedQueuedUserItemsWithoutHistory(timeline.items, current).filter((item) => {
        const claimedMessageId = claimedQueuedMessageIdFromPendingUserItem(item);
        return !claimedMessageId || !nextQueueIds.has(claimedMessageId);
      });
      const additions = claimedQueuedUserItemsWithoutHistory(timeline.items, claimed.filter((item) => !existingIds.has(item.id)));
      return additions.length === 0 && retained.length === current.length ? current : [...retained, ...additions];
    });

    previousQueueSnapshotRef.current = { ...currentScope, queue: nextQueue };
    replaceQueue(nextQueue);
  }, [activeThreadId, localSortOrder, replaceQueue, state?.activeTurnId, state?.queue, timeline.items]);

  useEffect(() => {
    activeFileSummaryScopeRef.current = { threadId: activeThreadId, threadPath: activeThreadPath, turnId: state?.activeTurnId ?? null };
  }, [activeThreadId, activeThreadPath, state?.activeTurnId]);

  useEffect(() => {
    setEphemeralItems([]);
    setPendingUserItems([]);
    setClaimedQueuedUserItems([]);
    setRetainedLiveTurnItems([]);
    setRetainedFileSummaryItems([]);
    setAnsweredApprovals(new Set());
    setActiveFileSummary(null);
    setPendingTurnWindow(null);
    finalizedFileSummaryFetchesRef.current.clear();
  }, [activeThreadId]);

  useEffect(() => {
    updateRetainedLiveTurnItems(timelineItemsForChat);
  }, [timelineItemsForChat, updateRetainedLiveTurnItems]);

  useEffect(() => {
    const currentTurnId = state?.activeTurnId ?? null;
    const previous = previousLiveTurnSnapshotRef.current;
    const previousRealTurnEnded =
      previous.threadId === activeThreadId &&
      Boolean(previous.turnId) &&
      previous.turnId !== currentTurnId &&
      !isSyntheticPendingTurnId(previous.turnId);

    if (previousRealTurnEnded && previous.liveItems.length > 0) {
      updateRetainedLiveTurnItems(previous.historyItems, previous.liveItems);
    }

    previousLiveTurnSnapshotRef.current = {
      threadId: activeThreadId,
      turnId: currentTurnId,
      historyItems: timelineItemsForChat,
      liveItems: visibleLiveTurnItems,
    };
  }, [activeThreadId, state?.activeTurnId, timelineItemsForChat, updateRetainedLiveTurnItems, visibleLiveTurnItems]);

  useEffect(() => {
    setRetainedFileSummaryItems((current) => {
      const next = current.filter((item) => !historyFileSummaryTurnIds.has(item.turnId));
      return next.length === current.length ? current : next;
    });
  }, [historyFileSummaryTurnIds]);

  useEffect(() => {
    if (state?.activeTurnId || visibleLiveTurnItems.length === 0) return;
    updateRetainedLiveTurnItems(timelineItemsForChat, visibleLiveTurnItems);
  }, [state?.activeTurnId, timelineItemsForChat, updateRetainedLiveTurnItems, visibleLiveTurnItems]);

  useEffect(() => {
    if (pendingTurnWindow && state?.activeTurnId && !isSyntheticPendingTurnId(state.activeTurnId)) setPendingTurnWindow(null);
  }, [pendingTurnWindow, state?.activeTurnId]);

  useEffect(() => {
    if (!pendingCompactionThreadId) return;
    if (activeThreadId !== pendingCompactionThreadId || state?.activeTurnId) setPendingCompactionThreadId(null);
  }, [activeThreadId, pendingCompactionThreadId, state?.activeTurnId]);

  const loadActiveFileSummary = useCallback(async (turnId: string | null | undefined) => {
    if (!turnId || !activeThreadId || socket.connectionState !== 'connected') {
      setActiveFileSummary(null);
      return;
    }
    const requestedThreadId = activeThreadId;
    const requestedThreadPath = activeThreadPath;
    try {
      const result = await socket.rpc<ActiveFileSummary>('webui/fileChange/summary', { threadId: requestedThreadId, turnId, threadPath: requestedThreadPath });
      const current = activeFileSummaryScopeRef.current;
      if (current.threadId !== requestedThreadId || current.threadPath !== requestedThreadPath || current.turnId !== turnId) return;
      setActiveFileSummary(result.files.length > 0 ? result : null);
    } catch {
      const current = activeFileSummaryScopeRef.current;
      if (current.threadId !== requestedThreadId || current.threadPath !== requestedThreadPath || current.turnId !== turnId) return;
      setActiveFileSummary(null);
    }
  }, [activeThreadId, activeThreadPath, socket.connectionState, socket.rpc]);

  useEffect(() => {
    if (!state?.activeTurnId) {
      setActiveFileSummary(null);
      return;
    }
    void loadActiveFileSummary(state.activeTurnId);
  }, [loadActiveFileSummary, state?.activeTurnId]);

  useEffect(() => {
    const current = { threadId: activeThreadId, threadPath: activeThreadPath, turnId: state?.activeTurnId ?? null };
    const previous = previousActiveTurnRef.current;
    const previousTurnEnded =
      previous.threadId === current.threadId &&
      Boolean(previous.turnId) &&
      previous.turnId !== current.turnId &&
      !isSyntheticPendingTurnId(previous.turnId);

    if (previousTurnEnded && previous.turnId) {
      if (activeFileSummary?.turnId === previous.turnId) appendRetainedFileSummary(activeFileSummary);
      void loadFinalizedFileSummary(previous.threadId, previous.threadPath, previous.turnId);
    }

    previousActiveTurnRef.current = current;
  }, [activeFileSummary, activeThreadId, activeThreadPath, appendRetainedFileSummary, loadFinalizedFileSummary, state?.activeTurnId]);

  useEffect(() => {
    if (!state?.activeTurnId || !lastNotification || typeof lastNotification !== 'object') return;
    const record = lastNotification as Record<string, unknown>;
    if (record.method !== 'webui/fileChange/summaryChanged') return;
    if (notificationMatchesActiveTurn(record, { activeThreadId, activeTurnId: state.activeTurnId })) {
      void loadActiveFileSummary(state.activeTurnId);
    }
  }, [activeThreadId, lastNotification, loadActiveFileSummary, state?.activeTurnId]);

  useEffect(() => {
    setPendingUserItems((items) => pendingUserItemsWithoutHistory(timeline.items, items));
    setClaimedQueuedUserItems((items) => claimedQueuedUserItemsWithoutHistory(timeline.items, items));
  }, [timeline.items]);

  useEffect(() => {
    if (!activeThreadId || latestCompletionCount === null || !timeline.isViewingLatest) return;
    if (lastHandledCompletionCountRef.current === latestCompletionCount) return;
    lastHandledCompletionCountRef.current = latestCompletionCount;

    let cancelled = false;
    const reload = () => {
      if (!cancelled) void timeline.reload();
    };
    reload();
    const timers = [500, 1500, 3000].map((delay) => window.setTimeout(reload, delay));
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeThreadId, latestCompletionCount, timeline.isViewingLatest, timeline.reload]);

  useEffect(() => {
    if (!activeThreadId || socket.connectionState !== 'connected' || socket.reconnectEpoch === 0) return;
    void timeline.reload();
  }, [activeThreadId, socket.connectionState, socket.reconnectEpoch, timeline.reload]);

  useEffect(() => {
    const handleBangOutput = (event: Event) => {
      const detail = getBangCommandOutputDetail(event);
      if (!detail) return;

    const now = Date.now();
    const counter = (bangCounterRef.current += 1);
    const item = bangOutputEventToTimelineItem(detail, activeThreadId, now, counter);
    if (!item) return;

      setEphemeralItems((items) => appendEphemeralBangItem(items, { ...item, sortOrder: localSortOrder(`bang:${item.id}`) }));
    };

    window.addEventListener('webui-bang-output', handleBangOutput);
    return () => window.removeEventListener('webui-bang-output', handleBangOutput);
  }, [activeThreadId, localSortOrder]);

  const setModel = useCallback((value: string | null) => {
    setModelState(value);
    setLocalStorageValue('codex-web-ui:model', value);
  }, []);

  const setMode = useCallback((value: string | null) => {
    setModeState(value);
    setLocalStorageValue('codex-web-ui:mode', value);
  }, []);

  const setEffort = useCallback((value: string | null) => {
    setEffortState(value);
    setLocalStorageValue('codex-web-ui:effort', value);
  }, []);

  const setSandbox = useCallback((value: string | null) => {
    setSandboxState(value);
    setLocalStorageValue('codex-web-ui:sandbox', value);
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const result = await socket.rpc<{ data: CodexThread[] }>('webui/session/list');
      setThreads(result.data);
      setSessionPickerOpen(true);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionLoading(false);
    }
  }, [socket.rpc]);

  const openNewSessionPicker = useCallback(() => {
    setSessionPickerOpen(false);
    setCwdPickerOpen(true);
  }, []);

  const addPendingUserMessage = useCallback((text: string) => {
    const now = Date.now();
    const id = `pending:user:${now}:${(pendingUserCounterRef.current += 1)}`;
    const pendingWindow = { id, threadId: activeThreadId, startCount: socket.notificationCount };
    updateRetainedLiveTurnItems(timelineItemsForChat, visibleLiveTurnItems);
    setPendingTurnWindow(pendingWindow);
    setPendingUserItems((items) => [...items, { id, kind: 'user', timestamp: now, sortOrder: localSortOrder(id), text }]);
    return () => {
      setPendingUserItems((items) => items.filter((item) => item.id !== id));
      setPendingTurnWindow((current) => (current?.id === pendingWindow.id ? null : current));
    };
  }, [activeThreadId, localSortOrder, socket.notificationCount, timelineItemsForChat, updateRetainedLiveTurnItems, visibleLiveTurnItems]);

  const addDirectSubmitError = useCallback((_: string, error: string) => {
    const id = `direct-submit-error:${Date.now()}:${(ephemeralCounterRef.current += 1)}`;
    setEphemeralItems((items) => [
      ...items,
      {
        id,
        kind: 'error',
        timestamp: Date.now(),
        text: `Turn failed: ${error}`,
      },
    ]);
    void timeline.reload();
    window.setTimeout(() => void timeline.reload(), 1000);
  }, [timeline.reload]);

  const openDetailItem = useCallback((item: TimelineItem) => {
    if (item.kind !== 'fileChange') {
      setDetailItem(item);
      return;
    }
    if (fileChangeHasInlineDiff(item)) {
      setDetailItem(item);
      return;
    }

    const loadingItem: TimelineItem = { ...item, diffLoading: true, diffError: undefined, resolvedDiff: undefined };
    setDetailItem(loadingItem);

    void socket
      .rpc<{ before: string; after: string; path?: string | null }>('webui/fileChange/diff', {
        threadId: activeThreadId,
        threadPath: activeThreadPath,
        turnId: fileChangeTurnId(item),
        path: item.filePath,
        changes: fileChangeRawChanges(item),
      })
      .then((diff) => {
        setDetailItem((current) => (current?.id === item.id ? { ...item, resolvedDiff: diff } : current));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setDetailItem((current) => (current?.id === item.id ? { ...item, diffError: message } : current));
      });
  }, [activeThreadId, activeThreadPath, socket.rpc]);

  const openFileSummaryDiff = useCallback((turnId: string, path: string, changeCount: number) => {
    openDetailItem({
      id: `${turnId}:file:${path}`,
      kind: 'fileChange',
      timestamp: Date.now(),
      turnId,
      item: { type: 'fileChange', id: `summary:${path}`, changes: [{ path }], status: 'completed' },
      filePath: path,
      changeCount,
    });
  }, [openDetailItem]);

  const startSession = useCallback(async (cwd: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      await socket.rpc('webui/session/start', { cwd, options: runOptions });
      window.location.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      setSessionLoading(false);
    }
  }, [runOptions, socket.rpc]);

  const resumeSession = useCallback(async (threadId: string, threadPath?: string | null) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      await socket.rpc('webui/session/resume', { threadId, threadPath, options: runOptions });
      window.location.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      setSessionLoading(false);
    }
  }, [runOptions, socket.rpc]);

  useEffect(() => {
    const handleSlashCommand = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.input !== 'string') return;
      const { command, value } = parseSlashCommand(event.detail.input);

      if (command === '/help') {
        setSessionError('Commands: /new, /resume [id], /model <name>, /effort <level>, /mode <value>, /sandbox <value>, /compact, /diff, /status');
        return;
      }
      if (command === '/status') {
        setSessionError(
          `Host ${socket.hello?.hostname ?? 'unknown'}; session ${activeThreadId ?? 'none'}; cwd ${state?.activeCwd ?? 'none'}; model ${model ?? 'default'}; effort ${effort ?? 'default'}; mode ${mode ?? 'default'}; sandbox ${sandbox ?? 'default'}; connection ${socket.connectionState}`,
        );
        return;
      }
      if (command === '/new') {
        setSessionPickerOpen(false);
        setCwdPickerOpen(true);
        return;
      }
      if (command === '/resume') {
        if (value) {
          void resumeSession(value);
          return;
        }
        void loadSessions();
        return;
      }
      if (command === '/compact') {
        if (!activeThreadId) {
          setSessionError('Start or resume a session before compacting');
          return;
        }
        setPendingCompactionThreadId(activeThreadId);
        setSessionError('Starting context compaction...');
        void socket
          .rpc('webui/thread/compact/start', { threadId: activeThreadId })
          .then(() => {
            setPendingCompactionThreadId(null);
            setSessionError('Context compaction started');
          })
          .catch((error) => {
            setPendingCompactionThreadId(null);
            setSessionError(error instanceof Error ? error.message : String(error));
          });
        return;
      }
      if (command === '/diff') {
        setSessionError('/diff is not supported by this Codex app-server integration yet');
        return;
      }
      if (command === '/model') {
        if (!value) {
          setSessionError('Usage: /model <name>');
          return;
        }
        setModel(value);
        setSessionError(`Model set to ${value}`);
        return;
      }
      if (command === '/effort') {
        if (!value) {
          setSessionError('Usage: /effort <level>');
          return;
        }
        if (!REASONING_EFFORTS.includes(value as (typeof REASONING_EFFORTS)[number])) {
          setSessionError('Effort must be one of none, minimal, low, medium, high, xhigh');
          return;
        }
        setEffort(value);
        setSessionError(`Effort set to ${value}`);
        return;
      }
      if (command === '/mode') {
        if (!value) {
          setSessionError('Usage: /mode <default|plan>');
          return;
        }
        if (!COLLABORATION_MODES.includes(value as (typeof COLLABORATION_MODES)[number])) {
          setSessionError('Mode must be default or plan');
          return;
        }
        if (!model) {
          setSessionError('Set /model before /mode so Codex can apply the mode');
          return;
        }
        setMode(value);
        setSessionError(`Mode set to ${value}`);
        return;
      }
      if (command === '/sandbox') {
        if (!value) {
          setSessionError('Usage: /sandbox <read-only|workspace-write|danger-full-access>');
          return;
        }
        if (!SANDBOX_MODES.includes(value as (typeof SANDBOX_MODES)[number])) {
          setSessionError('Sandbox must be read-only, workspace-write, or danger-full-access');
          return;
        }
        setSandbox(value);
        setSessionError(`Sandbox set to ${value}`);
      }
    };

    window.addEventListener('webui-slash-command', handleSlashCommand);
    return () => window.removeEventListener('webui-slash-command', handleSlashCommand);
  }, [activeThreadId, effort, loadSessions, mode, model, resumeSession, sandbox, setEffort, setMode, setModel, setSandbox, socket.connectionState, socket.hello?.hostname, socket.rpc, state?.activeCwd]);

  const editQueued = async (message: ClientQueuedMessage) => {
    setSessionError(null);
    try {
      await removeFromQueue(message.id);
      setComposerDraft(message.text);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeQueued = async (id: string) => {
    setSessionError(null);
    try {
      await removeFromQueue(id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const openFile = async (path: string, readOnly: boolean) => {
    setSessionError(null);
    const normalizedPath = normalizeMentionedFilePath(path);
    if (isImagePath(normalizedPath)) {
      setEditor(null);
      setImageViewer({ path: normalizedPath });
      return;
    }

    try {
      setImageViewer(null);
      const contentResult = await socket.rpc<unknown>('webui/fs/readFile', { path: normalizedPath });
      const metadataResult = await socket.rpc<unknown>('webui/fs/getMetadata', { path: normalizedPath });
      setEditor({
        path: normalizedPath,
        readOnly,
        content: decodeUtf8Base64(extractBase64(contentResult)),
        modifiedAtMs: extractModifiedAtMs(metadataResult),
      });
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveFile = async (path: string, content: string) => {
    const currentMetadata = await socket.rpc<unknown>('webui/fs/getMetadata', { path });
    const currentModifiedAtMs = extractModifiedAtMs(currentMetadata);
    if (
      editor?.modifiedAtMs !== null &&
      currentModifiedAtMs !== null &&
      editor?.modifiedAtMs !== undefined &&
      currentModifiedAtMs > editor.modifiedAtMs + 1 &&
      !window.confirm('This file changed on disk after it was opened. Overwrite it?')
    ) {
      return;
    }

    await socket.rpc('webui/fs/writeFile', { path, dataBase64: encodeUtf8Base64(content) });
    setEditor(null);
  };

  const respondToApproval = useCallback(
    async (item: Extract<TimelineItem, { kind: 'approval' }>, decision: unknown) => {
      await socket.rpc('webui/approval/respond', {
        requestId: item.requestId,
        method: item.method,
        decision,
        requestParams: item.params,
      });
      setAnsweredApprovals((current) => {
        const next = new Set(current);
        next.add(requestKey(item.requestId));
        return next;
      });
    },
    [socket],
  );

  return (
    <div className="app-shell">
      <Header
        hostname={socket.hello?.hostname ?? null}
        connectionState={socket.connectionState}
        activeThreadId={state?.activeThreadId ?? null}
        cwd={state?.activeCwd ?? null}
        model={model}
        mode={mode}
        effort={effort}
        sandbox={sandbox}
        appServerHealth={socket.hello?.appServerHealth ?? null}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        sessionBusy={sessionLoading}
        sessionError={sessionError}
        onOpenSessions={socket.connectionState === 'connected' ? () => void loadSessions() : undefined}
        onNewSession={socket.connectionState === 'connected' ? openNewSessionPicker : undefined}
        sessionPicker={
          <SessionPicker
            threads={threads}
            visible={sessionPickerOpen}
            busy={sessionLoading}
            onClose={() => setSessionPickerOpen(false)}
            onSelect={(threadId, threadPath) => void resumeSession(threadId, threadPath)}
            onNew={openNewSessionPicker}
          />
        }
      />
      <main className="main-panel">
        {socket.connectionState === 'disconnected' && <div className="disconnect-banner">Connection lost - reconnecting...</div>}
        <div className="workspace-layout">
          {state?.activeCwd && <FileExplorer root={state.activeCwd} rpc={socket.rpc} onOpenFile={(path, readOnly) => void openFile(path, readOnly)} />}
          <section className="workspace-main" aria-label="Chat workspace">
            <div className="main-content">
              {activeThreadId ? (
                <ChatTimeline
                  items={chatItems}
                  onLoadOlder={timeline.loadOlder}
                  onJumpToLatest={timeline.jumpToLatest}
                  hasOlder={timeline.hasOlder}
                  showJumpToLatest={!timeline.isViewingLatest}
                  loading={timeline.loading}
                  onOpenDetail={openDetailItem}
                  onApprovalDecision={respondToApproval}
                  onQueuedEdit={(message) => void editQueued(message as ClientQueuedMessage)}
                  onQueuedRemove={(id) => void removeQueued(id)}
                  onOpenFileSummary={openFileSummaryDiff}
                  onOpenMentionedFile={(path) => void openFile(path, true)}
                />
              ) : (
                <div className="empty-state">No active session loaded.</div>
              )}
            </div>
            {activeFileSummary && <FileChangeTray summary={activeFileSummary} onOpenDiff={openFileSummaryDiff} />}
            <InputBox
              rpc={socket.rpc}
              threadId={activeThreadId}
              isRunning={isRunning}
              activeCwd={state?.activeCwd ?? null}
              runOptions={runOptions}
              draftOverride={composerDraft}
              disabled={socket.connectionState !== 'connected'}
              onDraftConsumed={() => setComposerDraft(null)}
              onEnqueue={enqueue}
              onDirectSubmit={addPendingUserMessage}
              onDirectSubmitError={addDirectSubmitError}
            />
          </section>
        </div>
      </main>
      {editor && (
        <FileEditorModal
          path={editor.path}
          initialContent={editor.content}
          readOnly={editor.readOnly}
          onClose={() => setEditor(null)}
          onSave={(content) => saveFile(editor.path, content)}
        />
      )}
      {imageViewer && (
        <ImageViewerModal
          path={imageViewer.path}
          onClose={() => setImageViewer(null)}
          onPreviewError={(message) => setSessionError(`${message} ${imageViewer.path}`)}
        />
      )}
      {cwdPickerOpen && (
        <CwdPicker
          initialCwd={newSessionInitialCwd(state?.activeCwd, socket.hello?.startCwd)}
          rpc={socket.rpc}
          busy={sessionLoading}
          onCancel={() => setCwdPickerOpen(false)}
          onConfirm={(cwd) => void startSession(cwd)}
        />
      )}
      <AuthOverlay visible={socket.connectionState === 'auth-error'} onSubmitToken={socket.submitToken} />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}
