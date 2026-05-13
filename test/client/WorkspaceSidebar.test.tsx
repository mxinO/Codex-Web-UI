// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceSidebar from '../../src/components/WorkspaceSidebar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
type SidebarRpc = React.ComponentProps<typeof WorkspaceSidebar>['rpc'];

function asRpc(mock: unknown): SidebarRpc {
  return mock as SidebarRpc;
}

function renderSidebar(rpc: SidebarRpc, initialPanel?: 'files' | 'git') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<WorkspaceSidebar root="/repo-a" rpc={rpc} onOpenFile={vi.fn()} initialPanel={initialPanel} />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WorkspaceSidebar', () => {
  it('owns the shared aside and switches between Files and Git panels', async () => {
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/fs/readDirectory') return Promise.resolve({ entries: [] });
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/repo-a', repos: [] });
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderSidebar(asRpc(rpc));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('.file-explorer')).toBeInstanceOf(HTMLElement);
    expect(document.querySelector('[aria-label="Workspace panels"]')).toBeInstanceOf(HTMLElement);
    expect(document.querySelector('.file-list')).toBeInstanceOf(HTMLElement);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Show Files panel"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Show Git panel"]')?.getAttribute('role')).toBeNull();

    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Show Git panel"]')?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.localStorage.getItem('codex-web-ui:workspace-sidebar-panel')).toBe('git');
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Show Git panel"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.git-tracker-panel')).toBeInstanceOf(HTMLElement);
    expect(rpc).toHaveBeenCalledWith('webui/git/repos/list');
  });

  it('uses initialPanel ahead of persisted panel state for compatibility wrappers', async () => {
    window.localStorage.setItem('codex-web-ui:workspace-sidebar-panel', 'git');
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/fs/readDirectory') return Promise.resolve({ entries: [] });
      if (method === 'webui/git/repos/list') return Promise.resolve({ cwd: '/repo-a', repos: [] });
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    renderSidebar(asRpc(rpc), 'files');
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('.file-list')).toBeInstanceOf(HTMLElement);
    expect(document.querySelector('.git-tracker-panel')).toBeNull();
  });
});
