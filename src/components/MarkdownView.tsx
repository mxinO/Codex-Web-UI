import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { decodeFileMentionHref, FILE_MENTION_HREF_PREFIX, markdownFileHrefPath, remarkFileMentions } from '../lib/fileMentions';

interface MarkdownViewProps {
  content: string;
  onOpenFile?: (path: string) => void;
}

const REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight];

function markdownUrlTransform(url: string): string {
  return url.startsWith(FILE_MENTION_HREF_PREFIX) ? url : defaultUrlTransform(url);
}

function previousCharIsBackslash(value: string, index: number): boolean {
  return index > 0 && value[index - 1] === '\\';
}

function findLatexDelimiter(value: string, delimiter: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const found = value.indexOf(delimiter, index);
    if (found < 0) return -1;
    if (!previousCharIsBackslash(value, found)) return found;
    index = found + delimiter.length;
  }
  return -1;
}

function nextLineStart(value: string, index: number): number {
  const lineEnd = value.indexOf('\n', index);
  return lineEnd < 0 ? value.length : lineEnd + 1;
}

function fenceMatchAtLineStart(value: string, index: number): { marker: '`' | '~'; length: number; lineEnd: number } | null {
  if (index > 0 && value[index - 1] !== '\n') return null;
  const lineEnd = nextLineStart(value, index);
  const line = value.slice(index, lineEnd);
  const match = /^(?:(?: {0,3}>[ \t]?)* {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(line);
  if (!match) return null;
  const fence = match[1];
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
    lineEnd,
  };
}

function closingFenceLineEnd(value: string, index: number, marker: '`' | '~', length: number): number {
  let cursor = index;
  const markerPattern = marker === '`' ? '`' : '~';
  const closingPattern = new RegExp(`^(?:(?: {0,3}>[ \\t]?)* {0,3})${markerPattern}{${length},}[ \\t]*(?:\\n|$)`);
  while (cursor < value.length) {
    const lineEnd = nextLineStart(value, cursor);
    const line = value.slice(cursor, lineEnd);
    if (closingPattern.test(line)) return lineEnd;
    cursor = lineEnd;
  }
  return value.length;
}

function copyInlineCode(value: string, index: number): { text: string; nextIndex: number } {
  let markerEnd = index + 1;
  while (markerEnd < value.length && value[markerEnd] === '`') markerEnd += 1;
  const ticks = value.slice(index, markerEnd);
  const closing = value.indexOf(ticks, markerEnd);
  if (closing < 0) return { text: value.slice(index), nextIndex: value.length };
  return { text: value.slice(index, closing + ticks.length), nextIndex: closing + ticks.length };
}

function referenceDefinitionLineEnd(value: string, index: number): number | null {
  if (index > 0 && value[index - 1] !== '\n') return null;
  const lineEnd = nextLineStart(value, index);
  const line = value.slice(index, lineEnd);
  const definitionPattern = /^(?:(?: {0,3}>[ \t]?)* {0,3})\[(?:[^\]\\\n]|\\.){1,999}\]:[^\n]*(?:\n|$)/;
  return definitionPattern.test(line) ? lineEnd : null;
}

function markdownLinkDestinationEnd(value: string, index: number): number | null {
  if (!value.startsWith('](', index)) return null;

  let cursor = index + 2;
  let nestedParens = 0;
  let quote: '"' | "'" | null = null;

  while (cursor < value.length) {
    const char = value[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      cursor += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
      continue;
    }

    if (char === '(') {
      nestedParens += 1;
    } else if (char === ')') {
      if (nestedParens === 0) return cursor + 1;
      nestedParens -= 1;
    }

    cursor += 1;
  }

  return null;
}

function htmlTagEnd(value: string, index: number): number | null {
  if (value.startsWith('<!--', index)) {
    const end = value.indexOf('-->', index + 4);
    return end < 0 ? value.length : end + 3;
  }

  if (!/^<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>/]|$)/.test(value.slice(index, index + 128))) return null;

  let cursor = index + 1;
  let quote: '"' | "'" | null = null;
  while (cursor < value.length) {
    const char = value[cursor];
    if (quote) {
      if (char === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
      continue;
    }
    if (char === '>') return cursor + 1;
    cursor += 1;
  }

  return value.length;
}

export function normalizeLatexDelimiters(content: string): string {
  let result = '';
  let index = 0;

  while (index < content.length) {
    const fence = fenceMatchAtLineStart(content, index);
    if (fence) {
      const end = closingFenceLineEnd(content, fence.lineEnd, fence.marker, fence.length);
      result += content.slice(index, end);
      index = end;
      continue;
    }

    const referenceDefinitionEnd = referenceDefinitionLineEnd(content, index);
    if (referenceDefinitionEnd !== null) {
      result += content.slice(index, referenceDefinitionEnd);
      index = referenceDefinitionEnd;
      continue;
    }

    const linkDestinationEnd = markdownLinkDestinationEnd(content, index);
    if (linkDestinationEnd !== null) {
      result += content.slice(index, linkDestinationEnd);
      index = linkDestinationEnd;
      continue;
    }

    if (content[index] === '`') {
      const inlineCode = copyInlineCode(content, index);
      result += inlineCode.text;
      index = inlineCode.nextIndex;
      continue;
    }

    if (content[index] === '<') {
      const tagEnd = htmlTagEnd(content, index);
      if (tagEnd !== null) {
        result += content.slice(index, tagEnd);
        index = tagEnd;
        continue;
      }
    }

    if (content.startsWith('\\(', index) && !previousCharIsBackslash(content, index)) {
      const closing = findLatexDelimiter(content, '\\)', index + 2);
      if (closing >= 0) {
        result += `$${content.slice(index + 2, closing)}$`;
        index = closing + 2;
        continue;
      }
    }

    if (content.startsWith('\\[', index) && !previousCharIsBackslash(content, index)) {
      const closing = findLatexDelimiter(content, '\\]', index + 2);
      if (closing >= 0) {
        result += `\n\n$$\n${content.slice(index + 2, closing).trim()}\n$$\n\n`;
        index = closing + 2;
        continue;
      }
    }

    result += content[index];
    index += 1;
  }

  return result;
}

function MarkdownView({ content, onOpenFile }: MarkdownViewProps) {
  const remarkPlugins = useMemo(() => (onOpenFile ? [remarkGfm, remarkMath, remarkFileMentions] : [remarkGfm, remarkMath]), [Boolean(onOpenFile)]);
  const normalizedContent = useMemo(() => normalizeLatexDelimiters(content), [content]);
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const mentionedPath = href ? decodeFileMentionHref(href) ?? markdownFileHrefPath(href) : null;
        if (mentionedPath && onOpenFile) {
          return (
            <button className="markdown-file-link" type="button" title={`Open ${mentionedPath}`} onClick={() => onOpenFile(mentionedPath)}>
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [onOpenFile],
  );

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownView);
