import type { ThreadGoal, ThreadGoalStatus } from '../types/ui';

export type GoalExecutionAction = 'continue' | 'pause' | 'resume';

export function goalNeedsReplaceConfirmation(goal: ThreadGoal | null): boolean {
  return goal !== null && goal.status !== 'complete';
}

export function goalExecutionActions(
  status: ThreadGoalStatus,
  running: boolean,
  idleRecoveryReady: boolean,
): GoalExecutionAction[] {
  if (status === 'active') {
    return running || !idleRecoveryReady ? ['pause'] : ['continue', 'pause'];
  }
  if (status === 'paused' || status === 'blocked' || status === 'usageLimited') return ['resume'];
  return [];
}
