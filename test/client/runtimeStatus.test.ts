import { describe, expect, it } from 'vitest';
import { parseRuntimeStatusResult } from '../../src/lib/runtimeStatus';

function validStatus() {
  return {
    hostname: 'host-1',
    threadId: 'thread-1',
    cwd: '/repo',
    activeTurnId: 'turn-active',
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
        turnId: 'turn-previous',
        model: 'gpt-5.4',
        effort: 'high',
        recordedAt: '2026-06-30T11:00:00.000Z',
      },
      scannedBytes: 1024,
    },
  };
}

describe('parseRuntimeStatusResult', () => {
  it('validates and normalizes the complete found result', () => {
    const result = parseRuntimeStatusResult(
      {
        ...validStatus(),
        hostname: '  host-1  ',
        threadId: ' thread-1 ',
        cwd: ' /repo ',
        activeTurnId: ' turn-active ',
        model: ' gpt-5.4 ',
        effort: ' high ',
        mode: ' plan ',
        sandbox: ' workspace-write ',
        confirmedAt: ' 2026-06-30T12:00:00.000Z ',
        lastTurn: {
          status: 'found',
          context: {
            turnId: ' turn-previous ',
            model: ' gpt-5.4 ',
            effort: ' high ',
            recordedAt: ' 2026-06-30T11:00:00.000Z ',
          },
          scannedBytes: 1024,
        },
      },
      'thread-1',
    );

    expect(result).toEqual(validStatus());
  });

  it.each(['none', 'scanLimit', 'unavailable'] as const)('accepts the %s last-turn result', (status) => {
    const result = parseRuntimeStatusResult(
      {
        ...validStatus(),
        model: null,
        effort: null,
        mode: null,
        sandbox: null,
        activeTurnId: null,
        confirmationSource: null,
        confirmedAt: null,
        lastTurn: {
          status,
          context: null,
          scannedBytes: 0,
          ...(status === 'unavailable' ? { detail: ' rollout unavailable ' } : {}),
        },
      },
      'thread-1',
    );

    expect(result.lastTurn).toEqual({
      status,
      context: null,
      scannedBytes: 0,
      ...(status === 'unavailable' ? { detail: 'rollout unavailable' } : {}),
    });
  });

  it.each([
    ['non-object result', null],
    ['missing hostname', { ...validStatus(), hostname: undefined }],
    ['non-string hostname', { ...validStatus(), hostname: 42 }],
    ['null thread id', { ...validStatus(), threadId: null }],
    ['missing nullable field', { ...validStatus(), activeTurnId: undefined }],
    ['invalid model', { ...validStatus(), model: {} }],
    ['invalid confirmed flag', { ...validStatus(), confirmed: 'yes' }],
    ['invalid confirmation source', { ...validStatus(), confirmationSource: 'startup' }],
    ['invalid confirmation timestamp', { ...validStatus(), confirmedAt: 123 }],
    ['invalid last turn', { ...validStatus(), lastTurn: null }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseRuntimeStatusResult(value, 'thread-1')).toThrow('Invalid runtime status');
  });

  it.each([
    ['unknown status', { status: 'missing', context: null, scannedBytes: 0 }],
    ['found without context', { status: 'found', context: null, scannedBytes: 0 }],
    ['none with context', { status: 'none', context: validStatus().lastTurn.context, scannedBytes: 0 }],
    ['negative scanned bytes', { status: 'none', context: null, scannedBytes: -1 }],
    ['fractional scanned bytes', { status: 'none', context: null, scannedBytes: 1.5 }],
    ['found without model', { status: 'found', context: { ...validStatus().lastTurn.context, model: null }, scannedBytes: 0 }],
    ['found without recordedAt', { status: 'found', context: { ...validStatus().lastTurn.context, recordedAt: undefined }, scannedBytes: 0 }],
    ['non-string detail', { status: 'unavailable', context: null, scannedBytes: 0, detail: 42 }],
  ])('rejects malformed lastTurn: %s', (_label, lastTurn) => {
    expect(() => parseRuntimeStatusResult({ ...validStatus(), lastTurn }, 'thread-1')).toThrow('Invalid runtime status');
  });

  it.each([
    ['hostname', { hostname: 'h'.repeat(10_000) }],
    ['cwd', { cwd: `/${'p'.repeat(20_000)}` }],
    ['model', { model: 'm'.repeat(10_000) }],
    ['detail', { lastTurn: { status: 'unavailable', context: null, scannedBytes: 0, detail: 'd'.repeat(10_000) } }],
  ])('rejects an oversized %s', (_label, override) => {
    expect(() => parseRuntimeStatusResult({ ...validStatus(), ...override }, 'thread-1')).toThrow('Invalid runtime status');
  });

  it('rejects a result for a different active thread', () => {
    expect(() => parseRuntimeStatusResult({ ...validStatus(), threadId: 'thread-other' }, 'thread-1')).toThrow(
      'Runtime status thread does not match the active thread',
    );
  });
});
