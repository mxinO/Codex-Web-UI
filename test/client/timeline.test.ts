import { describe, expect, it } from 'vitest';
import {
  approvalItemsFromRequests,
  liveStreamingItemFromNotifications,
  mergeTimelineItemsByTimestamp,
  nextLiveNotificationWindow,
  notificationsSinceCount,
  notificationIsTurnComplete,
  notificationMatchesActiveTurn,
  latestCompletionNotificationCount,
  fileChangeHasInlineDiff,
  liveStreamingItemForTimeline,
  liveTimelineItemsFromNotifications,
  liveTurnItemsFromNotifications,
  requestKey,
  shouldShowLiveStreamingItem,
  timelineItemsWithLiveTurnOverlay,
  turnToTimelineItems,
  trimTimelineWindow,
  visibleLiveTurnItemsForTimeline,
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

  it('splits multiple raw changes from one Codex fileChange item into per-edit history cards', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        {
          type: 'fileChange',
          id: 'f1',
          status: 'completed',
          changes: [
            { path: '/repo/a.txt', kind: { type: 'add' }, diff: 'first\n' },
            { path: '/repo/a.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-first\n+second\n' },
          ],
        },
      ],
    };

    const items = turnToTimelineItems(turn);
    const fileChanges = items.filter((item): item is Extract<TimelineItem, { kind: 'fileChange' }> => item.kind === 'fileChange');
    const fileSummary = items.find((item): item is Extract<TimelineItem, { kind: 'fileChangeSummary' }> => item.kind === 'fileChangeSummary');

    expect(items.map((item) => item.kind)).toEqual(['fileChange', 'fileChange', 'fileChangeSummary']);
    expect(fileChanges.map((item) => item.id)).toEqual(['turn-file:f1:edit:0', 'turn-file:f1:edit:1']);
    expect(fileChanges.map((item) => item.changeCount)).toEqual([1, 1]);
    expect(fileChanges.map((item) => (item.item as { changes: unknown[] }).changes)).toEqual([
      [{ path: '/repo/a.txt', kind: { type: 'add' }, diff: 'first\n' }],
      [{ path: '/repo/a.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-first\n+second\n' }],
    ]);
    expect(fileSummary?.files).toEqual([{ path: '/repo/a.txt', changeCount: 2 }]);
  });

  it('splits multi-path raw changes into per-edit history cards and per-file summary counts', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        {
          type: 'fileChange',
          id: 'f1',
          status: 'completed',
          changes: [
            { path: '/repo/a.txt', diff: '@@ -1 +1 @@\n-a\n+b\n' },
            { path: '/repo/b.txt', diff: 'created\n' },
            { path: '/repo/a.txt', diff: '@@ -2 +2 @@\n-c\n+d\n' },
          ],
        },
      ],
    };

    const items = turnToTimelineItems(turn);
    const fileChanges = items.filter((item): item is Extract<TimelineItem, { kind: 'fileChange' }> => item.kind === 'fileChange');
    const fileSummary = items.find((item): item is Extract<TimelineItem, { kind: 'fileChangeSummary' }> => item.kind === 'fileChangeSummary');

    expect(fileChanges.map((item) => ({ id: item.id, path: item.filePath, count: item.changeCount }))).toEqual([
      { id: 'turn-file:f1:edit:0', path: '/repo/a.txt', count: 1 },
      { id: 'turn-file:f1:edit:1', path: '/repo/b.txt', count: 1 },
      { id: 'turn-file:f1:edit:2', path: '/repo/a.txt', count: 1 },
    ]);
    expect(fileSummary?.files).toEqual([
      { path: '/repo/a.txt', changeCount: 2 },
      { path: '/repo/b.txt', changeCount: 1 },
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

    expect(item).toMatchObject({ kind: 'streaming', text: 'Hello', active: false, turnId: 'turn-1' });
  });

  it('keeps scoped Codex event message text after task completion', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Working', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'task_complete', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
    );

    expect(item).toMatchObject({ kind: 'streaming', text: 'Working', active: false, turnId: 'turn-1' });
  });

  it('keeps unscoped live output from a retained completed-turn notification window', () => {
    const item = liveStreamingItemFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Final answer after edit' } },
        { method: 'event_msg', params: { type: 'task_complete', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
      { acceptUnscoped: true },
    );

    expect(item).toMatchObject({ kind: 'streaming', text: 'Final answer after edit', active: false, turnId: 'turn-1' });
  });

  it('keeps the completed turn notification window until a new turn starts', () => {
    const current = { activeThreadId: 'thread-1', activeTurnId: 'turn-1', startCount: 10 };

    expect(nextLiveNotificationWindow(current, { activeThreadId: 'thread-1', activeTurnId: null }, 20)).toBe(current);
    expect(nextLiveNotificationWindow(current, { activeThreadId: 'thread-1', activeTurnId: 'turn-2' }, 25)).toEqual({
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-2',
      startCount: 25,
    });
    expect(nextLiveNotificationWindow(current, { activeThreadId: 'thread-2', activeTurnId: null }, 30)).toEqual({
      activeThreadId: 'thread-2',
      activeTurnId: null,
      startCount: 30,
    });
  });

  it('keeps completed live output visible only until persisted history contains that turn', () => {
    const liveItem: Extract<TimelineItem, { kind: 'streaming' }> = {
      id: 'live:streaming-assistant',
      kind: 'streaming',
      timestamp: 100,
      text: 'Hello',
      active: false,
      turnId: 'turn-1',
    };
    const staleHistory: TimelineItem[] = [{ id: 'turn-old:a1', kind: 'assistant', timestamp: 1, text: 'old', phase: null }];
    const caughtUpHistory: TimelineItem[] = [{ id: 'turn-1:a1', kind: 'assistant', timestamp: 2, text: 'Hello', phase: null }];

    expect(shouldShowLiveStreamingItem(staleHistory, liveItem)).toBe(true);
    expect(shouldShowLiveStreamingItem(caughtUpHistory, liveItem)).toBe(false);
    expect(shouldShowLiveStreamingItem(staleHistory, null)).toBe(false);
  });

  it('preserves the pending submit notification window until the real turn id appears', () => {
    const idleWindow = { activeThreadId: 'thread-1', activeTurnId: null, startCount: 10 };

    const pendingWindow = nextLiveNotificationWindow(
      idleWindow,
      { activeThreadId: 'thread-1', activeTurnId: null },
      15,
      { pendingStartCount: 10 },
    );
    expect(pendingWindow).toEqual({ activeThreadId: 'thread-1', activeTurnId: null, startCount: 10 });

    expect(
      nextLiveNotificationWindow(pendingWindow, { activeThreadId: 'thread-1', activeTurnId: 'turn-1' }, 18),
    ).toEqual({
      activeThreadId: 'thread-1',
      activeTurnId: 'turn-1',
      startCount: 10,
    });
  });

  it('does not hide completed live output when only file edit history for that turn has arrived', () => {
    const liveItem: Extract<TimelineItem, { kind: 'streaming' }> = {
      id: 'live:streaming-assistant',
      kind: 'streaming',
      timestamp: 100,
      text: 'Created the file.',
      active: false,
      turnId: 'turn-1',
    };
    const fileOnlyHistory: TimelineItem[] = [
      {
        id: 'turn-1:file-1',
        kind: 'fileChange',
        timestamp: 100,
        turnId: 'turn-1',
        item: { type: 'fileChange', id: 'file-1', changes: [{ path: '/repo/a.txt' }], status: 'completed' },
        filePath: '/repo/a.txt',
        changeCount: 1,
      },
      {
        id: 'turn-1:file-summary',
        kind: 'fileChangeSummary',
        timestamp: 100,
        turnId: 'turn-1',
        files: [{ path: '/repo/a.txt', changeCount: 1 }],
      },
    ];

    expect(shouldShowLiveStreamingItem(fileOnlyHistory, liveItem)).toBe(true);
  });

  it('does not hide completed live output for same-turn non-assistant history', () => {
    const liveItem: Extract<TimelineItem, { kind: 'streaming' }> = {
      id: 'live:streaming-assistant',
      kind: 'streaming',
      timestamp: 100,
      text: 'Still responding.',
      active: false,
      turnId: 'turn-1',
    };
    const nonAssistantHistory: TimelineItem[] = [
      { id: 'turn-1:c1', kind: 'command', timestamp: 100, command: 'pwd', cwd: '/repo', output: '/repo\n', status: 'completed', exitCode: 0 },
      { id: 'turn-1:t1', kind: 'tool', timestamp: 100, item: { type: 'customTool', id: 't1' } },
    ];

    expect(shouldShowLiveStreamingItem(nonAssistantHistory, liveItem)).toBe(true);
  });

  it('does not hide completed live output when only same-turn commentary is persisted', () => {
    const liveItem: Extract<TimelineItem, { kind: 'streaming' }> = {
      id: 'live:streaming-assistant',
      kind: 'streaming',
      timestamp: 100,
      text: 'Final answer after the edit.',
      active: false,
      turnId: 'turn-1',
    };
    const partialHistory: TimelineItem[] = [
      {
        id: 'turn-1:a1',
        kind: 'assistant',
        timestamp: 100,
        text: 'I will edit the file.',
        phase: 'commentary',
      },
      {
        id: 'turn-1:file-1',
        kind: 'fileChange',
        timestamp: 100,
        turnId: 'turn-1',
        item: { type: 'fileChange', id: 'file-1', changes: [{ path: '/repo/a.txt' }], status: 'completed' },
        filePath: '/repo/a.txt',
        changeCount: 1,
      },
    ];

    expect(shouldShowLiveStreamingItem(partialHistory, liveItem)).toBe(true);
  });

  it('removes already persisted same-turn commentary from the visible live output', () => {
    const liveItem: Extract<TimelineItem, { kind: 'streaming' }> = {
      id: 'live:streaming-assistant',
      kind: 'streaming',
      timestamp: 100,
      text: 'I will edit the file.\n\nFinal answer after the edit.',
      active: false,
      turnId: 'turn-1',
    };
    const partialHistory: TimelineItem[] = [
      {
        id: 'turn-1:a1',
        kind: 'assistant',
        timestamp: 100,
        text: 'I will edit the file.',
        phase: 'commentary',
      },
    ];

    expect(liveStreamingItemForTimeline(partialHistory, liveItem)).toMatchObject({
      kind: 'streaming',
      text: 'Final answer after the edit.',
    });
  });

  it('finds a completion notification even when a file summary notification follows it', () => {
    const notifications = [
      { method: 'event_msg', params: { type: 'agent_message', message: 'Working', turn_id: 'turn-1' } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      { method: 'webui/fileChange/summaryChanged', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    ];

    expect(latestCompletionNotificationCount(notifications, 42, { activeThreadId: 'thread-1', activeTurnId: 'turn-1' })).toBe(41);
  });

  it('derives live command, file, and tool cards from completed item notifications', () => {
    const items = liveTimelineItemsFromNotifications(
      [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'reasoning', id: 'reason-1', summary: ['thinking'], content: [] },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pwd',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: '/repo\n',
              exitCode: 0,
            },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pwd',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: '/repo\n',
              exitCode: 0,
            },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'fileChange', id: 'file-1', changes: [{ path: '/repo/a.txt' }], status: 'completed' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'mcpToolCall', id: 'tool-1', server: 'test', tool: 'lookup', status: 'completed', arguments: {}, result: {}, error: null },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      100,
    );

    expect(items.map((item) => item.kind)).toEqual(['command', 'fileChange', 'tool']);
    expect(items.map((item) => item.id)).toEqual(['turn-1:cmd-1', 'turn-1:file-1', 'turn-1:tool-1']);
  });

  it('builds ordered live turn items instead of separating all activity from messages', () => {
    const items = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'I will inspect the file.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'sed -n 1p a.txt',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: 'old\n',
              exitCode: 0,
            },
          },
        },
        { method: 'event_msg', params: { type: 'agent_message', message: 'Now I will patch it.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'fileChange', id: 'edit-1', changes: [{ path: '/repo/a.txt' }], status: 'completed' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(items.map((item) => item.kind)).toEqual(['assistant', 'command', 'assistant', 'fileChange']);
    expect(items.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual([
      'I will inspect the file.',
      'turn-1:cmd-1',
      'Now I will patch it.',
      'turn-1:edit-1',
    ]);
  });

  it('treats repeated event message snapshots as replacement updates', () => {
    const items = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'msg-1', message: 'Creat', phase: 'final_answer', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', id: 'msg-1', message: 'Created the file.', phase: 'final_answer', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Created the file.', phase: 'final_answer' });
  });

  it('does not collapse distinct prefix-sharing assistant messages without a shared source id', () => {
    const items = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done, now testing.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(items.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual(['Done', 'Done, now testing.']);
  });

  it('does not overwrite multiple live activity notifications that have no item id', () => {
    const items = liveTurnItemsFromNotifications(
      [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', command: 'pwd', cwd: '/repo', status: 'completed', aggregatedOutput: '/repo\n', exitCode: 0 },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', command: 'git status', cwd: '/repo', status: 'completed', aggregatedOutput: 'clean\n', exitCode: 0 },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => (item.kind === 'command' ? item.command : item.id))).toEqual(['pwd', 'git status']);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });

  it('keeps live items until matching persisted history replaces them', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'I will inspect the file.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pwd',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: '/repo\n',
              exitCode: 0,
            },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );
    const partialHistory: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 100, text: 'I will inspect the file.', phase: 'commentary', turnId: 'turn-1' },
    ];
    const caughtUpHistory: TimelineItem[] = [
      ...partialHistory,
      { id: 'turn-1:cmd-1', kind: 'command', timestamp: 100, command: 'pwd', cwd: '/repo', output: '/repo\n', status: 'completed', exitCode: 0 },
    ];

    expect(visibleLiveTurnItemsForTimeline(partialHistory, liveItems).map((item) => item.id)).toEqual(['turn-1:cmd-1']);
    expect(visibleLiveTurnItemsForTimeline(caughtUpHistory, liveItems)).toEqual([]);
  });

  it('keeps duplicate active-turn history rows in live notification order while streaming', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'I will inspect the file.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pwd',
              cwd: '/repo',
              status: 'completed',
              aggregatedOutput: '/repo\n',
              exitCode: 0,
            },
          },
        },
        { method: 'event_msg', params: { type: 'agent_message', message: 'Now I will patch it.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      3000,
    );
    const persistedHistory: TimelineItem[] = [
      { id: 'turn-1:u1', kind: 'user', timestamp: 1000, text: 'go' },
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 1000, text: 'I will inspect the file.', phase: 'commentary', turnId: 'turn-1' },
      { id: 'turn-1:cmd-1', kind: 'command', timestamp: 1000, command: 'pwd', cwd: '/repo', output: '/repo\n', status: 'completed', exitCode: 0 },
    ];

    const overlaidHistory = timelineItemsWithLiveTurnOverlay(persistedHistory, liveItems, 'turn-1');
    const visibleLiveItems = visibleLiveTurnItemsForTimeline(overlaidHistory, liveItems);
    const merged = mergeTimelineItemsByTimestamp([...overlaidHistory, ...visibleLiveItems]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'go',
      'I will inspect the file.',
      'turn-1:cmd-1',
      'Now I will patch it.',
    ]);
    expect(timelineItemsWithLiveTurnOverlay(persistedHistory, liveItems, null)).toBe(persistedHistory);
  });

  it('detects file-change cards that already carry per-edit diff data', () => {
    expect(
      fileChangeHasInlineDiff({
        id: 'turn-1:file-1',
        kind: 'fileChange',
        timestamp: 100,
        turnId: 'turn-1',
        item: {
          type: 'fileChange',
          id: 'file-1',
          changes: [{ path: '/repo/a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
          status: 'completed',
        },
        filePath: '/repo/a.txt',
        changeCount: 1,
      }),
    ).toBe(true);
    expect(
      fileChangeHasInlineDiff({
        id: 'turn-1:file:/repo/a.txt',
        kind: 'fileChange',
        timestamp: 100,
        turnId: 'turn-1',
        item: { type: 'fileChange', id: 'summary:/repo/a.txt', changes: [{ path: '/repo/a.txt' }], status: 'completed' },
        filePath: '/repo/a.txt',
        changeCount: 3,
      }),
    ).toBe(false);
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
