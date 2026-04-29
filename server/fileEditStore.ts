import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface FileEditSnapshotInput {
  turnId: string;
  itemId?: string | null;
  path: string;
  before: string;
  createdAtMs?: number;
}

export interface FileEditPatchSnapshotInput extends FileEditSnapshotInput {
  source?: string;
  replaceBefore?: boolean;
}

export interface FileEditFinalizeInput {
  turnId: string;
  path: string;
  after: string;
  updatedAtMs?: number;
}

export interface FileEditPathInput {
  turnId: string;
  path: string;
}

export interface StoredFileDiff {
  turnId: string;
  path: string;
  before: string;
  after: string;
  editCount: number;
  updatedAtMs: number;
}

export interface TurnFileSummary {
  turnId: string;
  path: string;
  editCount: number;
  hasDiff: boolean;
  updatedAtMs: number;
}

interface FileEditStoreOptions {
  readonly?: boolean;
}

interface DiffRow {
  turn_id: string;
  path: string;
  before_text: string | null;
  after_text: string | null;
  source: string;
  edit_count: number;
  updated_at_ms: number | null;
}

function pathHash(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex');
}

function nowMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

export function sessionFileEditDbPath(threadPath: string): string {
  const parsed = path.parse(threadPath);
  const basename = parsed.ext === '.jsonl' ? parsed.name : parsed.base;
  return path.join(parsed.dir, `${basename}.webui.db`);
}

export class FileEditStore {
  private readonly db: Database.Database;

  constructor(dbPath: string, options: FileEditStoreOptions = {}) {
    if (!options.readonly) mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { readonly: Boolean(options.readonly), fileMustExist: Boolean(options.readonly) });
    if (!options.readonly) {
      this.db.pragma('journal_mode = DELETE');
      this.db.pragma('synchronous = NORMAL');
      this.migrate();
    }
  }

  recordSnapshot(input: FileEditSnapshotInput): void {
    const createdAtMs = nowMs(input.createdAtMs);
    const hash = pathHash(input.path);
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO file_edit_events
            (turn_id, item_id, path_hash, path, before_text, after_text, source, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, NULL, 'snapshot', ?, ?)`,
        )
        .run(input.turnId, input.itemId ?? null, hash, input.path, input.before, createdAtMs, createdAtMs);

      this.db
        .prepare(
          `INSERT INTO turn_file_diffs
            (turn_id, path_hash, path, before_text, after_text, source, edit_count, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, NULL, 'snapshot', 1, ?, ?)
           ON CONFLICT(turn_id, path_hash) DO UPDATE SET
             path = excluded.path,
             edit_count = turn_file_diffs.edit_count + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(input.turnId, hash, input.path, input.before, createdAtMs, createdAtMs);
    });
    insert();
  }

  recordPatchSnapshot(input: FileEditPatchSnapshotInput): void {
    const createdAtMs = nowMs(input.createdAtMs);
    const hash = pathHash(input.path);
    const source = input.source ?? 'patch';
    const replaceBefore = input.replaceBefore ? 1 : 0;
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO file_edit_events
            (turn_id, item_id, path_hash, path, before_text, after_text, source, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(input.turnId, input.itemId ?? null, hash, input.path, input.before, source, createdAtMs, createdAtMs);

      this.db
        .prepare(
          `INSERT INTO turn_file_diffs
            (turn_id, path_hash, path, before_text, after_text, source, edit_count, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)
           ON CONFLICT(turn_id, path_hash) DO UPDATE SET
             path = excluded.path,
             before_text = CASE
               WHEN ? = 1 THEN excluded.before_text
               ELSE COALESCE(turn_file_diffs.before_text, excluded.before_text)
             END,
             source = CASE
               WHEN ? = 1 OR turn_file_diffs.before_text IS NULL THEN excluded.source
               ELSE turn_file_diffs.source
             END,
             edit_count = turn_file_diffs.edit_count + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(input.turnId, hash, input.path, input.before, source, createdAtMs, createdAtMs, replaceBefore, replaceBefore);
    });
    insert();
  }

  discardPatchDiff(input: FileEditPathInput): void {
    const hash = pathHash(input.path);
    const discard = this.db.transaction(() => {
      const fallback = this.db
        .prepare(
          `SELECT path, before_text, source
           FROM file_edit_events
           WHERE turn_id = ? AND path_hash = ? AND source != 'patch'
           ORDER BY id ASC
           LIMIT 1`,
        )
        .get(input.turnId, hash) as Pick<DiffRow, 'path' | 'before_text' | 'source'> | undefined;

      if (fallback) {
        this.db
          .prepare(
            `UPDATE turn_file_diffs
             SET path = ?, before_text = ?, source = ?, updated_at_ms = ?
             WHERE turn_id = ? AND path_hash = ?`,
          )
          .run(fallback.path, fallback.before_text ?? '', fallback.source, Date.now(), input.turnId, hash);
        return;
      }

      this.db
        .prepare(
          `DELETE FROM turn_file_diffs
           WHERE turn_id = ? AND path_hash = ? AND source = 'patch'`,
        )
        .run(input.turnId, hash);
    });
    discard();
  }

  finalizeFile(input: FileEditFinalizeInput): void {
    const updatedAtMs = nowMs(input.updatedAtMs);
    const hash = pathHash(input.path);
    const finalize = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO turn_file_diffs
            (turn_id, path_hash, path, before_text, after_text, source, edit_count, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, '', ?, 'current', 0, ?, ?)
           ON CONFLICT(turn_id, path_hash) DO UPDATE SET
             path = excluded.path,
             after_text = excluded.after_text,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(input.turnId, hash, input.path, input.after, updatedAtMs, updatedAtMs);

      this.db
        .prepare(
          `UPDATE file_edit_events
           SET after_text = ?, updated_at_ms = ?
           WHERE id = (
             SELECT id FROM file_edit_events
             WHERE turn_id = ? AND path_hash = ?
             ORDER BY id DESC
             LIMIT 1
           )`,
        )
        .run(input.after, updatedAtMs, input.turnId, hash);
    });
    finalize();
  }

  getDiff(turnId: string, filePath: string): StoredFileDiff | null {
    const row = this.db
      .prepare(
        `SELECT turn_id, path, before_text, after_text, edit_count, updated_at_ms
         FROM turn_file_diffs
         WHERE turn_id = ? AND path_hash = ?`,
      )
      .get(turnId, pathHash(filePath)) as DiffRow | undefined;
    if (!row || row.after_text === null) return null;
    return {
      turnId: row.turn_id,
      path: row.path,
      before: row.before_text ?? '',
      after: row.after_text,
      editCount: row.edit_count,
      updatedAtMs: row.updated_at_ms ?? 0,
    };
  }

  getSnapshot(turnId: string, filePath: string): { path: string; before: string; editCount: number; source: string } | null {
    const row = this.db
      .prepare(
        `SELECT path, before_text, edit_count, source
         FROM turn_file_diffs
         WHERE turn_id = ? AND path_hash = ?`,
      )
      .get(turnId, pathHash(filePath)) as Pick<DiffRow, 'path' | 'before_text' | 'edit_count' | 'source'> | undefined;
    if (!row) return null;
    return { path: row.path, before: row.before_text ?? '', editCount: row.edit_count, source: row.source };
  }

  listTurnFiles(turnId: string): TurnFileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id, path, after_text, edit_count, updated_at_ms
         FROM turn_file_diffs
         WHERE turn_id = ?
         ORDER BY updated_at_ms ASC, path ASC`,
      )
      .all(turnId) as Array<Pick<DiffRow, 'turn_id' | 'path' | 'after_text' | 'edit_count' | 'updated_at_ms'>>;
    return rows.map((row) => ({
      turnId: row.turn_id,
      path: row.path,
      editCount: row.edit_count,
      hasDiff: row.after_text !== null,
      updatedAtMs: row.updated_at_ms ?? 0,
    }));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_edit_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id       TEXT NOT NULL,
        item_id       TEXT,
        path_hash     TEXT NOT NULL,
        path          TEXT NOT NULL,
        before_text   TEXT,
        after_text    TEXT,
        source        TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_file_diffs (
        turn_id       TEXT NOT NULL,
        path_hash     TEXT NOT NULL,
        path          TEXT NOT NULL,
        before_text   TEXT,
        after_text    TEXT,
        source        TEXT NOT NULL,
        edit_count    INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (turn_id, path_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_file_edit_events_turn_path
        ON file_edit_events(turn_id, path_hash, id);
    `);
  }
}
