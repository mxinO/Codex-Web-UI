// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexSocket } from '../../src/hooks/useCodexSocket';

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

    expect(fetch).toHaveBeenCalledWith('/api/auth?token=secret&mode=test', { credentials: 'same-origin' });
    expect(window.location.search).toBe('?mode=test');
    expect(window.location.hash).toBe('#pane');

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    expect(currentSocket?.connectionState).toBe('connected');
    const result = currentSocket?.rpc('slow.method', { value: 1 }, 50);
    const rejection = expect(result).rejects.toThrow('RPC request timed out: slow.method');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
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

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth?token=new-token', { credentials: 'same-origin' });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/auth', { credentials: 'same-origin' });
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      MockWebSocket.instances[0].open();
    });

    expect(currentSocket?.connectionState).toBe('connected');
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
            state: { activeThreadId: 'thread-1', activeTurnId: null, activeCwd: '/repo', theme: 'dark', queue: [] },
            requests: [pending],
          }),
        }),
      );
    });

    expect(currentSocket?.requests).toEqual([pending]);
  });

  it('increments reconnect epoch and clears stale notifications after reconnect', async () => {
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
    expect(currentSocket?.notifications).toEqual([]);
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
