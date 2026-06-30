export type ParsedGoalCommand =
  | { type: 'view' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' }
  | { type: 'set'; objective: string }
  | { type: 'error'; message: string };

const GOAL_OBJECTIVE_LIMIT = 4000;

export function parseGoalCommandValue(value: string): ParsedGoalCommand {
  const trimmed = value.trim();
  if (!trimmed) return { type: 'view' };

  const command = trimmed.toLowerCase();
  if (command === 'pause') return { type: 'pause' };
  if (command === 'resume') return { type: 'resume' };
  if (command === 'clear') return { type: 'clear' };

  if (trimmed.length > GOAL_OBJECTIVE_LIMIT) {
    return { type: 'error', message: 'Goal objective must be 4,000 characters or fewer' };
  }

  return { type: 'set', objective: trimmed };
}
