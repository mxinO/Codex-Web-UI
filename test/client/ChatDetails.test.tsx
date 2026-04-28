// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatItem from '../../src/components/ChatItem';
import DetailModal from '../../src/components/DetailModal';
import type { TimelineItem } from '../../src/lib/timeline';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onApprovalDecision = async () => undefined;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(node);
  });
}

async function flushLazy() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
    });
  }
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ChatItem details', () => {
  it('renders assistant markdown', async () => {
    const item: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 1, text: '**Ready**\n\n- item', phase: null };

    render(<ChatItem item={item} onOpenDetail={vi.fn()} onApprovalDecision={onApprovalDecision} />);
    expect(document.querySelector('.detail-loading')?.textContent).toBe('Loading markdown...');

    await act(async () => {
      await import('../../src/components/MarkdownView');
    });
    await flushLazy();

    expect(document.querySelector('.markdown-body strong')?.textContent).toBe('Ready');
    expect(document.querySelector('.markdown-body li')?.textContent).toBe('item');
  });

  it('opens command cards through the detail callback', () => {
    const onOpenDetail = vi.fn();
    const item: TimelineItem = {
      id: 'c1',
      kind: 'command',
      timestamp: 1,
      command: 'npm test',
      cwd: '/repo',
      output: 'ok',
      status: 'completed',
      exitCode: 0,
    };

    render(<ChatItem item={item} onOpenDetail={onOpenDetail} onApprovalDecision={onApprovalDecision} />);

    act(() => {
      document.querySelector<HTMLButtonElement>('.tool-card')?.click();
    });

    expect(onOpenDetail).toHaveBeenCalledWith(item);
  });

  it('renders bang command cards on the user side with inline output', () => {
    const item: TimelineItem = {
      id: 'bang-1',
      kind: 'bangCommand',
      timestamp: 1,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };

    render(<ChatItem item={item} onOpenDetail={vi.fn()} onApprovalDecision={onApprovalDecision} />);

    expect(document.querySelector('.chat-row--user .bang-card')?.textContent).toContain('$ pwd');
    expect(document.querySelector('.chat-row--user .bang-card')?.textContent).toContain('/repo');
    expect(document.querySelector('.chat-row--assistant .bang-card')).toBeNull();
  });

  it('renders queued messages as user-side chat items with edit and cancel controls', () => {
    const onQueuedEdit = vi.fn();
    const onQueuedRemove = vi.fn();
    const item: TimelineItem = {
      id: 'queued:q1',
      kind: 'queued',
      timestamp: 1,
      message: { id: 'q1', text: 'next task', createdAt: 1 },
    };

    render(
      <ChatItem
        item={item}
        onOpenDetail={vi.fn()}
        onApprovalDecision={onApprovalDecision}
        onQueuedEdit={onQueuedEdit}
        onQueuedRemove={onQueuedRemove}
      />,
    );

    expect(document.querySelector('.chat-row--user .queued-message')?.textContent).toContain('next task');
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Edit')?.click();
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')?.click();
    });

    expect(onQueuedEdit).toHaveBeenCalledWith(item.message);
    expect(onQueuedRemove).toHaveBeenCalledWith('q1');
  });

  it('opens file and tool cards through the detail callback', () => {
    const onOpenDetail = vi.fn();
    const fileItem: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      item: { type: 'fileChange', id: 'raw-file', changes: [], status: 'ok' },
    };
    const toolItem: TimelineItem = {
      id: 't1',
      kind: 'tool',
      timestamp: 1,
      item: { type: 'mcpToolCall', id: 'raw-tool', server: 'srv', tool: 'lookup', status: 'ok', arguments: {}, result: {}, error: null },
    };

    render(
      <>
        <ChatItem item={fileItem} onOpenDetail={onOpenDetail} onApprovalDecision={onApprovalDecision} />
        <ChatItem item={toolItem} onOpenDetail={onOpenDetail} onApprovalDecision={onApprovalDecision} />
      </>,
    );

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool-card'));
    act(() => {
      buttons[0]?.click();
      buttons[1]?.click();
    });

    expect(onOpenDetail).toHaveBeenNthCalledWith(1, fileItem);
    expect(onOpenDetail).toHaveBeenNthCalledWith(2, toolItem);
  });

  it('renders MCP and web-search tool cards with specific labels', () => {
    render(
      <>
        <ChatItem
          item={{
            id: 'mcp1',
            kind: 'tool',
            timestamp: 1,
            item: { type: 'mcpToolCall', id: 'raw-tool', server: 'srv', tool: 'lookup', status: 'completed', arguments: {}, result: {}, error: null },
          }}
          onOpenDetail={vi.fn()}
          onApprovalDecision={onApprovalDecision}
        />
        <ChatItem
          item={{
            id: 'web1',
            kind: 'tool',
            timestamp: 1,
            item: { type: 'webSearch', id: 'raw-web', query: 'codex web ui', status: 'completed' },
          }}
          onOpenDetail={vi.fn()}
          onApprovalDecision={onApprovalDecision}
        />
      </>,
    );

    const labels = Array.from(document.querySelectorAll('.tool-card')).map((item) => item.textContent);
    expect(labels).toContain('MCP: srv.lookup');
    expect(labels).toContain('Web search: codex web ui');
  });

  it('renders warning and error notices with severity classes', () => {
    render(
      <>
        <ChatItem item={{ id: 'w1', kind: 'warning', timestamp: 1, text: 'low disk' }} onOpenDetail={vi.fn()} onApprovalDecision={onApprovalDecision} />
        <ChatItem item={{ id: 'e1', kind: 'error', timestamp: 1, text: 'failed turn' }} onOpenDetail={vi.fn()} onApprovalDecision={onApprovalDecision} />
      </>,
    );

    expect(document.querySelector('.chat-notice--warning')?.textContent).toContain('low disk');
    expect(document.querySelector('.chat-notice--error')?.textContent).toContain('failed turn');
  });
});

describe('DetailModal', () => {
  it('renders file change metadata without fake diff output', () => {
    const item: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      item: { type: 'fileChange', id: 'raw-file', changes: [{ path: 'src/App.tsx' }], status: 'ok' },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    const pre = document.querySelector('.detail-pre');
    expect(pre?.textContent).toContain('"kind": "fileChange"');
    expect(pre?.textContent).toContain('"path": "src/App.tsx"');
    expect(document.querySelector('.detail-loading')?.textContent).not.toBe('Loading diff...');
  });

  it('renders file change diffs when before and after content are available', async () => {
    const item: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      item: {
        type: 'fileChange',
        id: 'raw-file',
        status: 'ok',
        changes: [{ path: 'src/App.tsx', before: 'old text', after: 'new text' }],
      },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    expect(document.querySelector('.detail-pre')).toBeNull();

    await act(async () => {
      await import('../../src/components/DiffViewer');
    });
    await flushLazy();

    expect(document.querySelector('[aria-label="Before"]')?.textContent).toContain('old text');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toContain('new text');
  });

  it('renders grouped add-and-update file changes as one final before/after diff', async () => {
    const item: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      filePath: '/repo/retry.txt',
      changeCount: 5,
      item: {
        type: 'fileChange',
        id: 'raw-file',
        status: 'completed',
        changes: [
          {
            path: '/repo/retry.txt',
            kind: { type: 'add' },
            diff: 'File edit retry\n\nEdit 1: Initial file created.\n',
          },
          {
            path: '/repo/retry.txt',
            kind: { type: 'update', move_path: null },
            diff: '@@ -3 +3,2 @@\n Edit 1: Initial file created.\n+Edit 2: Added a second line.\n',
          },
          {
            path: '/repo/retry.txt',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,2 @@\n-File edit retry\n+File edit retry - updated title\n \n',
          },
          {
            path: '/repo/retry.txt',
            kind: { type: 'update', move_path: null },
            diff: '@@ -4 +4,2 @@\n Edit 2: Added a second line.\n+Edit 3: Added a third line after changing the title.\n',
          },
          {
            path: '/repo/retry.txt',
            kind: { type: 'update', move_path: null },
            diff: '@@ -5 +5,3 @@\n Edit 3: Added a third line after changing the title.\n+\n+Done: Multiple edits were applied successfully.\n',
          },
        ],
      },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    await act(async () => {
      await import('../../src/components/DiffViewer');
    });
    await flushLazy();

    expect(document.querySelector('[aria-label="Patch"]')).toBeNull();
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toBe('');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toBe(
      'File edit retry - updated title\n\nEdit 1: Initial file created.\nEdit 2: Added a second line.\nEdit 3: Added a third line after changing the title.\n\nDone: Multiple edits were applied successfully.\n',
    );
  });

  it('shows diff load errors instead of falling back to raw patch logs', async () => {
    const item: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      filePath: '/repo/retry.txt',
      diffError: 'path is outside active workspace',
      item: {
        type: 'fileChange',
        id: 'raw-file',
        status: 'completed',
        changes: [{ path: '/repo/retry.txt', diff: 'raw edit log that is not a patch' }],
      },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    expect(document.querySelector('[aria-label="Patch"]')).toBeNull();
    expect(document.querySelector('.detail-pre')?.textContent).toContain('Unable to load file diff: path is outside active workspace');
    expect(document.querySelector('.detail-pre')?.textContent).not.toBe('raw edit log that is not a patch');
  });

  it('renders Codex patch hunks as side-by-side diff snippets', async () => {
    const item: TimelineItem = {
      id: 'f1',
      kind: 'fileChange',
      timestamp: 1,
      filePath: '/repo/a.txt',
      changeCount: 2,
      item: {
        type: 'fileChange',
        id: 'raw-file',
        status: 'completed',
        changes: [
          { path: '/repo/a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n' },
          { path: '/repo/a.txt', diff: '@@ -2 +2 @@\n-two\n+three\n' },
        ],
      },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    expect(document.querySelector('.detail-pre')).toBeNull();

    await act(async () => {
      await import('../../src/components/DiffViewer');
    });
    await flushLazy();

    expect(document.querySelector('[aria-label="Patch"]')).toBeNull();
    expect(document.querySelector('[aria-label="Before"]')?.textContent).toContain('old');
    expect(document.querySelector('[aria-label="After"]')?.textContent).toContain('three');
  });

  it('caps large JSON details and renders dialog semantics', () => {
    const onClose = vi.fn();
    const item: TimelineItem = {
      id: 't1',
      kind: 'tool',
      timestamp: 1,
      item: { type: 'custom', id: 'raw-tool', payload: 'x'.repeat(210_000) },
    };

    render(<DetailModal item={item} onClose={onClose} />);

    const dialog = document.querySelector('[role="dialog"]');
    const pre = document.querySelector('.detail-pre');

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('detail-modal-title');
    expect(pre?.textContent?.length).toBeLessThan(202_000);
    expect(pre?.textContent).toContain('Truncated after 200000 characters.');
  });

  it('handles circular detail data without losing sibling fields', () => {
    const circular: Record<string, unknown> = { label: 'kept' };
    circular.self = circular;
    const item: TimelineItem = {
      id: 't1',
      kind: 'tool',
      timestamp: 1,
      item: { type: 'custom', id: 'raw-tool', payload: circular },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    const text = document.querySelector('.detail-pre')?.textContent ?? '';
    expect(text).toContain('"label": "kept"');
    expect(text).toContain('[Circular]');
  });

  it('does not read object values beyond the key cap', () => {
    let getterReads = 0;
    const payload: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1) {
      Object.defineProperty(payload, `key${String(index).padStart(3, '0')}`, {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return `value-${index}`;
        },
      });
    }
    const item: TimelineItem = {
      id: 't1',
      kind: 'tool',
      timestamp: 1,
      item: { type: 'custom', id: 'raw-tool', payload },
    };

    render(<DetailModal item={item} onClose={vi.fn()} />);

    expect(getterReads).toBe(100);
    expect(document.querySelector('.detail-pre')?.textContent).toContain('"[More keys]": true');
  });

  it('closes on Escape, traps Tab focus, and restores previous focus on unmount', () => {
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.append(opener);
    opener.focus();
    const item: TimelineItem = {
      id: 't1',
      kind: 'tool',
      timestamp: 1,
      item: { type: 'custom', id: 'raw-tool' },
    };

    render(<DetailModal item={item} onClose={onClose} />);

    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close detail"]');
    expect(document.activeElement).toBe(close);

    act(() => {
      close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(close);

    act(() => {
      close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(<DetailModal item={null} onClose={onClose} />);
    });
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });
});
