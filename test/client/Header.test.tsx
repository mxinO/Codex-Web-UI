// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Header from '../../src/components/Header';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderHeader(overrides: Partial<React.ComponentProps<typeof Header>> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <Header
        hostname="host-a"
        connectionState="connected"
        activeThreadId="thread-123456789"
        cwd="/work/project"
        theme="dark"
        onToggleTheme={vi.fn()}
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

describe('Header', () => {
  it('keeps session controls in the top bar', () => {
    const onOpenSessions = vi.fn();
    const onNewSession = vi.fn();

    renderHeader({ onOpenSessions, onNewSession });

    const topbar = document.querySelector('.topbar');
    const session = topbar?.querySelector<HTMLButtonElement>('[aria-label="Switch session"]');
    const newSession = topbar?.querySelector<HTMLButtonElement>('[aria-label="New session"]');

    expect(session?.textContent).toContain('Session: thread-1');
    expect(newSession).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      session?.click();
      newSession?.click();
    });

    expect(onOpenSessions).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('shows app-server health in the top bar', () => {
    renderHeader({ appServerHealth: { connected: false, dead: true, error: 'Codex app-server exited', readyzUrl: null, url: null } });

    const appStatus = document.querySelector('.status--app-server');
    expect(appStatus?.textContent).toBe('App stopped');
    expect(appStatus?.getAttribute('title')).toBe('Codex app-server exited');
  });
});
