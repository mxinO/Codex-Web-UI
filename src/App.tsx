import AuthOverlay from './components/AuthOverlay';
import Header from './components/Header';
import { useCodexSocket } from './hooks/useCodexSocket';
import { useTheme } from './hooks/useTheme';

export default function App() {
  const socket = useCodexSocket();
  const { theme, setTheme } = useTheme();
  const state = socket.hello?.state;

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
        <div className="empty-state">No active session loaded.</div>
      </main>
      <AuthOverlay visible={socket.connectionState === 'auth-error'} />
    </div>
  );
}
