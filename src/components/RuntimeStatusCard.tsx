import { memo } from 'react';
import { CircleCheck, CircleHelp, Cpu, Folder, Hash, History, Server, TriangleAlert } from 'lucide-react';
import type { RuntimeStatusResult } from '../types/ui';

interface RuntimeStatusCardProps {
  status: RuntimeStatusResult;
}

function shortIdentifier(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...`;
}

function effortLabel(effort: string | null): string {
  return effort ? `${effort} effort` : 'Default effort';
}

export function runtimeStatusHasMismatch(status: RuntimeStatusResult): boolean {
  if (status.lastTurn.status !== 'found') return false;
  return status.model !== status.lastTurn.context.model || status.effort !== status.lastTurn.context.effort;
}

function RuntimeStatusCard({ status }: RuntimeStatusCardProps) {
  const lastTurn = status.lastTurn;
  const mismatch = runtimeStatusHasMismatch(status);
  const confirmationTitle = status.confirmed
    ? `Confirmed${status.confirmationSource ? ` by ${status.confirmationSource}` : ''}${status.confirmedAt ? ` at ${status.confirmedAt}` : ''}`
    : 'Runtime settings have not been confirmed';

  return (
    <article className="runtime-status-card" aria-label="Runtime status">
      <header className="runtime-status-card__header">
        <div className="runtime-status-card__title">
          <Cpu size={16} aria-hidden="true" />
          <span>Runtime status</span>
        </div>
        <div
          className="runtime-status-card__context"
          aria-label={`Host ${status.hostname}; session ${status.threadId ?? 'none'}`}
        >
          <span title={status.hostname}>
            <Server size={13} aria-hidden="true" />
            <span>{status.hostname || 'Unknown host'}</span>
          </span>
          <span title={status.threadId ?? 'No active session'}>
            <Hash size={13} aria-hidden="true" />
            <span>{status.threadId ? shortIdentifier(status.threadId) : 'No session'}</span>
          </span>
        </div>
      </header>

      <section className="runtime-status-card__row" aria-label="Current runtime settings">
        <Cpu className="runtime-status-card__row-icon" size={16} aria-hidden="true" />
        <div className="runtime-status-card__row-copy">
          <span className="runtime-status-card__row-label">Current</span>
          <div className="runtime-status-card__values">
            <strong title={status.model ?? 'Default model'}>{status.model ?? 'Default model'}</strong>
            <span>{effortLabel(status.effort)}</span>
          </div>
          <div className="runtime-status-card__metadata">
            <span>Mode: {status.mode ?? 'default'}</span>
            <span>Sandbox: {status.sandbox ?? 'default'}</span>
            {status.cwd && (
              <span className="runtime-status-card__cwd" title={status.cwd}>
                <Folder size={12} aria-hidden="true" />
                <span>{status.cwd}</span>
              </span>
            )}
          </div>
        </div>
        <span
          className={`runtime-status-card__badge runtime-status-card__badge--${status.confirmed ? 'confirmed' : 'unconfirmed'}`}
          aria-label={`Runtime settings ${status.confirmed ? 'confirmed' : 'unconfirmed'}`}
          title={confirmationTitle}
        >
          {status.confirmed ? <CircleCheck size={13} aria-hidden="true" /> : <CircleHelp size={13} aria-hidden="true" />}
          {status.confirmed ? 'Confirmed' : 'Unconfirmed'}
        </span>
      </section>

      <section className="runtime-status-card__row" aria-label="Last recorded turn">
        <History className="runtime-status-card__row-icon" size={16} aria-hidden="true" />
        <div className="runtime-status-card__row-copy">
          <span className="runtime-status-card__row-label">Last turn</span>
          {lastTurn.status === 'found' ? (
            <div className="runtime-status-card__values runtime-status-card__values--last">
              <strong title={lastTurn.context.model}>{lastTurn.context.model}</strong>
              <span>{effortLabel(lastTurn.context.effort)}</span>
              {lastTurn.context.turnId && (
                <code className="runtime-status-card__turn-id" title={lastTurn.context.turnId}>
                  {shortIdentifier(lastTurn.context.turnId)}
                </code>
              )}
            </div>
          ) : (
            <span className="runtime-status-card__empty">
              {lastTurn.status === 'none'
                ? 'No recorded turn yet.'
                : lastTurn.status === 'scanLimit'
                  ? 'Not found in recent rollout data.'
                  : 'Turn data unavailable.'}
            </span>
          )}
        </div>
      </section>

      {mismatch && (
        <div className="runtime-status-card__warning" role="note" aria-label="Runtime settings warning">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>Settings changed since the last turn.</span>
        </div>
      )}
    </article>
  );
}

export default memo(RuntimeStatusCard);
