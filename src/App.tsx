import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import DetailModal from './components/DetailModal';
import FileEditorModal from './components/FileEditorModal';
import FileExplorer from './components/FileExplorer';
import Header from './components/Header';
import InputBox from './components/InputBox';
import QueueCard from './components/QueueCard';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useQueue, type ClientQueuedMessage } from './hooks/useQueue';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import { appendEphemeralBangItem, bangOutputEventToTimelineItem, getBangCommandOutputDetail } from './lib/bangCommands';
import { parseSlashCommand } from './lib/slashCommands';
import { approvalItemsFromRequests, liveStreamingItemFromNotifications, notificationMatchesActiveTurn, requestKey, type TimelineItem } from './lib/timeline';
import type { CodexThread } from './types/codex';

interface OpenEditor {
  path: string;
  readOnly: boolean;
  content: string;
  modifiedAtMs: number | null;
}

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
  const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set());
  const [model, setModelState] = useState<string | null>(() => localStorageValue('codex-web-ui:model'));
  const [mode, setModeState] = useState<string | null>(() => localStorageValue('codex-web-ui:mode'));
  const [effort, setEffortState] = useState<string | null>(() => localStorageValue('codex-web-ui:effort'));
  const bangCounterRef = useRef(0);
  const lastNotification = socket.notifications.at(-1);
  const liveStreamingItem = useMemo(
    () => liveStreamingItemFromNotifications(socket.notifications, { activeThreadId, activeTurnId: state?.activeTurnId ?? null }, Boolean(state?.activeTurnId)),
    [activeThreadId, socket.notifications, state?.activeTurnId],
  );
  const approvalItems = useMemo(() => approvalItemsFromRequests(socket.requests, answeredApprovals), [answeredApprovals, socket.requests]);
  const chatItems = useMemo(
    () => timeline.items.concat(ephemeralItems, liveStreamingItem ? [liveStreamingItem] : [], approvalItems),
    [approvalItems, ephemeralItems, liveStreamingItem, timeline.items],
  );

  useEffect(() => {
    if (state?.queue) replaceQueue(state.queue);
  }, [replaceQueue, state?.queue]);

  useEffect(() => {
    setEphemeralItems([]);
    setAnsweredApprovals(new Set());
  }, [activeThreadId]);

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
    void timeline.reload();
  }, [activeThreadId, lastNotification, state?.activeTurnId, timeline.reload]);

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

  useEffect(() => {
    const handleSlashCommand = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.input !== 'string') return;
      const { command, value } = parseSlashCommand(event.detail.input);

      if (command === '/help') {
        setSessionError('Commands: /new, /resume, /model <name>, /effort <level>, /mode <value>, /sandbox <value>, /status');
        return;
      }
      if (command === '/status') {
        setSessionError(`Session ${activeThreadId ?? 'none'}; model ${model ?? 'default'}; effort ${effort ?? 'default'}; mode ${mode ?? 'default'}`);
        return;
      }
      if (command === '/new') {
        setSessionPickerOpen(false);
        setCwdPickerOpen(true);
        return;
      }
      if (command === '/resume') {
        void loadSessions();
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
        setEffort(value);
        setSessionError(`Effort set to ${value}`);
        return;
      }
      if (command === '/mode' || command === '/sandbox') {
        if (!value) {
          setSessionError(`Usage: ${command} <value>`);
          return;
        }
        const nextMode = command === '/sandbox' ? `sandbox:${value}` : value;
        setMode(nextMode);
        setSessionError(`Mode set to ${nextMode}`);
      }
    };

    window.addEventListener('webui-slash-command', handleSlashCommand);
    return () => window.removeEventListener('webui-slash-command', handleSlashCommand);
  }, [activeThreadId, effort, loadSessions, mode, model, setEffort, setMode, setModel]);

  const startSession = async (cwd: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      await socket.rpc('webui/session/start', { cwd });
      window.location.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      setSessionLoading(false);
    }
  };

  const resumeSession = async (threadId: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      await socket.rpc('webui/session/resume', { threadId });
      window.location.reload();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      setSessionLoading(false);
    }
  };

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
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />
      <main className="main-panel">
        {socket.connectionState === 'disconnected' && <div className="disconnect-banner">Connection lost - reconnecting...</div>}
        <div className="workspace-layout">
          {state?.activeCwd && <FileExplorer root={state.activeCwd} rpc={socket.rpc} onOpenFile={(path, readOnly) => void openFile(path, readOnly)} />}
          <section className="workspace-main" aria-label="Chat workspace">
            <div className="session-actions">
              <button className="text-button primary" type="button" onClick={loadSessions} disabled={socket.connectionState !== 'connected' || sessionLoading}>
                {sessionLoading ? 'Loading...' : 'Sessions'}
              </button>
              {sessionError && <span className="action-error">{sessionError}</span>}
              <SessionPicker
                threads={threads}
                visible={sessionPickerOpen}
                busy={sessionLoading}
                onClose={() => setSessionPickerOpen(false)}
                onSelect={(threadId) => void resumeSession(threadId)}
                onNew={() => {
                  setSessionPickerOpen(false);
                  setCwdPickerOpen(true);
                }}
              />
            </div>
            <div className="main-content">
              {activeThreadId ? (
                <ChatTimeline
                  items={chatItems}
                  onLoadOlder={timeline.loadOlder}
                  hasOlder={timeline.hasOlder}
                  loading={timeline.loading}
                  onOpenDetail={setDetailItem}
                  onApprovalDecision={respondToApproval}
                />
              ) : (
                <div className="empty-state">No active session loaded.</div>
              )}
              {queuedMessages.length > 0 && (
                <div className="queue-list">
                  {queuedMessages.map((message) => (
                    <QueueCard key={message.id} message={message} onEdit={(item) => void editQueued(item)} onRemove={(id) => void removeQueued(id)} />
                  ))}
                </div>
              )}
            </div>
            <InputBox
              rpc={socket.rpc}
              threadId={activeThreadId}
              isRunning={Boolean(state?.activeTurnId)}
              activeCwd={state?.activeCwd ?? null}
              draftOverride={composerDraft}
              disabled={socket.connectionState !== 'connected'}
              onDraftConsumed={() => setComposerDraft(null)}
              onEnqueue={enqueue}
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
          initialCwd={state?.activeCwd ?? ''}
          busy={sessionLoading}
          onCancel={() => setCwdPickerOpen(false)}
          onConfirm={(cwd) => void startSession(cwd)}
        />
      )}
      <AuthOverlay visible={socket.connectionState === 'auth-error'} />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}
