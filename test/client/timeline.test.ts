import { describe, expect, it } from 'vitest';
import {
  approvalItemsFromRequests,
  liveStreamingItemFromNotifications,
  mergeTimelineItemsByTimestamp,
  notificationsSinceCount,
  notificationIsTurnComplete,
  notificationMatchesActiveTurn,
  requestKey,
  turnToTimelineItems,
  trimTimelineWindow,
} from '../../src/lib/timeline';
import type { TimelineItem } from '../../src/lib/timeline';
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

  it('keeps chronological file edit cards and appends a per-turn file summary', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        { type: 'agentMessage', id: 'a1', text: 'editing', phase: 'commentary' },
        { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/repo/a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
        { type: 'commandExecution', id: 'c1', command: 'sed -n 1p a.txt', cwd: '/repo', status: 'completed', aggregatedOutput: 'new\n', exitCode: 0, durationMs: 1 },
        { type: 'fileChange', id: 'f2', status: 'completed', changes: [{ path: '/repo/a.txt', diff: '@@ -2 +2 @@\n-two\n+three\n' }] },
        { type: 'fileChange', id: 'f3', status: 'completed', changes: [{ path: '/repo/b.txt', diff: 'created\n' }] },
      ],
    };

    const items = turnToTimelineItems(turn);
    const fileChanges = items.filter((item): item is Extract<TimelineItem, { kind: 'fileChange' }> => item.kind === 'fileChange');
    const fileSummaries = items.filter((item): item is Extract<TimelineItem, { kind: 'fileChangeSummary' }> => item.kind === 'fileChangeSummary');

    expect(items.map((item) => item.kind)).toEqual(['assistant', 'fileChange', 'command', 'fileChange', 'fileChange', 'fileChangeSummary']);
    expect(fileChanges).toHaveLength(3);
    expect(fileChanges[0]).toMatchObject({ id: 'turn-file:f1', filePath: '/repo/a.txt', changeCount: 1 });
    expect(fileChanges[1]).toMatchObject({ id: 'turn-file:f2', filePath: '/repo/a.txt', changeCount: 1 });
    expect(fileChanges[2]).toMatchObject({ id: 'turn-file:f3', filePath: '/repo/b.txt', changeCount: 1 });
    expect(fileSummaries).toEqual([
      {
        id: 'turn-file:file-summary',
        kind: 'fileChangeSummary',
        timestamp: 10000,
        turnId: 'turn-file',
        files: [
          { path: '/repo/a.txt', changeCount: 2 },
          { path: '/repo/b.txt', changeCount: 1 },
        ],
      },
    ]);
  });

  it('renders warning and error items as severity-specific timeline cards', () => {
    const turn: CodexTurn = {
      id: 'turn-warning',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'warning', id: 'w1', message: 'low disk' },
        { type: 'error', id: 'e1', message: 'failed turn' },
      ],
    };

    expect(turnToTimelineItems(turn)).toEqual([
      { id: 'turn-warning:w1', kind: 'warning', timestamp: 1000, text: 'low disk' },
      { id: 'turn-warning:e1', kind: 'error', timestamp: 1000, text: 'failed turn' },
    ]);
  });

  it('trims old items while preserving newest window', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: String(i), kind: 'notice' as const, timestamp: i, text: String(i) }));
    const trimmed = trimTimelineWindow(items, 200);

    expect(trimmed).toHaveLength(200);
    expect(trimmed[0].id).toBe('5');
  });

  it('merges ephemeral bang output by timestamp instead of pinning it to the bottom', () => {
    const bang: TimelineItem = {
      id: 'bang:1000:1',
      kind: 'bangCommand',
      timestamp: 1000,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };
    const user: TimelineItem = { id: 'u1', kind: 'user', timestamp: 2000, text: 'next prompt' };
    const assistant: TimelineItem = { id: 'a1', kind: 'assistant', timestamp: 2000, text: 'reply', phase: null };

    expect(mergeTimelineItemsByTimestamp([user, assistant, bang]).map((item) => item.id)).toEqual(['bang:1000:1', 'u1', 'a1']);
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

  it('derives a live assistant item from Codex event messages', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Starting edit', phase: 'commentary' } },
        { method: 'event_msg', params: { type: 'patch_apply_end', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', message: 'Edit applied', phase: 'commentary' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
    );

    expect(item).toMatchObject({ id: 'live:streaming-assistant', kind: 'streaming', text: 'Starting edit\n\nEdit applied', active: true });
  });

  it('does not keep unscoped Codex event messages after the turn is no longer active', () => {
    const item = liveStreamingItemFromNotifications(
      [{ method: 'event_msg', params: { type: 'agent_message', message: 'Old live text', phase: 'final_answer' } }],
      { activeThreadId: 'thread-1', activeTurnId: null },
      false,
    );

    expect(item).toBeNull();
  });

  it('does not replay unscoped Codex event messages from a previous queued turn', () => {
    const notifications = [
      { method: 'event_msg', params: { type: 'agent_message', message: 'Previous turn text' } },
      { method: 'event_msg', params: { type: 'task_complete', thread_id: 'thread-1', turn_id: 'turn-old' } },
      { method: 'event_msg', params: { type: 'agent_message', message: 'Next turn text' } },
    ];
    const currentTurnNotifications = notificationsSinceCount(notifications, 3, 2);
    const item = liveStreamingItemFromNotifications(
      currentTurnNotifications,
      { activeThreadId: 'thread-1', activeTurnId: 'turn-next' },
      true,
    );

    expect(item).toMatchObject({ id: 'live:streaming-assistant', kind: 'streaming', text: 'Next turn text', active: true });
  });

  it('keeps current-turn notification windows stable after the retained buffer is capped', () => {
    const notifications = ['n-201', 'n-202', 'n-203'];

    expect(notificationsSinceCount(notifications, 203, 200)).toEqual(['n-201', 'n-202', 'n-203']);
    expect(notificationsSinceCount(notifications, 203, 202)).toEqual(['n-203']);
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

  it('clears Codex event message streaming text on task completion', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Working', phase: 'commentary' } },
        { method: 'event_msg', params: { type: 'task_complete', turn_id: 'turn-1' } },
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

  it('recognizes Codex task_complete event messages as turn completion signals', () => {
    expect(
      notificationIsTurnComplete(
        { method: 'event_msg', params: { type: 'task_complete', turn_id: 'turn-active' } },
        { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      ),
    ).toBe(true);
  });

  it('keeps numeric and string approval request ids distinct', () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'item/fileChange/requestApproval', params: { path: 'numeric.ts' } },
      { jsonrpc: '2.0', id: '1', method: 'item/fileChange/requestApproval', params: { path: 'string.ts' } },
    ];

    const approvals = approvalItemsFromRequests(requests, new Set([requestKey(1)])).filter((item): item is Extract<TimelineItem, { kind: 'approval' }> => item.kind === 'approval');
    expect(approvals.map((item) => item.requestId)).toEqual(['1']);
  });
});
