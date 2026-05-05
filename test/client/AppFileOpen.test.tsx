// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { FileContentTooLargeError } from '../../src/lib/fileContent';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  readTextFileStream: vi.fn(),
  setTheme: vi.fn(),
  enqueue: vi.fn(),
  removeQueued: vi.fn(),
  replaceQueue: vi.fn(),
  loadOlder: vi.fn(),
  jumpToLatest: vi.fn(),
  reloadTimeline: vi.fn(),
  submitToken: vi.fn(),
  queue: [],
  timelineItems: [],
  notifications: [],
  requests: [],
  stateQueue: [],
}));

vi.mock('../../src/lib/fileContent', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/fileContent')>('../../src/lib/fileContent');
  return { ...actual, readTextFileStream: mocks.readTextFileStream };
});

vi.mock('../../src/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light', setTheme: mocks.setTheme }) }));
vi.mock('../../src/hooks/useQueue', () => ({
  useQueue: () => ({ queue: mocks.queue, enqueue: mocks.enqueue, remove: mocks.removeQueued, replace: mocks.replaceQueue }),
}));
vi.mock('../../src/hooks/useThreadTimeline', () => ({
  useThreadTimeline: () => ({
    items: mocks.timelineItems,
    loading: false,
    loadError: null,
    retryScheduled: false,
    hasOlder: false,
    isViewingLatest: true,
    loadOlder: mocks.loadOlder,
    jumpToLatest: mocks.jumpToLatest,
    reload: mocks.reloadTimeline,
  }),
}));
vi.mock('../../src/hooks/useCodexSocket', () => ({
  useCodexSocket: () => ({
    connectionState: 'connected',
    hello: {
      hostname: 'host',
      state: { activeThreadId: 'thread-1', activeCwd: '/repo', queue: mocks.stateQueue },
    },
    notifications: mocks.notifications,
    notificationCount: 0,
    requests: mocks.requests,
    rpc: mocks.rpc,
    submitToken: mocks.submitToken,
  }),
}));
vi.mock('../../src/components/AuthOverlay', () => ({ default: () => null }));
vi.mock('../../src/components/ChatTimeline', () => ({ default: () => <div data-testid="chat-timeline" /> }));
vi.mock('../../src/components/CwdPicker', () => ({ default: () => null }));
vi.mock('../../src/components/DetailModal', () => ({ default: () => null }));
vi.mock('../../src/components/FileChangeTray', () => ({ default: () => null }));
vi.mock('../../src/components/Header', () => ({
  default: ({ sessionError }: { sessionError?: string | null }) => <div data-testid="header">{sessionError}</div>,
}));
vi.mock('../../src/components/InputBox', () => ({ default: () => <div data-testid="input-box" /> }));
vi.mock('../../src/components/SessionPicker', () => ({ default: () => null }));
vi.mock('../../src/components/FileExplorer', () => ({
  default: ({ onOpenFile }: { onOpenFile: (path: string, readOnly: boolean) => void }) => (
    <div>
      <button type="button" onClick={() => onOpenFile('/repo/src/app.py', true)}>
        open text
      </button>
      <button type="button" onClick={() => onOpenFile('/repo/plot.png', true)}>
        open image
      </button>
      <button type="button" onClick={() => onOpenFile('/repo/big.txt', true)}>
        open large
      </button>
    </div>
  ),
}));
vi.mock('../../src/components/FileEditorModal', () => ({
  default: (props: { path: string; initialContent: string; sizeBytes?: number | null }) => (
    <div role="dialog" aria-label="File viewer">
      <span>{props.path}</span>
      <pre>{props.initialContent}</pre>
      <span>size:{props.sizeBytes ?? 'unknown'}</span>
    </div>
  ),
}));
vi.mock('../../src/components/ImageViewerModal', () => ({
  default: ({ path }: { path: string }) => <div role="dialog" aria-label="Image viewer">{path}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderApp() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<App />);
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('App file open behavior', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.readTextFileStream.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('opens text files through HTTP streaming instead of webui/fs/readFile', async () => {
    mocks.readTextFileStream.mockResolvedValue({ content: 'print("hello")\n', sizeBytes: 15, modifiedAtMs: 1234, truncated: false });

    renderApp();
    act(() => buttonByText('open text').click());
    await flushReact();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('/repo/src/app.py');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('size:15');
    expect(mocks.readTextFileStream).toHaveBeenCalledWith('/repo/src/app.py');
    expect(mocks.rpc).not.toHaveBeenCalledWith('webui/fs/readFile', expect.anything());
  });

  it('falls back to getMetadata when streaming headers do not include mtime', async () => {
    mocks.readTextFileStream.mockResolvedValue({ content: 'hello', sizeBytes: 5, modifiedAtMs: null, truncated: false });
    mocks.rpc.mockResolvedValue({ modifiedAtMs: 4321 });

    renderApp();
    act(() => buttonByText('open text').click());
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/fs/getMetadata', { path: '/repo/src/app.py' });
  });

  it('keeps image opens on the image viewer path', async () => {
    renderApp();
    act(() => buttonByText('open image').click());
    await flushReact();

    expect(document.querySelector('[aria-label="Image viewer"]')?.textContent).toContain('/repo/plot.png');
    expect(mocks.readTextFileStream).not.toHaveBeenCalled();
  });

  it('does not open Monaco when the streamed file is too large', async () => {
    mocks.readTextFileStream.mockRejectedValue(new FileContentTooLargeError(99999999));

    renderApp();
    act(() => buttonByText('open large').click());
    await flushReact();

    expect(document.body.textContent).toContain('too large');
    expect(document.querySelector('[aria-label="File viewer"]')).toBeNull();
  });
});
