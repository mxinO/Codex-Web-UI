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

function MarkdownView({ content, onOpenFile }: MarkdownViewProps) {
  const remarkPlugins = useMemo(() => (onOpenFile ? [remarkGfm, remarkMath, remarkFileMentions] : [remarkGfm, remarkMath]), [Boolean(onOpenFile)]);
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
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownView);
