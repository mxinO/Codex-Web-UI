// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatTimeline, { INITIAL_RENDERED_GROUP_LIMIT, RENDERED_GROUP_INCREMENT } from '../../src/components/ChatTimeline';
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

function userItem(index: number): TimelineItem {
  return { id: `u${index}`, kind: 'user', timestamp: index, text: `message ${index}` };
}

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
  it('shows a retrying load error instead of an empty-history message', () => {
    render(<ChatTimeline {...baseProps} items={emptyItems} loadError="RPC request timed out: thread/turns/list" />);

    expect(document.body.textContent).toContain('Failed to load messages. Retrying...');
    expect(document.body.textContent).toContain('RPC request timed out: thread/turns/list');
    expect(document.body.textContent).not.toContain('No messages loaded.');
  });

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
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });

    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders only the latest loaded group window until the user scrolls up', () => {
    const items = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT + 5 }, (_, index) => userItem(index));

    render(<ChatTimeline {...baseProps} items={items} />);

    const rows = Array.from(document.querySelectorAll('.chat-row--user'));
    expect(rows).toHaveLength(INITIAL_RENDERED_GROUP_LIMIT);
    expect(rows[0].textContent).toContain('message 5');
    expect(document.body.textContent).not.toContain('message 0');
  });

  it('reveals loaded older groups before requesting another history page', () => {
    const onLoadOlder = vi.fn();
    const items = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT + 5 }, (_, index) => userItem(index));

    render(<ChatTimeline {...baseProps} items={items} hasOlder onLoadOlder={onLoadOlder} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });

    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const expectedVisibleRows = Math.min(items.length, INITIAL_RENDERED_GROUP_LIMIT + RENDERED_GROUP_INCREMENT);
    expect(document.querySelectorAll('.chat-row--user')).toHaveLength(expectedVisibleRows);
    expect(document.body.textContent).toContain('message 0');
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('collapses revealed older groups again when the user scrolls back to bottom', () => {
    const items = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT + 5 }, (_, index) => userItem(index));

    render(<ChatTimeline {...baseProps} items={items} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(document.querySelectorAll('.chat-row--user')).toHaveLength(items.length);
    expect(document.body.textContent).toContain('message 0');

    setScrollMetrics(scroller!, { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const rows = Array.from(document.querySelectorAll('.chat-row--user'));
    expect(rows).toHaveLength(INITIAL_RENDERED_GROUP_LIMIT);
    expect(rows[0].textContent).toContain('message 5');
    expect(document.body.textContent).not.toContain('message 0');
  });

  it('preserves the viewport when an older server page is prepended', () => {
    const onLoadOlder = vi.fn();
    const currentItems = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT }, (_, index) => userItem(index + 10));
    const olderItems = Array.from({ length: 10 }, (_, index) => userItem(index));

    render(<ChatTimeline {...baseProps} items={currentItems} hasOlder onLoadOlder={onLoadOlder} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });

    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(scroller?.scrollTop).toBe(24);

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 });
    rerender(<ChatTimeline {...baseProps} items={[...olderItems, ...currentItems]} hasOlder onLoadOlder={onLoadOlder} />);

    expect(scroller?.scrollTop).toBe(524);
    expect(document.body.textContent).toContain('message 0');
  });

  it('keeps a pending older-page anchor stable across bottom appends', () => {
    const onLoadOlder = vi.fn();
    const currentItems = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT }, (_, index) => userItem(index + 10));
    const olderItems = Array.from({ length: 10 }, (_, index) => userItem(index));
    const appendedItem = userItem(999);

    render(<ChatTimeline {...baseProps} items={currentItems} hasOlder onLoadOlder={onLoadOlder} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });

    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1100 });
    rerender(<ChatTimeline {...baseProps} items={[...currentItems, appendedItem]} hasOlder loading onLoadOlder={onLoadOlder} />);

    expect(scroller?.scrollTop).toBe(24);

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1600 });
    rerender(<ChatTimeline {...baseProps} items={[...olderItems, ...currentItems, appendedItem]} hasOlder={false} onLoadOlder={onLoadOlder} />);

    expect(scroller?.scrollTop).toBe(524);
    expect(document.body.textContent).toContain('message 0');
    expect(document.body.textContent).toContain('message 999');
  });

  it('cancels a pending older-page anchor when the user scrolls back to bottom before it arrives', () => {
    const onLoadOlder = vi.fn();
    const currentItems = Array.from({ length: INITIAL_RENDERED_GROUP_LIMIT }, (_, index) => userItem(index + 10));
    const olderItems = Array.from({ length: 10 }, (_, index) => userItem(index));

    render(<ChatTimeline {...baseProps} items={currentItems} hasOlder onLoadOlder={onLoadOlder} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    setScrollMetrics(scroller!, { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 });
    rerender(
      <ChatTimeline
        {...baseProps}
        items={[...olderItems, ...currentItems]}
        hasOlder={false}
        showJumpToLatest
        onLoadOlder={onLoadOlder}
      />,
    );

    expect(scroller?.scrollTop).toBe(700);
    expect(document.body.textContent).not.toContain('message 0');
  });

  it('keeps bottom auto-scroll enabled when short content is both top and bottom', () => {
    const onLoadOlder = vi.fn();
    const firstItem = userItem(1);
    const secondItem = userItem(2);

    render(<ChatTimeline {...baseProps} items={[firstItem]} hasOlder onLoadOlder={onLoadOlder} />);

    const scroller = document.querySelector<HTMLDivElement>('.chat-scroll');
    setScrollMetrics(scroller!, { scrollTop: 0, scrollHeight: 200, clientHeight: 300 });
    act(() => {
      scroller?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).not.toHaveBeenCalled();

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<ChatTimeline {...baseProps} items={[firstItem, secondItem]} hasOlder onLoadOlder={onLoadOlder} />);

    expect(scroller?.scrollTop).toBe(500);
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

  it('renders file summaries as standalone summary cards instead of activity blocks', () => {
    const onOpenFileSummary = vi.fn();
    const item: TimelineItem = {
      id: 'turn-1:file-summary',
      kind: 'fileChangeSummary',
      timestamp: 1,
      turnId: 'turn-1',
      files: [{ path: '/repo/a.txt', changeCount: 2 }],
    };

    render(<ChatTimeline {...baseProps} items={[item]} onOpenFileSummary={onOpenFileSummary} />);

    expect(document.querySelector('.activity-block')).toBeNull();
    expect(document.querySelector('.file-summary-card')?.textContent).toContain('Files changed');
    act(() => {
      document.querySelector<HTMLButtonElement>('.file-summary-card button[title="See diff"]')?.click();
    });

    expect(onOpenFileSummary).toHaveBeenCalledWith('turn-1', '/repo/a.txt', 2);
  });

  it('keeps an existing activity block mounted when activity appends', () => {
    const firstCommand: TimelineItem = {
      id: 'cmd-1',
      kind: 'command',
      timestamp: 1,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };
    const secondCommand: TimelineItem = {
      id: 'cmd-2',
      kind: 'command',
      timestamp: 2,
      command: 'ls',
      cwd: '/repo',
      output: 'README.md\n',
      status: 'completed',
      exitCode: 0,
    };

    render(<ChatTimeline {...baseProps} items={[firstCommand]} />);

    const block = document.querySelector('.activity-block');
    rerender(<ChatTimeline {...baseProps} items={[firstCommand, secondCommand]} />);

    expect(document.querySelector('.activity-block')).toBe(block);
    expect(document.querySelector('.activity-block')?.textContent).toContain('$ ls');
  });

  it('opens latest activity detail when detail-only fields change', () => {
    const onOpenDetail = vi.fn();
    const firstCommand: TimelineItem = {
      id: 'cmd-1',
      kind: 'command',
      timestamp: 1,
      command: 'pwd',
      cwd: '/old',
      output: 'old\n',
      status: 'completed',
      exitCode: 0,
    };
    const updatedCommand: TimelineItem = {
      ...firstCommand,
      cwd: '/new',
      output: 'new\n',
    };

    render(<ChatTimeline {...baseProps} items={[firstCommand]} onOpenDetail={onOpenDetail} />);
    rerender(<ChatTimeline {...baseProps} items={[updatedCommand]} onOpenDetail={onOpenDetail} />);

    act(() => {
      document.querySelector<HTMLButtonElement>('.activity-card')?.click();
    });

    expect(onOpenDetail).toHaveBeenCalledWith(updatedCommand);
  });

  it('appends a running row to the current activity block', () => {
    const command: TimelineItem = {
      id: 'cmd-1',
      kind: 'command',
      timestamp: 1,
      command: 'npm test',
      cwd: '/repo',
      output: '',
      status: 'running',
      exitCode: null,
    };

    render(<ChatTimeline {...baseProps} items={[command]} showActivityRunning />);

    const block = document.querySelector('.activity-block');
    expect(block?.classList.contains('activity-block--running')).toBe(true);
    expect(document.querySelector('.activity-block__header')?.textContent).toContain('1 event · running');
    const rows = Array.from(document.querySelectorAll('.activity-card'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('$ npm test');
    expect(rows[1].textContent).toContain('Running');
    expect(rows[1].classList.contains('activity-card--running')).toBe(true);
  });

  it('ignores empty streaming placeholders when appending a running row to activity', () => {
    const command: TimelineItem = {
      id: 'cmd-1',
      kind: 'command',
      timestamp: 1,
      command: 'npm test',
      cwd: '/repo',
      output: '',
      status: 'running',
      exitCode: null,
    };
    const emptyStreaming: TimelineItem = {
      id: 'streaming-empty',
      kind: 'streaming',
      timestamp: 2,
      text: '',
      active: true,
      turnId: 'turn-1',
    };

    render(<ChatTimeline {...baseProps} items={[command, emptyStreaming]} showActivityRunning />);

    expect(document.querySelectorAll('.activity-block')).toHaveLength(1);
    const rows = Array.from(document.querySelectorAll('.activity-card'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('$ npm test');
    expect(rows[1].textContent).toContain('Running');
  });

  it('shows a standalone running activity block when there is no current activity group', () => {
    const assistant: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 1, text: 'I will check that.', phase: null };

    render(<ChatTimeline {...baseProps} items={[assistant]} showActivityRunning />);

    const children = Array.from(document.querySelector('.chat-column')?.children ?? []);
    expect(children.map((node) => (node as HTMLElement).className)).toEqual(['chat-row chat-row--assistant', 'activity-block activity-block--running']);
    expect(document.querySelector('.activity-block__header')?.textContent).toContain('running');
    expect(document.querySelector('.activity-card--running')?.textContent).toContain('Running');
  });
});
