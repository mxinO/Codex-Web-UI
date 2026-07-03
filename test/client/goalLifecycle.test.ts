import { describe, expect, it } from 'vitest';
import { goalExecutionActions, goalNeedsReplaceConfirmation } from '../../src/lib/goalLifecycle';
import type { ThreadGoal, ThreadGoalStatus } from '../../src/types/ui';

function goal(status: ThreadGoalStatus): ThreadGoal {
  return {
    threadId: 'thread-1',
    objective: 'Finish the migration',
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 100,
    updatedAt: 100,
  };
}

describe('goal lifecycle decisions', () => {
  it('requires confirmation before replacing unfinished goals', () => {
    expect(goalNeedsReplaceConfirmation(null)).toBe(false);
    expect(goalNeedsReplaceConfirmation(goal('complete'))).toBe(false);

    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'] as const) {
      expect(goalNeedsReplaceConfirmation(goal(status))).toBe(true);
    }
  });

  it('selects execution actions from goal and runtime state', () => {
    expect(goalExecutionActions('active', true, false)).toEqual(['pause']);
    expect(goalExecutionActions('active', false, false)).toEqual(['pause']);
    expect(goalExecutionActions('active', false, true)).toEqual(['continue', 'pause']);
    expect(goalExecutionActions('paused', false, true)).toEqual(['resume']);
    expect(goalExecutionActions('blocked', false, true)).toEqual(['resume']);
    expect(goalExecutionActions('usageLimited', false, true)).toEqual(['resume']);
    expect(goalExecutionActions('budgetLimited', false, true)).toEqual([]);
    expect(goalExecutionActions('complete', false, true)).toEqual([]);
  });
});
