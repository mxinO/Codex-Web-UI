import { Pause, Pencil, Play, X } from 'lucide-react';
import { goalExecutionActions } from '../lib/goalLifecycle';
import type { ThreadGoal } from '../types/ui';

interface GoalProgressRowProps {
  goal: ThreadGoal;
  busy: boolean;
  running: boolean;
  idleRecoveryReady: boolean;
  onPause: () => void;
  onResume: () => void;
  onContinue: () => void;
  onEdit: () => void;
  onClear: () => void;
}

function statusLabel(status: ThreadGoal['status']): string {
  if (status === 'usageLimited') return 'Usage limited';
  if (status === 'budgetLimited') return 'Budget limited';
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTokens(goal: ThreadGoal): string {
  const used = goal.tokensUsed.toLocaleString();
  return goal.tokenBudget === null ? `${used} tokens` : `${used} / ${goal.tokenBudget.toLocaleString()} tokens`;
}

export default function GoalProgressRow({ goal, busy, running, idleRecoveryReady, onPause, onResume, onContinue, onEdit, onClear }: GoalProgressRowProps) {
  const actions = goalExecutionActions(goal.status, running, idleRecoveryReady);
  const displayedStatus = goal.status === 'active' && !running && !idleRecoveryReady ? 'Starting' : statusLabel(goal.status);
  return (
    <div className="goal-progress" aria-label="Active goal">
      <div className="goal-progress__main">
        <div className="goal-progress__eyebrow">
          <span className="goal-progress__status">{displayedStatus}</span>
          <span className="goal-progress__metric">{formatTokens(goal)}</span>
          <span className="goal-progress__metric">{formatDuration(goal.timeUsedSeconds)}</span>
        </div>
        <div className="goal-progress__objective" title={goal.objective}>
          {goal.objective}
        </div>
      </div>
      <div className="goal-progress__actions">
        {actions.includes('continue') && (
          <button className="text-button" type="button" onClick={onContinue} disabled={busy} title="Continue idle goal">
            <Play size={14} aria-hidden="true" />
            Continue
          </button>
        )}
        {actions.includes('resume') && (
          <button className="text-button" type="button" onClick={onResume} disabled={busy} title="Resume goal">
            <Play size={14} aria-hidden="true" />
            Resume
          </button>
        )}
        {actions.includes('pause') && (
          <button className="text-button" type="button" onClick={onPause} disabled={busy} title="Pause goal">
            <Pause size={14} aria-hidden="true" />
            Pause
          </button>
        )}
        <button className="text-button" type="button" onClick={onEdit} disabled={busy} title="Edit goal">
          <Pencil size={14} aria-hidden="true" />
          Edit
        </button>
        <button className="text-button" type="button" onClick={onClear} disabled={busy} title="Clear goal">
          <X size={14} aria-hidden="true" />
          Clear
        </button>
      </div>
    </div>
  );
}
