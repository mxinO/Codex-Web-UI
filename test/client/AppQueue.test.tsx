// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { ThreadGoal } from '../../src/types/ui';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  setTheme: vi.fn(),
  enqueue: vi.fn(),
  removeQueued: vi.fn(),
  replaceQueue: vi.fn(),
  loadOlder: vi.fn(),
  jumpToLatest: vi.fn(),
  reloadTimeline: vi.fn(),
  acknowledgeReplayGap: vi.fn(),
  submitToken: vi.fn(),
  queue: [] as Array<{ id: string; text: string; createdAt: number }>,
  timelineItems: [] as Array<{ id: string; kind: string; timestamp: number; text?: string }>,
  notifications: [] as unknown[],
  notificationCount: 0,
  requests: [] as unknown[],
  stateQueue: [] as Array<{ id: string; text: string; createdAt: number }>,
  activeThreadId: 'thread-1' as string | null,
  activeThreadPath: '/rollouts/thread-1.jsonl' as string | null,
  activeTurnId: 'turn-1' as string | null,
  activeGoal: null as ThreadGoal | null,
  reconnectEpoch: 0,
  replayGapEpoch: 0,
  timelineIsViewingLatest: true,
  runtimeModel: 'gpt-5.4' as string | null,
  runtimeEffort: 'high' as string | null,
  runtimeMode: null as string | null,
  runtimeSandbox: 'workspace-write' as string | null,
  chatTimelineItems: [] as Array<{
    id: string;
    kind: string;
    timestamp: number;
    text?: string;
    status?: Record<string, unknown>;
  }>,
  headerProps: null as null | {
    model?: string | null;
    effort?: string | null;
    modelOptions?: Array<{ model: string }>;
    effortOptions?: Array<{ reasoningEffort: string }>;
    runtimeOptionsDisabled?: boolean;
    runtimeOptionsLoading?: boolean;
    onOpenRuntimeOptions?: () => void;
    onSelectModel?: (model: string) => void;
    onSelectEffort?: (effort: string) => void;
  },
  inputProps: null as null | {
    runOptions?: { model: string | null; effort: string | null; mode: string | null; sandbox: string | null };
    draftOverride: string | null;
  },
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
    isViewingLatest: mocks.timelineIsViewingLatest,
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
      state: {
        activeThreadId: mocks.activeThreadId,
        activeThreadPath: mocks.activeThreadPath,
        activeTurnId: mocks.activeTurnId,
        activeCwd: '/repo',
        model: mocks.runtimeModel,
        effort: mocks.runtimeEffort,
        mode: mocks.runtimeMode,
        sandbox: mocks.runtimeSandbox,
        activeGoal: mocks.activeGoal,
        queue: mocks.stateQueue,
      },
    },
    notifications: mocks.notifications,
    notificationCount: mocks.notificationCount,
    requests: mocks.requests,
    rpc: mocks.rpc,
    submitToken: mocks.submitToken,
    reconnectEpoch: mocks.reconnectEpoch,
    replayGapEpoch: mocks.replayGapEpoch,
    acknowledgeReplayGap: mocks.acknowledgeReplayGap,
  }),
}));
vi.mock('../../src/components/AuthOverlay', () => ({ default: () => null }));
vi.mock('../../src/components/ChatTimeline', () => ({
  default: ({ items }: { items: typeof mocks.chatTimelineItems }) => {
    mocks.chatTimelineItems = items;
    return (
      <div data-testid="chat-timeline">
        {items.map((item) => (
          <span data-chat-kind={item.kind} key={item.id}>
            {item.text}
          </span>
        ))}
      </div>
    );
  },
}));
vi.mock('../../src/components/CwdPicker', () => ({ default: () => null }));
vi.mock('../../src/components/DetailModal', () => ({ default: () => null }));
vi.mock('../../src/components/FileChangeTray', () => ({ default: () => null }));
vi.mock('../../src/components/WorkspaceSidebar', () => ({ default: () => null }));
vi.mock('../../src/components/Header', () => ({
  default: (props: NonNullable<typeof mocks.headerProps>) => {
    mocks.headerProps = props;
    return <div data-testid="header">{(props as { sessionError?: string | null }).sessionError}</div>;
  },
}));
vi.mock('../../src/components/InputBox', () => ({
  default: (props: NonNullable<typeof mocks.inputProps>) => {
    mocks.inputProps = props;
    return <div data-testid="input-draft">{props.draftOverride ?? ''}</div>;
  },
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

function rerenderApp() {
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
    mocks.jumpToLatest.mockReset();
    mocks.queue = [];
    mocks.stateQueue = [];
    mocks.timelineItems = [];
    mocks.notifications = [];
    mocks.notificationCount = 0;
    mocks.requests = [];
    mocks.activeThreadId = 'thread-1';
    mocks.activeThreadPath = '/rollouts/thread-1.jsonl';
    mocks.activeTurnId = 'turn-1';
    mocks.activeGoal = null;
    mocks.reconnectEpoch = 0;
    mocks.replayGapEpoch = 0;
    mocks.reloadTimeline.mockReset().mockResolvedValue(true);
    mocks.acknowledgeReplayGap.mockReset();
    mocks.timelineIsViewingLatest = true;
    mocks.runtimeModel = 'gpt-5.4';
    mocks.runtimeEffort = 'high';
    mocks.runtimeMode = null;
    mocks.runtimeSandbox = 'workspace-write';
    mocks.chatTimelineItems = [];
    mocks.headerProps = null;
    mocks.inputProps = null;
    window.localStorage.clear();
  });

  it('reloads persisted history when notification replay has a gap after reconnect', async () => {
    renderApp();
    await flushReact();
    mocks.reloadTimeline.mockClear();

    mocks.reconnectEpoch += 1;
    mocks.replayGapEpoch += 1;
    rerenderApp();
    await flushReact();

    expect(mocks.reloadTimeline).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeReplayGap).toHaveBeenCalledWith(1);
  });

  it('does not re-handle an old replay gap when later connection state changes', async () => {
    renderApp();
    await flushReact();

    mocks.replayGapEpoch = 1;
    rerenderApp();
    await flushReact();
    mocks.reloadTimeline.mockClear();
    mocks.acknowledgeReplayGap.mockClear();

    mocks.reconnectEpoch += 1;
    rerenderApp();
    await flushReact();

    expect(mocks.reloadTimeline).not.toHaveBeenCalled();
    expect(mocks.acknowledgeReplayGap).not.toHaveBeenCalled();
  });

  it('does not acknowledge a replay gap when history recovery fails', async () => {
    mocks.reloadTimeline.mockResolvedValue(false);
    renderApp();
    await flushReact();

    mocks.replayGapEpoch = 1;
    rerenderApp();
    await flushReact();

    expect(mocks.reloadTimeline).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeReplayGap).not.toHaveBeenCalled();
  });

  it('retries an unacknowledged replay gap until history recovery succeeds', async () => {
    vi.useFakeTimers();
    mocks.reloadTimeline.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      renderApp();
      await flushReact();

      mocks.replayGapEpoch = 1;
      rerenderApp();
      await flushReact();
      expect(mocks.reloadTimeline).toHaveBeenCalledTimes(1);
      expect(mocks.acknowledgeReplayGap).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();
      });

      expect(mocks.reloadTimeline).toHaveBeenCalledTimes(2);
      expect(mocks.acknowledgeReplayGap).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reload persisted history for a contiguous reconnect', async () => {
    renderApp();
    await flushReact();
    mocks.reloadTimeline.mockClear();

    mocks.reconnectEpoch += 1;
    rerenderApp();
    await flushReact();

    expect(mocks.reloadTimeline).not.toHaveBeenCalled();
  });

  it('recovers a previous turn completion immediately before an autonomous turn starts', async () => {
    mocks.activeTurnId = 'turn-2';
    mocks.notifications = [
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } } },
    ];
    mocks.notificationCount = 2;

    renderApp();
    await flushReact();

    expect(mocks.reloadTimeline).toHaveBeenCalled();
  });

  it('keeps rendering live progress when an active goal advances to an autonomous turn', async () => {
    mocks.activeGoal = {
      threadId: 'thread-1', objective: 'Keep working', status: 'active', tokenBudget: null,
      tokensUsed: 1, timeUsedSeconds: 1, createdAt: 100, updatedAt: 100,
    };
    mocks.notifications = [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'First turn progress' } },
    ];
    mocks.notificationCount = 2;

    renderApp();
    await flushReact();
    expect(mocks.chatTimelineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'streaming', text: 'First turn progress', turnId: 'turn-1' }),
    ]));

    mocks.activeTurnId = 'turn-2';
    mocks.notifications = [
      ...mocks.notifications,
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'message-2', delta: 'Second turn progress' } },
    ];
    mocks.notificationCount = 5;
    rerenderApp();
    await flushReact();

    expect(mocks.chatTimelineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'streaming', text: 'Second turn progress', turnId: 'turn-2' }),
    ]));
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

  it('appends a claimed mid-turn prompt to the visible message flow', async () => {
    const queued = { id: 'q1', text: 'sent during turn', createdAt: 1000 };
    mocks.queue = [queued];
    mocks.stateQueue = [queued];
    mocks.timelineItems = [
      { id: 'already-visible', kind: 'assistant', timestamp: 2000, text: 'Already visible' },
    ];
    renderApp();
    await flushReact();

    mocks.queue = [];
    mocks.stateQueue = [];
    rerenderApp();
    await flushReact();

    expect(mocks.chatTimelineItems.map((item) => item.id)).toEqual([
      'already-visible',
      'claimed-queued:user:q1',
    ]);
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

  it('creates a new goal as active after checking authoritative state', async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/goal/get') return { goal: null };
      if (method === 'webui/thread/goal/replace') return { goal: null };
      return {};
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal Finish the migration' } }));
    });
    await flushReact();

    const goalCalls = mocks.rpc.mock.calls.filter(([method]) => String(method).startsWith('webui/thread/goal/'));
    expect(goalCalls).toEqual([
      ['webui/thread/goal/get', { threadId: 'thread-1' }],
      ['webui/thread/goal/replace', {
        threadId: 'thread-1',
        objective: 'Finish the migration',
        expectedGoal: null,
      }],
    ]);
  });

  it('confirms replacement of an unfinished goal and restores the proposed command on cancel', async () => {
    const goal: ThreadGoal = {
      threadId: 'thread-1',
      objective: 'Old objective',
      status: 'paused',
      tokenBudget: null,
      tokensUsed: 9,
      timeUsedSeconds: 4,
      createdAt: 100,
      updatedAt: 101,
    };
    mocks.activeGoal = goal;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/goal/get') return { goal };
      return {};
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal New objective' } }));
    });
    await flushReact();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Old objective');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New objective');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    act(() => buttonByText('Cancel').click());
    expect(document.querySelector('[data-testid="input-draft"]')?.textContent).toBe('/goal New objective');
  });

  it('replaces a confirmed unfinished goal with its original fingerprint', async () => {
    const goal: ThreadGoal = {
      threadId: 'thread-1', objective: 'Old objective', status: 'active', tokenBudget: null,
      tokensUsed: 9, timeUsedSeconds: 4, createdAt: 100, updatedAt: 101,
    };
    mocks.activeGoal = goal;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/goal/get') return { goal };
      return {};
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal New objective' } })));
    await flushReact();
    act(() => buttonByText('Replace').click());
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/goal/replace', {
      threadId: 'thread-1',
      objective: 'New objective',
      expectedGoal: { objective: 'Old objective', createdAt: 100, status: 'active' },
    });
  });

  it('replaces a completed goal without confirmation', async () => {
    const goal: ThreadGoal = {
      threadId: 'thread-1', objective: 'Done objective', status: 'complete', tokenBudget: null,
      tokensUsed: 9, timeUsedSeconds: 4, createdAt: 100, updatedAt: 101,
    };
    mocks.activeGoal = goal;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/goal/get') return { goal };
      return {};
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal Next objective' } })));
    await flushReact();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/goal/replace', {
      threadId: 'thread-1', objective: 'Next objective',
      expectedGoal: { objective: 'Done objective', createdAt: 100, status: 'complete' },
    });
  });

  it('edits a goal objective without sending status or budget fields', async () => {
    const goal: ThreadGoal = {
      threadId: 'thread-1', objective: 'Old objective', status: 'paused', tokenBudget: 500,
      tokensUsed: 9, timeUsedSeconds: 4, createdAt: 100, updatedAt: 101,
    };
    mocks.activeGoal = goal;
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => buttonByText('Edit').click());
    const textarea = document.querySelector('textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('goal textarea not found');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Updated objective');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttonByText('Save').click());
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/goal/edit', {
      threadId: 'thread-1', objective: 'Updated objective',
      expectedGoal: { objective: 'Old objective', createdAt: 100 },
    });
  });

  it('keeps edit failures visible in the dialog and disables a stale retry', async () => {
    mocks.activeGoal = {
      threadId: 'thread-1', objective: 'Old objective', status: 'paused', tokenBudget: null,
      tokensUsed: 9, timeUsedSeconds: 4, createdAt: 100, updatedAt: 101,
    };
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/goal/edit') throw new Error('goal edit conflicted with a different goal');
      return {};
    });
    renderApp();
    await flushReact();
    act(() => buttonByText('Edit').click());
    act(() => buttonByText('Save').click());
    await flushReact();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Cancel and reopen Edit');
    expect(buttonByText('Save').disabled).toBe(true);
  });

  it('offers Continue only after an active goal remains idle for the grace period', async () => {
    vi.useFakeTimers();
    mocks.activeTurnId = null;
    mocks.activeGoal = {
      threadId: 'thread-1', objective: 'Keep working', status: 'active', tokenBudget: null,
      tokensUsed: 9, timeUsedSeconds: 4, createdAt: 100, updatedAt: 101,
    };
    mocks.rpc.mockResolvedValue({});
    try {
      renderApp();
      await flushReact();
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Continue')).toBe(false);

      act(() => vi.advanceTimersByTime(1499));
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Continue')).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(buttonByText('Continue')).toBeTruthy();

      mocks.activeGoal = { ...mocks.activeGoal, objective: 'Replacement goal', createdAt: 200, updatedAt: 200 } as ThreadGoal;
      rerenderApp();
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Continue')).toBe(false);
      act(() => vi.advanceTimersByTime(1500));
      act(() => buttonByText('Continue').click());
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Continue')).toBe(false);
      act(() => vi.advanceTimersByTime(1499));
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Continue')).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(buttonByText('Continue')).toBeTruthy();
      await flushReact();

      expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/goal/set', { threadId: 'thread-1', status: 'active' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a deferred goal proposal after switching sessions', async () => {
    const pendingReads = new Map<string, (value: unknown) => void>();
    mocks.rpc.mockResolvedValue({ goal: null });
    renderApp();
    await flushReact();
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async (method: string, params?: { threadId?: string }) => {
      if (method !== 'webui/thread/goal/get' || !params?.threadId) return {};
      return new Promise((resolve) => pendingReads.set(params.threadId as string, resolve));
    });

    act(() => window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal Old session work' } })));
    await flushReact();
    mocks.activeThreadId = 'thread-2';
    mocks.activeThreadPath = '/rollouts/thread-2.jsonl';
    rerenderApp();
    await flushReact();
    await act(async () => pendingReads.get('thread-1')?.({ goal: null }));
    await flushReact();

    expect(mocks.rpc).not.toHaveBeenCalledWith('webui/thread/goal/replace', expect.anything());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="input-draft"]')?.textContent).toBe('');
    await act(async () => pendingReads.get('thread-2')?.({ goal: null }));
  });

  it('rejects a second goal command while the first command is pending', async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.rpc.mockResolvedValue({ goal: null });
    renderApp();
    await flushReact();
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method !== 'webui/thread/goal/get') return {};
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal First objective' } }));
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal Second objective' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="input-draft"]')?.textContent).toBe('/goal Second objective');
    await act(async () => resolveFirst({ goal: null }));
    await flushReact();
  });

  it('shows a goal returned with snake_case fields', async () => {
    renderApp();
    await flushReact();
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({
      goal: {
        thread_id: 'thread-1',
        objective: 'Finish the migration',
        status: 'paused',
        token_budget: null,
        tokens_used: 7,
        time_used_seconds: 2,
        created_at: 100,
        updated_at: 101,
      },
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal' } }));
    });
    await flushReact();

    expect(document.body.textContent).toContain('Goal paused: Finish the migration');
  });

  it('updates an idle active session model with a compatible effort and persists the result', async () => {
    mocks.activeTurnId = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deeper' }],
              defaultReasoningEffort: 'high',
            },
            {
              id: 'gpt-5.4-mini',
              model: 'gpt-5.4-mini',
              displayName: 'GPT-5.4 mini',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
              defaultReasoningEffort: 'medium',
            },
          ],
        };
      }
      if (method === 'webui/thread/runtime-options/set') {
        return { model: 'gpt-5.4-mini', effort: 'medium' };
      }
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => mocks.headerProps?.onOpenRuntimeOptions?.());
    await flushReact();
    expect(mocks.rpc).toHaveBeenCalledWith('webui/model/list');
    expect(mocks.headerProps?.modelOptions?.map((model) => model.model)).toEqual(['gpt-5.4', 'gpt-5.4-mini']);

    act(() => mocks.headerProps?.onSelectModel?.('gpt-5.4-mini'));
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      model: 'gpt-5.4-mini',
      effort: 'medium',
    });
    expect(window.localStorage.getItem('codex-web-ui:model')).toBe('gpt-5.4-mini');
    expect(window.localStorage.getItem('codex-web-ui:effort')).toBe('medium');
  });

  it('clears the prior effort when the selected model exposes no effort choices', async () => {
    mocks.activeTurnId = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'custom-model',
            model: 'custom-model',
            displayName: 'Custom model',
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
          }],
        };
      }
      if (method === 'webui/thread/runtime-options/set') return { model: 'custom-model', effort: null };
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => mocks.headerProps?.onSelectModel?.('custom-model'));
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      model: 'custom-model',
      effort: null,
    });
    expect(window.localStorage.getItem('codex-web-ui:model')).toBe('custom-model');
    expect(window.localStorage.getItem('codex-web-ui:effort')).toBeNull();
  });

  it('does not revive a stale local effort when the active session effort is null', async () => {
    mocks.activeTurnId = null;
    mocks.runtimeEffort = null;
    window.localStorage.setItem('codex-web-ui:effort', 'high');
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'gpt-next',
            model: 'gpt-next',
            displayName: 'GPT next',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Default' },
              { reasoningEffort: 'high', description: 'Deeper' },
            ],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      if (method === 'webui/thread/runtime-options/set') return { model: 'gpt-next', effort: 'medium' };
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => mocks.headerProps?.onSelectModel?.('gpt-next'));
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      model: 'gpt-next',
      effort: 'medium',
    });
  });

  it('routes slash model changes through the active-session runtime update', async () => {
    mocks.activeTurnId = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      if (method === 'webui/thread/runtime-options/set') return { model: 'gpt-5.5', effort: 'medium' };
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/model gpt-5.5' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      model: 'gpt-5.5',
      effort: 'medium',
    });
  });

  it('accepts app-server-defined effort values through the shared slash path', async () => {
    mocks.activeTurnId = null;
    mocks.runtimeModel = 'gpt-5.6-sol';
    mocks.runtimeEffort = 'medium';
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'ultra', description: 'Automatic delegation' },
            ],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      if (method === 'webui/thread/runtime-options/set') return { model: 'gpt-5.6-sol', effort: 'ultra' };
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/effort ultra' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      effort: 'ultra',
    });
  });

  it('keeps no-session model choices local until a session is created', async () => {
    mocks.activeThreadId = null;
    mocks.activeTurnId = null;
    mocks.runtimeModel = null;
    mocks.runtimeEffort = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => mocks.headerProps?.onSelectModel?.('gpt-5.5'));
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/model/list');
    expect(mocks.rpc).not.toHaveBeenCalledWith('webui/thread/runtime-options/set', expect.anything());
    expect(window.localStorage.getItem('codex-web-ui:model')).toBe('gpt-5.5');
    expect(window.localStorage.getItem('codex-web-ui:effort')).toBe('medium');
  });

  it('does not persist an active-session selection rejected by app-server', async () => {
    mocks.activeTurnId = null;
    window.localStorage.setItem('codex-web-ui:model', 'gpt-5.4');
    window.localStorage.setItem('codex-web-ui:effort', 'high');
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/model/list') {
        return {
          data: [{
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      if (method === 'webui/thread/runtime-options/set') throw new Error('model unavailable');
      return {};
    });

    renderApp();
    await flushReact();

    act(() => mocks.headerProps?.onSelectModel?.('gpt-5.5'));
    await flushReact();

    expect(window.localStorage.getItem('codex-web-ui:model')).toBe('gpt-5.4');
    expect(window.localStorage.getItem('codex-web-ui:effort')).toBe('high');
    expect(document.querySelector('[data-testid="header"]')?.textContent).toContain('model unavailable');
  });

  it('recovers when opening the model catalog throws synchronously', async () => {
    mocks.activeTurnId = null;
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/model/list') throw new Error('socket unavailable');
      return Promise.resolve({});
    });

    renderApp();
    await flushReact();

    act(() => mocks.headerProps?.onOpenRuntimeOptions?.());
    await flushReact();

    expect(mocks.headerProps?.runtimeOptionsLoading).toBe(false);
    expect(document.querySelector('[data-testid="header"]')?.textContent).toContain('socket unavailable');
  });

  it('uses active server model and effort for turns instead of stale browser defaults', async () => {
    mocks.activeTurnId = null;
    mocks.runtimeModel = 'gpt-5.6-sol';
    mocks.runtimeEffort = 'ultra';
    mocks.runtimeMode = 'default';
    mocks.runtimeSandbox = 'read-only';
    window.localStorage.setItem('codex-web-ui:model', 'gpt-5.4');
    window.localStorage.setItem('codex-web-ui:effort', 'medium');
    window.localStorage.setItem('codex-web-ui:mode', 'plan');
    window.localStorage.setItem('codex-web-ui:sandbox', 'danger-full-access');

    renderApp();
    await flushReact();

    expect(mocks.inputProps?.runOptions).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      mode: 'default',
      sandbox: 'read-only',
    });
  });

  it('resumes another session without copying the current session runtime options', async () => {
    mocks.activeTurnId = null;
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/session/resume') return new Promise(() => undefined);
      return Promise.resolve({});
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/resume thread-2' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/session/resume', {
      threadId: 'thread-2',
      threadPath: undefined,
    });
  });

  it('applies active mode and sandbox commands through runtime settings', async () => {
    mocks.activeTurnId = null;
    mocks.runtimeModel = 'gpt-5.6-sol';
    mocks.rpc.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'webui/thread/runtime-options/set') {
        return { model: 'gpt-5.6-sol', effort: 'medium', mode: (params as { mode?: string }).mode ?? null, sandbox: (params as { sandbox?: string }).sandbox ?? 'workspace-write' };
      }
      return {};
    });

    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/mode plan' } }));
    });
    await flushReact();
    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      mode: 'plan',
    });

    mocks.rpc.mockClear();
    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/sandbox read-only' } }));
    });
    await flushReact();
    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/runtime-options/set', {
      threadId: 'thread-1',
      sandbox: 'read-only',
    });
  });

  it('loads /status into one runtime status item and clears the header error', async () => {
    const result = runtimeStatusResult();
    mocks.rpc.mockImplementation(async (method: string) => (method === 'webui/thread/status' ? result : {}));
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/help' } }));
    });
    expect(document.querySelector('[data-testid="header"]')?.textContent).toContain('Commands:');

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/status', { threadId: 'thread-1' });
    expect(mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus')).toHaveLength(1);
    expect(mocks.chatTimelineItems.find((item) => item.kind === 'runtimeStatus')?.status).toEqual(result);
    expect(document.querySelector('[data-testid="header"]')?.textContent).toBe('');
  });

  it('appends a normal error item on /status failure without removing prior items', async () => {
    mocks.timelineItems = [{ id: 'existing-user', kind: 'user', timestamp: 1, text: 'Keep me' }];
    const result = runtimeStatusResult();
    mocks.rpc.mockImplementation(async (method: string) => (method === 'webui/thread/status' ? result : {}));
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/status') throw new Error('EACCES: /home/private/.codex/rollout.jsonl');
      return {};
    });
    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    expect(mocks.chatTimelineItems.map((item) => item.kind)).toEqual(expect.arrayContaining(['user', 'runtimeStatus', 'error']));
    expect(mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus')).toHaveLength(1);
    expect(mocks.chatTimelineItems.find((item) => item.kind === 'error')?.text).toBe('Unable to load runtime status. Retry /status.');
    expect(document.body.textContent).not.toContain('/home/private');
    expect(document.body.textContent).not.toContain('EACCES');
    expect(document.querySelector('[data-testid="header"]')?.textContent).toBe('');
  });

  it('builds a local unconfirmed /status item without an active session or RPC', async () => {
    mocks.activeThreadId = null;
    mocks.activeTurnId = null;
    mocks.runtimeModel = null;
    mocks.runtimeEffort = null;
    mocks.runtimeMode = null;
    mocks.runtimeSandbox = null;
    window.localStorage.setItem('codex-web-ui:model', 'gpt-local');
    window.localStorage.setItem('codex-web-ui:effort', 'medium');
    window.localStorage.setItem('codex-web-ui:mode', 'plan');
    window.localStorage.setItem('codex-web-ui:sandbox', 'read-only');
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    expect(mocks.rpc).not.toHaveBeenCalledWith('webui/thread/status', expect.anything());
    const item = mocks.chatTimelineItems.find((candidate) => candidate.kind === 'runtimeStatus');
    expect(item?.status).toMatchObject({
      hostname: 'host',
      threadId: null,
      cwd: '/repo',
      model: 'gpt-local',
      effort: 'medium',
      mode: 'plan',
      sandbox: 'read-only',
      confirmed: false,
      confirmationSource: null,
      confirmedAt: null,
      lastTurn: { status: 'none', context: null, scannedBytes: 0 },
    });
  });

  it('does not append a resolved /status response after the active session changes', async () => {
    const request = deferred<ReturnType<typeof runtimeStatusResult>>();
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/thread/status') return request.promise;
      return Promise.resolve({});
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();
    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/status', { threadId: 'thread-1' });

    mocks.activeThreadId = 'thread-2';
    mocks.activeTurnId = null;
    rerenderApp();
    await flushReact();

    request.resolve(runtimeStatusResult());
    await flushReact();

    expect(mocks.chatTimelineItems.some((item) => item.kind === 'runtimeStatus' || item.kind === 'error')).toBe(false);
  });

  it.each([
    ['malformed data', { ...runtimeStatusResult(), lastTurn: { status: 'found', context: null, scannedBytes: 0 } }],
    ['cross-thread data', { ...runtimeStatusResult(), threadId: 'thread-other' }],
  ])('turns %s into a generic ephemeral status error', async (_label, result) => {
    mocks.rpc.mockImplementation(async (method: string) => (method === 'webui/thread/status' ? result : {}));
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    expect(mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus')).toHaveLength(0);
    expect(mocks.chatTimelineItems.find((item) => item.kind === 'error')?.text).toBe('Unable to load runtime status. Retry /status.');
    expect(document.querySelector('[data-testid="header"]')?.textContent).toBe('');
  });

  it.each([
    ['thread path', () => { mocks.activeThreadPath = '/rollouts/thread-1-replaced.jsonl'; }],
    ['reconnect epoch', () => { mocks.reconnectEpoch += 1; }],
  ])('ignores a pending /status response after the committed %s changes', async (_label, changeScope) => {
    const request = deferred<ReturnType<typeof runtimeStatusResult>>();
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/thread/status') return request.promise;
      return Promise.resolve({});
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    changeScope();
    rerenderApp();
    await flushReact();
    request.resolve(runtimeStatusResult());
    await flushReact();

    expect(mocks.chatTimelineItems.some((item) => item.kind === 'runtimeStatus' || item.kind === 'error')).toBe(false);
  });

  it('keeps only the newest overlapping /status response', async () => {
    const first = deferred<ReturnType<typeof runtimeStatusResult>>();
    const second = deferred<ReturnType<typeof runtimeStatusResult>>();
    let requestIndex = 0;
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/thread/status') return [first.promise, second.promise][requestIndex++];
      return Promise.resolve({});
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    second.resolve({ ...runtimeStatusResult(), model: 'newest-model' });
    await flushReact();
    first.resolve({ ...runtimeStatusResult(), model: 'stale-model' });
    await flushReact();

    const statuses = mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.status?.model).toBe('newest-model');
  });

  it('invalidates a pending active-session request when local no-session status is invoked', async () => {
    const request = deferred<ReturnType<typeof runtimeStatusResult>>();
    mocks.rpc.mockImplementation((method: string) => {
      if (method === 'webui/thread/status') return request.promise;
      return Promise.resolve({});
    });
    renderApp();
    await flushReact();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    mocks.activeThreadId = null;
    mocks.activeThreadPath = null;
    mocks.activeTurnId = null;
    rerenderApp();
    await flushReact();
    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    request.resolve(runtimeStatusResult());
    await flushReact();

    const statuses = mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.status?.threadId).toBeNull();
    expect(mocks.chatTimelineItems.some((item) => item.kind === 'error')).toBe(false);
  });

  it('jumps to latest before requesting /status while older history is visible', async () => {
    const events: string[] = [];
    mocks.timelineIsViewingLatest = false;
    mocks.jumpToLatest.mockImplementation(() => {
      events.push('jump');
      mocks.timelineIsViewingLatest = true;
    });
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'webui/thread/status') {
        events.push('rpc');
        return runtimeStatusResult();
      }
      return {};
    });
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/status' } }));
    });
    await flushReact();

    expect(events).toEqual(['jump', 'rpc']);
    expect(mocks.jumpToLatest).toHaveBeenCalledTimes(1);
    expect(mocks.chatTimelineItems.filter((item) => item.kind === 'runtimeStatus')).toHaveLength(1);
  });
});

function runtimeStatusResult() {
  return {
    hostname: 'host',
    threadId: 'thread-1',
    cwd: '/repo',
    activeTurnId: 'turn-1',
    model: 'gpt-5.4',
    effort: 'high',
    mode: null,
    sandbox: 'workspace-write',
    confirmed: true,
    confirmationSource: 'threadStart' as const,
    confirmedAt: '2026-06-30T12:00:00.000Z',
    lastTurn: {
      status: 'found' as const,
      context: {
        turnId: 'turn-previous',
        model: 'gpt-5.4',
        effort: 'high',
        recordedAt: '2026-06-30T11:00:00.000Z',
      },
      scannedBytes: 1024,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
