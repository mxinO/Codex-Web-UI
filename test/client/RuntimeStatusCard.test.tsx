// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import RuntimeStatusCard, { runtimeStatusHasMismatch } from '../../src/components/RuntimeStatusCard';
import type { RuntimeStatusResult } from '../../src/types/ui';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const matchingStatus = {
  hostname: 'build-host',
  threadId: 'thread-1234567890',
  cwd: '/workspace/codex-web-ui',
  activeTurnId: null,
  model: 'gpt-5.4',
  effort: 'high',
  mode: 'plan',
  sandbox: 'workspace-write',
  confirmed: true,
  confirmationSource: 'settingsUpdated',
  confirmedAt: '2026-06-30T12:00:00.000Z',
  lastTurn: {
    status: 'found',
    context: {
      turnId: 'turn-abcdef123456',
      model: 'gpt-5.4',
      effort: 'high',
      recordedAt: '2026-06-30T11:59:00.000Z',
    },
    scannedBytes: 2048,
  },
} satisfies RuntimeStatusResult;

function renderStatus(status: RuntimeStatusResult = matchingStatus): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<RuntimeStatusCard status={status} />);
  });
  const card = container.querySelector<HTMLElement>('article[aria-label="Runtime status"]');
  if (!card) throw new Error('runtime status card not found');
  return card;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('RuntimeStatusCard', () => {
  it('renders matching current and recorded settings without a warning', () => {
    const card = renderStatus();

    expect(card.textContent).toContain('Runtime status');
    expect(card.textContent).toContain('build-host');
    expect(card.querySelector('[aria-label="Current runtime settings"]')?.textContent).toContain('gpt-5.4');
    expect(card.querySelector('[aria-label="Current runtime settings"]')?.textContent).toContain('high');
    expect(card.querySelector('[aria-label="Last recorded turn"]')?.textContent).toContain('gpt-5.4');
    expect(card.querySelector('.runtime-status-card__turn-id')?.textContent).not.toBe('turn-abcdef123456');
    expect(card.querySelector('.runtime-status-card__turn-id')?.getAttribute('title')).toBe('turn-abcdef123456');
    expect(card.querySelector('.runtime-status-card__warning')).toBeNull();
  });

  it('warns when current settings differ from the last recorded turn', () => {
    const card = renderStatus({ ...matchingStatus, model: 'gpt-5.5', effort: 'medium' });

    expect(card.querySelector('.runtime-status-card__warning')?.textContent).toContain('Settings changed since the last turn.');
  });

  it('compares null effort values without treating them as a mismatch', () => {
    const nullEffortStatus: RuntimeStatusResult = {
      ...matchingStatus,
      effort: null,
      lastTurn: {
        ...matchingStatus.lastTurn,
        context: { ...matchingStatus.lastTurn.context, effort: null },
      },
    };

    expect(runtimeStatusHasMismatch(nullEffortStatus)).toBe(false);
    expect(runtimeStatusHasMismatch({ ...nullEffortStatus, effort: 'high' })).toBe(true);
  });

  it('shows an accessible unconfirmed badge', () => {
    const card = renderStatus({
      ...matchingStatus,
      confirmed: false,
      confirmationSource: null,
      confirmedAt: null,
    });

    expect(card.querySelector('[aria-label="Runtime settings unconfirmed"]')?.textContent).toBe('Unconfirmed');
  });

  it('shows the empty last-turn state', () => {
    const card = renderStatus({
      ...matchingStatus,
      lastTurn: { status: 'none', context: null, scannedBytes: 0 },
    });

    expect(card.querySelector('[aria-label="Last recorded turn"]')?.textContent).toContain('No recorded turn yet.');
  });

  it('shows the bounded-scan last-turn state', () => {
    const card = renderStatus({
      ...matchingStatus,
      lastTurn: { status: 'scanLimit', context: null, scannedBytes: 1024 },
    });

    expect(card.querySelector('[aria-label="Last recorded turn"]')?.textContent).toContain('Not found in recent rollout data.');
  });

  it('shows unavailable turn data without exposing the raw detail', () => {
    const card = renderStatus({
      ...matchingStatus,
      lastTurn: {
        status: 'unavailable',
        context: null,
        scannedBytes: 0,
        detail: 'EACCES: /home/private/.codex/sessions/rollout.jsonl',
      },
    });

    expect(card.querySelector('[aria-label="Last recorded turn"]')?.textContent).toContain('Turn data unavailable.');
    expect(card.textContent).not.toContain('EACCES');
    expect(card.textContent).not.toContain('/home/private');
  });
});
