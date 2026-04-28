import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPathInsideRoot, resolveExistingPathInsideRoot, resolveWritablePathInsideRoot } from '../../server/fileTransfer.js';

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
});
