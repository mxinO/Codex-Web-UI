import { describe, expect, it } from 'vitest';
import {
  approvalItemsFromRequests,
  appendLiveTurnNotifications,
  claimedQueuedUserItemsWithoutHistory,
  claimedQueuedUserItemsFromQueueTransition,
  createLiveTurnAccumulator,
  liveStreamingItemFromNotifications,
  mergeRetainedLiveTurnItems,
  reconcileTimelineItemsByArrival,
  nextLiveNotificationWindow,
  notificationCountBeforeTurnStart,
  notificationsSinceCount,
  notificationIsTurnComplete,
  notificationMatchesActiveTurn,
  latestCompletionNotificationCount,
  fileChangeHasInlineDiff,
  liveStreamingItemForTimeline,
  liveTimelineItemsFromNotifications,
  liveTurnItemsFromAccumulator,
  liveTurnItemsFromNotifications,
  requestKey,
  retargetSyntheticUserItemsToTurn,
  pendingUserItemsWithoutHistory,
  shouldShowLiveStreamingItem,
  timelineItemsWithLiveTurnOverlay,
  timelineItemsWithRetainedLiveTurnOverlay,
  withTimelineNotificationMeta,
  turnToTimelineItems,
  trimTimelineWindow,
  visibleRetainedLiveTurnItemsForTimeline,
  visibleLiveTurnItemsForTimeline,
  withHistoryUserMatchOffsets,
} from '../../src/lib/timeline';
import type { TimelineItem } from '../../src/lib/timeline';
import type { CodexTurn } from '../../src/types/codex';

describe('timeline', () => {
  it('preserves the native item order returned by Codex', () => {
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

  it('appends the synthetic per-turn file summary without moving native messages', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/repo/a.txt', diff: 'created\n' }] },
        { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' },
      ],
    };

    expect(turnToTimelineItems(turn).map((item) => item.kind)).toEqual(['fileChange', 'assistant', 'fileChangeSummary']);
  });

  it('does not reinterpret a final phase as an ordering instruction', () => {
    const turn: CodexTurn = {
      id: 'turn-notice',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' },
        { type: 'plan', id: 'p1', text: 'Plan updated' },
      ],
    };

    expect(turnToTimelineItems(turn).map((item) => item.kind)).toEqual(['assistant', 'notice']);
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

  it('uses a synthetic webui file summary as the per-turn summary without deriving a duplicate raw summary', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        { type: 'agentMessage', id: 'a1', text: 'editing', phase: 'commentary' },
        { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/repo/raw.txt', diff: 'raw\n' }] },
        {
          type: 'webuiFileChangeSummary',
          id: 'summary-1',
          files: [
            { path: '/repo/final.txt', editCount: 3 },
            { path: '/repo/also-final.txt', changeCount: 2 },
          ],
        },
      ],
    };

    const items = turnToTimelineItems(turn);
    const summaries = items.filter((item): item is Extract<TimelineItem, { kind: 'fileChangeSummary' }> => item.kind === 'fileChangeSummary');

    expect(items.map((item) => item.kind)).toEqual(['assistant', 'fileChange', 'fileChangeSummary']);
    expect(summaries).toEqual([
      {
        id: 'turn-file:file-summary',
        kind: 'fileChangeSummary',
        timestamp: 10000,
        turnId: 'turn-file',
        files: [
          { path: '/repo/final.txt', changeCount: 3 },
          { path: '/repo/also-final.txt', changeCount: 2 },
        ],
      },
    ]);
  });

  it('appends exactly one synthetic webui file summary at the end of the turn', () => {
    const turn: CodexTurn = {
      id: 'turn-file',
      status: 'completed',
      startedAt: 10,
      completedAt: 11,
      items: [
        {
          type: 'webuiFileChangeSummary',
          id: 'summary-1',
          files: [{ path: '/repo/old.txt', editCount: 1 }],
        },
        { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/repo', status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 1 },
        {
          type: 'webuiFileChangeSummary',
          id: 'summary-2',
          files: [
            { path: '/repo/a.txt', editCount: 2 },
            { path: '/repo/a.txt', changeCount: 1 },
            { path: '/repo/b.txt', editCount: 1 },
          ],
        },
      ],
    };

    const items = turnToTimelineItems(turn);

    expect(items.map((item) => item.kind)).toEqual(['command', 'fileChangeSummary']);
    expect(items.at(-1)).toMatchObject({
      id: 'turn-file:file-summary',
      kind: 'fileChangeSummary',
      files: [
        { path: '/repo/a.txt', changeCount: 3 },
        { path: '/repo/b.txt', changeCount: 1 },
      ],
    });
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
      { id: 'turn-warning:w1', kind: 'warning', timestamp: 1000, text: 'low disk', turnId: 'turn-warning' },
      { id: 'turn-warning:e1', kind: 'error', timestamp: 1000, text: 'failed turn', turnId: 'turn-warning' },
    ]);
  });

  it('trims old items while preserving newest window', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: String(i), kind: 'notice' as const, timestamp: i, text: String(i) }));
    const trimmed = trimTimelineWindow(items, 200);

    expect(trimmed).toHaveLength(200);
    expect(trimmed[0].id).toBe('5');
  });

  it('preserves candidate order without consulting timestamps or sortOrder', () => {
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

    expect(reconcileTimelineItemsByArrival([], [user, assistant, bang]).map((item) => item.id)).toEqual([
      'u1',
      'a1',
      'bang:1000:1',
    ]);
  });

  it('keeps existing rows in place and appends newly observed candidates', () => {
    const reply: TimelineItem = { id: 'reply', kind: 'assistant', timestamp: 1000, text: 'reply', phase: 'commentary' };
    const bang: TimelineItem = {
      id: 'bang-1',
      kind: 'bangCommand',
      timestamp: 2000,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };
    const persistedLater: TimelineItem = { id: 'persisted-later', kind: 'assistant', timestamp: 1000, text: 'later', phase: null };

    expect(reconcileTimelineItemsByArrival([reply, bang], [reply, persistedLater, bang]).map((item) => item.id)).toEqual([
      'reply',
      'bang-1',
      'persisted-later',
    ]);
  });

  it('matches repeated pending user messages to persisted occurrences without swapping them', () => {
    const firstPending: TimelineItem = {
      id: 'pending:user:1',
      kind: 'user',
      timestamp: 1000,
      text: 'continue',
      turnId: 'turn-1',
    };
    const reply: TimelineItem = {
      id: 'turn-1:a1',
      kind: 'assistant',
      timestamp: 1000,
      text: 'first reply',
      phase: 'commentary',
      turnId: 'turn-1',
    };
    const secondPending: TimelineItem = {
      id: 'pending:user:2',
      kind: 'user',
      timestamp: 2000,
      text: 'continue',
      turnId: 'turn-1',
    };
    const firstPersisted: TimelineItem = {
      id: 'turn-1:u1',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };
    const secondPersisted: TimelineItem = {
      id: 'turn-1:u2',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };

    expect(
      reconcileTimelineItemsByArrival(
        [firstPending, reply, secondPending],
        [firstPersisted, reply, secondPersisted],
      ).map((item) => item.id),
    ).toEqual(['turn-1:u1', 'turn-1:a1', 'turn-1:u2']);
  });

  it('keeps the later repeated pending user when only the first occurrence has persisted', () => {
    const firstPending: Extract<TimelineItem, { kind: 'user' }> = {
      id: 'pending:user:1',
      kind: 'user',
      timestamp: 1000,
      text: 'continue',
      turnId: 'turn-1',
    };
    const secondPending: Extract<TimelineItem, { kind: 'user' }> = {
      id: 'pending:user:2',
      kind: 'user',
      timestamp: 2000,
      text: 'continue',
      turnId: 'turn-1',
    };
    const firstPersisted: TimelineItem = {
      id: 'turn-1:u1',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };
    const reply: TimelineItem = {
      id: 'turn-1:a1',
      kind: 'assistant',
      timestamp: 0,
      text: 'first reply',
      phase: 'commentary',
      turnId: 'turn-1',
    };

    const visiblePending = pendingUserItemsWithoutHistory([firstPersisted, reply], [firstPending, secondPending]);
    expect(visiblePending).toEqual([secondPending]);
    expect(
      reconcileTimelineItemsByArrival(
        [firstPending, reply, secondPending],
        [firstPersisted, reply, ...visiblePending],
      ).map((item) => item.id),
    ).toEqual(['turn-1:u1', 'turn-1:a1', 'pending:user:2']);
  });

  it('does not let older same-text history consume a newly claimed user occurrence', () => {
    const oldHistory: TimelineItem = {
      id: 'turn-1:u1',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };
    const newClaim: Extract<TimelineItem, { kind: 'user' }> = {
      id: 'claimed-queued:user:q2',
      kind: 'user',
      timestamp: 2000,
      text: 'continue',
      turnId: 'turn-1',
      historyMatchOffset: 1,
    };

    expect(claimedQueuedUserItemsWithoutHistory([oldHistory], [newClaim])).toEqual([newClaim]);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [oldHistory, { ...oldHistory, id: 'turn-1:u2' }],
        [newClaim],
      ),
    ).toEqual([]);
  });

  it('keeps repeated claimed user occurrences stable across cleanup passes', () => {
    const claims = withHistoryUserMatchOffsets(
      [],
      [
        { id: 'claimed-queued:user:q1', kind: 'user', timestamp: 1000, text: 'continue', turnId: 'turn-1' },
        { id: 'claimed-queued:user:q2', kind: 'user', timestamp: 2000, text: 'continue', turnId: 'turn-1' },
      ] satisfies Extract<TimelineItem, { kind: 'user' }>[],
    );
    const firstHistory: TimelineItem = {
      id: 'turn-1:u1',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };

    const afterFirstPass = claimedQueuedUserItemsWithoutHistory([firstHistory], claims);
    expect(afterFirstPass.map((item) => item.id)).toEqual(['claimed-queued:user:q2']);
    expect(claimedQueuedUserItemsWithoutHistory([firstHistory], afterFirstPass).map((item) => item.id)).toEqual([
      'claimed-queued:user:q2',
    ]);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [firstHistory, { ...firstHistory, id: 'turn-1:u2' }],
        afterFirstPass,
      ),
    ).toEqual([]);
  });

  it('allocates one occurrence sequence across pending and claimed user collections', () => {
    const [pending] = withHistoryUserMatchOffsets(
      [],
      [{ id: 'pending:user:1', kind: 'user', timestamp: 1000, text: 'continue', turnId: 'turn-1' }],
    );
    const [claimed] = withHistoryUserMatchOffsets(
      [pending],
      [{ id: 'claimed-queued:user:q1', kind: 'user', timestamp: 2000, text: 'continue', turnId: 'turn-1' }],
    );
    const firstHistory: TimelineItem = {
      id: 'turn-1:u1',
      kind: 'user',
      timestamp: 0,
      text: 'continue',
      turnId: 'turn-1',
    };

    expect(pending).toMatchObject({ historyMatchOffset: 0 });
    expect(claimed).toMatchObject({ historyMatchOffset: 1 });
    expect(pendingUserItemsWithoutHistory([firstHistory], [pending])).toEqual([]);
    expect(claimedQueuedUserItemsWithoutHistory([firstHistory], [claimed])).toEqual([claimed]);
    expect(claimedQueuedUserItemsWithoutHistory([firstHistory], [claimed])).toEqual([claimed]);
  });

  it('updates a same-id row without moving it past later rows', () => {
    const streaming: TimelineItem = { id: 'message-1', kind: 'streaming', timestamp: 1000, text: 'Hel', active: true, turnId: 'turn-1' };
    const later: TimelineItem = { id: 'tool-1', kind: 'notice', timestamp: 2000, text: 'Working', turnId: 'turn-1' };
    const updated: TimelineItem = { ...streaming, text: 'Hello' };

    expect(reconcileTimelineItemsByArrival([streaming, later], [later, updated])).toEqual([updated, later]);
  });

  it('updates a same-id kind transition without moving it past later rows', () => {
    const streaming: TimelineItem = { id: 'message-1', kind: 'streaming', timestamp: 1000, text: 'Done', active: false, turnId: 'turn-1' };
    const later: TimelineItem = { id: 'tool-1', kind: 'notice', timestamp: 2000, text: 'Working', turnId: 'turn-1' };
    const final: TimelineItem = { id: 'message-1', kind: 'assistant', timestamp: 3000, text: 'Done', phase: 'final_answer', turnId: 'turn-1' };

    expect(reconcileTimelineItemsByArrival([streaming, later], [later, final])).toEqual([final, later]);
  });

  it('matches duplicate ids by occurrence content before removing a stale copy', () => {
    const first: TimelineItem = { id: 'turn-1:a1', kind: 'assistant', timestamp: 1000, text: 'first', phase: null, turnId: 'turn-1' };
    const anchor: TimelineItem = { id: 'turn-1:tool', kind: 'notice', timestamp: 1000, text: 'anchor', turnId: 'turn-1' };
    const second: TimelineItem = { id: 'turn-1:a1', kind: 'assistant', timestamp: 1000, text: 'second', phase: null, turnId: 'turn-1' };

    expect(reconcileTimelineItemsByArrival([first, anchor, second], [second, anchor])).toEqual([anchor, second]);
  });

  it('keeps a synthetic user slot when persisted history changes its id', () => {
    const pending: TimelineItem = {
      id: 'pending:user:1',
      kind: 'user',
      timestamp: 2000,
      text: 'question',
      turnId: 'turn-start-pending:thread-1',
    };
    const later: TimelineItem = { id: 'live:later', kind: 'assistant', timestamp: 3000, text: 'answer', phase: null, turnId: 'turn-2' };
    const persisted: TimelineItem = { id: 'turn-2:user', kind: 'user', timestamp: 0, text: 'question', turnId: 'turn-2' };

    expect(reconcileTimelineItemsByArrival([pending, later], [later, persisted])).toEqual([persisted, later]);
  });

  it('removes a real-turn pending user when matching history has an unrelated timestamp', () => {
    const pending: Extract<TimelineItem, { kind: 'user' }> = {
      id: 'pending:user:1',
      kind: 'user',
      timestamp: 50_000,
      text: 'question',
      turnId: 'turn-2',
    };
    const persisted: TimelineItem = { id: 'turn-2:user', kind: 'user', timestamp: 0, text: 'question', turnId: 'turn-2' };

    expect(pendingUserItemsWithoutHistory([persisted], [pending])).toEqual([]);
  });

  it('keeps a source-less live assistant slot when persisted history changes its id', () => {
    const live: TimelineItem = { id: 'live:assistant:turn-1:1', kind: 'assistant', timestamp: 1000, text: 'Done.', phase: null, turnId: 'turn-1' };
    const command: TimelineItem = {
      id: 'turn-1:cmd-1',
      kind: 'command',
      timestamp: 2000,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
      turnId: 'turn-1',
    };
    const persisted: TimelineItem = { id: 'turn-1:persisted', kind: 'assistant', timestamp: 1000, text: 'Done.', phase: null, turnId: 'turn-1' };

    expect(reconcileTimelineItemsByArrival([live, command], [command, persisted])).toEqual([persisted, command]);
  });

  it('keeps a sourceful live assistant slot when persisted history changes source ids', () => {
    const live: TimelineItem = {
      id: 'turn-1:live-source',
      kind: 'assistant',
      timestamp: 1000,
      text: 'Done.',
      phase: null,
      turnId: 'turn-1',
      sourceId: 'live-source',
      liveSource: 'event_msg',
    };
    const later: TimelineItem = { id: 'turn-1:later', kind: 'notice', timestamp: 2000, text: 'later', turnId: 'turn-1' };
    const persisted: TimelineItem = {
      id: 'turn-1:persisted-source',
      kind: 'assistant',
      timestamp: 0,
      text: 'Done.',
      phase: null,
      turnId: 'turn-1',
      sourceId: 'persisted-source',
    };

    expect(reconcileTimelineItemsByArrival([live, later], [later, persisted])).toEqual([persisted, later]);
  });

  it('keeps an inactive source-less stream slot when a final replaces its partial text', () => {
    const partial: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 1000,
      text: 'Partial wording',
      active: false,
      turnId: 'turn-1',
    };
    const later: TimelineItem = { id: 'turn-1:later', kind: 'notice', timestamp: 2000, text: 'later', turnId: 'turn-1' };
    const final: TimelineItem = {
      id: 'turn-1:final',
      kind: 'assistant',
      timestamp: 0,
      text: 'Different final wording.',
      phase: 'final_answer',
      turnId: 'turn-1',
    };

    expect(reconcileTimelineItemsByArrival([partial, later], [later, final])).toEqual([final, later]);
  });

  it('preserves same-turn candidate order when seeding a timeline', () => {
    const final: TimelineItem = { id: 'turn-1:final', kind: 'assistant', timestamp: 1000, text: 'Done.', phase: 'final_answer', turnId: 'turn-1' };
    const command: TimelineItem = {
      id: 'turn-1:command',
      kind: 'command',
      timestamp: 5000,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
      turnId: 'turn-1',
    };
    const bang: TimelineItem = {
      id: 'bang:1',
      kind: 'bangCommand',
      timestamp: 2000,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };

    expect(reconcileTimelineItemsByArrival([], [final, bang, command]).map((item) => item.id)).toEqual([
      'turn-1:final',
      'bang:1',
      'turn-1:command',
    ]);
    expect(reconcileTimelineItemsByArrival([final, bang], [final, bang, command]).map((item) => item.id)).toEqual([
      'turn-1:final',
      'bang:1',
      'turn-1:command',
    ]);
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
      { id: 'turn-2:0', kind: 'user', timestamp: 0, text: '', turnId: 'turn-2' },
      { id: 'turn-2:r1', kind: 'notice', timestamp: 0, text: '', turnId: 'turn-2' },
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
      startIsProvisional: true,
    });
    expect(nextLiveNotificationWindow(current, { activeThreadId: 'thread-2', activeTurnId: null }, 30)).toEqual({
      activeThreadId: 'thread-2',
      activeTurnId: null,
      startCount: 30,
    });
  });

  it('anchors an autonomous turn window before its already received start event', () => {
    const notifications = [
      withTimelineNotificationMeta(
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } } },
        { order: 24, receivedAt: 100, streamId: 'stream-1', seq: 44 },
      ),
      withTimelineNotificationMeta(
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'message-2', delta: 'Still working' } },
        { order: 25, receivedAt: 101, streamId: 'stream-1', seq: 45 },
      ),
    ];
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-2' };
    const turnStartCount = notificationCountBeforeTurnStart(notifications, 25, scope);

    expect(turnStartCount).toBe(23);
    const window = nextLiveNotificationWindow(
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1', startCount: 10 },
      scope,
      25,
      { turnStartCount },
    );
    expect(window).toEqual({ ...scope, startCount: 23 });
    expect(notificationsSinceCount(notifications, 25, window.startCount)).toEqual(notifications);
  });

  it('keeps the original turn start anchor when the same start is repeated', () => {
    const notifications = [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1' } } },
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } },
      { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'tool-1' } } },
    ];

    expect(
      notificationCountBeforeTurnStart(
        notifications,
        14,
        { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      ),
    ).toBe(10);
  });

  it('moves a provisional autonomous window forward when its delayed start anchor arrives', () => {
    expect(
      nextLiveNotificationWindow(
        { activeThreadId: 'thread-1', activeTurnId: 'turn-2', startCount: 20, startIsProvisional: true },
        { activeThreadId: 'thread-1', activeTurnId: 'turn-2' },
        24,
        { turnStartCount: 22 },
      ),
    ).toEqual({ activeThreadId: 'thread-1', activeTurnId: 'turn-2', startCount: 22 });
  });

  it('does not move an established turn anchor after its original start is evicted', () => {
    const current = { activeThreadId: 'thread-1', activeTurnId: 'turn-2', startCount: 20 };

    expect(
      nextLiveNotificationWindow(
        current,
        { activeThreadId: 'thread-1', activeTurnId: 'turn-2' },
        5000,
        { turnStartCount: 3999 },
      ),
    ).toBe(current);
  });

  it('does not create an empty waiting chat item for an active turn with no assistant text', () => {
    expect(
      liveTurnItemsFromNotifications(
        [],
        { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
        true,
        100,
      ),
    ).toEqual([]);
  });

  it('starts a pending submit window without attributing new unscoped output to the previous turn', () => {
    const completedWindow = { activeThreadId: 'thread-1', activeTurnId: 'turn-previous', startCount: 10 };

    expect(
      nextLiveNotificationWindow(
        completedWindow,
        { activeThreadId: 'thread-1', activeTurnId: null },
        25,
        { pendingStartCount: 25 },
      ),
    ).toEqual({ activeThreadId: 'thread-1', activeTurnId: null, startCount: 25 });
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

  it('hides inactive streaming output once a same-turn final answer is available', () => {
    const liveItem: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 200,
      text: 'The complete live answer.',
      active: false,
      turnId: 'turn-1',
    };
    const partialFinalHistory: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 100, text: 'A partial final answer.', phase: 'final_answer', turnId: 'turn-1' },
    ];

    expect(visibleLiveTurnItemsForTimeline(partialFinalHistory, [liveItem])).toEqual([]);
  });

  it('hides a completed latest-response snapshot when a live finalized assistant covers it', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Created the fi' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'Created the file.', phase: 'final_answer' },
          },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['assistant']);
    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.kind)).toEqual(['assistant']);
  });

  it('does not keep a source-less delta card active after the finalized assistant item arrives', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Created the fi' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'Created the file.', phase: 'final_answer' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(liveItems[0]).toMatchObject({ kind: 'assistant', text: 'Created the file.' });
    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.kind)).toEqual(['assistant']);
  });

  it('marks the streaming card inactive after a terminal notification even before state catches up', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Done' } },
        { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(liveItems).toHaveLength(1);
    expect(liveItems[0]).toMatchObject({ kind: 'streaming', text: 'Done', active: false });
  });

  it('starts a fresh source-less streaming card after a completed assistant item', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'First' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'First finalized.', phase: 'commentary' },
          },
        },
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Second' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['assistant', 'streaming']);
    expect(liveItems.map((item) => (item.kind === 'streaming' ? `${item.text}:${item.active}` : item.kind === 'assistant' ? item.text : item.id))).toEqual([
      'First finalized.',
      'Second:true',
    ]);
  });

  it('marks a delta card inactive while later activity is running', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'I will inspect the file.' } },
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
      true,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['streaming', 'command']);
    expect(liveItems[0]).toMatchObject({ kind: 'streaming', active: false });
  });

  it('replaces a split streaming card with its finalized message across intervening activity', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'First part ' } },
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
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'and rest' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'First part and rest', phase: 'final_answer' },
          },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['assistant', 'command']);
    expect(liveItems.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual(['First part and rest', 'turn-1:cmd-1']);
    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.kind)).toEqual(['assistant', 'command']);
  });

  it('keeps separate streaming messages from being combined into one response', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'First message' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'First message', phase: 'commentary' },
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
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a2', delta: 'Second message' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a2', text: 'Second message', phase: 'final_answer' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['assistant', 'command', 'assistant']);
    expect(liveItems.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual([
      'First message',
      'turn-1:cmd-1',
      'Second message',
    ]);
  });

  it('does not hide a sourced streaming message behind a different finalized message in the same turn', () => {
    const streaming: TimelineItem = {
      id: 'turn-1:a1',
      kind: 'streaming',
      timestamp: 200,
      text: 'First message still streaming',
      active: false,
      turnId: 'turn-1',
      sourceId: 'a1',
    };
    const history: TimelineItem[] = [
      { id: 'turn-1:a2', kind: 'assistant', timestamp: 100, text: 'Second message final.', phase: 'final_answer', turnId: 'turn-1', sourceId: 'a2' },
    ];

    expect(visibleLiveTurnItemsForTimeline(history, [streaming])).toEqual([streaming]);
  });

  it('hides an inactive partial streaming duplicate after the final text persists with a different source id', () => {
    const streaming: TimelineItem = {
      id: 'turn-1:delta-transport',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-transport',
    };
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];

    expect(visibleLiveTurnItemsForTimeline(history, [streaming], { allowAssistantTextMatchAcrossSources: true })).toEqual([]);
  });

  it('keeps an inactive different streaming message after a final assistant with a different source id', () => {
    const streaming: TimelineItem = {
      id: 'turn-1:delta-transport',
      kind: 'streaming',
      timestamp: 200,
      text: 'I am inspecting a separate file.',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-transport',
    };
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'The tests are passing.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];

    expect(visibleLiveTurnItemsForTimeline(history, [streaming], { allowAssistantTextMatchAcrossSources: true })).toEqual([streaming]);
  });

  it('keeps identical finalized assistant text when the message ids are different', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'commentary' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a2', text: 'Done.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(liveItems.map((item) => item.id)).toEqual(['turn-1:a1', 'turn-1:a2']);
    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual(['turn-1:a1', 'turn-1:a2']);
    expect(visibleLiveTurnItemsForTimeline([], liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:a1',
      'turn-1:a2',
    ]);
  });

  it('hides completed live assistant snapshots with different transport ids after history catches up', () => {
    const history = turnToTimelineItems({
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'agentMessage', id: 'persisted-1', text: 'I will inspect the file.', phase: 'commentary' },
        { type: 'agentMessage', id: 'persisted-2', text: 'Now I will patch it.', phase: 'commentary' },
      ],
    });
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'I will inspect the file.', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-2', message: 'Now I will patch it.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline(history, liveItems).map((item) => item.id)).toEqual(['turn-1:transport-1', 'turn-1:transport-2']);
    expect(visibleLiveTurnItemsForTimeline(history, liveItems, { allowAssistantTextMatchAcrossSources: true })).toEqual([]);
  });

  it('keeps extra same-text live assistant snapshots beyond the persisted history count', () => {
    const history = turnToTimelineItems({
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' }],
    });
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-2', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline(history, liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:transport-2',
    ]);
  });

  it('keeps extra same-text live assistant snapshots after an exact-id persisted duplicate', () => {
    const history = turnToTimelineItems({
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' }],
    });
    const liveItems = liveTurnItemsFromNotifications(
      [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' },
          },
        },
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-2', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline(history, liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:transport-2',
    ]);
  });

  it('reserves exact-id persisted duplicates before hiding same-text live assistant snapshots', () => {
    const history = turnToTimelineItems({
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' }],
    });
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-2', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline(history, liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:transport-2',
    ]);
  });

  it('dedupes event-message and completed-message assistant snapshots with different transport ids after completion', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' },
          },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual(['turn-1:persisted-1']);
    expect(visibleLiveTurnItemsForTimeline([], liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:persisted-1',
    ]);
  });

  it('dedupes event-message and completed-message snapshots while the turn is active', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Inspecting now.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Inspecting now.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual(['turn-1:persisted-1']);
  });

  it('replaces a shorter raw-event snapshot with its structured completion in place', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Inspecting', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Inspecting now.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems)).toEqual([
      expect.objectContaining({ id: 'turn-1:persisted-1', kind: 'assistant', text: 'Inspecting now.' }),
    ]);
  });

  it('does not prefix-pair distinct transport messages across activity', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Inspecting', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', cwd: '/repo', status: 'completed', aggregatedOutput: '/repo\n', exitCode: 0 },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Inspecting now.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual([
      'turn-1:transport-1',
      'turn-1:cmd-1',
      'turn-1:persisted-1',
    ]);
  });

  it('replaces an inactive delta stream at its original slot across transport ids', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'delta-1', delta: 'Inspecting now.' },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', cwd: '/repo', status: 'completed', aggregatedOutput: '/repo\n', exitCode: 0 },
          },
        },
        {
          method: 'event_msg',
          params: { type: 'agent_message', id: 'transport-1', message: 'Inspecting now.', phase: 'commentary', turn_id: 'turn-1' },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual([
      'turn-1:transport-1',
      'turn-1:cmd-1',
    ]);
  });

  it('matches a delayed final to its source before a newer prefix-sharing stream', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'Inspecting' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', cwd: '/repo', status: 'completed', aggregatedOutput: '/repo\n', exitCode: 0 },
          },
        },
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a2', delta: 'Inspecting now.' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'Inspecting', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(liveItems.map((item) => item.id)).toEqual(['turn-1:a1', 'turn-1:cmd-1', 'turn-1:a2']);
    expect(liveItems.map((item) => item.kind)).toEqual(['assistant', 'command', 'streaming']);
    expect(liveItems[2]).toMatchObject({ kind: 'streaming', active: true });
  });

  it('dedupes repeated event/completed assistant pairs without collapsing legitimate repeated text', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-1', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', id: 'transport-2', message: 'Done.', phase: 'commentary', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-1', text: 'Done.', phase: 'commentary' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'persisted-2', text: 'Done.', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], liveItems).map((item) => item.id)).toEqual([
      'turn-1:persisted-1',
      'turn-1:persisted-2',
    ]);
    expect(visibleLiveTurnItemsForTimeline([], liveItems, { allowAssistantTextMatchAcrossSources: true }).map((item) => item.id)).toEqual([
      'turn-1:persisted-1',
      'turn-1:persisted-2',
    ]);
  });

  it('only removes retained streaming for matching or text-covered persisted assistant messages', () => {
    const history = turnToTimelineItems({
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'a1', text: 'Same text.', phase: 'final_answer' }],
    });
    const matching: TimelineItem = {
      id: 'turn-1:a1',
      kind: 'streaming',
      timestamp: 2000,
      text: 'Same text.',
      active: false,
      turnId: 'turn-1',
      sourceId: 'a1',
    };
    const different: TimelineItem = {
      id: 'turn-1:a2',
      kind: 'streaming',
      timestamp: 2001,
      text: 'Same text.',
      active: false,
      turnId: 'turn-1',
      sourceId: 'a2',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [matching, different])).toEqual([different]);
    expect(visibleLiveTurnItemsForTimeline(history, [matching, different], { allowAssistantTextMatchAcrossSources: true })).toEqual([different]);
  });

  it('keeps extra inactive prefix streaming rows beyond the final assistant cover count', () => {
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];
    const first: TimelineItem = {
      id: 'turn-1:delta-1',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-1',
    };
    const second: TimelineItem = {
      id: 'turn-1:delta-2',
      kind: 'streaming',
      timestamp: 201,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-2',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [first, second], { allowAssistantTextMatchAcrossSources: true })).toEqual([second]);
  });

  it('does not let a hidden duplicate live assistant cover extra streaming rows', () => {
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];
    const duplicateLiveAssistant: TimelineItem = {
      id: 'turn-1:transport-final',
      kind: 'assistant',
      timestamp: 301,
      text: 'I found the issue and fixed it.',
      phase: 'final_answer',
      turnId: 'turn-1',
      sourceId: 'transport-final',
      liveSource: 'event_msg',
    };
    const first: TimelineItem = {
      id: 'turn-1:delta-1',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-1',
    };
    const second: TimelineItem = {
      id: 'turn-1:delta-2',
      kind: 'streaming',
      timestamp: 201,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-2',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [duplicateLiveAssistant, first, second], { allowAssistantTextMatchAcrossSources: true })).toEqual([
      second,
    ]);
  });

  it('does not let a live-deduped assistant cover extra streaming rows', () => {
    const visibleAssistant: TimelineItem = {
      id: 'turn-1:transport-final',
      kind: 'assistant',
      timestamp: 300,
      text: 'I found the issue and fixed it.',
      phase: 'final_answer',
      turnId: 'turn-1',
      sourceId: 'transport-final',
      liveSource: 'event_msg',
    };
    const duplicateAssistant: TimelineItem = {
      id: 'turn-1:persisted-final',
      kind: 'assistant',
      timestamp: 301,
      text: 'I found the issue and fixed it.',
      phase: 'final_answer',
      turnId: 'turn-1',
      sourceId: 'persisted-final',
      liveSource: 'item_completed',
    };
    const first: TimelineItem = {
      id: 'turn-1:delta-1',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-1',
    };
    const second: TimelineItem = {
      id: 'turn-1:delta-2',
      kind: 'streaming',
      timestamp: 201,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-2',
    };

    expect(visibleLiveTurnItemsForTimeline([], [visibleAssistant, duplicateAssistant, first, second], { allowAssistantTextMatchAcrossSources: true })).toEqual([
      duplicateAssistant,
      second,
    ]);
  });

  it('keeps a repeated no-source streaming segment separated by activity when one final cover exists', () => {
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'Repeat status and finish.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];
    const first: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 100,
      text: 'Repeat status',
      active: false,
      turnId: 'turn-1',
    };
    const command: TimelineItem = {
      id: 'turn-1:cmd-1',
      kind: 'command',
      timestamp: 150,
      command: 'pwd',
      cwd: '/repo',
      output: '/repo\n',
      status: 'completed',
      exitCode: 0,
    };
    const second: TimelineItem = {
      id: 'live:streaming:turn-1:2',
      kind: 'streaming',
      timestamp: 200,
      text: 'Repeat status',
      active: false,
      turnId: 'turn-1',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [first, command, second])).toEqual([command, second]);
  });

  it('hides an unrelated source-less stream without spending the final cover for a sourced stale stream', () => {
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];
    const unrelated: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 100,
      text: 'Running tests now.',
      active: false,
      turnId: 'turn-1',
    };
    const stale: TimelineItem = {
      id: 'turn-1:delta-transport',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-transport',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [unrelated, stale], { allowAssistantTextMatchAcrossSources: true })).toEqual([]);
  });

  it('hides a matching source-less stream without spending the final cover for a sourced stale stream', () => {
    const history: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 300,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];
    const sourceLess: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 100,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
    };
    const stale: TimelineItem = {
      id: 'turn-1:delta-transport',
      kind: 'streaming',
      timestamp: 200,
      text: 'I found the issue',
      active: false,
      turnId: 'turn-1',
      sourceId: 'delta-transport',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [sourceLess, stale], { allowAssistantTextMatchAcrossSources: true })).toEqual([]);
  });

  it('starts a new no-id streaming segment after intervening activity', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'First message' } },
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
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Second message' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['streaming', 'command', 'streaming']);
    expect(liveItems.map((item) => (item.kind === 'streaming' ? item.text : item.id))).toEqual([
      'First message',
      'turn-1:cmd-1',
      'Second message',
    ]);
  });

  it('replaces event message snapshots with the completed item when the source id matches', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', id: 'a1', message: 'Draft', phase: 'commentary', turn_id: 'turn-1' } },
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
            item: { type: 'agentMessage', id: 'a1', text: 'Final', phase: 'commentary' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    expect(liveItems.map((item) => item.kind)).toEqual(['assistant', 'command']);
    expect(liveItems.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual(['Final', 'turn-1:cmd-1']);
  });

  it('does not hide active-turn history for a different assistant source with the same text', () => {
    const history: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 100, text: 'Done.', phase: 'commentary', turnId: 'turn-1', sourceId: 'a1' },
      { id: 'turn-1:a2', kind: 'assistant', timestamp: 100, text: 'Done.', phase: 'commentary', turnId: 'turn-1', sourceId: 'a2' },
    ];
    const live: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 200, text: 'Done.', phase: 'commentary', turnId: 'turn-1', sourceId: 'a1' },
    ];

    expect(timelineItemsWithLiveTurnOverlay(history, live, 'turn-1').map((item) => item.id)).toEqual(['turn-1:a2']);
  });

  it('replaces persisted history with an equivalent raw-event assistant snapshot', () => {
    const history: TimelineItem[] = [
      { id: 'turn-1:persisted', kind: 'assistant', timestamp: 100, text: 'Inspecting now.', phase: 'commentary', turnId: 'turn-1', sourceId: 'persisted' },
    ];
    const live: TimelineItem[] = [
      {
        id: 'turn-1:transport',
        kind: 'assistant',
        timestamp: 200,
        text: 'Inspecting now.',
        phase: 'commentary',
        turnId: 'turn-1',
        sourceId: 'transport',
        liveSource: 'event_msg',
      },
    ];

    expect(timelineItemsWithLiveTurnOverlay(history, live, 'turn-1')).toEqual([]);
  });

  it('matches raw-event overlays to repeated persisted text one occurrence at a time', () => {
    const history: TimelineItem[] = [
      { id: 'turn-1:first', kind: 'assistant', timestamp: 100, text: 'Still working.', phase: 'commentary', turnId: 'turn-1', sourceId: 'first' },
      { id: 'turn-1:second', kind: 'assistant', timestamp: 101, text: 'Still working.', phase: 'commentary', turnId: 'turn-1', sourceId: 'second' },
    ];
    const live: TimelineItem[] = [
      {
        id: 'turn-1:transport',
        kind: 'assistant',
        timestamp: 200,
        text: 'Still working.',
        phase: 'commentary',
        turnId: 'turn-1',
        sourceId: 'transport',
        liveSource: 'event_msg',
      },
    ];

    expect(timelineItemsWithLiveTurnOverlay(history, live, 'turn-1').map((item) => item.id)).toEqual(['turn-1:second']);
  });

  it('reserves an exact completed-item history match before applying raw-event text overlays', () => {
    const history: TimelineItem[] = [
      { id: 'turn-1:first', kind: 'assistant', timestamp: 100, text: 'Done.', phase: 'commentary', turnId: 'turn-1', sourceId: 'first' },
      { id: 'turn-1:cmd', kind: 'command', timestamp: 101, command: 'pwd', cwd: '/repo', output: '/repo\n', status: 'completed', exitCode: 0, turnId: 'turn-1' },
      { id: 'turn-1:second', kind: 'assistant', timestamp: 102, text: 'Done.', phase: 'commentary', turnId: 'turn-1', sourceId: 'second' },
    ];
    const live: TimelineItem[] = [
      {
        id: 'turn-1:transport',
        kind: 'assistant',
        timestamp: 200,
        text: 'Done.',
        phase: 'commentary',
        turnId: 'turn-1',
        sourceId: 'transport',
        liveSource: 'event_msg',
      },
      {
        id: 'turn-1:second',
        kind: 'assistant',
        timestamp: 201,
        text: 'Done.',
        phase: 'commentary',
        turnId: 'turn-1',
        sourceId: 'second',
        liveSource: 'item_completed',
      },
    ];

    expect(timelineItemsWithLiveTurnOverlay(history, live, 'turn-1').map((item) => item.id)).toEqual([
      'turn-1:first',
      'turn-1:cmd',
    ]);
  });

  it('hides retained streaming once the current live item has finalized for the same source id', () => {
    const retained: TimelineItem[] = [
      {
        id: 'turn-1:a1',
        kind: 'streaming',
        timestamp: 100,
        text: 'Created the fi',
        active: false,
        turnId: 'turn-1',
        sourceId: 'a1',
      },
    ];
    const current: TimelineItem[] = [
      {
        id: 'turn-1:a1',
        kind: 'assistant',
        timestamp: 200,
        text: 'Created the file.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'a1',
      },
    ];

    expect(visibleRetainedLiveTurnItemsForTimeline([], current, retained)).toEqual([]);
  });

  it('hides retained source-less streaming when a current live final assistant covers it', () => {
    const retained: TimelineItem[] = [
      {
        id: 'live:streaming:turn-1:1',
        kind: 'streaming',
        timestamp: 100,
        text: 'Created the fi',
        active: false,
        turnId: 'turn-1',
      },
    ];
    const current: TimelineItem[] = [
      {
        id: 'turn-1:a1',
        kind: 'assistant',
        timestamp: 200,
        text: 'Created the file.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'a1',
      },
    ];

    expect(visibleRetainedLiveTurnItemsForTimeline([], current, retained)).toEqual([]);
  });

  it('hides a latest-response snapshot when persisted history has a same-turn finalized prefix match', () => {
    const liveItem: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 200,
      text: 'Created the fi',
      active: false,
      turnId: 'turn-1',
    };
    const history: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 100, text: 'Created the file.', phase: 'final_answer', turnId: 'turn-1' },
    ];

    expect(visibleLiveTurnItemsForTimeline(history, [liveItem])).toEqual([]);
  });

  it('hides retained streaming output for persisted assistant history whose turn id contains a colon', () => {
    const history = turnToTimelineItems({
      id: 'turn:1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [{ type: 'agentMessage', id: 'a1', text: 'Finished with colon turn id.', phase: 'final_answer' }],
    });
    const liveItem: TimelineItem = {
      id: 'live:streaming:turn:1:1',
      kind: 'streaming',
      timestamp: 2000,
      text: 'Finished with colon',
      active: false,
      turnId: 'turn:1',
    };

    expect(visibleLiveTurnItemsForTimeline(history, [liveItem])).toEqual([]);
  });

  it('collapses repeated prefix streaming snapshots to the latest same-turn snapshot', () => {
    const first: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 100,
      text: 'Starting with a detailed plan',
      active: false,
      turnId: 'turn-1',
    };
    const second: TimelineItem = {
      id: 'live:streaming:turn-1:2',
      kind: 'streaming',
      timestamp: 200,
      text: 'Starting with a detailed plan and then running tests',
      active: false,
      turnId: 'turn-1',
    };

    expect(visibleLiveTurnItemsForTimeline([], [first, second])).toEqual([second]);
  });

  it('keeps distinct same-turn assistant messages that share a prefix', () => {
    const items = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done', phase: 'commentary', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done, now testing.', phase: 'commentary', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(visibleLiveTurnItemsForTimeline([], items).map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual([
      'Done',
      'Done, now testing.',
    ]);
  });

  it('keeps longer streaming output when persisted commentary is only a prefix', () => {
    const streaming: TimelineItem = {
      id: 'live:streaming:turn-1:1',
      kind: 'streaming',
      timestamp: 200,
      text: 'Starting with a detailed plan and continuing to run tests',
      active: false,
      turnId: 'turn-1',
    };
    const history: TimelineItem[] = [
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 100, text: 'Starting with a detailed plan', phase: 'commentary', turnId: 'turn-1' },
    ];

    expect(visibleLiveTurnItemsForTimeline(history, [streaming])).toEqual([streaming]);
  });

  it('keeps one live assistant when event and completed notifications have identical text', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done.', phase: 'final_answer', turn_id: 'turn-1' } },
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
            item: { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    const visible = visibleLiveTurnItemsForTimeline([], liveItems);
    expect(visible.map((item) => item.kind)).toEqual(['assistant', 'command']);
    expect(visible.filter((item) => item.kind === 'assistant')).toHaveLength(1);
  });

  it('dedupes exact final live assistant text across final-equivalent phases', () => {
    const liveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Done.', phase: 'final_answer', turn_id: 'turn-1' } },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'Done.', phase: null },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      100,
    );

    const visible = visibleLiveTurnItemsForTimeline([], liveItems);
    expect(visible.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(visible.map((item) => (item.kind === 'assistant' ? item.text : item.id))).toEqual(['Done.']);
  });

  it('retains completed live items across a pending next user message until history catches up', () => {
    const completedLiveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Previous answer.', phase: 'final_answer', turn_id: 'turn-1' } },
        { method: 'event_msg', params: { type: 'task_complete', thread_id: 'thread-1', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      1000,
    );
    const staleHistory: TimelineItem[] = [
      { id: 'turn-0:a1', kind: 'assistant', timestamp: 500, text: 'Older persisted answer.', phase: null, turnId: 'turn-0' },
    ];
    const pendingUser: TimelineItem = { id: 'pending:user:1', kind: 'user', timestamp: 2000, text: 'Next question' };

    const retained = mergeRetainedLiveTurnItems(staleHistory, [], completedLiveItems);
    const visible = visibleLiveTurnItemsForTimeline([...staleHistory, pendingUser], retained);
    const merged = reconcileTimelineItemsByArrival([], [...staleHistory, ...visible, pendingUser]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'streaming' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'Older persisted answer.',
      'Previous answer.',
      'Next question',
    ]);

    const caughtUpHistory: TimelineItem[] = [
      ...staleHistory,
      { id: 'turn-1:a1', kind: 'assistant', timestamp: 1000, text: 'Previous answer.', phase: 'final_answer', turnId: 'turn-1' },
    ];
    expect(mergeRetainedLiveTurnItems(caughtUpHistory, retained, [])).toEqual([]);
  });

  it('keeps retained completed-turn activities between their live assistant anchors after history catches up', () => {
    const completedLiveItems = liveTurnItemsFromNotifications(
      [
        withTimelineNotificationMeta(
          { method: 'event_msg', params: { type: 'agent_message', message: 'I will inspect the file.', phase: 'commentary', turn_id: 'turn-1' } },
          { order: 1, receivedAt: 2000, streamId: 'stream-1', seq: 1 },
        ),
        withTimelineNotificationMeta(
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
          { order: 2, receivedAt: 3000, streamId: 'stream-1', seq: 2 },
        ),
        withTimelineNotificationMeta(
          { method: 'event_msg', params: { type: 'agent_message', message: 'Done.', phase: 'final_answer', turn_id: 'turn-1' } },
          { order: 3, receivedAt: 4000, streamId: 'stream-1', seq: 3 },
        ),
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      false,
      1000,
    );
    const caughtUpHistory: TimelineItem[] = [
      { id: 'turn-1:u1', kind: 'user', timestamp: 1000, text: 'question', turnId: 'turn-1' },
      {
        id: 'turn-1:persisted-commentary',
        kind: 'assistant',
        timestamp: 1000,
        text: 'I will inspect the file.',
        phase: 'commentary',
        turnId: 'turn-1',
        sourceId: 'persisted-commentary',
      },
      {
        id: 'turn-1:persisted-final',
        kind: 'assistant',
        timestamp: 1000,
        text: 'Done.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'persisted-final',
      },
    ];

    const retained = mergeRetainedLiveTurnItems(caughtUpHistory, [], completedLiveItems);
    const overlaidHistory = timelineItemsWithRetainedLiveTurnOverlay(caughtUpHistory, retained);
    const visibleRetained = visibleRetainedLiveTurnItemsForTimeline(overlaidHistory, [], retained);
    const merged = reconcileTimelineItemsByArrival([], [...overlaidHistory, ...visibleRetained]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'question',
      'I will inspect the file.',
      'turn-1:cmd-1',
      'Done.',
    ]);
  });

  it('keeps retained completed-turn activity before the next persisted user prompt', () => {
    const caughtUpHistory: TimelineItem[] = [
      { id: 'turn-1:u1', kind: 'user', timestamp: 1000, text: 'first question', turnId: 'turn-1' },
      {
        id: 'turn-1:persisted-final',
        kind: 'assistant',
        timestamp: 1000,
        text: 'Done.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'persisted-final',
      },
      { id: 'turn-2:u1', kind: 'user', timestamp: 2500, text: 'next question', turnId: 'turn-2' },
    ];
    const retained: TimelineItem[] = [
      {
        id: 'turn-1:cmd-1',
        kind: 'command',
        timestamp: 3000,
        sortOrder: 2,
        command: 'pwd',
        cwd: '/repo',
        output: '/repo\n',
        status: 'completed',
        exitCode: 0,
        turnId: 'turn-1',
      },
      {
        id: 'turn-1:live-final',
        kind: 'assistant',
        timestamp: 4000,
        sortOrder: 3,
        text: 'Done.',
        phase: 'final_answer',
        turnId: 'turn-1',
      },
    ];

    const overlaidHistory = timelineItemsWithRetainedLiveTurnOverlay(caughtUpHistory, retained);
    const visibleRetained = visibleRetainedLiveTurnItemsForTimeline(overlaidHistory, [], retained);
    const merged = reconcileTimelineItemsByArrival([], [...overlaidHistory, ...visibleRetained]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'first question',
      'turn-1:cmd-1',
      'Done.',
      'next question',
    ]);
  });

  it('keeps retained activity ordered for turn ids that contain colons', () => {
    const turnId = 'turn:1';
    const history: TimelineItem[] = [
      { id: `${turnId}:u1`, kind: 'user', timestamp: 1000, text: 'first question', turnId },
      { id: `${turnId}:final`, kind: 'assistant', timestamp: 1000, text: 'Done.', phase: 'final_answer', turnId },
      { id: 'turn-2:u1', kind: 'user', timestamp: 2500, text: 'next question', turnId: 'turn-2' },
    ];
    const retained = liveTurnItemsFromNotifications(
      [
        withTimelineNotificationMeta(
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId,
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
          { order: 1, receivedAt: 3000, streamId: 'stream-1', seq: 1 },
        ),
        withTimelineNotificationMeta(
          { method: 'event_msg', params: { type: 'agent_message', message: 'Done.', phase: 'final_answer', turn_id: turnId } },
          { order: 2, receivedAt: 4000, streamId: 'stream-1', seq: 2 },
        ),
      ],
      { activeThreadId: 'thread-1', activeTurnId: turnId },
      false,
      1000,
    );

    const overlaidHistory = timelineItemsWithRetainedLiveTurnOverlay(history, retained);
    const visibleRetained = visibleRetainedLiveTurnItemsForTimeline(overlaidHistory, [], retained);
    const merged = reconcileTimelineItemsByArrival([], [...overlaidHistory, ...visibleRetained]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'first question',
      `${turnId}:cmd-1`,
      'Done.',
      'next question',
    ]);
  });

  it('keeps a retained file summary at the turn tail without moving native messages', () => {
    const history: TimelineItem[] = [
      { id: 'turn-1:u1', kind: 'user', timestamp: 1000, text: 'question', turnId: 'turn-1' },
      { id: 'turn-1:final', kind: 'assistant', timestamp: 1000, text: 'Done.', phase: 'final_answer', turnId: 'turn-1' },
    ];
    const retainedSummary: Extract<TimelineItem, { kind: 'fileChangeSummary' }> = {
      id: 'turn-1:file-summary',
      kind: 'fileChangeSummary',
      timestamp: 4000,
      turnId: 'turn-1',
      files: [{ path: '/repo/a.txt', changeCount: 1 }],
    };

    const merged = reconcileTimelineItemsByArrival([], [...history, retainedSummary]);

    expect(merged.map((item) => (item.kind === 'assistant' || item.kind === 'user' ? item.text : item.id))).toEqual([
      'question',
      'Done.',
      'turn-1:file-summary',
    ]);
  });

  it('removes retained partial streaming once final history catches up with a different source id', () => {
    const retained: TimelineItem[] = [
      {
        id: 'turn-1:delta-transport',
        kind: 'streaming',
        timestamp: 1000,
        text: 'I found the issue',
        active: false,
        turnId: 'turn-1',
        sourceId: 'delta-transport',
      },
    ];
    const caughtUpHistory: TimelineItem[] = [
      {
        id: 'turn-1:final-item',
        kind: 'assistant',
        timestamp: 2000,
        text: 'I found the issue and fixed it.',
        phase: 'final_answer',
        turnId: 'turn-1',
        sourceId: 'final-item',
      },
    ];

    expect(visibleRetainedLiveTurnItemsForTimeline(caughtUpHistory, [], retained)).toEqual([]);
    expect(mergeRetainedLiveTurnItems(caughtUpHistory, retained, [])).toEqual([]);
  });

  it('retains old live items when active turn transitions directly to a pending start', () => {
    const previousLiveItems = liveTurnItemsFromNotifications(
      [
        { method: 'event_msg', params: { type: 'agent_message', message: 'Previous answer.', phase: 'final_answer', turn_id: 'turn-1' } },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      1000,
    );
    const staleHistory: TimelineItem[] = [
      { id: 'turn-0:a1', kind: 'assistant', timestamp: 500, text: 'Older persisted answer.', phase: null, turnId: 'turn-0' },
    ];

    const retained = mergeRetainedLiveTurnItems(staleHistory, [], previousLiveItems);
    const pendingWindow = nextLiveNotificationWindow(
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1', startCount: 5 },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
      8,
    );

    expect(pendingWindow).toEqual({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1', startCount: 8 });
    expect(visibleRetainedLiveTurnItemsForTimeline(staleHistory, [], retained)).toEqual(retained);
  });

  it('does not hide retained live output because a new live turn reuses a synthetic id and text', () => {
    const retained: TimelineItem[] = [
      {
        id: 'live:streaming:unscoped:1',
        kind: 'streaming',
        timestamp: 1,
        text: 'same partial',
        active: false,
        turnId: 'turn-1',
      },
    ];
    const newLive: TimelineItem[] = [
      {
        id: 'live:streaming:unscoped:1',
        kind: 'streaming',
        timestamp: 2,
        text: 'same partial',
        active: true,
        turnId: 'turn-2',
      },
    ];

    expect(visibleRetainedLiveTurnItemsForTimeline([], newLive, retained)).toEqual(retained);
  });

  it('hides retained live output while the same live item is still current for the same turn', () => {
    const retained: TimelineItem[] = [
      {
        id: 'live:streaming:turn-1:1',
        kind: 'streaming',
        timestamp: 1,
        text: 'same partial',
        active: false,
        turnId: 'turn-1',
      },
    ];
    const currentLive: TimelineItem[] = [
      {
        id: 'live:streaming:turn-1:1',
        kind: 'streaming',
        timestamp: 2,
        text: 'same partial',
        active: true,
        turnId: 'turn-1',
      },
    ];

    expect(visibleRetainedLiveTurnItemsForTimeline([], currentLive, retained)).toEqual([]);
  });

  it('keeps a claimed queued prompt visible until persisted history confirms it', () => {
    const previousQueue = [{ id: 'queued-1', text: 'queued prompt', createdAt: 1000 }];
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      previousQueue,
      [],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
      () => 10,
      1000,
    );

    expect(claimed).toEqual([
      {
        id: 'claimed-queued:user:queued-1',
        kind: 'user',
        timestamp: 1000,
        sortOrder: 10,
        text: 'queued prompt',
        turnId: 'turn-start-pending:thread-1',
      },
    ]);
    expect(pendingUserItemsWithoutHistory([], claimed)).toEqual(claimed);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-2:u1', kind: 'user', timestamp: 0, text: 'queued prompt', turnId: 'turn-2' }],
        claimed,
      ),
    ).toEqual(claimed);
    const retargeted = retargetSyntheticUserItemsToTurn(claimed, 'turn-2');
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-2:u1', kind: 'user', timestamp: 0, text: 'queued prompt', turnId: 'turn-2' }],
        retargeted,
      ),
    ).toEqual([]);
  });

  it('does not confirm a claimed queued prompt from an earlier identical user message', () => {
    const claimed: Extract<TimelineItem, { kind: 'user' }>[] = [
      { id: 'claimed-queued:user:queued-1', kind: 'user', timestamp: 1000, sortOrder: 10, text: 'same', turnId: 'turn-new' },
    ];

    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-old:u1', kind: 'user', timestamp: 2000, text: 'same', turnId: 'turn-old' }],
        claimed,
      ),
    ).toEqual(claimed);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-new:u1', kind: 'user', timestamp: 0, text: 'same', turnId: 'turn-new' }],
        claimed,
      ),
    ).toEqual([]);
  });

  it('confirms a steered queued prompt from finalized history for the same turn even when history uses the turn start timestamp', () => {
    const claimed: Extract<TimelineItem, { kind: 'user' }>[] = [
      { id: 'claimed-queued:user:queued-1', kind: 'user', timestamp: 2000, sortOrder: 10, text: 'same turn', turnId: 'turn-1' },
    ];

    expect(
      claimedQueuedUserItemsWithoutHistory([{ id: 'turn-1:u1', kind: 'user', timestamp: 1000, text: 'same turn', turnId: 'turn-1' }], claimed),
    ).toEqual([]);
    expect(
      claimedQueuedUserItemsWithoutHistory([{ id: 'turn-2:u1', kind: 'user', timestamp: 1000, text: 'same turn', turnId: 'turn-2' }], claimed),
    ).toEqual(claimed);
  });

  it('does not confirm a queued-turn claim with a synthetic pending turn id from unrelated finalized history', () => {
    const claimed: Extract<TimelineItem, { kind: 'user' }>[] = [
      {
        id: 'claimed-queued:user:queued-1',
        kind: 'user',
        timestamp: 2000,
        sortOrder: 10,
        text: 'started from queue',
        turnId: 'turn-start-pending:thread-1',
      },
    ];

    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-real:u1', kind: 'user', timestamp: 1000, text: 'started from queue', turnId: 'turn-real' }],
        claimed,
      ),
    ).toEqual(claimed);
    expect(
      claimedQueuedUserItemsWithoutHistory([{ id: 'turn-old:u1', kind: 'user', timestamp: 1000, text: 'started from queue', turnId: 'turn-old' }], claimed),
    ).toEqual(claimed);
  });

  it('retargets synthetic queued claims to the real active turn before history cleanup', () => {
    const claimed: Extract<TimelineItem, { kind: 'user' }>[] = [
      {
        id: 'claimed-queued:user:queued-1',
        kind: 'user',
        timestamp: 2000,
        sortOrder: 10,
        text: 'started from queue',
        turnId: 'turn-start-pending:thread-1',
      },
    ];

    const retargeted = retargetSyntheticUserItemsToTurn(claimed, 'turn-real');

    expect(retargeted).toEqual([{ ...claimed[0], turnId: 'turn-real', historyMatchOffset: 0 }]);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-real:u1', kind: 'user', timestamp: 1000, text: 'started from queue', turnId: 'turn-real' }],
        retargeted,
      ),
    ).toEqual([]);
  });

  it('claims a timed-out queued prompt when a late real turn starts from idle', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [{ id: 'queued-1', text: 'late prompt', createdAt: 1000 }],
      [],
      { activeThreadId: 'thread-1', activeTurnId: null },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-late' },
      () => 10,
      1000,
    );

    expect(claimed).toEqual([
      { id: 'claimed-queued:user:queued-1', kind: 'user', timestamp: 1000, sortOrder: 10, text: 'late prompt', turnId: 'turn-late' },
    ]);
  });

  it('uses strict history confirmation for newly claimed queued prompts', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [{ id: 'queued-1', text: 'same', createdAt: 1000 }],
      [],
      { activeThreadId: 'thread-1', activeTurnId: null },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-late' },
      () => 10,
      1000,
    );

    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-old:u1', kind: 'user', timestamp: 2000, text: 'same', turnId: 'turn-old' }],
        claimed,
      ),
    ).toEqual(claimed);
    expect(
      claimedQueuedUserItemsWithoutHistory(
        [{ id: 'turn-late:u1', kind: 'user', timestamp: 0, text: 'same', turnId: 'turn-late' }],
        claimed,
      ),
    ).toEqual([]);
  });

  it('claims only the first removed queued head on an active-turn transition', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'first', createdAt: 1000 },
        { id: 'queued-2', text: 'second', createdAt: 1001 },
      ],
      [],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
      () => 10,
      1000,
    );

    expect(claimed).toEqual([
      {
        id: 'claimed-queued:user:queued-1',
        kind: 'user',
        timestamp: 1000,
        sortOrder: 10,
        text: 'first',
        turnId: 'turn-start-pending:thread-1',
      },
    ]);
  });

  it('skips ignored removed heads before claiming one sent prompt on an active-turn transition', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'edited locally', createdAt: 1000 },
        { id: 'queued-2', text: 'started next turn', createdAt: 1001 },
      ],
      [],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-2' },
      () => 10,
      1001,
      { ignoredRemovedMessageIds: new Set(['queued-1']) },
    );

    expect(claimed).toEqual([
      { id: 'claimed-queued:user:queued-2', kind: 'user', timestamp: 1001, sortOrder: 10, text: 'started next turn', turnId: 'turn-2' },
    ]);
  });

  it('claims a removed queued head while the active turn stays the same for turn steering', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'steered', createdAt: 1000 },
        { id: 'queued-2', text: 'still queued', createdAt: 1001 },
      ],
      [{ id: 'queued-2', text: 'still queued', createdAt: 1001 }],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      () => 10,
      1000,
    );

    expect(claimed).toEqual([
      { id: 'claimed-queued:user:queued-1', kind: 'user', timestamp: 1000, sortOrder: 10, text: 'steered', turnId: 'turn-1' },
    ]);
  });

  it('uses claim-time ordering when a mid-turn queued prompt becomes visible', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [{ id: 'q1', text: 'sent during turn', createdAt: 1000 }],
      [],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      () => 10,
      2000,
    );
    const existing: TimelineItem = {
      id: 'already-visible',
      kind: 'assistant',
      timestamp: 1500,
      text: 'Already visible',
      phase: 'commentary',
      turnId: 'turn-1',
    };

    expect(reconcileTimelineItemsByArrival([], [existing, ...claimed]).map((item) => item.id)).toEqual([
      'already-visible',
      'claimed-queued:user:q1',
    ]);
  });

  it('claims multiple removed queued heads while the active turn stays the same for turn steering', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'first steered', createdAt: 1000 },
        { id: 'queued-2', text: 'second steered', createdAt: 1001 },
        { id: 'queued-3', text: 'still queued', createdAt: 1002 },
      ],
      [{ id: 'queued-3', text: 'still queued', createdAt: 1002 }],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      (id) => id.length,
      2000,
    );

    expect(claimed).toEqual([
      {
        id: 'claimed-queued:user:queued-1',
        kind: 'user',
        timestamp: 2000,
        sortOrder: 'claimed-queued:user:queued-1'.length,
        text: 'first steered',
        turnId: 'turn-1',
      },
      {
        id: 'claimed-queued:user:queued-2',
        kind: 'user',
        timestamp: 2000,
        sortOrder: 'claimed-queued:user:queued-2'.length,
        text: 'second steered',
        turnId: 'turn-1',
      },
    ]);
  });

  it('does not claim edited or canceled queued heads while claiming later steered heads', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'edited locally', createdAt: 1000 },
        { id: 'queued-2', text: 'sent by steer', createdAt: 1001 },
      ],
      [],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      () => 10,
      1001,
      { ignoredRemovedMessageIds: new Set(['queued-1']) },
    );

    expect(claimed).toEqual([
      { id: 'claimed-queued:user:queued-2', kind: 'user', timestamp: 1001, sortOrder: 10, text: 'sent by steer', turnId: 'turn-1' },
    ]);
  });

  it('does not claim removed queued prompts after the queue head remains visible', () => {
    expect(
      claimedQueuedUserItemsFromQueueTransition(
        [
          { id: 'queued-1', text: 'first', createdAt: 1000 },
          { id: 'queued-2', text: 'second', createdAt: 1001 },
        ],
        [{ id: 'queued-1', text: 'first', createdAt: 1000 }],
        { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
        { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
        () => 10,
        2000,
      ),
    ).toEqual([]);
  });

  it('claims a later removed queued prompt when a maybe-sent head remains visible', () => {
    const claimed = claimedQueuedUserItemsFromQueueTransition(
      [
        { id: 'queued-1', text: 'maybe sent', createdAt: 1000, deliveryState: 'maybeSent' },
        { id: 'queued-2', text: 'started next turn', createdAt: 1001 },
      ],
      [{ id: 'queued-1', text: 'maybe sent', createdAt: 1000, deliveryState: 'maybeSent' }],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
      () => 10,
      1001,
    );

    expect(claimed).toEqual([
      {
        id: 'claimed-queued:user:queued-2',
        kind: 'user',
        timestamp: 1001,
        sortOrder: 10,
        text: 'started next turn',
        turnId: 'turn-start-pending:thread-1',
      },
    ]);
  });

  it('caps retained claimed queued prompts after history cleanup', () => {
    const claimed = Array.from({ length: 55 }, (_, index): Extract<TimelineItem, { kind: 'user' }> => ({
      id: `claimed-queued:user:queued-${index + 1}`,
      kind: 'user',
      timestamp: index + 1,
      sortOrder: index + 1,
      text: `prompt ${index + 1}`,
    }));

    const visible = claimedQueuedUserItemsWithoutHistory([], claimed);

    expect(visible).toHaveLength(50);
    expect(visible[0].id).toBe('claimed-queued:user:queued-6');
    expect(visible.at(-1)?.id).toBe('claimed-queued:user:queued-55');
  });

  it('does not claim manually removed queued prompts without an active-turn transition', () => {
    expect(
      claimedQueuedUserItemsFromQueueTransition(
        [{ id: 'queued-1', text: 'queued prompt', createdAt: 1000 }],
        [],
        { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
        { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
        () => 10,
        1000,
        { ignoredRemovedMessageIds: new Set(['queued-1']) },
      ),
    ).toEqual([]);
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

  it('preserves pending submit notifications across a synthetic pending turn id', () => {
    const idleWindow = { activeThreadId: 'thread-1', activeTurnId: null, startCount: 10 };

    const pendingWindow = nextLiveNotificationWindow(
      idleWindow,
      { activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1' },
      12,
      { pendingStartCount: 10 },
    );
    expect(pendingWindow).toEqual({ activeThreadId: 'thread-1', activeTurnId: 'turn-start-pending:thread-1', startCount: 10 });

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

  it('treats thread compacted notifications as turn completion', () => {
    const notifications = [
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-compact', delta: 'Compacting' } },
      { method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'turn-compact' } },
    ];

    expect(latestCompletionNotificationCount(notifications, 12, { activeThreadId: 'thread-1', activeTurnId: 'turn-compact' })).toBe(12);
  });

  it('treats interrupted and failed notifications as terminal turn signals', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };

    expect(latestCompletionNotificationCount([{ method: 'turn/interrupted', params: { threadId: 'thread-1', turnId: 'turn-1' } }], 4, scope)).toBe(4);
    expect(latestCompletionNotificationCount([{ method: 'turn/failed', params: { threadId: 'thread-1', turnId: 'turn-1' } }], 5, scope)).toBe(5);
    expect(latestCompletionNotificationCount([{ method: 'event_msg', params: { type: 'task_interrupted', thread_id: 'thread-1', turn_id: 'turn-1' } }], 6, scope)).toBe(6);
    expect(latestCompletionNotificationCount([{ method: 'event_msg', params: { type: 'task_failed', thread_id: 'thread-1', turn_id: 'turn-1' } }], 7, scope)).toBe(7);
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

  it('incrementally reduces native live notifications without changing their ordered timeline', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const notifications = [
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'I will inspect ' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'the file.' } },
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
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a2', delta: 'Done.' } },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'a2', text: 'Done.', phase: 'final_answer' },
        },
      },
    ];

    let accumulator = createLiveTurnAccumulator();
    accumulator = appendLiveTurnNotifications(accumulator, notifications.slice(0, 2), scope, 100);
    accumulator = appendLiveTurnNotifications(accumulator, notifications.slice(2, 4), scope, 100);
    accumulator = appendLiveTurnNotifications(accumulator, notifications.slice(4), scope, 100);

    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual(
      liveTurnItemsFromNotifications(notifications, scope, true, 100),
    );
  });

  it('keeps compact live state while reducing a long assistant stream', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const notifications = Array.from({ length: 10_000 }, () => ({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'x' },
    }));

    const accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), notifications, scope, 100);
    const items = liveTurnItemsFromAccumulator(accumulator, true);

    expect(accumulator.items).toHaveLength(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'streaming', text: 'x'.repeat(10_000), active: true });
  });

  it('replaces a native in-progress activity in place when the item completes', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const started = withTimelineNotificationMeta(
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'cmd-1',
            command: 'npm test',
            cwd: '/repo',
            status: 'inProgress',
            aggregatedOutput: null,
            exitCode: null,
          },
        },
      },
      { order: 10, receivedAt: 1000, streamId: 'stream-1', seq: 10 },
    );
    const completed = withTimelineNotificationMeta(
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'cmd-1',
            command: 'npm test',
            cwd: '/repo',
            status: 'completed',
            aggregatedOutput: 'passed\n',
            exitCode: 0,
          },
        },
      },
      { order: 30, receivedAt: 3000, streamId: 'stream-1', seq: 30 },
    );

    let accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), [started], scope, 100);
    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual([
      expect.objectContaining({ kind: 'command', id: 'turn-1:cmd-1', status: 'inProgress', sortOrder: 10, timestamp: 1000 }),
    ]);

    accumulator = appendLiveTurnNotifications(accumulator, [completed], scope, 100);
    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual([
      expect.objectContaining({ kind: 'command', id: 'turn-1:cmd-1', status: 'completed', output: 'passed\n', sortOrder: 10, timestamp: 1000 }),
    ]);
  });

  it('keeps a finalized native message at its first-delta position across later activity', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const notifications = [
      withTimelineNotificationMeta(
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'I will inspect.' } },
        { order: 10, receivedAt: 1000, streamId: 'stream-1', seq: 10 },
      ),
      withTimelineNotificationMeta(
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
        { order: 20, receivedAt: 2000, streamId: 'stream-1', seq: 20 },
      ),
      withTimelineNotificationMeta(
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'a1', text: 'I will inspect.', phase: 'commentary' },
          },
        },
        { order: 30, receivedAt: 3000, streamId: 'stream-1', seq: 30 },
      ),
    ];

    const items = liveTurnItemsFromNotifications(notifications, scope, true, 100);

    expect(items.map((item) => item.kind)).toEqual(['assistant', 'command']);
    expect(items.map((item) => item.sortOrder)).toEqual([10, 20]);
    expect(reconcileTimelineItemsByArrival([], items).map((item) => item.kind)).toEqual(['assistant', 'command']);
  });

  it('does not leave an empty file-change start card when completion expands into edit cards', () => {
    const items = liveTurnItemsFromNotifications(
      [
        {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'fileChange', id: 'edit-1', changes: [], status: 'inProgress' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'fileChange',
              id: 'edit-1',
              changes: [{ path: '/repo/a.txt' }, { path: '/repo/b.txt' }],
              status: 'completed',
            },
          },
        },
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      100,
    );

    expect(items.map((item) => item.id)).toEqual(['turn-1:edit-1:edit:0', 'turn-1:edit-1:edit:1']);
  });

  it('does not retain high-volume native command output deltas', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const started = {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'yes',
          cwd: '/repo',
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
        },
      },
    };
    const output = Array.from({ length: 10_000 }, () => ({
      method: 'item/commandExecution/outputDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', delta: 'y\n' },
    }));

    const accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), [started, ...output], scope, 100);

    expect(accumulator.items).toHaveLength(1);
    expect(liveTurnItemsFromAccumulator(accumulator, true)[0]).toMatchObject({ kind: 'command', id: 'turn-1:cmd-1', status: 'inProgress' });
  });

  it('retains scoped native warnings in live event order', () => {
    const notification = withTimelineNotificationMeta(
      { method: 'warning', params: { threadId: 'thread-1', message: 'Retrying the request.' } },
      { order: 12, receivedAt: 1200, streamId: 'stream-1', seq: 12 },
    );
    const accumulator = appendLiveTurnNotifications(
      createLiveTurnAccumulator(),
      [notification],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      100,
    );

    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual([
      expect.objectContaining({ kind: 'warning', text: 'Retrying the request.', sortOrder: 12, timestamp: 1200 }),
    ]);
  });

  it('shows model safety buffering and records when the check completes', () => {
    const scope = { activeThreadId: 'thread-1', activeTurnId: 'turn-1' };
    const buffering = withTimelineNotificationMeta(
      {
        method: 'model/safetyBuffering/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          model: 'gpt-5.6-sol',
          useCases: ['cyber'],
          reasons: ['additional_check'],
          showBufferingUi: true,
          fasterModel: 'gpt-5.6-luna',
        },
      },
      { order: 13, receivedAt: 1300, streamId: 'stream-1', seq: 13 },
    );
    const completed = withTimelineNotificationMeta(
      {
        method: 'model/safetyBuffering/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          model: 'gpt-5.6-sol',
          useCases: ['cyber'],
          reasons: [],
          showBufferingUi: false,
          fasterModel: 'gpt-5.6-luna',
        },
      },
      { order: 14, receivedAt: 1400, streamId: 'stream-1', seq: 14 },
    );

    let accumulator = appendLiveTurnNotifications(createLiveTurnAccumulator(), [buffering], scope, 100);
    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual([
      expect.objectContaining({
        id: 'live:model-safety-buffering:turn-1',
        kind: 'warning',
        text: expect.stringContaining('gpt-5.6-luna'),
        sortOrder: 13,
        timestamp: 1300,
      }),
    ]);

    accumulator = appendLiveTurnNotifications(accumulator, [completed], scope, 100);
    expect(liveTurnItemsFromAccumulator(accumulator, true)).toEqual([
      expect.objectContaining({
        id: 'live:model-safety-buffering:turn-1',
        kind: 'notice',
        text: expect.stringContaining('completed'),
        sortOrder: 13,
        timestamp: 1300,
      }),
    ]);

    const falseOnly = appendLiveTurnNotifications(createLiveTurnAccumulator(), [completed], scope, 100);
    expect(liveTurnItemsFromAccumulator(falseOnly, true)).toEqual([]);
  });

  it('uses notification metadata timestamps for live turn item ordering', () => {
    const items = liveTurnItemsFromNotifications(
      [
        withTimelineNotificationMeta(
          { method: 'event_msg', params: { type: 'agent_message', message: 'First', phase: 'commentary', turn_id: 'turn-1' } },
          { order: 1, receivedAt: 1000, streamId: 'stream-1', seq: 1 },
        ),
        withTimelineNotificationMeta(
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
          { order: 2, receivedAt: 2000, streamId: 'stream-1', seq: 2 },
        ),
      ],
      { activeThreadId: 'thread-1', activeTurnId: 'turn-1' },
      true,
      9999,
    );

    expect(items.map((item) => item.timestamp)).toEqual([1000, 2000]);
    expect(items.map((item) => item.sortOrder)).toEqual([1, 2]);
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
    const merged = reconcileTimelineItemsByArrival([], [...overlaidHistory, ...visibleLiveItems]);

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
    expect(
      notificationIsTurnComplete(
        { method: 'event_msg', params: { type: 'task_interrupted', turn_id: 'turn-active' } },
        { activeThreadId: 'thread-active', activeTurnId: 'turn-active' },
      ),
    ).toBe(true);
    expect(
      notificationIsTurnComplete(
        { method: 'turn/failed', params: { turnId: 'turn-active' } },
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
