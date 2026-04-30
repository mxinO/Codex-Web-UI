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

export default function MarkdownView({ content, onOpenFile }: MarkdownViewProps) {
  const remarkPlugins = onOpenFile ? [remarkGfm, remarkMath, remarkFileMentions] : [remarkGfm, remarkMath];

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        urlTransform={(url) => (url.startsWith(FILE_MENTION_HREF_PREFIX) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
