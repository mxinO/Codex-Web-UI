import { describe, expect, it } from 'vitest';
import { turnToTimelineItems, trimTimelineWindow } from '../../src/lib/timeline';
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
});
