import { useId, useState } from 'react';

interface Props {
  initialCwd: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (cwd: string) => void;
}

export default function CwdPicker({ initialCwd, busy = false, onCancel, onConfirm }: Props) {
  const [cwd, setCwd] = useState(initialCwd);
  const titleId = useId();
  const trimmedCwd = cwd.trim();

  return (
    <div className="modal-overlay">
      <form
        className="auth-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedCwd && !busy) onConfirm(trimmedCwd);
        }}
      >
        <h2 id={titleId}>New Session</h2>
        <label className="field-label">
          Working directory
          <input className="text-input" value={cwd} onChange={(event) => setCwd(event.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button className="text-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="text-button primary" type="submit" disabled={!trimmedCwd || busy}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
