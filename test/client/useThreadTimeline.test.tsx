// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadTimeline } from '../../src/hooks/useThreadTimeline';
import type { CodexTurn } from '../../src/types/codex';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult = ReturnType<typeof useThreadTimeline>;
type RpcResult = { data?: CodexTurn[]; turns?: CodexTurn[]; thread?: { turns?: CodexTurn[] }; nextCursor?: string | null; next_cursor?: string | null };
type TimelineRpc = Parameters<typeof useThreadTimeline>[2];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentTimeline: HookResult | null = null;

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] | null = null;
  let reject: Deferred<T>['reject'] | null = null;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve: resolve!, reject: reject! };
}

function makeTurn(id: string, text = id): CodexTurn {
  return {
    id,
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
    items: [{ type: 'agentMessage', id: `${id}-item`, text, phase: null }],
  };
}

function makeTurns(prefix: string, count: number): CodexTurn[] {
  return Array.from({ length: count }, (_, index) => makeTurn(`${prefix}-${index}`, `${prefix}-${index}`));
}

function asRpc(mock: unknown): TimelineRpc {
  return mock as TimelineRpc;
}

function itemText(item: NonNullable<HookResult>['items'][number]): string {
  return item.kind === 'assistant' || item.kind === 'user' || item.kind === 'notice' || item.kind === 'streaming' ? item.text : '';
}

function Harness({
  activeThreadId,
  activeThreadPath,
  rpc,
}: {
  activeThreadId: string | null;
  activeThreadPath: string | null;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
}) {
  currentTimeline = useThreadTimeline(activeThreadId, activeThreadPath, rpc);
  return null;
}

async function renderHook(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>, activeThreadPath: string | null = null) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<Harness activeThreadId={activeThreadId} activeThreadPath={activeThreadPath} rpc={rpc} />);
  });
}

async function rerenderHook(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>, activeThreadPath: string | null = null) {
  await act(async () => {
    root?.render(<Harness activeThreadId={activeThreadId} activeThreadPath={activeThreadPath} rpc={rpc} />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  vi.useRealTimers();
  container?.remove();
  root = null;
  container = null;
  currentTimeline = null;
});

describe('useThreadTimeline', () => {
  it('initial latest fetch reverses desc data and supports next_cursor', async () => {
    const first = deferred<RpcResult>();
    const rpc = vi.fn(() => first.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      first.resolve({ data: [makeTurn('newer'), makeTurn('older')], next_cursor: 'older-cursor' });
      await first.promise;
    });

    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 12,
      sortDirection: 'desc',
      cursor: null,
    }, 120000);
    expect(currentTimeline?.items.map(itemText)).toEqual(['older', 'newer']);
    expect(currentTimeline?.hasOlder).toBe(true);
    expect((currentTimeline as HookResult & { isViewingLatest?: boolean })?.isViewingLatest).toBe(true);
  });

  it('includes the active thread path when loading history after refresh', async () => {
    const first = deferred<RpcResult>();
    const rpc = vi.fn(() => first.promise);
    const threadPath = '/home/user/.codex/sessions/2026/05/05/rollout-thread-1.jsonl';

    await renderHook('thread-1', asRpc(rpc), threadPath);

    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      threadPath,
      limit: 12,
      sortDirection: 'desc',
      cursor: null,
    }, 120000);
  });

  it('initial load failure exposes an error and retries the fixed-size latest page', async () => {
    vi.useFakeTimers();
    const failed = deferred<RpcResult>();
    const retry = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      failed.reject(new Error('RPC request timed out: thread/turns/list'));
      await failed.promise.catch(() => undefined);
    });

    expect(currentTimeline?.items).toEqual([]);
    expect(currentTimeline?.loading).toBe(false);
    expect(currentTimeline?.loadError).toBe('RPC request timed out: thread/turns/list');
    expect(currentTimeline?.retryScheduled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 12,
      sortDirection: 'desc',
      cursor: null,
    }, 120000);

    await act(async () => {
      retry.resolve({ data: [makeTurn('turn-1')], nextCursor: null });
      await retry.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1']);
    expect(currentTimeline?.loadError).toBeNull();
    expect(currentTimeline?.retryScheduled).toBe(false);
  });

  it('stops automatic initial retries after the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(() => Promise.reject(new Error('thread not found')));

    await renderHook('thread-1', asRpc(rpc));

    for (const delay of [1000, 2500, 5000, 10000]) {
      await act(async () => {
        await Promise.resolve();
      });
      expect(currentTimeline?.retryScheduled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(delay);
      });
    }

    await act(async () => {
      await Promise.resolve();
    });
    expect(currentTimeline?.loadError).toBe('thread not found');
    expect(currentTimeline?.retryScheduled).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  it('loadOlder prepends older messages while preserving the latest page when under the window limit', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(older.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('latest-new'), makeTurn('latest-old')], nextCursor: 'cursor-1' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('older-new'), makeTurn('older-old')], nextCursor: null });
      await older.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['older-old', 'older-new', 'latest-old', 'latest-new']);
    expect(currentTimeline?.hasOlder).toBe(false);
    expect((currentTimeline as HookResult & { isViewingLatest?: boolean })?.isViewingLatest).toBe(false);
  });

  it('loadOlder keeps a bounded older-side window when the timeline is long', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(older.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: makeTurns('latest', 5), nextCursor: 'cursor-1' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: makeTurns('older', 130), nextCursor: 'cursor-2' });
      await older.promise;
    });

    const texts = currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '') ?? [];
    expect(currentTimeline?.items).toHaveLength(120);
    expect(texts[0]).toBe('older-129');
    expect(texts.at(-1)).toBe('older-10');
    expect(texts).not.toContain('older-9');
    expect(texts).not.toContain('latest-0');
    expect(currentTimeline?.hasOlder).toBe(true);
    expect((currentTimeline as HookResult & { isViewingLatest?: boolean })?.isViewingLatest).toBe(false);
  });

  it('accepts turns response shape when loading history', async () => {
    const first = deferred<RpcResult>();
    const rpc = vi.fn(() => first.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      first.resolve({ turns: [makeTurn('newer'), makeTurn('older')], nextCursor: 'older-cursor' });
      await first.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['older', 'newer']);
    expect(currentTimeline?.hasOlder).toBe(true);
  });

  it('accepts nested thread turns response shape when loading history', async () => {
    const first = deferred<RpcResult>();
    const rpc = vi.fn(() => first.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      first.resolve({ thread: { turns: [makeTurn('newer'), makeTurn('older')] }, nextCursor: null });
      await first.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['older', 'newer']);
  });

  it('reload merges newly fetched latest turns without dropping older loaded messages', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const catchup = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(catchup.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('turn-3'), makeTurn('turn-2')], nextCursor: 'cursor-1' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('turn-1')], nextCursor: null });
      await older.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1', 'turn-2', 'turn-3']);

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      catchup.resolve({ data: [makeTurn('turn-4'), makeTurn('turn-3', 'turn-3 updated')], nextCursor: null });
      await catchup.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1', 'turn-2', 'turn-3 updated', 'turn-4']);
  });

  it('reload merges sparse stale latest pages without deleting rendered newer turns', async () => {
    const latest = deferred<RpcResult>();
    const staleReload = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(staleReload.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('turn-3'), makeTurn('turn-2'), makeTurn('turn-1')], nextCursor: null });
      await latest.promise;
    });

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      staleReload.resolve({ data: [makeTurn('turn-2', 'turn-2 refreshed')], nextCursor: null });
      await staleReload.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1', 'turn-2 refreshed', 'turn-3']);
  });

  it('reload merges a partial same-turn response without deleting already rendered items', async () => {
    const latest = deferred<RpcResult>();
    const partialReload = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(partialReload.promise);
    const fullTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'a1', text: 'complete answer', phase: null },
      ],
    };
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'a1', text: 'partial', phase: null },
      ],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [fullTurn], nextCursor: null });
      await latest.promise;
    });
    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'complete answer']);

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      partialReload.resolve({ data: [partialTurn], nextCursor: null });
      await partialReload.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'complete answer']);
  });

  it('reload replaces an in-progress partial assistant when final history uses a different item id', async () => {
    const partial = deferred<RpcResult>();
    const completed = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(partial.promise).mockReturnValueOnce(completed.promise);
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'transport-partial', text: 'I found the issue', phase: 'final_answer' },
      ],
    };
    const completedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'persisted-final', text: 'I found the issue and fixed it.', phase: 'final_answer' },
      ],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });
    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'I found the issue']);

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      completed.resolve({ data: [completedTurn], nextCursor: null });
      await completed.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'I found the issue and fixed it.']);
  });

  it('reload replaces an exact same-text in-progress assistant when final history uses a different item id', async () => {
    const partial = deferred<RpcResult>();
    const completed = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(partial.promise).mockReturnValueOnce(completed.promise);
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [{ type: 'agentMessage', id: 'transport-partial', text: 'Done.', phase: 'final_answer' }],
    };
    const completedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-final', text: 'Done.', phase: 'final_answer' }],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      completed.resolve({ data: [completedTurn], nextCursor: null });
      await completed.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done.']);
  });

  it('reload replaces a short in-progress assistant prefix when final history uses a different item id', async () => {
    const partial = deferred<RpcResult>();
    const completed = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(partial.promise).mockReturnValueOnce(completed.promise);
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [{ type: 'agentMessage', id: 'transport-partial', text: 'Done', phase: 'final_answer' }],
    };
    const completedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-final', text: 'Done with tests.', phase: 'final_answer' }],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      completed.resolve({ data: [completedTurn], nextCursor: null });
      await completed.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done with tests.']);
  });

  it('reload ignores a stale in-progress partial assistant after terminal history with a different item id', async () => {
    const completed = deferred<RpcResult>();
    const partial = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(completed.promise).mockReturnValueOnce(partial.promise);
    const completedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'persisted-final', text: 'I found the issue and fixed it.', phase: 'final_answer' },
      ],
    };
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'transport-partial', text: 'I found the issue', phase: 'final_answer' },
      ],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      completed.resolve({ data: [completedTurn], nextCursor: null });
      await completed.promise;
    });
    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'I found the issue and fixed it.']);

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'I found the issue and fixed it.']);
  });

  it('reload ignores exact same-text stale in-progress assistant after terminal history with a different item id', async () => {
    const completed = deferred<RpcResult>();
    const partial = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(completed.promise).mockReturnValueOnce(partial.promise);
    const completedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-final', text: 'Done.', phase: 'final_answer' }],
    };
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [{ type: 'agentMessage', id: 'transport-partial', text: 'Done.', phase: 'final_answer' }],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      completed.resolve({ data: [completedTurn], nextCursor: null });
      await completed.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done.']);
  });

  it('reload preserves distinct same-text assistant messages with different item ids', async () => {
    const first = deferred<RpcResult>();
    const second = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' }],
    };
    const secondTurn: CodexTurn = {
      ...firstTurn,
      items: [
        { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' },
        { type: 'agentMessage', id: 'a2', text: 'Done.', phase: 'final_answer' },
      ],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      first.resolve({ data: [firstTurn], nextCursor: null });
      await first.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      second.resolve({ data: [secondTurn], nextCursor: null });
      await second.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done.', 'Done.']);
  });

  it('reload preserves existing repeated same-text messages when a sparse terminal page returns one copy', async () => {
    const first = deferred<RpcResult>();
    const sparse = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(sparse.promise);
    const completeTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' },
        { type: 'agentMessage', id: 'a2', text: 'Done.', phase: 'final_answer' },
      ],
    };
    const sparseTurn: CodexTurn = {
      ...completeTurn,
      items: [{ type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' }],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      first.resolve({ data: [completeTurn], nextCursor: null });
      await first.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      sparse.resolve({ data: [sparseTurn], nextCursor: null });
      await sparse.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done.', 'Done.']);
  });

  it('reload removes only one stale same-text partial per covering final item', async () => {
    const partial = deferred<RpcResult>();
    const sparse = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(partial.promise).mockReturnValueOnce(sparse.promise);
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        { type: 'agentMessage', id: 'transport-1', text: 'Done.', phase: 'final_answer' },
        { type: 'agentMessage', id: 'transport-2', text: 'Done.', phase: 'final_answer' },
      ],
    };
    const sparseTurn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'final_answer' }],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      partial.resolve({ data: [partialTurn], nextCursor: null });
      await partial.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      sparse.resolve({ data: [sparseTurn], nextCursor: null });
      await sparse.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['Done.', 'Done.']);
  });

  it('reload does not regress a terminal failed turn to a partial in-progress response', async () => {
    const latest = deferred<RpcResult>();
    const partialReload = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(partialReload.promise);
    const failedTurn: CodexTurn = {
      id: 'turn-1',
      status: 'failed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'a1', text: 'error context', phase: null },
      ],
    };
    const partialTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: 'a1', text: 'partial', phase: null },
      ],
    };

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [failedTurn], nextCursor: null });
      await latest.promise;
    });

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      partialReload.resolve({ data: [partialTurn], nextCursor: null });
      await partialReload.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['question', 'error context']);
  });

  it('reload after older pagination preserves the older-page cursor', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const catchup = deferred<RpcResult>();
    const nextOlder = deferred<RpcResult>();
    const rpc = vi
      .fn()
      .mockReturnValueOnce(latest.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(catchup.promise)
      .mockReturnValueOnce(nextOlder.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('turn-4'), makeTurn('turn-3')], nextCursor: 'cursor-after-latest' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('turn-2')], nextCursor: 'cursor-after-older' });
      await older.promise;
    });
    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      catchup.resolve({ data: [makeTurn('turn-5'), makeTurn('turn-4')], nextCursor: 'stale-latest-cursor' });
      await catchup.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });

    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 12,
      sortDirection: 'desc',
      cursor: 'cursor-after-older',
    }, 120000);

    await act(async () => {
      nextOlder.resolve({ data: [makeTurn('turn-1')], nextCursor: null });
      await nextOlder.promise;
    });
    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
  });

  it('reload after exhausting older pagination does not restore a latest-page cursor', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const catchup = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(catchup.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('turn-3')], nextCursor: 'cursor-after-latest' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('turn-2')], nextCursor: null });
      await older.promise;
    });
    expect(currentTimeline?.hasOlder).toBe(false);

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      catchup.resolve({ data: [makeTurn('turn-4'), makeTurn('turn-3')], nextCursor: 'stale-latest-cursor' });
      await catchup.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });

    expect(currentTimeline?.hasOlder).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-2', 'turn-3', 'turn-4']);
  });

  it('reload failure preserves existing messages and older cursor', async () => {
    const latest = deferred<RpcResult>();
    const failedReload = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(failedReload.promise).mockReturnValueOnce(older.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('turn-2')], nextCursor: 'cursor-1' });
      await latest.promise;
    });

    await act(async () => {
      currentTimeline?.reload();
    });
    await act(async () => {
      failedReload.reject(new Error('network lag'));
      await failedReload.promise.catch(() => undefined);
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-2']);
    expect(currentTimeline?.hasOlder).toBe(true);

    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('turn-1')], nextCursor: null });
      await older.promise;
    });

    expect(currentTimeline?.items.map(itemText)).toEqual(['turn-1', 'turn-2']);
  });

  it('jumpToLatest refetches latest items after loading an older page', async () => {
    const latest = deferred<RpcResult>();
    const older = deferred<RpcResult>();
    const latestAgain = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(latestAgain.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('latest-initial')], nextCursor: 'cursor-1' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await act(async () => {
      older.resolve({ data: [makeTurn('older-page')], nextCursor: 'cursor-2' });
      await older.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['older-page', 'latest-initial']);

    await act(async () => {
      currentTimeline?.jumpToLatest();
    });
    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 12,
      sortDirection: 'desc',
      cursor: null,
    }, 120000);
    await act(async () => {
      latestAgain.resolve({ data: [makeTurn('latest-restored')], nextCursor: 'cursor-3' });
      await latestAgain.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['latest-restored']);
    expect(currentTimeline?.hasOlder).toBe(true);
    expect((currentTimeline as HookResult & { isViewingLatest?: boolean })?.isViewingLatest).toBe(true);
  });

  it('stale request for old thread does not overwrite current thread items', async () => {
    const oldThread = deferred<RpcResult>();
    const newThread = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(oldThread.promise).mockReturnValueOnce(newThread.promise);

    await renderHook('old-thread', asRpc(rpc));
    await rerenderHook('new-thread', asRpc(rpc));
    await act(async () => {
      newThread.resolve({ data: [makeTurn('new-thread-turn')], nextCursor: null });
      await newThread.promise;
    });
    await act(async () => {
      oldThread.resolve({ data: [makeTurn('old-thread-turn')], nextCursor: null });
      await oldThread.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['new-thread-turn']);
  });

  it('does not expose the previous thread older cursor while a new thread is loading', async () => {
    const firstThread = deferred<RpcResult>();
    const secondThread = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(firstThread.promise).mockReturnValueOnce(secondThread.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      firstThread.resolve({ data: [makeTurn('thread-1-latest')], nextCursor: 'thread-1-cursor' });
      await firstThread.promise;
    });
    expect(currentTimeline?.hasOlder).toBe(true);

    await rerenderHook('thread-2', asRpc(rpc));
    expect(currentTimeline?.items).toEqual([]);
    expect(currentTimeline?.hasOlder).toBe(false);
    expect(currentTimeline?.loading).toBe(true);

    await act(async () => {
      currentTimeline?.loadOlder();
    });
    expect(rpc).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondThread.resolve({ data: [makeTurn('thread-2-latest')], nextCursor: null });
      await secondThread.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['thread-2-latest']);
  });

  it('stale loadOlder request does not overwrite a newer thread', async () => {
    const latest = deferred<RpcResult>();
    const oldOlder = deferred<RpcResult>();
    const newLatest = deferred<RpcResult>();
    const rpc = vi.fn().mockReturnValueOnce(latest.promise).mockReturnValueOnce(oldOlder.promise).mockReturnValueOnce(newLatest.promise);

    await renderHook('thread-1', asRpc(rpc));
    await act(async () => {
      latest.resolve({ data: [makeTurn('thread-1-latest')], nextCursor: 'cursor-1' });
      await latest.promise;
    });
    await act(async () => {
      currentTimeline?.loadOlder();
    });
    await rerenderHook('thread-2', asRpc(rpc));
    await act(async () => {
      newLatest.resolve({ data: [makeTurn('thread-2-latest')], nextCursor: null });
      await newLatest.promise;
    });
    await act(async () => {
      oldOlder.resolve({ data: [makeTurn('thread-1-older')], nextCursor: null });
      await oldOlder.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['thread-2-latest']);
  });
});
