import { lazy, Suspense, useEffect, useRef, type KeyboardEvent } from 'react';
import type { TimelineItem } from '../lib/timeline';

const MarkdownView = lazy(() => import('./MarkdownView'));
const DiffViewer = lazy(() => import('./DiffViewer'));
const DETAIL_LIMIT = 200_000;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const TRUNCATION_TEXT = `Truncated after ${DETAIL_LIMIT} characters.`;

function capText(value: string): string {
  if (value.length <= DETAIL_LIMIT) return value;
  return `${value.slice(0, DETAIL_LIMIT)}\n\n[${TRUNCATION_TEXT}]`;
}

function stringifyDetail(value: unknown): string {
  const seen = new WeakSet<object>();
  let remaining = DETAIL_LIMIT;
  let truncated = false;

  function spend(amount: number): boolean {
    remaining -= amount;
    if (remaining >= 0) return true;
    truncated = true;
    return false;
  }

  function normalize(input: unknown, depth: number): unknown {
    if (remaining <= 0) {
      truncated = true;
      return '[Truncated]';
    }

    if (input === null || typeof input === 'number' || typeof input === 'boolean') {
      spend(String(input).length);
      return input;
    }

    if (typeof input === 'string') {
      if (!spend(input.length)) return `${input.slice(0, Math.max(0, input.length + remaining))}[Truncated]`;
      return input;
    }

    if (typeof input === 'bigint') {
      const value = `${input.toString()}n`;
      spend(value.length);
      return value;
    }

    if (typeof input === 'undefined' || typeof input === 'function' || typeof input === 'symbol') {
      const value = `[${typeof input}]`;
      spend(value.length);
      return value;
    }

    if (typeof input !== 'object') return input;

    if (seen.has(input)) {
      spend(10);
      return '[Circular]';
    }

    if (depth >= MAX_DEPTH) {
      truncated = true;
      return '[Max depth reached]';
    }

    seen.add(input);

    if (Array.isArray(input)) {
      const count = Math.min(input.length, MAX_ARRAY_ITEMS);
      const output = input.slice(0, count).map((entry) => normalize(entry, depth + 1));
      if (input.length > count) {
        truncated = true;
        output.push(`[${input.length - count} more items]`);
      }
      seen.delete(input);
      return output;
    }

    const output: Record<string, unknown> = {};
    let count = 0;
    let hasMoreKeys = false;

    for (const key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

      if (count >= MAX_OBJECT_KEYS) {
        hasMoreKeys = true;
        break;
      }

      if (!spend(key.length)) {
        output['[Truncated]'] = TRUNCATION_TEXT;
        break;
      }

      output[key] = normalize((input as Record<string, unknown>)[key], depth + 1);
      count += 1;

      if (remaining <= 0) break;
    }

    if (hasMoreKeys) {
      truncated = true;
      output['[More keys]'] = true;
    }

    seen.delete(input);
    return output;
  }

  try {
    const normalized = normalize(value, 0);
    const json = JSON.stringify(normalized, null, 2);
    return capText(truncated ? `${json}\n\n[${TRUNCATION_TEXT}]` : json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return capText(`Unable to serialize detail: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstStringAt(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!isRecord(current)) {
        current = null;
        break;
      }
      current = current[key];
    }
    if (typeof current === 'string') return current;
  }
  return null;
}

function firstRecordChange(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.changes)) return value.changes.find(isRecord) ?? null;
  if (Array.isArray(value.data)) return value.data.find(isRecord) ?? null;
  return value;
}

function languageFromPath(filePath: string | null): string {
  const extension = filePath?.split('.').pop()?.toLowerCase();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx') return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'css') return 'css';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'py') return 'python';
  if (extension === 'sh' || extension === 'bash') return 'shell';
  return 'plaintext';
}

type FileChangeDetail =
  | { type: 'twoWay'; before: string; after: string; language: string }
  | { type: 'patch'; patch: string; language: string };

function allRecordChanges(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.changes)) return value.changes.filter(isRecord);
  if (Array.isArray(value.data)) return value.data.filter(isRecord);
  return [value];
}

function diffText(change: unknown): string | null {
  return firstStringAt(change, [['diff'], ['patch'], ['unifiedDiff'], ['unified_diff']]);
}

function changeKindType(change: unknown): string | null {
  return firstStringAt(change, [['kind', 'type'], ['type']]);
}

function isPatch(text: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
}

function splitContentLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function joinContentLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function applyUnifiedPatch(content: string, patch: string): string | null {
  const source = splitContentLines(content);
  const output: string[] = [];
  let sourceIndex = 0;
  let trailingNewline = content.endsWith('\n');
  const lines = patch.split('\n');
  let index = 0;
  let applied = false;

  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    applied = true;
    const oldStart = Number(header[1]);
    const targetIndex = oldStart > 0 ? oldStart - 1 : 0;
    while (sourceIndex < targetIndex && sourceIndex < source.length) {
      output.push(source[sourceIndex]);
      sourceIndex += 1;
    }

    index += 1;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      if (line === '\\ No newline at end of file') {
        trailingNewline = false;
        index += 1;
        continue;
      }
      if (!line) {
        index += 1;
        continue;
      }

      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        output.push(text);
        sourceIndex += 1;
      } else if (marker === '-') {
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(text);
        trailingNewline = true;
      }
      index += 1;
    }
  }

  if (!applied) return null;
  while (sourceIndex < source.length) {
    output.push(source[sourceIndex]);
    sourceIndex += 1;
  }
  return joinContentLines(output, trailingNewline);
}

function reconstructAddedFileDiff(changes: unknown[]): { before: string; after: string } | null {
  const first = changes[0];
  const firstDiff = diffText(first);
  if (changeKindType(first) !== 'add' || firstDiff === null || isPatch(firstDiff)) return null;

  let after = firstDiff;
  for (const change of changes.slice(1)) {
    const patch = diffText(change);
    if (!patch || !isPatch(patch)) continue;
    const next = applyUnifiedPatch(after, patch);
    if (next === null) return null;
    after = next;
  }

  return { before: '', after };
}

function explicitBeforeAfterDiff(changes: unknown[]): { before: string; after: string; filePath: string | null } | null {
  const first = changes.find((change) =>
    firstStringAt(change, [
      ['before'],
      ['oldText'],
      ['old_text'],
      ['previousText'],
      ['previous_text'],
      ['original'],
      ['beforeContent'],
      ['before_content'],
    ]) !== null,
  );
  const last = [...changes].reverse().find((change) =>
    firstStringAt(change, [
      ['after'],
      ['newText'],
      ['new_text'],
      ['updatedText'],
      ['updated_text'],
      ['modified'],
      ['afterContent'],
      ['after_content'],
    ]) !== null,
  );
  if (!first || !last) return null;

  const before = firstStringAt(first, [
    ['before'],
    ['oldText'],
    ['old_text'],
    ['previousText'],
    ['previous_text'],
    ['original'],
    ['beforeContent'],
    ['before_content'],
  ]);
  const after = firstStringAt(last, [
    ['after'],
    ['newText'],
    ['new_text'],
    ['updatedText'],
    ['updated_text'],
    ['modified'],
    ['afterContent'],
    ['after_content'],
  ]);
  if (before === null || after === null) return null;

  return {
    before,
    after,
    filePath: firstStringAt(first, [['path'], ['file'], ['filePath'], ['file_path']]) ?? firstStringAt(last, [['path'], ['file'], ['filePath'], ['file_path']]),
  };
}

function patchHunkDiff(changes: unknown[]): string | null {
  const patches = changes
    .map(diffText)
    .filter((entry): entry is string => entry !== null && isPatch(entry));
  return patches.length > 0 ? patches.join('\n\n') : null;
}

function fileChangeDiff(item: Extract<TimelineItem, { kind: 'fileChange' }>): FileChangeDetail | null {
  if (item.resolvedDiff) {
    return {
      type: 'twoWay',
      before: item.resolvedDiff.before,
      after: item.resolvedDiff.after,
      language: languageFromPath(item.resolvedDiff.path ?? item.filePath ?? null),
    };
  }

  const value = item.item;
  const change = firstRecordChange(value);
  if (!change) return null;

  const changes = allRecordChanges(value);
  const explicit = explicitBeforeAfterDiff(changes);
  if (explicit) {
    return { type: 'twoWay', before: explicit.before, after: explicit.after, language: languageFromPath(explicit.filePath) };
  }

  const reconstructed = reconstructAddedFileDiff(changes);
  if (reconstructed) {
    const filePath = firstStringAt(change, [['path'], ['file'], ['filePath'], ['file_path']]);
    return { type: 'twoWay', before: reconstructed.before, after: reconstructed.after, language: languageFromPath(filePath) };
  }

  const hunkPatch = patchHunkDiff(changes);
  if (hunkPatch) {
    const filePath = firstStringAt(change, [['path'], ['file'], ['filePath'], ['file_path']]);
    return { type: 'patch', patch: hunkPatch, language: languageFromPath(filePath) };
  }

  const patch = changes
    .map(diffText)
    .filter((entry): entry is string => entry !== null && entry.length > 0)
    .join('\n\n');
  if (patch) {
    const filePath = firstStringAt(change, [['path'], ['file'], ['filePath'], ['file_path']]);
    return { type: 'patch', patch, language: languageFromPath(filePath) };
  }

  return null;
}

function fileChangePath(item: Extract<TimelineItem, { kind: 'fileChange' }>): string | null {
  if (item.resolvedDiff?.path) return item.resolvedDiff.path;
  if (item.filePath) return item.filePath;

  for (const change of allRecordChanges(item.item)) {
    const filePath = firstStringAt(change, [['path'], ['file'], ['filePath'], ['file_path']]);
    if (filePath) return filePath;
  }

  const change = firstRecordChange(item.item);
  return firstStringAt(change, [['path'], ['file'], ['filePath'], ['file_path']]);
}

function getFocusableElements(element: HTMLElement): HTMLElement[] {
  return Array.from(
    element.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'),
  ).filter((candidate) => !candidate.hasAttribute('disabled') && candidate.getAttribute('aria-hidden') !== 'true');
}

export default function DetailModal({ item, onClose }: { item: TimelineItem | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!item) return undefined;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, [item]);

  if (!item) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== 'Tab' || !dialogRef.current) return;

    const focusable = getFocusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const diff = item.kind === 'fileChange' && !item.diffLoading && !item.diffError ? fileChangeDiff(item) : null;
  const titlePath = item.kind === 'fileChange' ? fileChangePath(item) : null;
  const titleText = titlePath ?? item.kind;
  const body =
    item.kind === 'assistant' ? (
      <Suspense fallback={<div className="detail-loading">Loading markdown...</div>}>
        <MarkdownView content={item.text} />
      </Suspense>
    ) : item.kind === 'bangCommand' ? (
      <pre className="detail-pre">{`$ ${item.command}\n${item.output}`}</pre>
    ) : item.kind === 'fileChange' && item.diffLoading ? (
      <div className="detail-loading">Loading diff...</div>
    ) : diff ? (
      <Suspense fallback={<div className="detail-loading">Loading diff...</div>}>
        {diff.type === 'patch' ? <DiffViewer patch={diff.patch} language={diff.language} /> : <DiffViewer before={diff.before} after={diff.after} language={diff.language} />}
      </Suspense>
    ) : item.kind === 'fileChange' && item.diffError ? (
      <pre className="detail-pre">{`Unable to load file diff: ${item.diffError}\n\n${stringifyDetail({ kind: item.kind, metadata: item.item })}`}</pre>
    ) : item.kind === 'fileChange' ? (
      <pre className="detail-pre">{stringifyDetail({ kind: item.kind, metadata: item.item })}</pre>
    ) : (
      <pre className="detail-pre">{stringifyDetail(item)}</pre>
    );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-modal-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={`modal-header${titlePath ? ' file-editor-header' : ''}`}>
          <span id="detail-modal-title" className={titlePath ? 'file-editor-title' : undefined} title={titlePath ?? undefined}>
            {titleText}
          </span>
          <button className="icon-button" type="button" aria-label="Close detail" onClick={onClose} ref={closeButtonRef}>
            X
          </button>
        </div>
        <div className="modal-body">{body}</div>
      </div>
    </div>
  );
}
