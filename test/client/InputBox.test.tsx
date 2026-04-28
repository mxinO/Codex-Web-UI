// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InputBox from '../../src/components/InputBox';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
});
