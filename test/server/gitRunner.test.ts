import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_GIT_QUEUE_DEPTH, runGit } from '../../server/gitRunner.js';

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeFakeGit(scriptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-webui-fake-git-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gitPath = join(bin, 'git');
  writeFileSync(gitPath, `#!/usr/bin/env node\n${scriptBody}\n`);
  chmodSync(gitPath, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return dir;
}

describe('runGit', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('spawns git without a shell and sets GIT_OPTIONAL_LOCKS for read-only calls', async () => {
    makeFakeGit(`
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    optionalLocks: process.env.GIT_OPTIONAL_LOCKS,
    stdin: Buffer.concat(chunks).toString('utf8')
  }));
});
`);

    const result = await runGit({
      args: ['arg with spaces', 'semi;colon'],
      stdin: 'hello from stdin',
      timeoutMs: 1_000,
      outputLimitBytes: 10_000,
      readOnly: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['arg with spaces', 'semi;colon'],
      optionalLocks: '0',
      stdin: 'hello from stdin',
    });
  });

  it('caps stdout and stderr independently without throwing on non-zero exit', async () => {
    makeFakeGit(`
process.stdout.write('a'.repeat(32));
process.stderr.write('b'.repeat(32));
process.exit(7);
`);

    const result = await runGit({
      args: ['status'],
      timeoutMs: 1_000,
      outputLimitBytes: 8,
    });

    expect(result).toMatchObject({
      stdout: 'aaaaaaaa',
      stderr: 'bbbbbbbb',
      exitCode: 7,
      timedOut: false,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it('kills commands that exceed the timeout', async () => {
    makeFakeGit(`
setInterval(() => {
  process.stdout.write('still running\\n');
}, 50);
`);

    const result = await runGit({
      args: ['status'],
      timeoutMs: 60,
      outputLimitBytes: 1_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('rejects quickly when the git queue is full', async () => {
    makeFakeGit(`
setInterval(() => {}, 1000);
`);

    const jobs = Array.from({ length: MAX_GIT_QUEUE_DEPTH + 1 }, () =>
      runGit({
        args: ['status'],
        timeoutMs: 30,
        outputLimitBytes: 100,
      }),
    );

    await expect(jobs[jobs.length - 1]).rejects.toThrow('too many git jobs queued');
    await Promise.allSettled(jobs);
  });
});
