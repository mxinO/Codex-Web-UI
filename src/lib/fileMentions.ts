import { normalizeMentionedFilePath } from './filePreview';

export const FILE_MENTION_HREF_PREFIX = 'webui-file:';

export interface FileMentionTextPart {
  type: 'text';
  value: string;
}

export interface FileMentionFilePart {
  type: 'file';
  value: string;
  path: string;
}

export type FileMentionPart = FileMentionTextPart | FileMentionFilePart;

const PATH_CANDIDATE_PATTERN =
  /(^|[\s([{"'`])((?:\.{1,2}\/|\/|~\/)?[A-Za-z0-9._~@%+=-]+(?:\/[A-Za-z0-9._~@%+=-]+)+(?:\:\d+(?:\:\d+)?)?|[A-Za-z0-9._~@%+=-]+\.[A-Za-z0-9][A-Za-z0-9-]{0,15}(?:\:\d+(?:\:\d+)?)?)(?=$|[\s)\]}>"'`,.;!?])/g;

const FILE_EXTENSIONS = new Set([
  '.avif',
  '.bash',
  '.bmp',
  '.c',
  '.cfg',
  '.cjs',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cxx',
  '.env',
  '.fish',
  '.gif',
  '.go',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ico',
  '.ini',
  '.java',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.lock',
  '.log',
  '.markdown',
  '.md',
  '.mjs',
  '.pdf',
  '.php',
  '.png',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.tsv',
  '.txt',
  '.webp',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

const COMMON_DOTTED_TERMS = new Set(['bun.sh', 'd3.js', 'deno.js', 'next.js', 'node.js', 'nuxt.js', 'socket.io', 'three.js', 'vue.js']);

function trimTrailingSentencePunctuation(value: string): { fileValue: string; trailing: string } {
  const trailing = value.match(/[.,;!?]+$/)?.[0] ?? '';
  return trailing ? { fileValue: value.slice(0, -trailing.length), trailing } : { fileValue: value, trailing: '' };
}

function extensionForPath(value: string): string | null {
  const normalized = normalizeMentionedFilePath(value);
  const lastSlashIndex = normalized.lastIndexOf('/');
  const filename = normalized.slice(lastSlashIndex + 1);
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return null;
  if (dotIndex === 0 && filename.indexOf('.', 1) < 0) return filename.toLowerCase();
  return filename.slice(dotIndex).toLowerCase();
}

function hasExplicitPathPrefix(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/');
}

function startsWithDomainLikeSegment(value: string): boolean {
  if (hasExplicitPathPrefix(value)) return false;
  const firstSegment = value.split('/')[0] ?? '';
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(firstSegment);
}

function isLikelyFileMention(value: string): boolean {
  const normalized = normalizeMentionedFilePath(value);
  if (normalized.includes('@')) return false;
  if (/^\d+(?:\.\d+)+$/.test(normalized)) return false;
  if (COMMON_DOTTED_TERMS.has(normalized.toLowerCase())) return false;
  if (startsWithDomainLikeSegment(normalized)) return false;

  const extension = extensionForPath(normalized);
  return extension !== null && FILE_EXTENSIONS.has(extension);
}

export function fileMentionHref(path: string): string {
  return `${FILE_MENTION_HREF_PREFIX}${encodeURIComponent(path)}`;
}

export function decodeFileMentionHref(href: string): string | null {
  if (!href.startsWith(FILE_MENTION_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(FILE_MENTION_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

export function splitFileMentions(text: string): FileMentionPart[] {
  const parts: FileMentionPart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PATH_CANDIDATE_PATTERN)) {
    const prefix = match[1] ?? '';
    const value = match[2] ?? '';
    if (!value) continue;

    const start = (match.index ?? 0) + prefix.length;
    const { fileValue, trailing } = trimTrailingSentencePunctuation(value);
    if (!fileValue || !isLikelyFileMention(fileValue)) continue;

    if (start > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, start) });
    parts.push({ type: 'file', value: fileValue, path: normalizeMentionedFilePath(fileValue) });
    if (trailing) parts.push({ type: 'text', value: trailing });
    lastIndex = start + value.length;
  }

  if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ type: 'text', value: text }];
}

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
}

const SKIP_MARKDOWN_TYPES = new Set(['code', 'definition', 'html', 'image', 'imageReference', 'inlineCode', 'link', 'linkReference']);

function transformNode(node: MarkdownNode): void {
  if (!node.children || SKIP_MARKDOWN_TYPES.has(node.type ?? '')) return;

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitFileMentions(child.value);
      if (parts.length === 1 && parts[0].type === 'text') {
        nextChildren.push(child);
        continue;
      }
      for (const part of parts) {
        if (part.type === 'text') {
          nextChildren.push({ type: 'text', value: part.value });
        } else {
          nextChildren.push({
            type: 'link',
            url: fileMentionHref(part.path),
            title: null,
            children: [{ type: 'text', value: part.value }],
          });
        }
      }
      continue;
    }

    transformNode(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

export function remarkFileMentions() {
  return (tree: MarkdownNode) => {
    transformNode(tree);
  };
}
