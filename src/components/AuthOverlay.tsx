import { FormEvent, useEffect, useId, useState } from 'react';

interface AuthOverlayProps {
  visible: boolean;
  onSubmitToken: (token: string) => Promise<void>;
}

export default function AuthOverlay({ visible, onSubmitToken }: AuthOverlayProps) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!visible) {
      setToken('');
      setBusy(false);
      setError(null);
    }
  }, [visible]);

  if (!visible) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      await onSubmitToken(trimmed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <form className="auth-box" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
        <h2 id={titleId}>Authentication Required</h2>
        <p>Enter the access token printed by the server.</p>
        <label className="field-label auth-token-field">
          Access token
          <input
            className="text-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste access token"
            autoFocus
            autoComplete="off"
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button className="text-button primary" type="submit" disabled={!token.trim() || busy}>
            {busy ? 'Checking...' : 'Reconnect'}
          </button>
        </div>
      </form>
    </div>
  );
}
