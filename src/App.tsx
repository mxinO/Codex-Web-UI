import { useEffect, useRef, useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import DetailModal from './components/DetailModal';
import Header from './components/Header';
import InputBox from './components/InputBox';
import QueueCard from './components/QueueCard';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useQueue, type ClientQueuedMessage } from './hooks/useQueue';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import { appendEphemeralBangItem, bangOutputEventToTimelineItem, getBangCommandOutputDetail } from './lib/bangCommands';
import type { TimelineItem } from './lib/timeline';
import type { CodexThread } from './types/codex';

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
  const [ephemeralItems, setEphemeralItems] = useState<TimelineItem[]>([]);
  const bangCounterRef = useRef(0);

  useEffect(() => {
    if (state?.queue) replaceQueue(state.queue);
  }, [replaceQueue, state?.queue]);

  useEffect(() => {
    setEphemeralItems([]);
  }, [activeThreadId]);

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

  const loadSessions = async () => {
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
  };

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

  return (
    <div className="app-shell">
      <Header
        hostname={socket.hello?.hostname ?? null}
        connectionState={socket.connectionState}
        activeThreadId={state?.activeThreadId ?? null}
        cwd={state?.activeCwd ?? null}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />
      <main className="main-panel">
        {socket.connectionState === 'disconnected' && <div className="disconnect-banner">Connection lost - reconnecting...</div>}
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
              items={timeline.items.concat(ephemeralItems)}
              onLoadOlder={timeline.loadOlder}
              hasOlder={timeline.hasOlder}
              loading={timeline.loading}
              onOpenDetail={setDetailItem}
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
      </main>
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
