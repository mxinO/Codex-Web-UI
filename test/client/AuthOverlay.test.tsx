// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import AuthOverlay from '../../src/components/AuthOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(visible: boolean) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<AuthOverlay visible={visible} />);
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
  });

  it('renders nothing when hidden', () => {
    render(false);

    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});
