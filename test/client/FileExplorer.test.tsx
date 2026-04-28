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

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text);
  if (!button) throw new Error(`missing button ${text}`);
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
  it('ignores stale directory responses after navigating again', async () => {
    const initialRootLoad = deferred<unknown>();
    const staleRootRefresh = deferred<unknown>();
    const dirALoad = deferred<unknown>();
    let rootReadCount = 0;
    const rpc = vi.fn((method: string, params?: unknown) => {
      const path = (params as { path?: string } | undefined)?.path;
      if (method !== 'webui/fs/readDirectory') return Promise.reject(new Error(`unexpected method ${method}`));
      if (path === '/repo-a') {
        rootReadCount += 1;
        return rootReadCount === 1 ? initialRootLoad.promise : staleRootRefresh.promise;
      }
      if (path === '/repo-a/a') return dirALoad.promise;
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    renderFileExplorer(asRpc(rpc), '/repo-a');

    await act(async () => {
      initialRootLoad.resolve({ entries: [{ name: 'a', path: '/repo-a/a', isDirectory: true }] });
      await Promise.resolve();
    });

    await act(async () => {
      buttonByText('Refresh').click();
      fileButton('/repo-a/a').click();
      staleRootRefresh.resolve({ entries: [{ name: 'stale.txt', path: '/repo-a/stale.txt', isFile: true }] });
      await Promise.resolve();
    });

    expect(document.querySelector('.file-current')?.textContent).toBe('/repo-a/a');
    expect(document.querySelector('[title="/repo-a/stale.txt"]')).toBeNull();
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
      buttonByText('New File').click();
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

    expect(document.querySelector('.file-current')?.textContent).toBe('/repo-b');
    expect(fileButton('/repo-b/b.txt')).not.toBeNull();
    expect(document.querySelector('[title="/repo-a/a.txt"]')).toBeNull();
  });
});
