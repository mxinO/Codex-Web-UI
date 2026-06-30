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

  it('exposes a restart Codex action in the top bar', () => {
    const onRestartCodex = vi.fn();
    renderHeader({
      appServerHealth: { connected: true, dead: false, error: null, readyzUrl: 'http://127.0.0.1:1/readyz', url: 'ws://127.0.0.1:1' },
      onRestartCodex,
    });

    const restart = document.querySelector<HTMLButtonElement>('[aria-label="Restart Codex"]');
    expect(restart).toBeInstanceOf(HTMLButtonElement);
    expect(restart?.disabled).toBe(false);

    act(() => {
      restart?.click();
    });

    expect(onRestartCodex).toHaveBeenCalledTimes(1);
  });

  it('opens the model picker and selects a catalog model', () => {
    const onOpenRuntimeOptions = vi.fn();
    const onSelectModel = vi.fn();
    renderHeader({
      model: 'gpt-5.4',
      modelOptions: [
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: 'General coding model',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          isDefault: true,
        },
        {
          id: 'gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          displayName: 'GPT-5.4 mini',
          description: 'Faster coding model',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          isDefault: false,
        },
      ],
      onOpenRuntimeOptions,
      onSelectModel,
    });

    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Choose model"]');
    act(() => trigger?.click());

    expect(onOpenRuntimeOptions).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.runtime-option-menu')).not.toBeNull();
    expect(document.querySelector('.runtime-option-item[aria-pressed="true"]')?.textContent).toContain('GPT-5.4');

    const mini = [...document.querySelectorAll<HTMLElement>('.runtime-option-item')]
      .find((option) => option.textContent?.includes('GPT-5.4 mini'));
    act(() => mini?.click());

    expect(onSelectModel).toHaveBeenCalledWith('gpt-5.4-mini');
    expect(document.querySelector('.runtime-option-menu')).toBeNull();
  });

  it('offers only the selected model efforts and closes with Escape', () => {
    const onSelectEffort = vi.fn();
    renderHeader({
      effort: 'medium',
      effortOptions: [
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'high', description: 'Deeper reasoning' },
      ],
      onSelectEffort,
    });

    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Choose effort"]');
    act(() => trigger?.click());
    expect(document.querySelectorAll('.runtime-option-item')).toHaveLength(2);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.runtime-option-menu')).toBeNull();
    expect(onSelectEffort).not.toHaveBeenCalled();
  });

  it('disables runtime selectors while changing options or running Codex', () => {
    renderHeader({
      model: 'gpt-5.4',
      effort: 'high',
      runtimeOptionsDisabled: true,
    });

    expect(document.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Choose effort"]')?.disabled).toBe(true);
  });
});
