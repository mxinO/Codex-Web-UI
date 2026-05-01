// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../src/components/FileExplorer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
type FileExplorerRpc = React.ComponentProps<typeof FileExplorer>['rpc'];

function asRpc(mock: unknown): FileExplorerRpc {
  return mock as FileExplorerRpc;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderFileExplorer(rpc: React.ComponentProps<typeof FileExplorer>['rpc'], workspaceRoot = '/repo-a') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(<FileExplorer root={workspaceRoot} rpc={rpc} onOpenFile={vi.fn()} />);
  });
}

function rerenderFileExplorer(rpc: React.ComponentProps<typeof FileExplorer>['rpc'], workspaceRoot: string) {
  act(() => {
    root?.render(<FileExplorer root={workspaceRoot} rpc={rpc} onOpenFile={vi.fn()} />);
  });
}

function fileButton(path: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`.file-name[title="${path}"]`);
  if (!button) throw new Error(`missing file button for ${path}`);
  return button;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`missing button ${label}`);
  return button;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('FileExplorer', () => {
  it('expands directories inline instead of navigating away from the root tree', async () => {
    const rootLoad = deferred<unknown>();
    const dirALoad = deferred<unknown>();
    const rpc = vi.fn((method: string, params?: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (method !== 'webui/fs/readDirectory') return Promise.reject(new Error(`unexpected method ${method}`));
      if (path === '/repo-a') return rootLoad.promise;
      if (path === '/repo-a/a') return dirALoad.promise;
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    renderFileExplorer(asRpc(rpc), '/repo-a');

    await act(async () => {
      rootLoad.resolve({
        entries: [
          { name: 'a', path: '/repo-a/a', isDirectory: true },
          { name: 'root.txt', path: '/repo-a/root.txt', isFile: true },
        ],
      });
      await Promise.resolve();
    });

    await act(async () => {
      buttonByLabel('Expand a').click();
      dirALoad.resolve({ entries: [{ name: 'nested.txt', path: '/repo-a/a/nested.txt', isFile: true }] });
      await Promise.resolve();
    });

    expect(fileButton('/repo-a/root.txt')).not.toBeNull();
    expect(fileButton('/repo-a/a/nested.txt')).not.toBeNull();
  });

  it('refreshes loaded nested directories from the toolbar button', async () => {
    const rootInitialLoad = deferred<unknown>();
    const childInitialLoad = deferred<unknown>();
    const rootRefresh = deferred<unknown>();
    const childRefresh = deferred<unknown>();
    const readCounts = new Map<string, number>();
    const rpc = vi.fn((method: string, params?: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (method !== 'webui/fs/readDirectory') return Promise.reject(new Error(`unexpected method ${method}`));
      readCounts.set(String(path), (readCounts.get(String(path)) ?? 0) + 1);
      if (path === '/repo-a') return readCounts.get('/repo-a') === 1 ? rootInitialLoad.promise : rootRefresh.promise;
      if (path === '/repo-a/a') return readCounts.get('/repo-a/a') === 1 ? childInitialLoad.promise : childRefresh.promise;
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    renderFileExplorer(asRpc(rpc), '/repo-a');

    await act(async () => {
      rootInitialLoad.resolve({ entries: [{ name: 'a', path: '/repo-a/a', isDirectory: true }] });
      await Promise.resolve();
    });
    await act(async () => {
      buttonByLabel('Expand a').click();
      childInitialLoad.resolve({ entries: [{ name: 'old.txt', path: '/repo-a/a/old.txt', isFile: true }] });
      await Promise.resolve();
    });

    expect(fileButton('/repo-a/a/old.txt')).not.toBeNull();

    act(() => {
      buttonByLabel('Refresh file explorer').click();
    });
    await act(async () => {
      rootRefresh.resolve({ entries: [{ name: 'a', path: '/repo-a/a', isDirectory: true }] });
      await Promise.resolve();
    });
    await act(async () => {
      childRefresh.resolve({ entries: [{ name: 'new.txt', path: '/repo-a/a/new.txt', isFile: true }] });
      await Promise.resolve();
    });

    expect(fileButton('/repo-a/a/new.txt')).not.toBeNull();
    expect(document.querySelector('[title="/repo-a/a/old.txt"]')).toBeNull();
  });

  it('does not refresh the old directory after create resolves following navigation', async () => {
    const rootAInitialLoad = deferred<unknown>();
    const rootAStaleRefresh = deferred<unknown>();
    const rootBLoad = deferred<unknown>();
    const createFile = deferred<unknown>();
    let repoAReadCount = 0;
    const rpc = vi.fn((method: string, params?: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (method === 'webui/fs/readDirectory') {
        if (path === '/repo-a') {
          repoAReadCount += 1;
          return repoAReadCount === 1 ? rootAInitialLoad.promise : rootAStaleRefresh.promise;
        }
        if (path === '/repo-b') return rootBLoad.promise;
      }
      if (method === 'webui/fs/createFile' && path === '/repo-a/new.txt') return createFile.promise;
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    vi.spyOn(window, 'prompt').mockReturnValue('new.txt');

    renderFileExplorer(asRpc(rpc), '/repo-a');
    act(() => {
      buttonByLabel('New file in root').click();
    });
    rerenderFileExplorer(asRpc(rpc), '/repo-b');

    await act(async () => {
      rootBLoad.resolve({ entries: [{ name: 'b.txt', path: '/repo-b/b.txt', isFile: true }] });
      await Promise.resolve();
    });
    await act(async () => {
      createFile.resolve({ ok: true });
      await Promise.resolve();
    });
    await act(async () => {
      rootAStaleRefresh.resolve({ entries: [{ name: 'a.txt', path: '/repo-a/a.txt', isFile: true }] });
      await Promise.resolve();
    });

    expect(fileButton('/repo-b/b.txt')).not.toBeNull();
    expect(document.querySelector('[title="/repo-a/a.txt"]')).toBeNull();
  });

  it('exposes a resize handle for the explorer panel', async () => {
    const rpc = vi.fn().mockResolvedValue({ entries: [] });
    renderFileExplorer(asRpc(rpc), '/repo-a');
    await act(async () => {
      await Promise.resolve();
    });

    const explorer = document.querySelector<HTMLElement>('.file-explorer');
    const handle = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file explorer"]');
    const initialWidth = Number.parseInt(explorer?.style.getPropertyValue('--file-explorer-width') ?? '0', 10);

    expect(handle).toBeInstanceOf(HTMLElement);

    act(() => {
      handle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 420 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const expectedWidth = Math.min(720, Math.max(240, initialWidth + 120));
    expect(explorer?.style.getPropertyValue('--file-explorer-width')).toBe(`${expectedWidth}px`);
    expect(handle?.getAttribute('aria-valuenow')).toBe(String(expectedWidth));
  });

  it('supports keyboard resizing through the separator', async () => {
    const rpc = vi.fn().mockResolvedValue({ entries: [] });
    renderFileExplorer(asRpc(rpc), '/repo-a');
    await act(async () => {
      await Promise.resolve();
    });

    const explorer = document.querySelector<HTMLElement>('.file-explorer');
    const handle = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file explorer"]');
    const initialWidth = Number.parseInt(explorer?.style.getPropertyValue('--file-explorer-width') ?? '0', 10);

    expect(handle?.getAttribute('tabindex')).toBe('0');
    expect(handle?.getAttribute('aria-valuemin')).toBe('240');
    expect(handle?.getAttribute('aria-valuemax')).toBe('720');

    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    });

    expect(explorer?.style.getPropertyValue('--file-explorer-width')).toBe(`${initialWidth + 16}px`);
    expect(handle?.getAttribute('aria-valuenow')).toBe(String(initialWidth + 16));
  });
});
