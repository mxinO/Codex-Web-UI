import type { CodexThread } from '../types/codex';

interface Props {
  threads: CodexThread[];
  visible: boolean;
  busy?: boolean;
  onClose: () => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}

export default function SessionPicker({ threads, visible, busy = false, onClose, onSelect, onNew }: Props) {
  if (!visible) return null;

  return (
    <div className="popover session-picker" aria-label="Session picker">
      <button className="text-button primary" type="button" onClick={onNew} disabled={busy}>
        New session...
      </button>
      {threads.length === 0 ? (
        <div className="empty-list">No recent sessions.</div>
      ) : (
        threads.map((thread) => (
          <button key={thread.id} className="session-row" type="button" onClick={() => onSelect(thread.id)} title={thread.cwd} disabled={busy}>
            <span>{thread.name || thread.preview || thread.id}</span>
            <small>{thread.cwd}</small>
          </button>
        ))
      )}
      <button className="text-button" type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
