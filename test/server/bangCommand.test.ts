import { describe, expect, it } from 'vitest';
import { buildBangCommandParams, isInteractiveCommandBlocked } from '../../server/bangCommand.js';

describe('bang command helpers', () => {
  it('builds bounded non-streaming bash exec params', () => {
    expect(buildBangCommandParams('echo hi', '/tmp', 1000, 4096)).toEqual({
      command: ['bash', '-lc', 'echo hi'],
      cwd: '/tmp',
      timeoutMs: 1000,
      outputBytesCap: 4096,
      tty: false,
      streamStdoutStderr: false,
      streamStdin: false,
    });
  });

  it('blocks obvious interactive commands', () => {
    expect(isInteractiveCommandBlocked('vim file.txt')).toBe(true);
    expect(isInteractiveCommandBlocked('echo ok')).toBe(false);
  });
});
