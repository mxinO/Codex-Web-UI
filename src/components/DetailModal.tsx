import { lazy, Suspense, useEffect, useRef, type KeyboardEvent } from 'react';
import type { TimelineItem } from '../lib/timeline';

const MarkdownView = lazy(() => import('./MarkdownView'));
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

  const body =
    item.kind === 'assistant' ? (
      <Suspense fallback={<div className="detail-loading">Loading markdown...</div>}>
        <MarkdownView content={item.text} />
      </Suspense>
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
        <div className="modal-header">
          <span id="detail-modal-title">{item.kind}</span>
          <button className="icon-button" type="button" aria-label="Close detail" onClick={onClose} ref={closeButtonRef}>
            X
          </button>
        </div>
        <div className="modal-body">{body}</div>
      </div>
    </div>
  );
}
