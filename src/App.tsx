import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import DetailModal from './components/DetailModal';
import FileEditorModal from './components/FileEditorModal';
import FileExplorer from './components/FileExplorer';
import Header from './components/Header';
import InputBox from './components/InputBox';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useQueue, type ClientQueuedMessage } from './hooks/useQueue';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import { appendEphemeralBangItem, bangOutputEventToTimelineItem, getBangCommandOutputDetail } from './lib/bangCommands';
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
import { parseSlashCommand } from './lib/slashCommands';
import { approvalItemsFromRequests, liveStreamingItemFromNotifications, notificationMatchesActiveTurn, requestKey, type TimelineItem } from './lib/timeline';
import type { CodexThread } from './types/codex';
import type { CodexRunOptions } from './types/ui';

interface OpenEditor {
  path: string;
  readOnly: boolean;
  content: string;
  modifiedAtMs: number | null;
}

type UserTimelineItem = Extract<TimelineItem, { kind: 'user' }>;

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
  const marker = ':file:';
  const markerIndex = item.id.indexOf(marker);
  return markerIndex > 0 ? item.id.slice(0, markerIndex) : null;
}

function fileChangeRawChanges(item: Extract<TimelineItem, { kind: 'fileChange' }>): unknown[] {
  const changes = (item.item as Record<string, unknown>).changes;
  return Array.isArray(changes) ? changes : [];
}

export default function App() {
  const socket = useCodexSocket();
  const { theme, setTheme } = useTheme();
  const state = socket.hello?.state;
  const activeThreadId = state?.activeThreadId ?? null;
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
  const [ephemeralItems, setEphemeralItems] = useState<TimelineItem[]>([]);
  const [pendingUserItems, setPendingUserItems] = useState<UserTimelineItem[]>([]);
  const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set());
  const [model, setModelState] = useState<string | null>(() => sanitizeStoredModel(localStorageValue('codex-web-ui:model')));
  const [mode, setModeState] = useState<string | null>(initialMode);
  const [effort, setEffortState] = useState<string | null>(() => sanitizeStoredEffort(localStorageValue('codex-web-ui:effort')));
  const [sandbox, setSandboxState] = useState<string | null>(initialSandbox);
  const bangCounterRef = useRef(0);
  const pendingUserCounterRef = useRef(0);
  const lastNotification = socket.notifications.at(-1);
  const liveStreamingItem = useMemo(
    () => liveStreamingItemFromNotifications(socket.notifications, { activeThreadId, activeTurnId: state?.activeTurnId ?? null }, Boolean(state?.activeTurnId)),
    [activeThreadId, socket.notifications, state?.activeTurnId],
  );
  const approvalItems = useMemo(() => approvalItemsFromRequests(socket.requests, answeredApprovals), [answeredApprovals, socket.requests]);
  const queuedTimelineItems = useMemo<TimelineItem[]>(
    () =>
      queuedMessages.map((message) => ({
        id: `queued:${message.id}`,
        kind: 'queued',
        timestamp: message.createdAt,
        message,
      })),
    [queuedMessages],
  );
  const chatItems = useMemo<TimelineItem[]>(() => {
    if (!timeline.isViewingLatest) return timeline.items;
    return [...timeline.items, ...pendingUserItems, ...queuedTimelineItems, ...ephemeralItems, ...(liveStreamingItem ? [liveStreamingItem] : []), ...approvalItems];
  }, [approvalItems, ephemeralItems, liveStreamingItem, pendingUserItems, queuedTimelineItems, timeline.isViewingLatest, timeline.items]);
  const runOptions = useMemo<CodexRunOptions>(() => ({ model, mode: effectiveMode(mode, model), effort, sandbox }), [effort, mode, model, sandbox]);

  useEffect(() => {
    if (state?.queue) replaceQueue(state.queue);
  }, [replaceQueue, state?.queue]);

  useEffect(() => {
    setEphemeralItems([]);
    setPendingUserItems([]);
    setAnsweredApprovals(new Set());
  }, [activeThreadId]);

  useEffect(() => {
    setPendingUserItems((items) =>
      items.filter(
        (pending) =>
          !timeline.items.some(
            (item) => item.kind === 'user' && item.text.trim() === pending.text.trim() && item.timestamp >= pending.timestamp - 60_000,
          ),
      ),
    );
  }, [timeline.items]);

  useEffect(() => {
    if (
      !activeThreadId ||
      typeof lastNotification !== 'object' ||
      lastNotification === null ||
      (lastNotification as Record<string, unknown>).method !== 'turn/completed' ||
      !notificationMatchesActiveTurn(lastNotification, { activeThreadId, activeTurnId: state?.activeTurnId ?? null })
    ) {
      return;
    }
    if (timeline.isViewingLatest) void timeline.reload();
  }, [activeThreadId, lastNotification, state?.activeTurnId, timeline.isViewingLatest, timeline.reload]);

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

      setEphemeralItems((items) => appendEphemeralBangItem(items, item));
    };

    window.addEventListener('webui-bang-output', handleBangOutput);
    return () => window.removeEventListener('webui-bang-output', handleBangOutput);
  }, [activeThreadId]);

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
    const id = `pending:user:${Date.now()}:${(pendingUserCounterRef.current += 1)}`;
    setPendingUserItems((items) => [...items, { id, kind: 'user', timestamp: Date.now(), text }]);
    return () => setPendingUserItems((items) => items.filter((item) => item.id !== id));
  }, []);

  const openDetailItem = useCallback((item: TimelineItem) => {
    if (item.kind !== 'fileChange') {
      setDetailItem(item);
      return;
    }

    const loadingItem: TimelineItem = { ...item, diffLoading: true, diffError: undefined, resolvedDiff: undefined };
    setDetailItem(loadingItem);

    void socket
      .rpc<{ before: string; after: string; path?: string | null }>('webui/fileChange/diff', {
        threadId: activeThreadId,
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
  }, [activeThreadId, socket.rpc]);

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

  const resumeSession = useCallback(async (threadId: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      await socket.rpc('webui/session/resume', { threadId, options: runOptions });
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
        setSessionError('/compact is not supported by this Codex app-server integration yet');
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
  }, [activeThreadId, effort, loadSessions, mode, model, resumeSession, sandbox, setEffort, setMode, setModel, setSandbox, socket.connectionState, socket.hello?.hostname, state?.activeCwd]);

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
    try {
      const contentResult = await socket.rpc<unknown>('webui/fs/readFile', { path });
      const metadataResult = await socket.rpc<unknown>('webui/fs/getMetadata', { path });
      setEditor({
        path,
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
            onSelect={(threadId) => void resumeSession(threadId)}
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
                />
              ) : (
                <div className="empty-state">No active session loaded.</div>
              )}
            </div>
            <InputBox
              rpc={socket.rpc}
              threadId={activeThreadId}
              isRunning={Boolean(state?.activeTurnId)}
              activeCwd={state?.activeCwd ?? null}
              runOptions={runOptions}
              draftOverride={composerDraft}
              disabled={socket.connectionState !== 'connected'}
              onDraftConsumed={() => setComposerDraft(null)}
              onEnqueue={enqueue}
              onDirectSubmit={addPendingUserMessage}
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
      {cwdPickerOpen && (
        <CwdPicker
          initialCwd={state?.activeCwd ?? '/'}
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
