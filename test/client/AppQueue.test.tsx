// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  setTheme: vi.fn(),
  enqueue: vi.fn(),
  removeQueued: vi.fn(),
  replaceQueue: vi.fn(),
  loadOlder: vi.fn(),
  jumpToLatest: vi.fn(),
  reloadTimeline: vi.fn(),
  submitToken: vi.fn(),
  queue: [] as Array<{ id: string; text: string; createdAt: number }>,
  timelineItems: [] as Array<{ id: string; kind: string; timestamp: number; text?: string }>,
  notifications: [] as unknown[],
  requests: [] as unknown[],
  stateQueue: [] as Array<{ id: string; text: string; createdAt: number }>,
}));

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
      state: { activeThreadId: 'thread-1', activeTurnId: 'turn-1', activeCwd: '/repo', queue: mocks.stateQueue },
    },
    notifications: mocks.notifications,
    notificationCount: 0,
    requests: mocks.requests,
    rpc: mocks.rpc,
    submitToken: mocks.submitToken,
    reconnectEpoch: 0,
  }),
}));
vi.mock('../../src/components/AuthOverlay', () => ({ default: () => null }));
vi.mock('../../src/components/ChatTimeline', () => ({
  default: ({ items }: { items: Array<{ id: string; kind: string; text?: string }> }) => (
    <div data-testid="chat-timeline">
      {items.map((item) => (
        <span data-chat-kind={item.kind} key={item.id}>
          {item.text}
        </span>
      ))}
    </div>
  ),
}));
vi.mock('../../src/components/CwdPicker', () => ({ default: () => null }));
vi.mock('../../src/components/DetailModal', () => ({ default: () => null }));
vi.mock('../../src/components/FileChangeTray', () => ({ default: () => null }));
vi.mock('../../src/components/FileExplorer', () => ({ default: () => null }));
vi.mock('../../src/components/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../../src/components/InputBox', () => ({
  default: ({ draftOverride }: { draftOverride: string | null }) => <div data-testid="input-draft">{draftOverride ?? ''}</div>,
}));
vi.mock('../../src/components/SessionPicker', () => ({ default: () => null }));

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

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

describe('App queued message tray', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.enqueue.mockReset();
    mocks.removeQueued.mockReset();
    mocks.replaceQueue.mockReset();
    mocks.queue = [];
    mocks.stateQueue = [];
    mocks.timelineItems = [];
    mocks.notifications = [];
    mocks.requests = [];
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('keeps queued messages in the composer tray instead of the chat timeline', async () => {
    const queued = { id: 'q1', text: 'queued text', createdAt: 1000 };
    mocks.queue = [queued];
    mocks.stateQueue = [queued];

    renderApp();
    await flushReact();

    expect(document.querySelector('.queue-tray .queued-message')?.textContent).toContain('queued text');
    expect(document.querySelector('[data-chat-kind="queued"]')).toBeNull();
  });

  it('returns canceled queued message text to the composer', async () => {
    const queued = { id: 'q1', text: 'queued text', createdAt: 1000 };
    mocks.queue = [queued];
    mocks.stateQueue = [queued];
    mocks.removeQueued.mockImplementation(async (_id: string, beforeReplace?: (result: unknown) => void) => {
      const result = { queue: [], removed: true };
      beforeReplace?.(result);
      return result;
    });

    renderApp();

    act(() => {
      buttonByText('Cancel').click();
    });
    await flushReact();

    expect(mocks.removeQueued).toHaveBeenCalledWith('q1', expect.any(Function));
    expect(document.querySelector('[data-testid="input-draft"]')?.textContent).toBe('queued text');
  });
});
