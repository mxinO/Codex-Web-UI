// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GoalObjectiveDialog from '../../src/components/GoalObjectiveDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(text: string): HTMLButtonElement {
  const next = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent === text);
  if (!next) throw new Error(`button not found: ${text}`);
  return next;
}

function changeTextareaValue(textarea: HTMLTextAreaElement | null, value: string) {
  if (!textarea) throw new Error('textarea not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
});

describe('GoalObjectiveDialog', () => {
  it('edits and trims an objective with initial textarea focus', () => {
    const onSave = vi.fn();
    mount(<GoalObjectiveDialog mode="edit" currentObjective="Old objective" busy={false} onCancel={vi.fn()} onSave={onSave} />);

    const textarea = document.querySelector('textarea');
    expect(document.activeElement).toBe(textarea);
    expect(textarea?.value).toBe('Old objective');

    act(() => {
      changeTextareaValue(textarea, '  Updated objective  ');
    });
    act(() => button('Save').click());

    expect(onSave).toHaveBeenCalledWith('Updated objective');
  });

  it('disables empty edits and cancels with Escape', () => {
    const onCancel = vi.fn();
    mount(<GoalObjectiveDialog mode="edit" currentObjective="Old objective" busy={false} onCancel={onCancel} onSave={vi.fn()} />);

    const textarea = document.querySelector('textarea');
    act(() => {
      changeTextareaValue(textarea, '   ');
    });
    expect(button('Save').disabled).toBe(true);

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirms replacement and disables actions while busy', () => {
    const onReplace = vi.fn();
    const onCancel = vi.fn();
    mount(
      <GoalObjectiveDialog
        mode="replace"
        currentObjective="Old objective"
        proposedObjective="New objective"
        busy={false}
        onCancel={onCancel}
        onReplace={onReplace}
      />,
    );

    expect(document.body.textContent).toContain('Old objective');
    expect(document.body.textContent).toContain('New objective');
    expect(document.activeElement).toBe(button('Cancel'));
    act(() => button('Replace').click());
    expect(onReplace).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <GoalObjectiveDialog
          mode="replace"
          currentObjective="Old objective"
          proposedObjective="New objective"
          busy
          onCancel={onCancel}
          onReplace={onReplace}
        />,
      );
    });
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Replacing...').disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
  });

  it('announces an edit error and can disable stale retries', () => {
    mount(
      <GoalObjectiveDialog
        mode="edit"
        currentObjective="Old objective"
        busy={false}
        error="Goal changed. Cancel and reopen Edit before retrying."
        submitDisabled
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Goal changed');
    expect(button('Save').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-describedby')).toBe('goal-objective-dialog-error');
  });

  it('traps focus and restores the previously focused element', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.append(trigger);
    trigger.focus();

    mount(
      <GoalObjectiveDialog
        mode="replace"
        currentObjective="Old objective"
        proposedObjective="New objective"
        busy={false}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
      />,
    );

    const cancel = button('Cancel');
    const replace = button('Replace');
    expect(document.activeElement).toBe(cancel);

    act(() => cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(replace);
    act(() => replace.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(cancel);

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(trigger);
  });
});
