import { List, Moon, Plus, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConnectionState } from '../hooks/useCodexSocket';

interface HeaderProps {
  hostname: string | null;
  connectionState: ConnectionState;
  activeThreadId: string | null;
  cwd: string | null;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  sandbox?: string | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  sessionBusy?: boolean;
  sessionError?: string | null;
  onOpenSessions?: () => void;
  onNewSession?: () => void;
  sessionPicker?: ReactNode;
}

function trimPath(path: string) {
  return path.length > 48 ? `...${path.slice(-45)}` : path;
}

export default function Header(props: HeaderProps) {
  const shortThread = props.activeThreadId ? `Session: ${props.activeThreadId.slice(0, 8)}...` : 'No session';

  return (
    <header className="topbar">
      <span className="brand" title={props.hostname ? `Codex Web UI @${props.hostname}` : 'Codex Web UI'}>
        Codex Web UI{props.hostname ? ` @${props.hostname}` : ''}
      </span>
      <div className="topbar-session">
        <button
          className="header-pill header-pill--session"
          type="button"
          onClick={props.onOpenSessions}
          disabled={!props.onOpenSessions || props.sessionBusy}
          title={props.activeThreadId ? `Switch session ${props.activeThreadId}` : 'Open sessions'}
          aria-label="Switch session"
        >
          <List size={14} aria-hidden="true" />
          <span>{props.sessionBusy ? 'Loading sessions...' : shortThread}</span>
        </button>
        {props.sessionPicker}
      </div>
      <button className="icon-button icon-button--square" type="button" onClick={props.onNewSession} disabled={!props.onNewSession} title="New session" aria-label="New session">
        <Plus size={16} aria-hidden="true" />
      </button>
      {props.cwd && (
        <span className="cwd" title={props.cwd}>
          {trimPath(props.cwd)}
        </span>
      )}
      {props.model && <span className="badge">{props.model}</span>}
      {props.mode && <span className="badge">{props.mode}</span>}
      {props.effort && <span className="badge">{props.effort}</span>}
      {props.sandbox && <span className="badge">{props.sandbox}</span>}
      {props.sessionError && (
        <span className="topbar-error" title={props.sessionError}>
          {props.sessionError}
        </span>
      )}
      <button className="icon-button icon-button--square" type="button" onClick={props.onToggleTheme} title="Toggle theme" aria-label="Toggle theme">
        {props.theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      </button>
      <span className={`status status--${props.connectionState}`}>{props.connectionState}</span>
    </header>
  );
}
