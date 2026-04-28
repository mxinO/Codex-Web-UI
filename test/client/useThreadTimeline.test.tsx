// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadTimeline } from '../../src/hooks/useThreadTimeline';
import type { CodexTurn } from '../../src/types/codex';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult = ReturnType<typeof useThreadTimeline>;
type RpcResult = { data: CodexTurn[]; nextCursor?: string | null; next_cursor?: string | null };
type TimelineRpc = Parameters<typeof useThreadTimeline>[1];

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

function Harness({ activeThreadId, rpc }: { activeThreadId: string | null; rpc: <T>(method: string, params?: unknown) => Promise<T> }) {
  currentTimeline = useThreadTimeline(activeThreadId, rpc);
  return null;
}

async function renderHook(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<Harness activeThreadId={activeThreadId} rpc={rpc} />);
  });
}

async function rerenderHook(activeThreadId: string | null, rpc: <T>(method: string, params?: unknown) => Promise<T>) {
  await act(async () => {
    root?.render(<Harness activeThreadId={activeThreadId} rpc={rpc} />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
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
      limit: 50,
      sortDirection: 'desc',
      cursor: null,
    });
    expect(currentTimeline?.items.map(itemText)).toEqual(['older', 'newer']);
    expect(currentTimeline?.hasOlder).toBe(true);
  });

  it('loadOlder keeps a bounded older page window', async () => {
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
      older.resolve({ data: makeTurns('older', 205), nextCursor: 'cursor-2' });
      await older.promise;
    });

    const texts = currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '') ?? [];
    expect(currentTimeline?.items).toHaveLength(200);
    expect(texts[0]).toBe('older-199');
    expect(texts.at(-1)).toBe('older-0');
    expect(texts).not.toContain('older-200');
    expect(texts).not.toContain('latest-0');
    expect(currentTimeline?.hasOlder).toBe(true);
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

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['older-page']);

    await act(async () => {
      currentTimeline?.jumpToLatest();
    });
    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 50,
      sortDirection: 'desc',
      cursor: null,
    });
    await act(async () => {
      latestAgain.resolve({ data: [makeTurn('latest-restored')], nextCursor: 'cursor-3' });
      await latestAgain.promise;
    });

    expect(currentTimeline?.items.map((item) => item.kind === 'assistant' ? item.text : '')).toEqual(['latest-restored']);
    expect(currentTimeline?.hasOlder).toBe(true);
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
