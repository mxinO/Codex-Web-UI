import { lazy, Suspense } from 'react';

const MarkdownView = lazy(() => import('./MarkdownView'));

interface StreamingCardProps {
  text: string;
  active: boolean;
  onOpenMentionedFile?: (path: string) => void;
}

export default function StreamingCard({ text, active, onOpenMentionedFile }: StreamingCardProps) {
  return (
    <div className={`streaming-card${active ? ' streaming-card--active' : ''}`} aria-live="polite">
      <div className="streaming-card__header">
        <span className="streaming-card__dot" aria-hidden="true" />
        <span>{active ? 'Streaming' : 'Latest response'}</span>
        {active ? (
          <span className="streaming-card__pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
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
