import type { GitStatusEntry, GitStatusKind } from './types.js';

export interface ParsedGitStatus {
  branch: string | null;
  headOid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: GitStatusEntry[];
  truncated: boolean;
}

export interface ParseGitStatusOptions {
  entryLimit?: number;
}

const DEFAULT_ENTRY_LIMIT = 2_000;

function statusKind(indexStatus: string, worktreeStatus: string): GitStatusKind {
  if (indexStatus === '?' && worktreeStatus === '?') return 'untracked';
  if (indexStatus === '!' && worktreeStatus === '!') return 'ignored';
  if (indexStatus === 'U' || worktreeStatus === 'U') return 'conflict';
  if (indexStatus !== '.' && indexStatus !== ' ') return 'staged';
  return 'unstaged';
}

function pushEntry(entries: GitStatusEntry[], entry: GitStatusEntry, limit: number): boolean {
  if (entries.length >= limit) return false;
  entries.push(entry);
  return true;
}

function parseBranchHeader(result: ParsedGitStatus, record: string): void {
  if (record.startsWith('# branch.oid ')) {
    const value = record.slice('# branch.oid '.length);
    result.headOid = value === '(initial)' ? null : value;
    return;
  }
  if (record.startsWith('# branch.head ')) {
    const value = record.slice('# branch.head '.length);
    result.branch = value === '(detached)' ? null : value;
    return;
  }
  if (record.startsWith('# branch.upstream ')) {
    result.upstream = record.slice('# branch.upstream '.length);
    return;
  }
  if (record.startsWith('# branch.ab ')) {
    const match = /^# branch\.ab \+(-?\d+) -(-?\d+)$/.exec(record);
    if (match) {
      result.ahead = Number.parseInt(match[1], 10);
      result.behind = Number.parseInt(match[2], 10);
    }
  }
}

function parseOrdinary(record: string): GitStatusEntry | null {
  const body = record.slice(2);
  const xy = body.slice(0, 2);
  const fields = body.slice(3).split(' ');
  if (fields.length < 7) return null;
  const path = fields.slice(6).join(' ');
  if (!path) return null;
  return {
    path,
    indexStatus: xy[0] ?? '.',
    worktreeStatus: xy[1] ?? '.',
    kind: statusKind(xy[0] ?? '.', xy[1] ?? '.'),
    submodule: fields[0],
  };
}

function parseRename(record: string, originalPath: string | undefined): GitStatusEntry | null {
  const body = record.slice(2);
  const xy = body.slice(0, 2);
  const fields = body.slice(3).split(' ');
  if (fields.length < 8) return null;
  const path = fields.slice(7).join(' ');
  if (!path) return null;
  const entry: GitStatusEntry = {
    path,
    indexStatus: xy[0] ?? '.',
    worktreeStatus: xy[1] ?? '.',
    kind: statusKind(xy[0] ?? '.', xy[1] ?? '.'),
    submodule: fields[0],
  };
  if (originalPath) entry.originalPath = originalPath;
  return entry;
}

function parseUnmerged(record: string): GitStatusEntry | null {
  const body = record.slice(2);
  const xy = body.slice(0, 2);
  const fields = body.slice(3).split(' ');
  if (fields.length < 9) return null;
  const path = fields.slice(8).join(' ');
  if (!path) return null;
  return {
    path,
    indexStatus: xy[0] ?? 'U',
    worktreeStatus: xy[1] ?? 'U',
    kind: 'conflict',
    submodule: fields[0],
  };
}

export function parseGitStatusPorcelainV2(output: string | Buffer, options: ParseGitStatusOptions = {}): ParsedGitStatus {
  const records = (Buffer.isBuffer(output) ? output.toString('utf8') : output).split('\0');
  const entryLimit = options.entryLimit ?? DEFAULT_ENTRY_LIMIT;
  const result: ParsedGitStatus = {
    branch: null,
    headOid: null,
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
    truncated: false,
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    let entry: GitStatusEntry | null = null;
    if (record.startsWith('# ')) {
      parseBranchHeader(result, record);
      continue;
    }
    if (record.startsWith('1 ')) entry = parseOrdinary(record);
    else if (record.startsWith('2 ')) entry = parseRename(record, records[++index]);
    else if (record.startsWith('u ')) entry = parseUnmerged(record);
    else if (record.startsWith('? ')) {
      const path = record.slice(2);
      entry = { path, indexStatus: '?', worktreeStatus: '?', kind: 'untracked' };
      if (path.endsWith('/')) entry.isDirectory = true;
    } else if (record.startsWith('! ')) {
      entry = { path: record.slice(2), indexStatus: '!', worktreeStatus: '!', kind: 'ignored' };
    }

    if (entry && !pushEntry(result.entries, entry, entryLimit)) {
      result.truncated = true;
      break;
    }
  }

  return result;
}
