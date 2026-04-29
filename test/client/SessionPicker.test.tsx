// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CwdPicker from '../../src/components/CwdPicker';
import SessionPicker from '../../src/components/SessionPicker';
import type { CodexThread } from '../../src/types/codex';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(node);
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

function thread(overrides: Partial<CodexThread>): CodexThread {
  return {
    id: 'thread-1',
    preview: 'preview text',
    createdAt: 1,
    updatedAt: 2,
    status: { type: 'idle' },
    cwd: '/work/project',
    name: null,
    turns: [],
    ...overrides,
  };
}

type CwdPickerRpc = React.ComponentProps<typeof CwdPicker>['rpc'];

function asCwdRpc(mock: unknown): CwdPickerRpc {
  return mock as CwdPickerRpc;
}

describe('SessionPicker', () => {
  it('renders session actions and empty state only when visible', () => {
    render(<SessionPicker threads={[]} visible onClose={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />);

    expect(document.querySelector('.session-picker')?.getAttribute('aria-label')).toBe('Session picker');
    expect(document.querySelector('.empty-list')?.textContent).toBe('No recent sessions.');
    expect(document.querySelectorAll('button')).toHaveLength(2);
  });

  it('selects a thread by id and session path', () => {
    const onSelect = vi.fn();
    render(
      <SessionPicker
        threads={[thread({ id: 'abc', name: 'Named session', path: '/home/user/.codex/sessions/rollout-abc.jsonl' })]}
        visible
        onClose={vi.fn()}
        onSelect={onSelect}
        onNew={vi.fn()}
      />,
    );

    act(() => {
      document.querySelector<HTMLButtonElement>('.session-row')?.click();
    });

    expect(onSelect).toHaveBeenCalledWith('abc', '/home/user/.codex/sessions/rollout-abc.jsonl');
  });

  it('disables session mutation controls when busy', () => {
    const onNew = vi.fn();
    const onSelect = vi.fn();
    render(<SessionPicker threads={[thread({ id: 'abc' })]} visible busy onClose={vi.fn()} onSelect={onSelect} onNew={onNew} />);

    const row = document.querySelector<HTMLButtonElement>('.session-row');
    const newButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'New session...');

    expect(row?.disabled).toBe(true);
    expect(newButton?.disabled).toBe(true);
  });
});

describe('CwdPicker', () => {
  it('trims cwd on submit', () => {
    const onConfirm = vi.fn();
    render(<CwdPicker initialCwd=" /work/project " onCancel={vi.fn()} onConfirm={onConfirm} />);

    const dialog = document.querySelector('[role="dialog"]');
    const start = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Start');

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(start?.disabled).toBe(false);

    act(() => {
      start?.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('/work/project');
  });

  it('disables empty submissions', () => {
    render(<CwdPicker initialCwd="   " onCancel={vi.fn()} onConfirm={vi.fn()} />);

    const start = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Start');

    expect(start?.disabled).toBe(true);
  });

  it('disables start while busy', () => {
    render(<CwdPicker initialCwd="/work/project" busy onCancel={vi.fn()} onConfirm={vi.fn()} />);

    const start = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Start');

    expect(start?.disabled).toBe(true);
  });

  it('browses folders and uses the selected cwd for new sessions', async () => {
    const onConfirm = vi.fn();
    const rpc = vi.fn((method: string, params?: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (method === 'webui/fs/browseDirectory' && path === '/work') {
        return Promise.resolve({ entries: [{ name: 'project', path: '/work/project', isDirectory: true }] });
      }
      if (method === 'webui/fs/browseDirectory' && path === '/work/project') {
        return Promise.resolve({ entries: [] });
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });

    render(<CwdPicker initialCwd="/work" rpc={asCwdRpc(rpc)} onCancel={vi.fn()} onConfirm={onConfirm} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const folder = document.querySelector<HTMLButtonElement>('[aria-label="Open folder project"]');
    expect(folder).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      folder?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector<HTMLInputElement>('.text-input')?.value).toBe('/work/project');

    const start = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Start');
    act(() => {
      start?.click();
    });

    expect(onConfirm).toHaveBeenCalledWith('/work/project');
  });
});
