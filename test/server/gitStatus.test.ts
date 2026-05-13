import { describe, expect, it } from 'vitest';
import { parseGitStatusPorcelainV2 } from '../../server/gitStatus.js';

const OID = '0123456789abcdef0123456789abcdef01234567';

describe('parseGitStatusPorcelainV2', () => {
  it('parses branch headers and porcelain v2 entries', () => {
    const raw = [
      '# branch.oid abcdef0123456789abcdef0123456789abcdef01',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      `1 M. N... 100644 100644 100644 ${OID} ${OID} staged.txt`,
      `1 .M N... 100644 100644 100644 ${OID} ${OID} unstaged.txt`,
      `1 .D N... 100644 100644 000000 ${OID} ${OID} deleted.txt`,
      `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 renamed.txt`,
      'old-name.txt',
      'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict.txt',
      '? notes.md',
      '? scratch/',
      '! ignored.log',
      '',
    ].join('\0');

    const result = parseGitStatusPorcelainV2(raw);

    expect(result).toMatchObject({
      branch: 'main',
      headOid: 'abcdef0123456789abcdef0123456789abcdef01',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      truncated: false,
    });
    expect(result.entries).toEqual([
      {
        path: 'staged.txt',
        indexStatus: 'M',
        worktreeStatus: '.',
        kind: 'staged',
        submodule: 'N...',
      },
      {
        path: 'unstaged.txt',
        indexStatus: '.',
        worktreeStatus: 'M',
        kind: 'unstaged',
        submodule: 'N...',
      },
      {
        path: 'deleted.txt',
        indexStatus: '.',
        worktreeStatus: 'D',
        kind: 'unstaged',
        submodule: 'N...',
      },
      {
        path: 'renamed.txt',
        originalPath: 'old-name.txt',
        indexStatus: 'R',
        worktreeStatus: '.',
        kind: 'staged',
        submodule: 'N...',
      },
      {
        path: 'conflict.txt',
        indexStatus: 'U',
        worktreeStatus: 'U',
        kind: 'conflict',
        submodule: 'N...',
      },
      {
        path: 'notes.md',
        indexStatus: '?',
        worktreeStatus: '?',
        kind: 'untracked',
      },
      {
        path: 'scratch/',
        indexStatus: '?',
        worktreeStatus: '?',
        kind: 'untracked',
        isDirectory: true,
      },
      {
        path: 'ignored.log',
        indexStatus: '!',
        worktreeStatus: '!',
        kind: 'ignored',
      },
    ]);
  });

  it('marks detached heads and capped entries', () => {
    const raw = ['# branch.oid (initial)', '# branch.head (detached)', '? a.txt', '? b.txt', '? c.txt', ''].join('\0');

    const result = parseGitStatusPorcelainV2(raw, { entryLimit: 2 });

    expect(result.branch).toBeNull();
    expect(result.headOid).toBeNull();
    expect(result.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(result.truncated).toBe(true);
  });

  it('treats space status as unchanged', () => {
    const raw = [`1  M N... 100644 100644 100644 ${OID} ${OID} worktree-only.txt`, ''].join('\0');

    const result = parseGitStatusPorcelainV2(raw);

    expect(result.entries).toEqual([
      {
        path: 'worktree-only.txt',
        indexStatus: ' ',
        worktreeStatus: 'M',
        kind: 'unstaged',
        submodule: 'N...',
      },
    ]);
  });
});
