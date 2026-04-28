import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { BANG_COMMAND_RPC_TIMEOUT_MS, parseBangCommand } from '../lib/bangCommands';
import { classifySlashCommand } from '../lib/slashCommands';
import type { CodexRunOptions } from '../types/ui';

interface InputBoxProps {
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  threadId: string | null;
  isRunning: boolean;
  activeCwd?: string | null;
  runOptions?: CodexRunOptions;
  draftOverride: string | null;
  disabled?: boolean;
  onDraftConsumed: () => void;
  onEnqueue: (text: string, options?: CodexRunOptions) => Promise<void>;
}

interface FileSuggestion {
  name: string;
  path: string;
}

function dispatchInputEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function extractEntries(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.entries)) return record.entries as Array<Record<string, unknown>>;
  if (Array.isArray(record.data)) return record.data as Array<Record<string, unknown>>;
  const data = record.data;
  if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).entries)) {
    return (data as Record<string, unknown>).entries as Array<Record<string, unknown>>;
  }
  return [];
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, '')}/${child}`.replace(/\/+/g, '/');
}

function normalizeSuggestion(entry: Record<string, unknown>, activeCwd: string): FileSuggestion | null {
  const path = typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : null;
  const name =
    typeof entry.fileName === 'string' && entry.fileName.trim()
      ? entry.fileName.trim()
      : typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : path?.split('/').pop();
  if (!name) return null;
  return { name, path: path ?? joinPath(activeCwd, name) };
}

function getInsertText(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as unknown;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof detail !== 'object' || detail === null) return null;
  const record = detail as Record<string, unknown>;
  const value = record.text ?? record.path;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export default function InputBox({
  rpc,
  threadId,
  isRunning,
  activeCwd,
  runOptions,
  draftOverride,
  disabled = false,
  onDraftConsumed,
  onEnqueue,
}: InputBoxProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const autocompleteSeqRef = useRef(0);

  useEffect(() => {
    if (draftOverride === null) return;
    autocompleteSeqRef.current += 1;
    setDraft(draftOverride);
    onDraftConsumed();
  }, [draftOverride, onDraftConsumed]);

  useEffect(() => {
    const handleInsertText = (event: Event) => {
      const text = getInsertText(event);
      if (!text) return;
      setDraft((current) => {
        if (!current.trim()) return text;
        return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
      });
    };

    window.addEventListener('insert-input-text', handleInsertText);
    return () => window.removeEventListener('insert-input-text', handleInsertText);
  }, []);

  useEffect(() => {
    const match = draft.match(/(^|\s)@([^\s@]*)$/);
    if (!activeCwd || !match) {
      autocompleteSeqRef.current += 1;
      setFileSuggestions([]);
      return;
    }

    const sequence = (autocompleteSeqRef.current += 1);
    const query = match[2].toLowerCase();
    void rpc<unknown>('webui/fs/readDirectory', { path: activeCwd })
      .then((result) => {
        if (sequence !== autocompleteSeqRef.current) return;
        const suggestions = extractEntries(result)
          .map((entry) => normalizeSuggestion(entry, activeCwd))
          .filter((entry): entry is FileSuggestion => Boolean(entry))
          .filter((entry) => entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query))
          .slice(0, 20);
        setFileSuggestions(suggestions);
      })
      .catch(() => {
        if (sequence === autocompleteSeqRef.current) setFileSuggestions([]);
      });
  }, [activeCwd, draft, rpc]);

  const insertSuggestion = (path: string) => {
    autocompleteSeqRef.current += 1;
    setDraft((current) => `${current.replace(/(^|\s)@[^\s@]*$/, (_match, prefix: string) => `${prefix}${path}`)} `);
    setFileSuggestions([]);
  };

  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    autocompleteSeqRef.current += 1;
    setDraft(event.target.value);
  };

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
        await onEnqueue(text, runOptions);
        setDraft('');
        return;
      }

      if (!threadId) {
        setError('Start or resume a session before sending a message');
        return;
      }

      await rpc('webui/turn/start', { threadId, text, options: runOptions });
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
      {fileSuggestions.length > 0 && (
        <div className="file-autocomplete">
          {fileSuggestions.map((suggestion) => (
            <button
              key={suggestion.path}
              type="button"
              className="file-autocomplete-row"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertSuggestion(suggestion.path)}
              title={suggestion.path}
            >
              <span>{suggestion.name}</span>
              <small>{suggestion.path}</small>
            </button>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        onChange={handleDraftChange}
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
