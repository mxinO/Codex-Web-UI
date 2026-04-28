import { describe, expect, it } from 'vitest';
import { bangOutputEventToTimelineItem, parseBangCommand } from '../../src/lib/bangCommands';

describe('bang commands', () => {
  it('parses bang command input', () => {
    expect(parseBangCommand('!git status')).toEqual({ command: 'git status' });
  });

  it('ignores normal chat input', () => {
    expect(parseBangCommand('git status')).toBeNull();
  });

  it('ignores empty bang input', () => {
    expect(parseBangCommand('!   ')).toBeNull();
  });

  it('builds user-side bang timeline items with submit-time cwd', () => {
    const item = bangOutputEventToTimelineItem(
      { command: 'pwd', cwd: '/submitted/cwd', threadId: 'thread-1', result: { exitCode: 0, stdout: '/submitted/cwd\n', stderr: '' } },
      'thread-1',
      10,
      1,
    );

    expect(item).toMatchObject({
      id: 'bang:10:1',
      kind: 'bangCommand',
      timestamp: 10,
      command: 'pwd',
      cwd: '/submitted/cwd',
      output: '/submitted/cwd\n',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('ignores stale thread bang output', () => {
    expect(
      bangOutputEventToTimelineItem({ command: 'pwd', cwd: '/old/cwd', threadId: 'thread-old', result: { exitCode: 0, stdout: 'old\n' } }, 'thread-new', 10, 1),
    ).toBeNull();
  });
});
