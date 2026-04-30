import { lazy, Suspense } from 'react';

const MarkdownView = lazy(() => import('./MarkdownView'));

interface StreamingCardProps {
  text: string;
  active: boolean;
  onOpenMentionedFile?: (path: string) => void;
}

export default function StreamingCard({ text, active, onOpenMentionedFile }: StreamingCardProps) {
  return (
    <div className="streaming-card" aria-live="polite">
      <div className="streaming-card__header">
        <span className="streaming-card__dot" aria-hidden="true" />
        <span>{active ? 'Streaming' : 'Latest response'}</span>
      </div>
      {text ? (
        <Suspense fallback={<div className="detail-loading">Loading markdown...</div>}>
          <MarkdownView content={text} onOpenFile={onOpenMentionedFile} />
        </Suspense>
      ) : (
        <div className="streaming-card__empty">Waiting for assistant output...</div>
      )}
    </div>
  );
}
