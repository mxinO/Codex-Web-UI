// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexSocket } from '../../src/hooks/useCodexSocket';
import { timelineNotificationMeta } from '../../src/lib/timeline';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

type SocketHook = ReturnType<typeof useCodexSocket>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentSocket: SocketHook | null = null;

function HookHarness() {
  currentSocket = useCodexSocket();
  return null;
}

async function renderHook() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<HookHarness />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  currentSocket = null;
  window.history.replaceState(null, '', '/app?token=secret&mode=test#pane');
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useCodexSocket', () => {
  it('strips token after auth succeeds and rejects timed-out RPCs', async () => {
    await renderHook();

    expect(fetch).toHaveBeenCalledWith('/api/auth?token=secret&mode=test', expect.objectContaining({ credentials: 'same-origin' }));
    expect(window.location.search).toBe('?mode=test');
    expect(window.location.hash).toBe('#pane');

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe(`ws://${window.location.host}/ws?token=secret`);
    act(() => {
      ws.open();
    });

    expect(currentSocket?.connectionState).toBe('connected');
    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'client/hello', params: { lastNotificationStreamId: null, lastNotificationSeq: null } }));
    const result = currentSocket?.rpc('slow.method', { value: 1 }, 50);
    const rejection = expect(result).rejects.toThrow('RPC request timed out: slow.method');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    await rejection;
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: 'rpc', id: 1, method: 'slow.method', params: { value: 1 } }));
  });

  it('recovers from auth-error after a manually entered token is accepted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState(null, '', '/app');

    await renderHook();

    expect(currentSocket?.connectionState).toBe('auth-error');
    expect(MockWebSocket.instances).toHaveLength(0);

    await act(async () => {
      await currentSocket?.submitToken('new-token');
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth?token=new-token', expect.objectContaining({ credentials: 'same-origin' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/auth', expect.objectContaining({ credentials: 'same-origin' }));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe(`ws://${window.location.host}/ws?token=new-token`);

    act(() => {
      MockWebSocket.instances[0].open();
    });

    expect(currentSocket?.connectionState).toBe('connected');
  });

  it('reuses the current tab token when the reconnect cookie auth check fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await renderHook();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.close();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth?mode=test', expect.objectContaining({ credentials: 'same-origin' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/auth?token=secret', expect.objectContaining({ credentials: 'same-origin' }));
    expect(currentSocket?.connectionState).not.toBe('auth-error');
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe(`ws://${window.location.host}/ws?token=secret`);
  });

  it('retries websocket auth with the current tab token after a cookie-only websocket rejection', async () => {
    await renderHook();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'server/hello',
            hostname: 'host-a',
            state: { activeThreadId: null, activeThreadPath: null, activeTurnId: null, activeCwd: null, theme: 'dark', queue: [] },
          }),
        }),
      );
      first.close();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(MockWebSocket.instances[1].url).toBe(`ws://${window.location.host}/ws`);

    act(() => {
      MockWebSocket.instances[1].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'auth/error' }) }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(currentSocket?.connectionState).not.toBe('auth-error');
    expect(MockWebSocket.instances[2].url).toBe(`ws://${window.location.host}/ws?token=secret`);
  });

  it('treats an auth check timeout as a reconnectable connection problem', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState(null, '', '/app');

    await renderHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(currentSocket?.connectionState).toBe('disconnected');
    expect(currentSocket?.connectionState).not.toBe('auth-error');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('stores app-server requests from the browser socket', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/request',
            message: { jsonrpc: '2.0', id: 'approval-1', method: 'item/fileChange/requestApproval', params: { path: 'file.ts' } },
          }),
        }),
      );
    });

    expect(currentSocket?.requests).toEqual([{ jsonrpc: '2.0', id: 'approval-1', method: 'item/fileChange/requestApproval', params: { path: 'file.ts' } }]);
  });

  it('restores pending app-server requests from server hello', async () => {
    const pending = { jsonrpc: '2.0', id: 'approval-hello', method: 'item/fileChange/requestApproval', params: { path: 'file.ts' } };
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'server/hello',
            hostname: 'host-a',
            state: { activeThreadId: 'thread-1', activeThreadPath: '/sessions/thread-1.jsonl', activeTurnId: null, activeCwd: '/repo', theme: 'dark', queue: [] },
            requests: [pending],
          }),
        }),
      );
    });

    expect(currentSocket?.requests).toEqual([pending]);
  });

  it('increments reconnect epoch and preserves retained notifications after reconnect', async () => {
    await renderHook();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { delta: 'stale' } } }),
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });
    expect(currentSocket?.notifications).toHaveLength(1);
    expect(currentSocket?.reconnectEpoch).toBe(0);

    act(() => {
      first.close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    const second = MockWebSocket.instances[1];
    act(() => {
      second.open();
    });

    expect(currentSocket?.reconnectEpoch).toBe(1);
    expect(currentSocket?.notifications).toHaveLength(1);
  });

  it('flushes buffered notifications before a socket close reconnects', async () => {
    await renderHook();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { delta: 'before-close' } } }),
        }),
      );
      first.close();
    });

    expect(currentSocket?.notificationCount).toBe(1);
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['before-close']);
  });

  it('batches app-server notifications before updating React state', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      for (let index = 0; index < 3; index += 1) {
        ws.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: String(index) } } }),
          }),
        );
      }
    });

    expect(currentSocket?.notifications).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(currentSocket?.notificationCount).toBe(1);
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['012']);
  });

  it('does not coalesce deltas from different assistant message ids', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'first' } } }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { itemId: 'a2', delta: 'second' } } }),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(currentSocket?.notificationCount).toBe(2);
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['first', 'second']);
  });

  it('does not coalesce adjacent unscoped deltas without a message id', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      for (const delta of ['first', 'second']) {
        ws.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'codex/notification', message: { method: 'item/agentMessage/delta', params: { delta } } }),
          }),
        );
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(currentSocket?.notificationCount).toBe(2);
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['first', 'second']);
  });

  it('keeps the latest sequence metadata when coalescing deltas', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'stream-1', seq: 3, message: { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Hel' } } }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'stream-1', seq: 4, message: { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'lo' } } }),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['Hello']);
    expect(timelineNotificationMeta(currentSocket?.notifications[0])).toMatchObject({ order: 1, streamId: 'stream-1', seq: 4 });
    expect(window.localStorage.getItem(`codex-web-ui:notificationReplay:${window.location.host}`)).toBe(JSON.stringify({ streamId: 'stream-1', seq: 4 }));
  });

  it('sends the last notification sequence on reconnect and ignores replay duplicates', async () => {
    await renderHook();
    const first = MockWebSocket.instances[0];
    act(() => {
      first.open();
      first.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'stream-1', seq: 7, message: { method: 'item/agentMessage/delta', params: { delta: 'kept' } } }),
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    act(() => {
      first.close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    const second = MockWebSocket.instances[1];
    act(() => {
      second.open();
      second.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'stream-1', seq: 7, message: { method: 'item/agentMessage/delta', params: { delta: 'duplicate' } } }),
        }),
      );
      second.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'stream-1', seq: 8, message: { method: 'item/agentMessage/delta', params: { delta: 'missed' } } }),
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(second.sent[0]).toBe(JSON.stringify({ type: 'client/hello', params: { lastNotificationStreamId: 'stream-1', lastNotificationSeq: 7 } }));
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['kept', 'missed']);
    expect(timelineNotificationMeta(currentSocket?.notifications[1])).toMatchObject({ order: 2, streamId: 'stream-1', seq: 8 });
    expect(window.localStorage.getItem(`codex-web-ui:notificationReplay:${window.location.host}`)).toBe(JSON.stringify({ streamId: 'stream-1', seq: 8 }));
  });

  it('does not drop low sequence notifications from a restarted server stream', async () => {
    window.localStorage.setItem(
      `codex-web-ui:notificationReplay:${window.location.host}`,
      JSON.stringify({ streamId: 'old-stream', seq: 100 }),
    );

    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'server/hello', notificationStreamId: 'new-stream', hostname: 'host-a', state: { activeThreadId: null, activeThreadPath: null, activeTurnId: null, activeCwd: null, theme: 'dark', queue: [] } }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'codex/notification', streamId: 'new-stream', seq: 1, message: { method: 'item/agentMessage/delta', params: { delta: 'after-restart' } } }),
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });

    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'client/hello', params: { lastNotificationStreamId: 'old-stream', lastNotificationSeq: 100 } }));
    expect(currentSocket?.notifications.map((item) => (item as { params?: { delta?: string } }).params?.delta)).toEqual(['after-restart']);
    expect(window.localStorage.getItem(`codex-web-ui:notificationReplay:${window.location.host}`)).toBe(JSON.stringify({ streamId: 'new-stream', seq: 1 }));
  });

  it('caps app-server request history at 50 items', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      for (let index = 0; index < 55; index += 1) {
        ws.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'codex/request',
              message: { jsonrpc: '2.0', id: index, method: 'item/commandExecution/requestApproval', params: { index } },
            }),
          }),
        );
      }
    });

    expect(currentSocket?.requests).toHaveLength(50);
    expect(currentSocket?.requests[0]).toMatchObject({ id: 5 });
  });

  it('removes app-server requests when the server broadcasts resolution', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/request',
            message: { jsonrpc: '2.0', id: 'approval-1', method: 'item/fileChange/requestApproval', params: { path: 'file.ts' } },
          }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/requestResolved',
            requestId: 'approval-1',
          }),
        }),
      );
    });

    expect(currentSocket?.requests).toEqual([]);
  });

  it('does not collapse numeric and string request ids when resolving requests', async () => {
    await renderHook();
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/request',
            message: { jsonrpc: '2.0', id: 1, method: 'item/fileChange/requestApproval', params: { path: 'numeric.ts' } },
          }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/request',
            message: { jsonrpc: '2.0', id: '1', method: 'item/fileChange/requestApproval', params: { path: 'string.ts' } },
          }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'codex/requestResolved',
            requestId: 1,
          }),
        }),
      );
    });

    expect(currentSocket?.requests).toEqual([{ jsonrpc: '2.0', id: '1', method: 'item/fileChange/requestApproval', params: { path: 'string.ts' } }]);
  });
});
