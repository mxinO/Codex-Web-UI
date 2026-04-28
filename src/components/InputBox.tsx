import { FormEvent, KeyboardEvent, useEffect, useState } from 'react';
import { BANG_COMMAND_RPC_TIMEOUT_MS, parseBangCommand } from '../lib/bangCommands';
import { classifySlashCommand } from '../lib/slashCommands';

interface InputBoxProps {
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  threadId: string | null;
  isRunning: boolean;
  activeCwd?: string | null;
  draftOverride: string | null;
  disabled?: boolean;
  onDraftConsumed: () => void;
  onEnqueue: (text: string) => Promise<void>;
}

function dispatchInputEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export default function InputBox({
  rpc,
  threadId,
  isRunning,
  activeCwd,
  draftOverride,
  disabled = false,
  onDraftConsumed,
  onEnqueue,
}: InputBoxProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draftOverride === null) return;
    setDraft(draftOverride);
    onDraftConsumed();
  }, [draftOverride, onDraftConsumed]);

  const submitText = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    setBusy(true);
    setError(null);
    try {
      if (text.startsWith('/')) {
        const classification = classifySlashCommand(text, isRunning);
        if (!classification.allowed) {
          setError(classification.reason);
          return;
        }
        dispatchInputEvent('webui-slash-command', { input: text, command: classification.command, turnActive: isRunning, activeCwd });
        setDraft('');
        return;
      }

      const bangCommand = parseBangCommand(text);
      if (bangCommand) {
        if (isRunning) {
          setError('! commands are disabled while Codex is working');
          return;
        }
        const submittedCwd = activeCwd ?? '';
        const submittedThreadId = threadId;
        const result = await rpc('webui/bang/run', { command: bangCommand.command }, BANG_COMMAND_RPC_TIMEOUT_MS);
        dispatchInputEvent('webui-bang-output', { command: bangCommand.command, cwd: submittedCwd, threadId: submittedThreadId, result });
        setDraft('');
        return;
      }

      if (isRunning) {
        await onEnqueue(text);
        setDraft('');
        return;
      }

      if (!threadId) {
        setError('Start or resume a session before sending a message');
        return;
      }

      await rpc('webui/turn/start', { threadId, text });
      setDraft('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submitText();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submitText();
  };

  const stopTurn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc('webui/turn/interrupt');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="input-panel" onSubmit={handleSubmit}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={isRunning ? 'Queue a message...' : 'Message Codex...'}
        rows={3}
      />
      {error && <div className="input-error">{error}</div>}
      <div className="input-actions">
        {isRunning && (
          <button className="text-button" type="button" onClick={() => void stopTurn()} disabled={disabled || busy}>
            Stop
          </button>
        )}
        <button className="text-button primary" type="submit" disabled={disabled || busy || draft.trim().length === 0}>
          {isRunning ? 'Queue' : 'Send'}
        </button>
      </div>
    </form>
  );
}
