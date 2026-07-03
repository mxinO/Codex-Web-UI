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
        running
        idleRecoveryReady={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
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

  it('shows pause for running active goals and resume for paused goals', () => {
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
          running={false}
          idleRecoveryReady
          onPause={onPause}
          onResume={onResume}
          onContinue={vi.fn()}
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

  it('offers continue and pause when an active goal remains idle', () => {
    const onContinue = vi.fn();
    const onPause = vi.fn();
    renderGoalRow({ running: false, idleRecoveryReady: false });
    expect(document.querySelector('.goal-progress__status')?.textContent).toBe('Starting');
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    renderGoalRow({ running: false, idleRecoveryReady: true, onContinue, onPause });

    act(() => {
      buttonByText('Continue')?.click();
      buttonByText('Pause')?.click();
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('resumes blocked and usage-limited goals but not budget-limited goals', () => {
    const onResume = vi.fn();
    renderGoalRow({ goal: { ...activeGoal, status: 'blocked' }, running: false, idleRecoveryReady: true, onResume });
    act(() => buttonByText('Resume')?.click());

    for (const status of ['usageLimited'] as const) {
      act(() => {
        root?.render(
          <GoalProgressRow
            goal={{ ...activeGoal, status }}
            busy={false}
            running={false}
            idleRecoveryReady
            onPause={vi.fn()}
            onResume={onResume}
            onContinue={vi.fn()}
            onEdit={vi.fn()}
            onClear={vi.fn()}
          />,
        );
      });
      act(() => buttonByText('Resume')?.click());
    }
    expect(onResume).toHaveBeenCalledTimes(2);

    act(() => {
      root?.render(
        <GoalProgressRow
          goal={{ ...activeGoal, status: 'budgetLimited' }}
          busy={false}
          running={false}
          idleRecoveryReady
          onPause={vi.fn()}
          onResume={onResume}
          onContinue={vi.fn()}
          onEdit={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });

    expect(buttonByText('Resume')).toBeUndefined();
    expect(buttonByText('Pause')).toBeUndefined();
  });
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === text);
}
