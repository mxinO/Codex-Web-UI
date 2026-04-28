import { describe, expect, it } from 'vitest';
import { approvalItemsFromRequests, liveStreamingItemFromNotifications, notificationMatchesActiveTurn, requestKey, turnToTimelineItems, trimTimelineWindow } from '../../src/lib/timeline';
import type { CodexTurn } from '../../src/types/codex';

describe('timeline', () => {
  it('converts user, assistant, and command items', () => {
    const turn: CodexTurn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
        { type: 'agentMessage', id: 'a1', text: 'hi', phase: 'final_answer' },
        { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/tmp', status: 'completed', aggregatedOutput: 'ok', exitCode: 0, durationMs: 1 },
      ],
    };

    expect(turnToTimelineItems(turn).map((item) => item.kind)).toEqual(['user', 'assistant', 'command']);
  });

  it('trims old items while preserving newest window', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: String(i), kind: 'notice' as const, timestamp: i, text: String(i) }));
    const trimmed = trimTimelineWindow(items, 200);

    expect(trimmed).toHaveLength(200);
    expect(trimmed[0].id).toBe('5');
  });

  it('normalizes malformed arrays and missing item ids defensively', () => {
    const turn: CodexTurn = {
      id: 'turn-2',
      status: 'completed',
      startedAt: null,
      completedAt: null,
      items: [
        { type: 'userMessage', content: null },
        { type: 'reasoning', id: 'r1', summary: null, content: 'not-array' },
      ] as unknown as CodexTurn['items'],
    };

    expect(() => turnToTimelineItems(turn)).not.toThrow();
    expect(turnToTimelineItems(turn)).toEqual([
      { id: 'turn-2:0', kind: 'user', timestamp: 0, text: '' },
      { id: 'turn-2:r1', kind: 'notice', timestamp: 0, text: '' },
    ]);
  });

  it('derives a live assistant item from agent message deltas', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hel' } },
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'lo' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
    );

    expect(item).toMatchObject({ id: 'live:streaming-assistant', kind: 'streaming', text: 'Hello', active: true });
  });

  it('clears streaming text after turn completion unless a turn is still active', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello' } },
        { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
    );

    expect(item).toBeNull();
  });

  it('ignores live deltas from a different thread', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-old', turnId: 'turn-old', delta: 'Old text' } },
        { method: 'item/agentMessage/delta', params: { delta: 'unscoped text' } },
      ],
      { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      false,
    );

    expect(item).toBeNull();
  });

  it('uses matching thread deltas for the live assistant item', () => {
    const item = liveStreamingItemFromNotifications(
      [{ method: 'item/agentMessage/delta', params: { thread: { id: 'thread-active' }, turn: { id: 'turn-active' }, delta: 'Scoped text' } }],
      { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      true,
    );

    expect(item).toMatchObject({ kind: 'streaming', text: 'Scoped text', active: true });
  });

  it('matches completion notifications to the active thread or turn', () => {
    expect(
      notificationMatchesActiveTurn(
        { method: 'turn/completed', params: { threadId: 'thread-active', turnId: 'turn-active' } },
        { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      ),
    ).toBe(true);
    expect(
      notificationMatchesActiveTurn(
        { method: 'turn/completed', params: { threadId: 'thread-other', turnId: 'turn-other' } },
        { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      ),
    ).toBe(false);
  });

  it('keeps numeric and string approval request ids distinct', () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'item/fileChange/requestApproval', params: { path: 'numeric.ts' } },
      { jsonrpc: '2.0', id: '1', method: 'item/fileChange/requestApproval', params: { path: 'string.ts' } },
    ];

    expect(approvalItemsFromRequests(requests, new Set([requestKey(1)])).map((item) => item.requestId)).toEqual(['1']);
  });
});
