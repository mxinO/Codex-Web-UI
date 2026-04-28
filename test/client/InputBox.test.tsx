// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InputBox from '../../src/components/InputBox';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
type InputRpc = React.ComponentProps<typeof InputBox>['rpc'];

function asRpc(mock: unknown): InputRpc {
  return mock as InputRpc;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controllableThenable<T>() {
  let resolveHandler: ((value: T) => unknown) | null = null;
  const promise = {
    then(resolve: (value: T) => unknown) {
      resolveHandler = resolve;
      return { catch: () => undefined };
    },
  } as unknown as Promise<T>;
  return {
    promise,
    resolve(value: T) {
      resolveHandler?.(value);
    },
  };
}

function renderInputBox(overrides: Partial<React.ComponentProps<typeof InputBox>> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <InputBox
        rpc={vi.fn()}
        threadId="thread-1"
        isRunning={false}
        draftOverride={null}
        onDraftConsumed={vi.fn()}
        onEnqueue={vi.fn()}
        {...overrides}
      />,
    );
  });
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

describe('InputBox', () => {
  it('runs bang commands through rpc, dispatches output, and clears draft after success', async () => {
    const result = { exitCode: 0, stdout: 'ok\n', stderr: '' };
    const rpc = vi.fn().mockResolvedValue(result);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderInputBox({ rpc, draftOverride: '!pwd', activeCwd: '/work/project' });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/bang/run', { command: 'pwd' }, 35_000);
    const outputEvent = dispatch.mock.calls.map(([event]) => event).find((event) => event.type === 'webui-bang-output') as CustomEvent | undefined;
    expect(outputEvent?.detail).toEqual({ command: 'pwd', cwd: '/work/project', threadId: 'thread-1', result });
    expect(textarea?.value).toBe('');
  });

  it('preserves bang command drafts when rpc fails', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('command failed'));
    renderInputBox({ rpc, draftOverride: '!pwd' });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/bang/run', { command: 'pwd' }, 35_000);
    expect(textarea?.value).toBe('!pwd');
    expect(document.querySelector('.input-error')?.textContent).toBe('command failed');
  });

  it('blocks bang commands while a turn is running and preserves draft', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderInputBox({ isRunning: true, draftOverride: '!pwd' });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Queue');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'webui-bang-output' }));
    expect(textarea?.value).toBe('!pwd');
    expect(document.querySelector('.input-error')?.textContent).toBe('! commands are disabled while Codex is working');
  });

  it('dispatches supported slash commands', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderInputBox({ draftOverride: '/model gpt-5.4' });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    const slashEvent = dispatch.mock.calls.map(([event]) => event).find((event) => event.type === 'webui-slash-command') as CustomEvent | undefined;
    expect(slashEvent?.detail).toMatchObject({ input: '/model gpt-5.4', command: '/model', turnActive: false });
    expect(textarea?.value).toBe('');
  });

  it('dispatches compatibility-gated slash commands and clears the draft', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderInputBox({ draftOverride: '/compact' });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    const slashEvent = dispatch.mock.calls.map(([event]) => event).find((event) => event.type === 'webui-slash-command') as CustomEvent | undefined;
    expect(slashEvent?.detail).toMatchObject({ input: '/compact', command: '/compact' });
    expect(textarea?.value).toBe('');
  });

  it('passes run options when starting a turn', async () => {
    const rpc = vi.fn().mockResolvedValue({ turn: { id: 'turn-1' } });
    const runOptions = { model: 'gpt-5.5', effort: 'high', mode: 'plan', sandbox: 'workspace-write' };
    renderInputBox({ rpc, draftOverride: 'hello', runOptions });
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpc).toHaveBeenCalledWith('webui/turn/start', { threadId: 'thread-1', text: 'hello', options: runOptions });
  });

  it('notifies the app about a direct send before the turn RPC resolves', async () => {
    const turnStart = deferred<unknown>();
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/turn/start') return turnStart.promise;
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const onDirectSubmit = vi.fn();
    renderInputBox({ rpc: asRpc(rpc), draftOverride: 'hello now', onDirectSubmit });
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Send');

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      submit?.click();
    });

    expect(onDirectSubmit).toHaveBeenCalledWith('hello now');
    expect(rpc).toHaveBeenCalledWith('webui/turn/start', { threadId: 'thread-1', text: 'hello now', options: undefined });

    await act(async () => {
      turnStart.resolve({ turn: { id: 'turn-1' } });
      await Promise.resolve();
    });
  });

  it('passes run options when queueing a message', async () => {
    const onEnqueue = vi.fn().mockResolvedValue(undefined);
    const runOptions = { model: 'gpt-5.5', effort: 'high', mode: 'plan', sandbox: 'workspace-write' };
    renderInputBox({ isRunning: true, draftOverride: 'next', runOptions, onEnqueue });
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Queue');

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onEnqueue).toHaveBeenCalledWith('next', runOptions);
  });

  it('ignores stale file autocomplete responses after draft no longer matches', async () => {
    const readDirectory = controllableThenable<unknown>();
    const rpc = vi.fn((method: string) => {
      if (method === 'webui/fs/readDirectory') return readDirectory.promise;
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    renderInputBox({ rpc: asRpc(rpc), draftOverride: '@', activeCwd: '/repo' });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => {
      if (!textarea) throw new Error('missing textarea');
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, 'normal text');
      Simulate.change(textarea);
      readDirectory.resolve({ entries: [{ name: 'stale.txt', path: '/repo/stale.txt', isFile: true }] });
    });

    expect(document.querySelector('.file-autocomplete')).toBeNull();
  });

  it('shows slash command suggestions for the current prefix', async () => {
    renderInputBox({ draftOverride: '/m' });

    await act(async () => {
      await Promise.resolve();
    });

    const suggestions = Array.from(document.querySelectorAll<HTMLButtonElement>('.slash-autocomplete-row')).map((button) => button.textContent);
    expect(suggestions.some((text) => text?.includes('/model'))).toBe(true);
    expect(suggestions.some((text) => text?.includes('/status'))).toBe(false);
  });
});
