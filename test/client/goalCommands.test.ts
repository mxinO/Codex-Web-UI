import { describe, expect, it } from 'vitest';
import { parseGoalCommandValue } from '../../src/lib/goalCommands';

describe('goal commands', () => {
  it('parses view, lifecycle actions, and goal objectives', () => {
    expect(parseGoalCommandValue('')).toEqual({ type: 'view' });
    expect(parseGoalCommandValue('pause')).toEqual({ type: 'pause' });
    expect(parseGoalCommandValue('resume')).toEqual({ type: 'resume' });
    expect(parseGoalCommandValue('clear')).toEqual({ type: 'clear' });
    expect(parseGoalCommandValue('Finish the migration')).toEqual({ type: 'set', objective: 'Finish the migration' });
  });

  it('rejects goal objectives over the Codex limit', () => {
    expect(parseGoalCommandValue('x'.repeat(4001))).toEqual({
      type: 'error',
      message: 'Goal objective must be 4,000 characters or fewer',
    });
  });
});
