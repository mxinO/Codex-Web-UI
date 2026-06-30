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
  activeThreadId: 'thread-1' as string | null,
  activeThreadPath: '/rollouts/thread-1.jsonl' as string | null,
  activeTurnId: 'turn-1' as string | null,
  reconnectEpoch: 0,
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
        queue: mocks.stateQueue,
      },
    },
    notifications: mocks.notifications,
    notificationCount: 0,
    requests: mocks.requests,
    rpc: mocks.rpc,
    submitToken: mocks.submitToken,
    reconnectEpoch: mocks.reconnectEpoch,
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
    mocks.requests = [];
    mocks.activeThreadId = 'thread-1';
    mocks.activeThreadPath = '/rollouts/thread-1.jsonl';
    mocks.activeTurnId = 'turn-1';
    mocks.reconnectEpoch = 0;
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

  it('saves a new goal as paused instead of immediately starting autonomous goal work', async () => {
    renderApp();
    await flushReact();
    mocks.rpc.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent('webui-slash-command', { detail: { input: '/goal Finish the migration' } }));
    });
    await flushReact();

    expect(mocks.rpc).toHaveBeenCalledWith('webui/thread/goal/set', {
      threadId: 'thread-1',
      objective: 'Finish the migration',
      status: 'paused',
    });
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
