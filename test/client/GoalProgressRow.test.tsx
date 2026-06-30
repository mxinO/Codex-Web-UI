// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GoalProgressRow from '../../src/components/GoalProgressRow';
import type { ThreadGoal } from '../../src/types/ui';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const activeGoal: ThreadGoal = {
  threadId: 'thread-1',
  objective: 'Finish the migration and keep tests green',
  status: 'active',
  tokenBudget: 1000,
  tokensUsed: 250,
  timeUsedSeconds: 125,
  createdAt: 100,
  updatedAt: 200,
};

function renderGoalRow(overrides: Partial<React.ComponentProps<typeof GoalProgressRow>> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <GoalProgressRow
        goal={activeGoal}
        busy={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onEdit={vi.fn()}
        onClear={vi.fn()}
        {...overrides}
      />,
    );
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('GoalProgressRow', () => {
  it('renders the active goal status and progress counters', () => {
    renderGoalRow();

    expect(document.querySelector('.goal-progress__objective')?.textContent).toBe('Finish the migration and keep tests green');
    expect(document.querySelector('.goal-progress__status')?.textContent).toBe('Active');
    expect(document.querySelector('.goal-progress__metric')?.textContent).toContain('250 / 1,000 tokens');
    expect(document.querySelectorAll('.goal-progress__metric')[1]?.textContent).toBe('2m 5s');
  });

  it('shows pause for active goals and resume for paused goals', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    renderGoalRow({ onPause, onResume });

    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Pause')?.click();
    });

    expect(onPause).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <GoalProgressRow
          goal={{ ...activeGoal, status: 'paused' }}
          busy={false}
          onPause={onPause}
          onResume={onResume}
          onEdit={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });

    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Resume')?.click();
    });

    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
