import { useState } from 'react';
import AuthOverlay from './components/AuthOverlay';
import ChatTimeline from './components/ChatTimeline';
import CwdPicker from './components/CwdPicker';
import Header from './components/Header';
import SessionPicker from './components/SessionPicker';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useThreadTimeline } from './hooks/useThreadTimeline';
import { useTheme } from './hooks/useTheme';
import type { CodexThread } from './types/codex';

export default function App() {
  const socket = useCodexSocket();
  const { theme, setTheme } = useTheme();
  const state = socket.hello?.state;
  const activeThreadId = state?.activeThreadId ?? null;
  const timeline = useThreadTimeline(activeThreadId, socket.rpc);
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

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
        {activeThreadId ? (
          <ChatTimeline items={timeline.items} onLoadOlder={timeline.loadOlder} hasOlder={timeline.hasOlder} loading={timeline.loading} />
        ) : (
          <div className="empty-state">No active session loaded.</div>
        )}
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
    </div>
  );
}
