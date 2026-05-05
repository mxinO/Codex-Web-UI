// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthOverlay from '../../src/components/AuthOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(visible: boolean, overrides: Partial<React.ComponentProps<typeof AuthOverlay>> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<AuthOverlay visible={visible} onSubmitToken={vi.fn()} {...overrides} />);
  });
}

function changeInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  Simulate.change(input, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('AuthOverlay', () => {
  it('renders dialog semantics when visible', () => {
    render(true);

    const dialog = document.querySelector('[role="dialog"]');
    const heading = document.querySelector('h2');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.id).toBeTruthy();
    expect(heading?.textContent).toBe('Authentication Required');
    expect(document.body.textContent).toContain('Enter the access token printed by the server.');
    expect(document.body.textContent).not.toContain('server token changed');
    expect(document.querySelector('input')?.getAttribute('placeholder')).toBe('Paste access token');
  });

  it('renders nothing when hidden', () => {
    render(false);

    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('submits typed tokens and shows invalid-token errors', async () => {
    const onSubmitToken = vi.fn().mockRejectedValueOnce(new Error('Invalid token')).mockResolvedValueOnce(undefined);
    render(true, { onSubmitToken });

    const input = document.querySelector<HTMLInputElement>('input');
    const form = document.querySelector('form');

    await act(async () => {
      changeInput(input!, 'bad-token');
      await Promise.resolve();
    });
    await act(async () => {
      Simulate.submit(form!);
      await Promise.resolve();
    });

    expect(onSubmitToken).toHaveBeenCalledWith('bad-token');
    expect(document.querySelector('.auth-error')?.textContent).toBe('Invalid token');

    await act(async () => {
      changeInput(input!, 'good-token');
      await Promise.resolve();
    });
    await act(async () => {
      Simulate.submit(form!);
      await Promise.resolve();
    });

    expect(onSubmitToken).toHaveBeenCalledWith('good-token');
  });
});
