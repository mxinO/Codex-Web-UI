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
}

function trimPath(path: string) {
  return path.length > 48 ? `...${path.slice(-45)}` : path;
}

export default function Header(props: HeaderProps) {
  const shortThread = props.activeThreadId ? `${props.activeThreadId.slice(0, 8)}...` : 'No session';

  return (
    <header className="topbar">
      <span className="brand" title={props.hostname ? `Codex Web UI @${props.hostname}` : 'Codex Web UI'}>
        Codex Web UI{props.hostname ? ` @${props.hostname}` : ''}
      </span>
      <span className="badge">{shortThread}</span>
      {props.cwd && (
        <span className="cwd" title={props.cwd}>
          {trimPath(props.cwd)}
        </span>
      )}
      {props.model && <span className="badge">{props.model}</span>}
      {props.mode && <span className="badge">{props.mode}</span>}
      {props.effort && <span className="badge">{props.effort}</span>}
      {props.sandbox && <span className="badge">{props.sandbox}</span>}
      <button className="icon-button" type="button" onClick={props.onToggleTheme} title="Toggle theme" aria-label="Toggle theme">
        {props.theme === 'dark' ? 'Light' : 'Dark'}
      </button>
      <span className={`status status--${props.connectionState}`}>{props.connectionState}</span>
    </header>
  );
}
