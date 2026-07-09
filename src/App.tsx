import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import DetailModal from './components/DetailModal';
import FileChangeTray, { type ActiveFileSummary } from './components/FileChangeTray';
import FileEditorModal from './components/FileEditorModal';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import Header from './components/Header';
import ImageViewerModal from './components/ImageViewerModal';
import InputBox from './components/InputBox';
import GoalObjectiveDialog from './components/GoalObjectiveDialog';
import GoalProgressRow from './components/GoalProgressRow';
import QueueTray from './components/QueueTray';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useQueue, type ClientQueuedMessage } from './hooks/useQueue';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import { appendEphemeralBangItem, bangOutputEventToTimelineItem, getBangCommandOutputDetail } from './lib/bangCommands';
import { FileContentTooLargeError, readTextFileStream } from './lib/fileContent';
import { isImagePath, normalizeMentionedFilePath } from './lib/filePreview';
import { parseGoalCommandValue } from './lib/goalCommands';
import { goalNeedsReplaceConfirmation } from './lib/goalLifecycle';
import { effortOptionsForModel, modelOptionsFromResult, reconcileEffortForModel } from './lib/modelOptions';
import { parseRuntimeStatusResult } from './lib/runtimeStatus';
import {
  COLLABORATION_MODES,
  SANDBOX_MODES,
  effectiveMode,
  displayRuntimeValue,
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
  appendLiveTurnNotifications,
  claimedQueuedMessageIdFromPendingUserItem,
  claimedQueuedUserItemsWithoutHistory,
  claimedQueuedUserItemsFromQueueTransition,
  createLiveTurnAccumulator,
  fileChangeHasInlineDiff,
  latestCompletionNotificationCount,
  isSyntheticPendingTurnId,
  liveTurnItemsFromAccumulator,
  mergeRetainedLiveTurnItems,
  mergeTimelineItemsByTimestamp,
  nextLiveNotificationWindow,
  notificationCountBeforeTurnStart,
  notificationsSinceCount,
  notificationMatchesActiveTurn,
  pendingUserItemsWithoutHistory,
  requestKey,
  retargetSyntheticUserItemsToTurn,
  timelineItemsWithLiveTurnOverlay,
  timelineItemsWithRetainedLiveTurnOverlay,
  timelineItemsWithRetainedTurnTimestamps,
  visibleRetainedLiveTurnItemsForTimeline,
  visibleLiveTurnItemsForTimeline,
  type TimelineItem,
} from './lib/timeline';
import type { CodexThread } from './types/codex';
import type { CodexModelOption, CodexRunOptions, RuntimeStatusResult, ThreadGoal, ThreadGoalStatus } from './types/ui';

interface OpenEditor {
  path: string;
  readOnly: boolean;
  content: string;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
}

interface OpenImage {
  path: string;
}

type UserTimelineItem = Extract<TimelineItem, { kind: 'user' }>;
type FileChangeSummaryTimelineItem = Extract<TimelineItem, { kind: 'fileChangeSummary' }>;

interface RuntimeStatusScope {
  threadId: string | null;
  threadPath: string | null;
  reconnectEpoch: number;
  generation: number;
}

type GoalDialogState =
  | { mode: 'replace'; threadId: string; currentObjective: string; currentCreatedAt: number; currentStatus: ThreadGoalStatus; proposedObjective: string }
  | { mode: 'edit'; threadId: string; currentObjective: string; currentCreatedAt: number }
  | null;

type GoalDialogError = { message: string; submitDisabled: boolean } | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const GOAL_STATUSES = new Set<ThreadGoalStatus>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: Record<string, unknown>, camelKey: string, snakeKey: string): string | null {
  const next = value[camelKey] ?? value[snakeKey];
  return typeof next === 'string' ? next : null;
}

function numberValue(value: Record<string, unknown>, camelKey: string, snakeKey: string): number | null {
  return finiteNumber(value[camelKey]) ?? finiteNumber(value[snakeKey]);
}

function goalFromValue(value: unknown): ThreadGoal | null {
  if (!isRecord(value)) return null;
  const threadId = stringValue(value, 'threadId', 'thread_id');
  const objective = typeof value.objective === 'string' ? value.objective : null;
  const statusValue = value.status;
  if (
    !threadId ||
    !objective ||
    typeof statusValue !== 'string' ||
    !GOAL_STATUSES.has(statusValue as ThreadGoalStatus)
  ) {
    return null;
  }
  const status = statusValue as ThreadGoalStatus;

  const rawTokenBudget = value.tokenBudget ?? value.token_budget;
  const tokenBudget = rawTokenBudget === null || rawTokenBudget === undefined ? null : finiteNumber(rawTokenBudget);
  const tokensUsed = numberValue(value, 'tokensUsed', 'tokens_used');
  const timeUsedSeconds = numberValue(value, 'timeUsedSeconds', 'time_used_seconds');
  const createdAt = numberValue(value, 'createdAt', 'created_at');
  const updatedAt = numberValue(value, 'updatedAt', 'updated_at');
  if (tokenBudget === null && rawTokenBudget !== null && rawTokenBudget !== undefined) return null;
  if (tokensUsed === null || timeUsedSeconds === null || createdAt === null || updatedAt === null) return null;

  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function goalFromRpcResult(result: unknown): ThreadGoal | null {
  if (!isRecord(result)) return null;
  return goalFromValue(result.goal) ?? goalFromValue(getNestedRecord(result, 'data')?.goal) ?? goalFromValue(result);
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  if (status === 'usageLimited') return 'usage limited';
  if (status === 'budgetLimited') return 'budget limited';
  return status;
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

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
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
  const timeline = useThreadTimeline(activeThreadId, activeThreadPath, socket.rpc);
  const { queue: queuedMessages, enqueue, remove: removeFromQueue, replace: replaceQueue } = useQueue(socket.rpc, state?.queue ?? []);
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [codexRestarting, setCodexRestarting] = useState(false);
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
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalDialog, setGoalDialog] = useState<GoalDialogState>(null);
  const [goalDialogError, setGoalDialogError] = useState<GoalDialogError>(null);
  const [readyIdleGoalKey, setReadyIdleGoalKey] = useState<string | null>(null);
  const [idleGoalGraceGeneration, setIdleGoalGraceGeneration] = useState(0);
  const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set());
  const [model, setModelState] = useState<string | null>(() => sanitizeStoredModel(localStorageValue('codex-web-ui:model')));
  const [mode, setModeState] = useState<string | null>(initialMode);
  const [effort, setEffortState] = useState<string | null>(() => sanitizeStoredEffort(localStorageValue('codex-web-ui:effort')));
  const [sandbox, setSandboxState] = useState<string | null>(initialSandbox);
  const [modelOptions, setModelOptions] = useState<CodexModelOption[]>([]);
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [runtimeOptionsBusy, setRuntimeOptionsBusy] = useState(false);
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
  const transientSessionMessageTimerRef = useRef<number | null>(null);
  const manuallyRemovedQueuedIdsRef = useRef(new Set<string>());
  const finalizedFileSummaryFetchesRef = useRef(new Set<string>());
  const liveNotificationWindowRef = useRef({ activeThreadId, activeTurnId: state?.activeTurnId ?? null, startCount: socket.notificationCount });
  const lastHandledCompletionCountRef = useRef<number | null>(null);
  const fileOpenGenerationRef = useRef(0);
  const fileOpenAbortRef = useRef<AbortController | null>(null);
  const modelOptionsRef = useRef<CodexModelOption[]>([]);
  const modelCatalogLoadedRef = useRef(false);
  const modelCatalogRequestRef = useRef<Promise<CodexModelOption[]> | null>(null);
  const modelCatalogGenerationRef = useRef(0);
  const runtimeOptionsBusyRef = useRef(false);
  const runtimeStatusScopeRef = useRef<RuntimeStatusScope>({
    threadId: activeThreadId,
    threadPath: activeThreadPath,
    reconnectEpoch: socket.reconnectEpoch,
    generation: 0,
  });
  const runtimeStatusRequestSequenceRef = useRef(0);
  const activeGoalThreadRef = useRef(activeThreadId);
  const goalOperationGenerationRef = useRef(0);
  const goalBusyRef = useRef(false);
  const pendingTurnStartCount = pendingTurnWindow?.threadId === activeThreadId ? pendingTurnWindow.startCount : null;
  const observedTurnStartCount = notificationCountBeforeTurnStart(
    socket.notifications,
    socket.notificationCount,
    { activeThreadId, activeTurnId: state?.activeTurnId ?? null },
  );
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
    { pendingStartCount: pendingTurnStartCount, turnStartCount: observedTurnStartCount },
  );

  useLayoutEffect(() => {
    const current = runtimeStatusScopeRef.current;
    if (
      current.threadId === activeThreadId &&
      current.threadPath === activeThreadPath &&
      current.reconnectEpoch === socket.reconnectEpoch
    ) {
      return;
    }
    runtimeStatusScopeRef.current = {
      threadId: activeThreadId,
      threadPath: activeThreadPath,
      reconnectEpoch: socket.reconnectEpoch,
      generation: current.generation + 1,
    };
  }, [activeThreadId, activeThreadPath, socket.reconnectEpoch]);

  useLayoutEffect(() => {
    activeGoalThreadRef.current = activeThreadId;
    goalOperationGenerationRef.current += 1;
    goalBusyRef.current = false;
    setGoalDialog(null);
    setGoalDialogError(null);
    setGoalBusy(false);
  }, [activeThreadId]);

  useEffect(() => {
    return () => {
      fileOpenAbortRef.current?.abort();
      if (transientSessionMessageTimerRef.current !== null) window.clearTimeout(transientSessionMessageTimerRef.current);
    };
  }, []);
  const showTransientSessionMessage = useCallback((message: string, durationMs = 3000) => {
    if (transientSessionMessageTimerRef.current !== null) window.clearTimeout(transientSessionMessageTimerRef.current);
    setSessionError(message);
    transientSessionMessageTimerRef.current = window.setTimeout(() => {
      setSessionError((current) => (current === message ? null : current));
      transientSessionMessageTimerRef.current = null;
    }, durationMs);
  }, []);
  const invalidateModelCatalog = useCallback(() => {
    modelCatalogGenerationRef.current += 1;
    modelCatalogLoadedRef.current = false;
    modelCatalogRequestRef.current = null;
    modelOptionsRef.current = [];
    setModelOptions([]);
    setModelOptionsLoading(false);
  }, []);
  const liveNotificationActiveTurnId = liveNotificationWindowRef.current.activeTurnId;
  const liveNotificationStartCount = liveNotificationWindowRef.current.startCount;
  const lastNotification = socket.notifications.at(-1);
  const liveNotificationWindowKey = `${activeThreadId ?? ''}\0${liveNotificationActiveTurnId ?? ''}\0${liveNotificationStartCount}`;
  const [liveNotificationSnapshot, setLiveNotificationSnapshot] = useState(() => ({
    key: liveNotificationWindowKey,
    accumulator: createLiveTurnAccumulator(),
  }));
  const liveNotificationAccumulatorRef = useRef({
    key: liveNotificationWindowKey,
    processedCount: liveNotificationStartCount,
    accumulator: liveNotificationSnapshot.accumulator,
  });
  const acknowledgedReplayGapEpochRef = useRef(0);
  useEffect(() => {
    const current = liveNotificationAccumulatorRef.current;
    const scope = { activeThreadId, activeTurnId: liveNotificationActiveTurnId };
    const acceptUnscoped = Boolean(liveNotificationActiveTurnId);
    if (
      current.key !== liveNotificationWindowKey ||
      current.processedCount < liveNotificationStartCount ||
      current.processedCount > socket.notificationCount
    ) {
      const retained = notificationsSinceCount(socket.notifications, socket.notificationCount, liveNotificationStartCount);
      const accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), retained, scope, Date.now(), { acceptUnscoped });
      liveNotificationAccumulatorRef.current = {
        key: liveNotificationWindowKey,
        processedCount: socket.notificationCount,
        accumulator,
      };
      setLiveNotificationSnapshot({ key: liveNotificationWindowKey, accumulator });
      return;
    }

    const additions = notificationsSinceCount(socket.notifications, socket.notificationCount, current.processedCount);
    if (additions.length === 0) return;
    const accumulator = appendLiveTurnNotifications(current.accumulator, additions, scope, Date.now(), { acceptUnscoped });
    liveNotificationAccumulatorRef.current = {
      key: liveNotificationWindowKey,
      processedCount: socket.notificationCount,
      accumulator,
    };
    setLiveNotificationSnapshot({ key: liveNotificationWindowKey, accumulator });
  }, [activeThreadId, liveNotificationActiveTurnId, liveNotificationStartCount, liveNotificationWindowKey, socket.notificationCount, socket.notifications]);
  const liveTurnItems = useMemo(
    () =>
      liveNotificationSnapshot.key === liveNotificationWindowKey
        ? liveTurnItemsFromAccumulator(liveNotificationSnapshot.accumulator, Boolean(state?.activeTurnId))
        : [],
    [liveNotificationSnapshot, liveNotificationWindowKey, state?.activeTurnId],
  );
  const timelineItemsForChat = useMemo(
    () => timelineItemsWithLiveTurnOverlay(timeline.items, liveTurnItems, state?.activeTurnId ? liveNotificationActiveTurnId : null),
    [liveNotificationActiveTurnId, liveTurnItems, state?.activeTurnId, timeline.items],
  );
  const retainedOverlayItems = useMemo(
    () => [...retainedLiveTurnItems, ...retainedFileSummaryItems],
    [retainedFileSummaryItems, retainedLiveTurnItems],
  );
  const timelineItemsForChatWithRetainedOverlay = useMemo(
    () => timelineItemsWithRetainedLiveTurnOverlay(timelineItemsForChat, retainedOverlayItems),
    [retainedOverlayItems, timelineItemsForChat],
  );
  const retainedLiveTurnItemsForChat = useMemo(
    () => timelineItemsWithRetainedTurnTimestamps(timelineItemsForChat, retainedLiveTurnItems),
    [retainedLiveTurnItems, timelineItemsForChat],
  );
  const latestCompletionCount = useMemo(
    () =>
      latestCompletionNotificationCount(socket.notifications, socket.notificationCount, {
        activeThreadId,
        activeTurnId: null,
      }),
    [activeThreadId, socket.notificationCount, socket.notifications],
  );
  const visibleLiveTurnItems = useMemo(
    () => visibleLiveTurnItemsForTimeline(timelineItemsForChatWithRetainedOverlay, liveTurnItems, { allowAssistantTextMatchAcrossSources: !state?.activeTurnId }),
    [liveTurnItems, state?.activeTurnId, timelineItemsForChatWithRetainedOverlay],
  );
  const visibleRetainedLiveTurnItems = useMemo(
    () => visibleRetainedLiveTurnItemsForTimeline(timelineItemsForChatWithRetainedOverlay, visibleLiveTurnItems, retainedLiveTurnItemsForChat),
    [retainedLiveTurnItemsForChat, timelineItemsForChatWithRetainedOverlay, visibleLiveTurnItems],
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
  const visibleRetainedFileSummaryItemsForChat = useMemo(
    () => timelineItemsWithRetainedTurnTimestamps(timelineItemsForChat, visibleRetainedFileSummaryItems),
    [timelineItemsForChat, visibleRetainedFileSummaryItems],
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
      ...timelineItemsForChatWithRetainedOverlay,
      ...visibleRetainedLiveTurnItems,
      ...visibleRetainedFileSummaryItemsForChat,
      ...pendingUserItems,
      ...claimedQueuedUserItems,
      ...ephemeralItems,
      ...visibleLiveTurnItems,
      ...approvalItems,
    ]);
  }, [approvalItems, claimedQueuedUserItems, ephemeralItems, pendingUserItems, timeline.isViewingLatest, timeline.items, timelineItemsForChatWithRetainedOverlay, visibleLiveTurnItems, visibleRetainedFileSummaryItemsForChat, visibleRetainedLiveTurnItems]);
  const serverModel = sanitizeStoredModel(state?.model ?? null);
  const serverEffort = sanitizeStoredEffort(state?.effort ?? null);
  const serverMode = sanitizeStoredMode(state?.mode ?? null);
  const serverSandbox = sanitizeStoredSandbox(state?.sandbox ?? null);
  const displayModel = displayRuntimeValue(activeThreadId, serverModel, model);
  const displayEffort = displayRuntimeValue(activeThreadId, serverEffort, effort);
  const displayMode = displayRuntimeValue(activeThreadId, serverMode, mode);
  const displaySandbox = displayRuntimeValue(activeThreadId, serverSandbox, sandbox);
  const runModel = activeThreadId ? displayModel : model;
  const runEffort = activeThreadId ? displayEffort : effort;
  const runMode = activeThreadId ? displayMode : mode;
  const runSandbox = activeThreadId ? displaySandbox : sandbox;
  const runOptions = useMemo<CodexRunOptions>(
    () => ({ model: runModel, mode: effectiveMode(runMode, runModel), effort: runEffort, sandbox: runSandbox }),
    [runEffort, runMode, runModel, runSandbox],
  );
  const isRunning = Boolean(state?.activeTurnId || (pendingCompactionThreadId && pendingCompactionThreadId === activeThreadId));
  const activeGoal = state?.activeGoal ?? null;
  const threadGoal = activeGoal && activeGoal.threadId === activeThreadId ? activeGoal : null;
  const visibleGoal = threadGoal?.status !== 'complete' ? threadGoal : null;
  const activeIdleGoalKey =
    visibleGoal?.status === 'active' && !isRunning
      ? `${activeThreadId ?? ''}\0${visibleGoal.createdAt}\0${visibleGoal.updatedAt}\0${visibleGoal.objective}`
      : null;
  const goalIdleRecoveryReady = activeIdleGoalKey !== null && readyIdleGoalKey === activeIdleGoalKey;
  const hasActiveStreamingText = useMemo(
    () => visibleLiveTurnItems.some((item) => item.kind === 'streaming' && item.active && item.text.trim().length > 0),
    [visibleLiveTurnItems],
  );
  const showActivityRunning = isRunning && !hasActiveStreamingText;

  useEffect(() => {
    setReadyIdleGoalKey(null);
    if (!activeIdleGoalKey) return;
    const timer = window.setTimeout(() => setReadyIdleGoalKey(activeIdleGoalKey), 1500);
    return () => window.clearTimeout(timer);
  }, [activeIdleGoalKey, idleGoalGraceGeneration]);

  const restartCodex = useCallback(async () => {
    if (isRunning) {
      setSessionError('Stop the active turn before restarting Codex');
      return;
    }

    setCodexRestarting(true);
    setSessionError('Restarting Codex app-server...');
    try {
      await socket.rpc('webui/codex/restart', undefined, 120_000);
      invalidateModelCatalog();
      showTransientSessionMessage('Codex app-server restarted');
      if (activeThreadId) void timeline.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexRestarting(false);
    }
  }, [activeThreadId, invalidateModelCatalog, isRunning, showTransientSessionMessage, socket.rpc, timeline.reload]);

  useEffect(() => {
    if (!activeThreadId || socket.connectionState !== 'connected') return;
    try {
      void Promise.resolve(socket.rpc('webui/thread/goal/get', { threadId: activeThreadId }, 5_000)).catch(() => undefined);
    } catch {
      // Goal refresh is best-effort; command handlers surface actionable failures.
    }
  }, [activeThreadId, socket.connectionState, socket.reconnectEpoch, socket.rpc]);

  const goalOperationIsCurrent = useCallback(
    (threadId: string, generation: number) =>
      activeGoalThreadRef.current === threadId && goalOperationGenerationRef.current === generation,
    [],
  );

  const beginGoalOperation = useCallback((threadId: string): number | null => {
    if (goalBusyRef.current || activeGoalThreadRef.current !== threadId) return null;
    goalBusyRef.current = true;
    const generation = (goalOperationGenerationRef.current += 1);
    setGoalBusy(true);
    return generation;
  }, []);

  const finishGoalOperation = useCallback((threadId: string, generation: number) => {
    if (!goalOperationIsCurrent(threadId, generation)) return;
    goalBusyRef.current = false;
    setGoalBusy(false);
  }, [goalOperationIsCurrent]);

  const setGoalStatus = useCallback(
    async (status: ThreadGoalStatus) => {
      if (!activeThreadId) {
        setSessionError('Start or resume a session before managing a goal');
        return;
      }
      const threadId = activeThreadId;
      const generation = beginGoalOperation(threadId);
      if (generation === null) {
        setSessionError('A goal update is already in progress');
        return;
      }
      try {
        await socket.rpc('webui/thread/goal/set', { threadId, status });
        if (!goalOperationIsCurrent(threadId, generation)) return;
        showTransientSessionMessage(`Goal ${goalStatusLabel(status)}`);
      } catch (error) {
        if (!goalOperationIsCurrent(threadId, generation)) return;
        setSessionError(error instanceof Error ? error.message : String(error));
      } finally {
        finishGoalOperation(threadId, generation);
      }
    },
    [activeThreadId, beginGoalOperation, finishGoalOperation, goalOperationIsCurrent, showTransientSessionMessage, socket.rpc],
  );

  const clearGoal = useCallback(async () => {
    if (!activeThreadId) {
      setSessionError('Start or resume a session before clearing a goal');
      return;
    }
    const threadId = activeThreadId;
    const generation = beginGoalOperation(threadId);
    if (generation === null) {
      setSessionError('A goal update is already in progress');
      return;
    }
    try {
      await socket.rpc('webui/thread/goal/clear', { threadId });
      if (!goalOperationIsCurrent(threadId, generation)) return;
      showTransientSessionMessage('Goal cleared');
    } catch (error) {
      if (!goalOperationIsCurrent(threadId, generation)) return;
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      finishGoalOperation(threadId, generation);
    }
  }, [activeThreadId, beginGoalOperation, finishGoalOperation, goalOperationIsCurrent, showTransientSessionMessage, socket.rpc]);

  const editGoal = useCallback(() => {
    if (!threadGoal || !activeThreadId) return;
    setGoalDialogError(null);
    setGoalDialog({
      mode: 'edit',
      threadId: activeThreadId,
      currentObjective: threadGoal.objective,
      currentCreatedAt: threadGoal.createdAt,
    });
  }, [activeThreadId, threadGoal]);

  const proposeGoal = useCallback(async (objective: string) => {
    if (!activeThreadId) return;
    const threadId = activeThreadId;
    const generation = beginGoalOperation(threadId);
    if (generation === null) {
      setComposerDraft(`/goal ${objective}`);
      setSessionError('A goal update is already in progress');
      return;
    }
    try {
      const result = await socket.rpc('webui/thread/goal/get', { threadId });
      if (!goalOperationIsCurrent(threadId, generation)) return;
      const currentGoal = goalFromRpcResult(result);
      if (currentGoal && goalNeedsReplaceConfirmation(currentGoal)) {
        setGoalDialogError(null);
        setGoalDialog({
          mode: 'replace',
          threadId,
          currentObjective: currentGoal.objective,
          currentCreatedAt: currentGoal.createdAt,
          currentStatus: currentGoal.status,
          proposedObjective: objective,
        });
        return;
      }
      const expectedGoal = currentGoal
        ? { objective: currentGoal.objective, createdAt: currentGoal.createdAt, status: currentGoal.status }
        : null;
      await socket.rpc('webui/thread/goal/replace', { threadId, objective, expectedGoal });
      if (!goalOperationIsCurrent(threadId, generation)) return;
      showTransientSessionMessage('Goal set');
    } catch (error) {
      if (!goalOperationIsCurrent(threadId, generation)) return;
      setComposerDraft(`/goal ${objective}`);
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      finishGoalOperation(threadId, generation);
    }
  }, [activeThreadId, beginGoalOperation, finishGoalOperation, goalOperationIsCurrent, showTransientSessionMessage, socket.rpc]);

  const confirmGoalReplacement = useCallback(async () => {
    if (!goalDialog || goalDialog.mode !== 'replace' || goalDialog.threadId !== activeThreadId) return;
    const dialog = goalDialog;
    const generation = beginGoalOperation(dialog.threadId);
    if (generation === null) return;
    try {
      await socket.rpc('webui/thread/goal/replace', {
        threadId: dialog.threadId,
        objective: dialog.proposedObjective,
        expectedGoal: { objective: dialog.currentObjective, createdAt: dialog.currentCreatedAt, status: dialog.currentStatus },
      });
      if (!goalOperationIsCurrent(dialog.threadId, generation)) return;
      setGoalDialog(null);
      setGoalDialogError(null);
      showTransientSessionMessage('Goal set');
    } catch (error) {
      if (!goalOperationIsCurrent(dialog.threadId, generation)) return;
      setGoalDialog(null);
      setGoalDialogError(null);
      setComposerDraft(`/goal ${dialog.proposedObjective}`);
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      finishGoalOperation(dialog.threadId, generation);
    }
  }, [activeThreadId, beginGoalOperation, finishGoalOperation, goalDialog, goalOperationIsCurrent, showTransientSessionMessage, socket.rpc]);

  const saveGoalEdit = useCallback(async (objective: string) => {
    if (!goalDialog || goalDialog.mode !== 'edit' || goalDialog.threadId !== activeThreadId) return;
    const dialog = goalDialog;
    const generation = beginGoalOperation(dialog.threadId);
    if (generation === null) return;
    setGoalDialogError(null);
    try {
      await socket.rpc('webui/thread/goal/edit', {
        threadId: dialog.threadId,
        objective,
        expectedGoal: { objective: dialog.currentObjective, createdAt: dialog.currentCreatedAt },
      });
      if (!goalOperationIsCurrent(dialog.threadId, generation)) return;
      setGoalDialog(null);
      setGoalDialogError(null);
      showTransientSessionMessage('Goal updated');
    } catch (error) {
      if (!goalOperationIsCurrent(dialog.threadId, generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      const stale = /goal (?:changed|edit conflicted|edit failed because the goal no longer exists)/i.test(message);
      setGoalDialogError({
        message: stale ? `${message}. Cancel and reopen Edit before retrying.` : message,
        submitDisabled: stale,
      });
      setSessionError(message);
    } finally {
      finishGoalOperation(dialog.threadId, generation);
    }
  }, [activeThreadId, beginGoalOperation, finishGoalOperation, goalDialog, goalOperationIsCurrent, showTransientSessionMessage, socket.rpc]);

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
      { ignoredRemovedMessageIds: manuallyRemovedQueuedIdsRef.current },
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
    for (const id of Array.from(manuallyRemovedQueuedIdsRef.current)) {
      if (!nextQueueIds.has(id)) manuallyRemovedQueuedIdsRef.current.delete(id);
    }
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
    setClaimedQueuedUserItems((items) => {
      const retargeted = retargetSyntheticUserItemsToTurn(items, state?.activeTurnId);
      const next = claimedQueuedUserItemsWithoutHistory(timeline.items, retargeted);
      return next === items ? items : next;
    });
  }, [state?.activeTurnId, timeline.items]);

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
    const epoch = socket.replayGapEpoch;
    if (epoch === 0 || epoch <= acknowledgedReplayGapEpochRef.current || socket.connectionState !== 'connected') return;
    if (!activeThreadId) {
      socket.acknowledgeReplayGap(epoch);
      acknowledgedReplayGapEpochRef.current = epoch;
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const recover = async (attempt: number) => {
      const recovered = await timeline.reload();
      if (cancelled) return;
      if (recovered) {
        socket.acknowledgeReplayGap(epoch);
        acknowledgedReplayGapEpochRef.current = epoch;
        return;
      }
      const delay = Math.min(5_000, 250 * 2 ** attempt);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void recover(attempt + 1);
      }, delay);
    };
    void recover(0);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [activeThreadId, socket.acknowledgeReplayGap, socket.connectionState, socket.replayGapEpoch, timeline.reload]);

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

  const loadRuntimeOptions = useCallback(async (): Promise<CodexModelOption[]> => {
    if (modelCatalogLoadedRef.current) return modelOptionsRef.current;
    if (modelCatalogRequestRef.current) return modelCatalogRequestRef.current;

    const generation = modelCatalogGenerationRef.current;
    setModelOptionsLoading(true);
    const request = Promise.resolve()
      .then(() => socket.rpc<unknown>('webui/model/list'))
      .then((result) => {
        if (generation !== modelCatalogGenerationRef.current) return modelOptionsRef.current;
        const options = modelOptionsFromResult(result);
        modelOptionsRef.current = options;
        modelCatalogLoadedRef.current = true;
        setModelOptions(options);
        return options;
      })
      .catch((error) => {
        if (generation === modelCatalogGenerationRef.current) {
          setSessionError(error instanceof Error ? error.message : String(error));
        }
        return modelOptionsRef.current;
      })
      .finally(() => {
        if (modelCatalogRequestRef.current === request) modelCatalogRequestRef.current = null;
        if (generation === modelCatalogGenerationRef.current) setModelOptionsLoading(false);
      });

    modelCatalogRequestRef.current = request;
    return request;
  }, [socket.rpc]);

  const applyRuntimeOptions = useCallback(async (next: { model?: string | null; effort?: string | null; mode?: string | null; sandbox?: string | null }): Promise<boolean> => {
    if (runtimeOptionsBusyRef.current) return false;
    if (isRunning) {
      setSessionError('Stop the active turn before changing model or effort');
      return false;
    }
    if (socket.connectionState !== 'connected') {
      setSessionError('Reconnect before changing model or effort');
      return false;
    }

    if (!activeThreadId) {
      if (next.model !== undefined) setModel(next.model);
      if (next.effort !== undefined) setEffort(next.effort);
      if (next.mode !== undefined) setMode(next.mode);
      if (next.sandbox !== undefined) setSandbox(next.sandbox);
      return true;
    }

    runtimeOptionsBusyRef.current = true;
    setRuntimeOptionsBusy(true);
    setSessionError(null);
    try {
      const result = await socket.rpc<unknown>('webui/thread/runtime-options/set', {
        threadId: activeThreadId,
        ...next,
      });
      const record = isRecord(result) ? result : null;
      const resultModel = sanitizeStoredModel(typeof record?.model === 'string' ? record.model : null);
      const resultEffort = sanitizeStoredEffort(typeof record?.effort === 'string' ? record.effort : null);
      const resultMode = sanitizeStoredMode(typeof record?.mode === 'string' ? record.mode : null);
      const resultSandbox = sanitizeStoredSandbox(typeof record?.sandbox === 'string' ? record.sandbox : null);
      setModel(resultModel ?? (next.model !== undefined ? next.model : displayModel));
      setEffort(resultEffort ?? (next.effort !== undefined ? next.effort : displayEffort));
      setMode(resultMode ?? (next.mode !== undefined ? next.mode : displayMode));
      setSandbox(resultSandbox ?? (next.sandbox !== undefined ? next.sandbox : displaySandbox));
      return true;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runtimeOptionsBusyRef.current = false;
      setRuntimeOptionsBusy(false);
    }
  }, [activeThreadId, displayEffort, displayMode, displayModel, displaySandbox, isRunning, setEffort, setMode, setModel, setSandbox, socket.connectionState, socket.rpc]);

  const selectModel = useCallback(async (value: string) => {
    const nextModel = sanitizeStoredModel(value);
    if (!nextModel) {
      setSessionError('Choose a valid model');
      return;
    }
    const catalog = await loadRuntimeOptions();
    const nextEffort = reconcileEffortForModel(catalog, nextModel, runEffort);
    if (await applyRuntimeOptions({ model: nextModel, effort: nextEffort })) {
      showTransientSessionMessage(`Model set to ${nextModel}`);
    }
  }, [applyRuntimeOptions, loadRuntimeOptions, runEffort, showTransientSessionMessage]);

  const selectEffort = useCallback(async (value: string) => {
    const nextEffort = sanitizeStoredEffort(value);
    if (!nextEffort) {
      setSessionError('Choose a valid reasoning effort');
      return;
    }
    const catalog = await loadRuntimeOptions();
    const supported = effortOptionsForModel(catalog, runModel);
    if (supported.length > 0 && !supported.some((option) => option.reasoningEffort === nextEffort)) {
      setSessionError(`Effort for ${runModel} must be one of ${supported.map((option) => option.reasoningEffort).join(', ')}`);
      return;
    }
    if (await applyRuntimeOptions({ effort: nextEffort })) {
      showTransientSessionMessage(`Effort set to ${nextEffort}`);
    }
  }, [applyRuntimeOptions, loadRuntimeOptions, runModel, showTransientSessionMessage]);

  const selectMode = useCallback(async (value: string) => {
    const nextMode = sanitizeStoredMode(value);
    if (!nextMode) {
      setSessionError('Mode must be default or plan');
      return;
    }
    if (await applyRuntimeOptions({ mode: nextMode })) {
      showTransientSessionMessage(`Mode set to ${nextMode}`);
    }
  }, [applyRuntimeOptions, showTransientSessionMessage]);

  const selectSandbox = useCallback(async (value: string) => {
    const nextSandbox = sanitizeStoredSandbox(value);
    if (!nextSandbox) {
      setSessionError('Sandbox must be read-only, workspace-write, or danger-full-access');
      return;
    }
    if (await applyRuntimeOptions({ sandbox: nextSandbox })) {
      showTransientSessionMessage(`Sandbox set to ${nextSandbox}`);
    }
  }, [applyRuntimeOptions, showTransientSessionMessage]);

  const selectedEffortOptions = useMemo(
    () => effortOptionsForModel(modelOptions, runModel),
    [modelOptions, runModel],
  );

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

  const appendRuntimeStatus = useCallback((status: RuntimeStatusResult) => {
    const timestamp = Date.now();
    const id = `runtime-status:${timestamp}:${(ephemeralCounterRef.current += 1)}`;
    setEphemeralItems((items) => [
      ...items,
      { id, kind: 'runtimeStatus', timestamp, sortOrder: localSortOrder(id), status },
    ]);
  }, [localSortOrder]);

  const appendRuntimeStatusError = useCallback(() => {
    const timestamp = Date.now();
    const id = `runtime-status-error:${timestamp}:${(ephemeralCounterRef.current += 1)}`;
    setEphemeralItems((items) => [
      ...items,
      {
        id,
        kind: 'error',
        timestamp,
        sortOrder: localSortOrder(id),
        text: 'Unable to load runtime status. Retry /status.',
      },
    ]);
  }, [localSortOrder]);

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
      await socket.rpc('webui/session/resume', { threadId, threadPath });
      window.location.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      setSessionLoading(false);
    }
  }, [socket.rpc]);

  useEffect(() => {
    const handleSlashCommand = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.input !== 'string') return;
      const { command, value } = parseSlashCommand(event.detail.input);

      if (command === '/help') {
        setSessionError('Commands: /new, /resume [id], /model <name>, /effort <level>, /mode <value>, /sandbox <value>, /goal [objective|pause|resume|clear], /compact, /diff, /status');
        return;
      }
      if (command === '/status') {
        setSessionError(null);
        const requestSequence = (runtimeStatusRequestSequenceRef.current += 1);
        if (!timeline.isViewingLatest) timeline.jumpToLatest();
        const requestedScope = runtimeStatusScopeRef.current;
        if (
          requestedScope.threadId !== activeThreadId ||
          requestedScope.threadPath !== activeThreadPath ||
          requestedScope.reconnectEpoch !== socket.reconnectEpoch
        ) {
          return;
        }
        if (!activeThreadId) {
          appendRuntimeStatus({
            hostname: socket.hello?.hostname ?? 'unknown',
            threadId: null,
            cwd: state?.activeCwd ?? null,
            activeTurnId: state?.activeTurnId ?? null,
            model: displayModel,
            effort: displayEffort,
            mode: displayMode,
            sandbox: displaySandbox,
            confirmed: false,
            confirmationSource: null,
            confirmedAt: null,
            lastTurn: { status: 'none', context: null, scannedBytes: 0 },
          });
          return;
        }

        const requestedThreadId = activeThreadId;
        const requestIsCurrent = () => {
          const currentScope = runtimeStatusScopeRef.current;
          return (
            runtimeStatusRequestSequenceRef.current === requestSequence &&
            currentScope.threadId === requestedScope.threadId &&
            currentScope.threadPath === requestedScope.threadPath &&
            currentScope.reconnectEpoch === requestedScope.reconnectEpoch &&
            currentScope.generation === requestedScope.generation
          );
        };
        void (async () => {
          try {
            const rawResult = await socket.rpc<unknown>('webui/thread/status', { threadId: requestedThreadId });
            if (!requestIsCurrent()) return;
            const result = parseRuntimeStatusResult(rawResult, requestedThreadId);
            appendRuntimeStatus(result);
          } catch {
            if (!requestIsCurrent()) return;
            appendRuntimeStatusError();
          }
        })();
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
      if (command === '/goal') {
        if (!activeThreadId) {
          setSessionError('Start or resume a session before managing a goal');
          return;
        }
        const goalCommand = parseGoalCommandValue(value);
        if (goalCommand.type === 'error') {
          setSessionError(goalCommand.message);
          return;
        }
        if (goalCommand.type === 'clear') {
          void clearGoal();
          return;
        }
        if (goalCommand.type === 'pause' || goalCommand.type === 'resume') {
          void setGoalStatus(goalCommand.type === 'pause' ? 'paused' : 'active');
          return;
        }
        if (goalCommand.type === 'set') {
          void proposeGoal(goalCommand.objective);
          return;
        }
        void (async () => {
          const threadId = activeThreadId;
          const generation = beginGoalOperation(threadId);
          if (generation === null) {
            setSessionError('A goal update is already in progress');
            return;
          }
          try {
            const result = await socket.rpc('webui/thread/goal/get', { threadId });
            if (!goalOperationIsCurrent(threadId, generation)) return;
            const goal = goalFromRpcResult(result);
            setSessionError(goal ? `Goal ${goalStatusLabel(goal.status)}: ${goal.objective}` : 'No active goal');
          } catch (error) {
            if (!goalOperationIsCurrent(threadId, generation)) return;
            setSessionError(error instanceof Error ? error.message : String(error));
          } finally {
            finishGoalOperation(threadId, generation);
          }
        })();
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
        void selectModel(value);
        return;
      }
      if (command === '/effort') {
        if (!value) {
          setSessionError('Usage: /effort <level>');
          return;
        }
        void selectEffort(value);
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
        if (!runModel) {
          setSessionError('Set /model before /mode so Codex can apply the mode');
          return;
        }
        void selectMode(value);
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
        void selectSandbox(value);
      }
    };

    window.addEventListener('webui-slash-command', handleSlashCommand);
    return () => window.removeEventListener('webui-slash-command', handleSlashCommand);
  }, [activeThreadId, activeThreadPath, appendRuntimeStatus, appendRuntimeStatusError, beginGoalOperation, clearGoal, displayEffort, displayMode, displayModel, displaySandbox, finishGoalOperation, goalOperationIsCurrent, loadSessions, proposeGoal, resumeSession, runModel, selectEffort, selectMode, selectModel, selectSandbox, setGoalStatus, socket.hello?.hostname, socket.reconnectEpoch, socket.rpc, state?.activeCwd, state?.activeTurnId, timeline.isViewingLatest, timeline.jumpToLatest]);

  const editQueued = useCallback(async (message: ClientQueuedMessage) => {
    setSessionError(null);
    try {
      const result = await removeFromQueue(message.id, (removeResult) => {
        if (removeResult.removed) manuallyRemovedQueuedIdsRef.current.add(message.id);
      });
      if (!result.removed) {
        setSessionError('Queued message was already sent.');
        return;
      }
      setComposerDraft(message.text);
    } catch (error) {
      manuallyRemovedQueuedIdsRef.current.delete(message.id);
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [removeFromQueue]);

  const removeQueued = useCallback(async (message: ClientQueuedMessage): Promise<boolean> => {
    setSessionError(null);
    try {
      const result = await removeFromQueue(message.id, (removeResult) => {
        if (removeResult.removed) manuallyRemovedQueuedIdsRef.current.add(message.id);
      });
      if (result.removed) setComposerDraft(message.text);
      return result.removed;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [removeFromQueue]);

  const openFile = useCallback(async (path: string, readOnly: boolean) => {
    setSessionError(null);
    fileOpenAbortRef.current?.abort();
    fileOpenAbortRef.current = null;
    const generation = fileOpenGenerationRef.current + 1;
    fileOpenGenerationRef.current = generation;
    const isCurrentOpen = (controller: AbortController) =>
      fileOpenGenerationRef.current === generation && fileOpenAbortRef.current === controller && !controller.signal.aborted;

    if (isImagePath(path)) {
      setEditor(null);
      setImageViewer({ path });
      return;
    }

    const controller = new AbortController();
    fileOpenAbortRef.current = controller;

    try {
      setImageViewer(null);
      const contentResult = await readTextFileStream(path, { signal: controller.signal });
      if (!isCurrentOpen(controller)) return;
      let modifiedAtMs = contentResult.modifiedAtMs;
      if (modifiedAtMs === null) {
        const metadataResult = await socket.rpc<unknown>('webui/fs/getMetadata', { path });
        if (!isCurrentOpen(controller)) return;
        modifiedAtMs = extractModifiedAtMs(metadataResult);
      }
      setEditor({
        path,
        readOnly,
        content: contentResult.content,
        sizeBytes: contentResult.sizeBytes,
        modifiedAtMs,
      });
    } catch (error) {
      if (controller.signal.aborted || fileOpenGenerationRef.current !== generation || isAbortError(error)) return;
      setSessionError(
        error instanceof FileContentTooLargeError
          ? `${error.message} Use the file explorer download button for this file.`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      if (fileOpenGenerationRef.current === generation && fileOpenAbortRef.current === controller) {
        fileOpenAbortRef.current = null;
      }
    }
  }, [socket.rpc]);

  const handleQueuedEdit = useCallback((message: Extract<TimelineItem, { kind: 'queued' }>['message']) => {
    void editQueued(message as ClientQueuedMessage);
  }, [editQueued]);

  const handleQueuedRemove = useCallback((message: ClientQueuedMessage) => {
    void removeQueued(message).then((removed) => {
      if (!removed) manuallyRemovedQueuedIdsRef.current.delete(message.id);
    });
  }, [removeQueued]);

  const handleQueuedTimelineRemove = useCallback((id: string) => {
    const message = queuedMessages.find((candidate) => candidate.id === id);
    if (message) handleQueuedRemove(message);
  }, [handleQueuedRemove, queuedMessages]);

  const handleOpenMentionedFile = useCallback((path: string) => {
    void openFile(normalizeMentionedFilePath(path), true);
  }, [openFile]);

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
    [socket.rpc],
  );

  return (
    <div className="app-shell">
      <Header
        hostname={socket.hello?.hostname ?? null}
        connectionState={socket.connectionState}
        activeThreadId={state?.activeThreadId ?? null}
        cwd={state?.activeCwd ?? null}
        model={displayModel}
        mode={displayMode}
        effort={displayEffort}
        modelOptions={modelOptions}
        effortOptions={selectedEffortOptions}
        runtimeOptionsDisabled={isRunning || codexRestarting || runtimeOptionsBusy || sessionLoading || goalBusy || socket.connectionState !== 'connected'}
        runtimeOptionsLoading={modelOptionsLoading}
        onOpenRuntimeOptions={() => void loadRuntimeOptions()}
        onSelectModel={(value) => void selectModel(value)}
        onSelectEffort={(value) => void selectEffort(value)}
        sandbox={displaySandbox}
        appServerHealth={socket.hello?.appServerHealth ?? null}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        sessionBusy={sessionLoading || runtimeOptionsBusy}
        sessionError={sessionError}
        onOpenSessions={socket.connectionState === 'connected' && !runtimeOptionsBusy ? () => void loadSessions() : undefined}
        onNewSession={socket.connectionState === 'connected' && !runtimeOptionsBusy ? openNewSessionPicker : undefined}
        onRestartCodex={socket.connectionState === 'connected' && !isRunning && !runtimeOptionsBusy ? () => void restartCodex() : undefined}
        codexRestarting={codexRestarting}
        sessionPicker={
          <SessionPicker
            threads={threads}
            visible={sessionPickerOpen}
            busy={sessionLoading || runtimeOptionsBusy}
            onClose={() => setSessionPickerOpen(false)}
            onSelect={(threadId, threadPath) => void resumeSession(threadId, threadPath)}
            onNew={openNewSessionPicker}
          />
        }
      />
      <main className="main-panel">
        {socket.connectionState === 'disconnected' && <div className="disconnect-banner">Connection lost - reconnecting...</div>}
        <div className="workspace-layout">
          {state?.activeCwd && <WorkspaceSidebar root={state.activeCwd} rpc={socket.rpc} onOpenFile={(path, readOnly) => void openFile(path, readOnly)} />}
          <section className="workspace-main" aria-label="Chat workspace">
            <div className="main-content">
              {activeThreadId || ephemeralItems.some((item) => item.kind === 'runtimeStatus' && item.status.threadId === null) ? (
                <ChatTimeline
                  items={chatItems}
                  onLoadOlder={timeline.loadOlder}
                  onJumpToLatest={timeline.jumpToLatest}
                  hasOlder={timeline.hasOlder}
                  showJumpToLatest={!timeline.isViewingLatest}
                  showActivityRunning={timeline.isViewingLatest && showActivityRunning}
                  loading={timeline.loading}
                  loadError={timeline.loadError}
                  retryScheduled={timeline.retryScheduled}
                  onRetryLoad={timeline.reload}
                  onOpenDetail={openDetailItem}
                  onApprovalDecision={respondToApproval}
                  onQueuedEdit={handleQueuedEdit}
                  onQueuedRemove={handleQueuedTimelineRemove}
                  onOpenFileSummary={openFileSummaryDiff}
                  onOpenMentionedFile={handleOpenMentionedFile}
                />
              ) : (
                <div className="empty-state">No active session loaded.</div>
              )}
            </div>
            {activeFileSummary && <FileChangeTray summary={activeFileSummary} onOpenDiff={openFileSummaryDiff} />}
            <QueueTray messages={queuedMessages} onEdit={handleQueuedEdit} onCancel={handleQueuedRemove} />
            {visibleGoal && (
              <GoalProgressRow
                goal={visibleGoal}
                busy={goalBusy || runtimeOptionsBusy}
                running={isRunning}
                idleRecoveryReady={goalIdleRecoveryReady}
                onPause={() => void setGoalStatus('paused')}
                onResume={() => void setGoalStatus('active')}
                onContinue={() => {
                  setReadyIdleGoalKey(null);
                  setIdleGoalGraceGeneration((current) => current + 1);
                  void setGoalStatus('active');
                }}
                onEdit={editGoal}
                onClear={() => void clearGoal()}
              />
            )}
            <InputBox
              rpc={socket.rpc}
              threadId={activeThreadId}
              isRunning={isRunning}
              activeCwd={state?.activeCwd ?? null}
              runOptions={runOptions}
              draftOverride={composerDraft}
              disabled={socket.connectionState !== 'connected' || codexRestarting || runtimeOptionsBusy || goalBusy}
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
          sizeBytes={editor.sizeBytes}
          readOnly={editor.readOnly}
          onClose={() => setEditor(null)}
          onSave={(content) => saveFile(editor.path, content)}
          onOpenFile={(path) => void openFile(path, true)}
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
      {goalDialog?.mode === 'replace' && (
        <GoalObjectiveDialog
          mode="replace"
          currentObjective={goalDialog.currentObjective}
          proposedObjective={goalDialog.proposedObjective}
          busy={goalBusy}
          error={goalDialogError?.message}
          submitDisabled={goalDialogError?.submitDisabled}
          onCancel={() => {
            setComposerDraft(`/goal ${goalDialog.proposedObjective}`);
            setGoalDialog(null);
            setGoalDialogError(null);
          }}
          onReplace={() => void confirmGoalReplacement()}
        />
      )}
      {goalDialog?.mode === 'edit' && (
        <GoalObjectiveDialog
          mode="edit"
          currentObjective={goalDialog.currentObjective}
          busy={goalBusy}
          error={goalDialogError?.message}
          submitDisabled={goalDialogError?.submitDisabled}
          onCancel={() => {
            setGoalDialog(null);
            setGoalDialogError(null);
          }}
          onSave={(objective) => void saveGoalEdit(objective)}
        />
      )}
      <AuthOverlay visible={socket.connectionState === 'auth-error'} onSubmitToken={socket.submitToken} />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}
