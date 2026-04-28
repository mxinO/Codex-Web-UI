// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalCard from '../../src/components/ApprovalCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCard(method: string, params: unknown = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<ApprovalCard requestId="approval-1" method={method} params={params} onDecision={vi.fn()} />);
  });

  return Array.from(container.querySelectorAll('button')).map((button) => button.textContent);
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ApprovalCard', () => {
  it('does not offer accept for MCP elicitation without content collection', async () => {
    expect(await renderCard('mcpServer/elicitation/request')).toEqual(['decline', 'cancel']);
  });

  it('offers both accept and decline for permission requests', async () => {
    expect(await renderCard('item/permissions/requestApproval', { permissions: ['network'] })).toEqual(['accept', 'decline']);
  });

  it('uses protocol-provided decisions for file change approvals', async () => {
    expect(await renderCard('item/fileChange/requestApproval', { availableDecisions: ['approve_once', 'deny'] })).toEqual(['approve_once', 'deny']);
  });
});
