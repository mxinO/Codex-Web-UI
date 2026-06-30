import { Pause, Pencil, Play, X } from 'lucide-react';
import type { ThreadGoal } from '../types/ui';

interface GoalProgressRowProps {
  goal: ThreadGoal;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
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

export default function GoalProgressRow({ goal, busy, onPause, onResume, onEdit, onClear }: GoalProgressRowProps) {
  const paused = goal.status === 'paused';
  return (
    <div className="goal-progress" aria-label="Active goal">
      <div className="goal-progress__main">
        <div className="goal-progress__eyebrow">
          <span className="goal-progress__status">{statusLabel(goal.status)}</span>
          <span className="goal-progress__metric">{formatTokens(goal)}</span>
          <span className="goal-progress__metric">{formatDuration(goal.timeUsedSeconds)}</span>
        </div>
        <div className="goal-progress__objective" title={goal.objective}>
          {goal.objective}
        </div>
      </div>
      <div className="goal-progress__actions">
        {paused ? (
          <button className="text-button" type="button" onClick={onResume} disabled={busy} title="Resume goal">
            <Play size={14} aria-hidden="true" />
            Resume
          </button>
        ) : (
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
