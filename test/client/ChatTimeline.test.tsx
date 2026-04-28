// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatTimeline from '../../src/components/ChatTimeline';
import type { TimelineItem } from '../../src/lib/timeline';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyItems: TimelineItem[] = [];
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
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
});
