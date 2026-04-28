import { describe, expect, it } from 'vitest';
import { isInteractiveCommandBlocked, runBangCommand } from '../../server/bangCommand.js';

describe('bang command helpers', () => {
  it('runs local bash commands with bounded output', async () => {
    const result = await runBangCommand('printf abcdef', process.cwd(), 1000, 3);

    expect(result).toMatchObject({
      stdout: 'abc',
      stderr: '',
      exitCode: 0,
      killed: false,
      cwd: process.cwd(),
      outputTruncated: true,
    });
  });

  it('blocks obvious interactive commands', () => {
    expect(isInteractiveCommandBlocked('vim file.txt')).toBe(true);
    expect(isInteractiveCommandBlocked('echo ok')).toBe(false);
  });
});
