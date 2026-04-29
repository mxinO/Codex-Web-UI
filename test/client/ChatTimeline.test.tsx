// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatTimeline from '../../src/components/ChatTimeline';
import type { TimelineItem } from '../../src/lib/timeline';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyItems: TimelineItem[] = [];
const baseProps = {
  onLoadOlder: vi.fn(),
  hasOlder: false,
  onOpenDetail: vi.fn(),
  onApprovalDecision: vi.fn(),
  showJumpToLatest: false,
  onJumpToLatest: vi.fn(),
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

function rerender(node: React.ReactNode) {
  act(() => {
    root?.render(node);
  });
}

function setScrollMetrics(scroller: HTMLDivElement, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: metrics.clientHeight });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  vi.unstubAllGlobals();
  container?.remove();
  root = null;
  container = null;
});

describe('ChatTimeline', () => {
  it('shows a jump-to-latest action while an older page is displayed', () => {
    const onJumpToLatest = vi.fn();

    render(
      <ChatTimeline
        items={emptyItems}
        onLoadOlder={vi.fn()}
        hasOlder={false}
        onOpenDetail={vi.fn()}
        onApprovalDecision={vi.fn()}
        showJumpToLatest
        onJumpToLatest={onJumpToLatest}
      />,
    );

    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.match(/jump to latest/i));
    expect(button).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it('loads older messages when scrolling near the top', () => {
    const onLoadOlder = vi.fn();

    render(
      <ChatTimeline
        items={[{ id: 'a1', kind: 'assistant', timestamp: 1, text: 'hello', phase: null }]}
        onLoadOlder={onLoadOlder}
        hasOlder
        onOpenDetail={vi.fn()}
        onApprovalDecision={vi.fn()}
        showJumpToLatest={false}
        onJumpToLatest={vi.fn()}
      />,
    );

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 24 });

    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest message visible when new chat items appear', () => {
    const firstItem: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 1, text: 'hello', phase: null };
    const secondItem: TimelineItem = { id: 'a2', kind: 'assistant', timestamp: 2, text: 'world', phase: null };

    render(<ChatTimeline {...baseProps} items={[firstItem]} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 });

    rerender(<ChatTimeline {...baseProps} items={[firstItem, secondItem]} />);

    expect(scroller?.scrollTop).toBe(500);
  });

  it('does not pull the viewport down when the user has scrolled away from latest', () => {
    const firstItem: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 1, text: 'hello', phase: null };
    const secondItem: TimelineItem = { id: 'a2', kind: 'assistant', timestamp: 2, text: 'world', phase: null };

    render(<ChatTimeline {...baseProps} items={[firstItem]} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 100, scrollHeight: 500, clientHeight: 200 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    rerender(<ChatTimeline {...baseProps} items={[firstItem, secondItem]} />);

    expect(scroller?.scrollTop).toBe(100);
  });

  it('keeps the latest message visible when rendered content grows after paint', () => {
    let notifyResize: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();

    class MockResizeObserver {
      observe = observe;
      disconnect = disconnect;

      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const item: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 1, text: '**hello**', phase: null };

    render(<ChatTimeline {...baseProps} items={[item]} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    const column = document.querySelector<HTMLDivElement>('.chat-column');
    setScrollMetrics(scroller!, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 });
    act(() => {
      notifyResize?.([] as ResizeObserverEntry[], {} as ResizeObserver);
    });

    expect(observe).toHaveBeenCalledWith(column);
    expect(scroller?.scrollTop).toBe(800);
  });

  it('groups only adjacent activity items and preserves message ordering', () => {
    const firstCommand: TimelineItem = {
      id: 'cmd-1',
      kind: 'command',
      timestamp: 1,
      command: 'rg retry',
      cwd: '/repo',
      output: 'retry.ts\n',
      status: 'completed',
      exitCode: 0,
    };
    const firstEdit: TimelineItem = {
      id: 'edit-1',
      kind: 'fileChange',
      timestamp: 2,
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'edit-1', status: 'completed', changes: [{ path: '/repo/retry.ts' }] },
      filePath: '/repo/retry.ts',
      changeCount: 1,
    };
    const assistant: TimelineItem = { id: 'assistant-1', kind: 'assistant', timestamp: 3, text: 'I found the reset. I am patching it now.', phase: null };
    const secondCommand: TimelineItem = {
      id: 'cmd-2',
      kind: 'command',
      timestamp: 4,
      command: 'npm test -- retry',
      cwd: '/repo',
      output: 'ok\n',
      status: 'completed',
      exitCode: 0,
    };

    render(<ChatTimeline {...baseProps} items={[firstCommand, firstEdit, assistant, secondCommand]} />);

    const children = Array.from(document.querySelector('.chat-column')?.children ?? []);
    expect(children.map((node) => (node as HTMLElement).className)).toEqual(['activity-block', 'chat-row chat-row--assistant', 'activity-block']);
    const blocks = Array.from(document.querySelectorAll('.activity-block'));
    expect(blocks[0].textContent).toContain('$ rg retry');
    expect(blocks[0].textContent).toContain('Edited retry.ts');
    expect(blocks[1].textContent).toContain('$ npm test -- retry');
  });

  it('keeps file summary diff actions working inside activity blocks', () => {
    const onOpenFileSummary = vi.fn();
    const item: TimelineItem = {
      id: 'turn-1:file-summary',
      kind: 'fileChangeSummary',
      timestamp: 1,
      turnId: 'turn-1',
      files: [{ path: '/repo/a.txt', changeCount: 2 }],
    };

    render(<ChatTimeline {...baseProps} items={[item]} onOpenFileSummary={onOpenFileSummary} />);

    expect(document.querySelector('.activity-block')?.textContent).toContain('Files changed');
    act(() => {
      document.querySelector<HTMLButtonElement>('.activity-file__diff')?.click();
    });

    expect(onOpenFileSummary).toHaveBeenCalledWith('turn-1', '/repo/a.txt', 2);
  });
});
