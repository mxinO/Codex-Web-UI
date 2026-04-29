import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileEditStore } from '../../server/fileEditStore.js';

describe('FileEditStore', () => {
  it('persists first snapshots and final per-file turn diffs by turn and path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-webui-file-edit-store-'));
    try {
      const dbPath = join(dir, 'rollout.webui.db');
      const store = new FileEditStore(dbPath);

      store.recordSnapshot({
        turnId: 'turn-1',
        itemId: 'edit-1',
        path: '/repo/a.txt',
        before: 'first before\n',
        createdAtMs: 1000,
      });
      store.recordSnapshot({
        turnId: 'turn-1',
        itemId: 'edit-2',
        path: '/repo/a.txt',
        before: 'middle before must not win\n',
        createdAtMs: 2000,
      });
      store.finalizeFile({
        turnId: 'turn-1',
        path: '/repo/a.txt',
        after: 'preview after must not win\n',
        updatedAtMs: 2500,
      });
      store.finalizeFile({
        turnId: 'turn-1',
        path: '/repo/a.txt',
        after: 'final after\n',
        updatedAtMs: 3000,
      });
      store.recordSnapshot({
        turnId: 'turn-2',
        itemId: 'edit-3',
        path: '/repo/a.txt',
        before: 'next turn before\n',
        createdAtMs: 4000,
      });
      store.finalizeFile({
        turnId: 'turn-2',
        path: '/repo/a.txt',
        after: 'next turn after\n',
        updatedAtMs: 5000,
      });
      store.close();

      const reopened = new FileEditStore(dbPath);
      expect(reopened.getDiff('turn-1', '/repo/a.txt')).toMatchObject({
        path: '/repo/a.txt',
        before: 'first before\n',
        after: 'final after\n',
        editCount: 2,
      });
      expect(reopened.getDiff('turn-2', '/repo/a.txt')).toMatchObject({
        path: '/repo/a.txt',
        before: 'next turn before\n',
        after: 'next turn after\n',
        editCount: 1,
      });
      expect(reopened.listTurnFiles('turn-1')).toEqual([
        {
          turnId: 'turn-1',
          path: '/repo/a.txt',
          editCount: 2,
          hasDiff: true,
          updatedAtMs: 3000,
        },
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
