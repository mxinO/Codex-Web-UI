import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPathInsideRoot,
  readOpenedFileFully,
  resolveExistingPathInsideRoot,
  resolveWritablePathInsideRoot,
  writeFileInsideRoot,
} from '../../server/fileTransfer.js';

describe('assertPathInsideRoot', () => {
  it('allows a root-relative child path', () => {
    expect(assertPathInsideRoot('/tmp/workspace', 'src/App.tsx')).toBe('/tmp/workspace/src/App.tsx');
  });

  it('allows an absolute child path inside the root', () => {
    expect(assertPathInsideRoot('/tmp/workspace', '/tmp/workspace/src/App.tsx')).toBe('/tmp/workspace/src/App.tsx');
  });

  it('rejects traversal outside the root', () => {
    expect(() => assertPathInsideRoot('/tmp/workspace', '../outside.txt')).toThrow('path is outside active workspace');
  });

  it('rejects sibling-prefix paths outside the root', () => {
    expect(() => assertPathInsideRoot('/tmp/root', '/tmp/root-other/file.txt')).toThrow('path is outside active workspace');
  });
});

describe('symlink-aware file transfer path helpers', () => {
  function makeDirs() {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-webui-transfer-'));
    const root = join(tmp, 'root');
    const outside = join(tmp, 'outside');
    mkdirSync(join(root, 'safe'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { tmp, root, outside };
  }

  it('rejects downloads through a symlinked directory outside the root', async () => {
    const { tmp, root, outside } = makeDirs();
    try {
      symlinkSync(outside, join(root, 'out'), 'dir');
      writeFileSync(join(outside, 'secret.txt'), 'secret');

      await expect(resolveExistingPathInsideRoot(root, 'out/secret.txt')).rejects.toThrow('path is outside active workspace');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects uploads into a symlinked directory outside the root', async () => {
    const { tmp, root, outside } = makeDirs();
    try {
      symlinkSync(outside, join(root, 'out'), 'dir');

      await expect(resolveWritablePathInsideRoot(root, 'out/new.txt')).rejects.toThrow('path is outside active workspace');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects uploads to an existing symlink outside the root', async () => {
    const { tmp, root, outside } = makeDirs();
    try {
      const outsideFile = join(outside, 'secret.txt');
      writeFileSync(outsideFile, 'secret');
      symlinkSync(outsideFile, join(root, 'link.txt'), 'file');

      await expect(resolveWritablePathInsideRoot(root, 'link.txt')).rejects.toThrow('path is outside active workspace');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves normal inside-root writable paths', async () => {
    const { tmp, root } = makeDirs();
    try {
      const resolved = await resolveWritablePathInsideRoot(root, 'safe/new.txt');

      expect(resolved).toBe(join(await realpath(root), 'safe/new.txt'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes regular files inside the root through a descriptor-validated handle', async () => {
    const { tmp, root } = makeDirs();
    try {
      await writeFileInsideRoot(root, 'safe/new.txt', Buffer.from('hello'));
      expect(readFileSync(join(root, 'safe', 'new.txt'), 'utf8')).toBe('hello');

      await writeFileInsideRoot(root, 'safe/new.txt', Buffer.from('updated'));
      expect(readFileSync(join(root, 'safe', 'new.txt'), 'utf8')).toBe('updated');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects descriptor-validated writes to symlinks outside the root without truncating the target', async () => {
    const { tmp, root, outside } = makeDirs();
    try {
      const outsideFile = join(outside, 'secret.txt');
      writeFileSync(outsideFile, 'secret');
      symlinkSync(outsideFile, join(root, 'safe', 'link.txt'), 'file');

      await expect(writeFileInsideRoot(root, 'safe/link.txt', Buffer.from('changed'))).rejects.toThrow('path is outside active workspace');
      expect(readFileSync(outsideFile, 'utf8')).toBe('secret');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects descriptor-validated writes to existing FIFOs', async () => {
    const { tmp, root } = makeDirs();
    try {
      execFileSync('mkfifo', [join(root, 'safe', 'pipe')]);

      await expect(writeFileInsideRoot(root, 'safe/pipe', Buffer.from('data'))).rejects.toThrow('path is not a file');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('readOpenedFileFully', () => {
  it('continues reading until the requested size is filled or EOF is reached', async () => {
    const source = Buffer.from('complete');
    const reads: Array<{ offset: number; length: number; position: number }> = [];
    const handle = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        reads.push({ offset, length, position });
        if (position >= source.length) return { bytesRead: 0, buffer };
        const bytesRead = Math.min(2, length, source.length - position);
        source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead, buffer };
      },
    };

    const data = await readOpenedFileFully(handle, source.length);

    expect(data.toString('utf8')).toBe('complete');
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.map((read) => read.position)).toEqual([0, 2, 4, 6]);
  });
});
