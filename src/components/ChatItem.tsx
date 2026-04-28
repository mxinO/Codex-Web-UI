import { lazy, Suspense } from 'react';
import type { TimelineItem } from '../lib/timeline';

const MarkdownView = lazy(() => import('./MarkdownView'));

export default function ChatItem({ item, onOpenDetail }: { item: TimelineItem; onOpenDetail: (item: TimelineItem) => void }) {
  if (item.kind === 'user') {
    return (
      <div className="chat-row chat-row--user">
        <div className="chat-bubble chat-bubble--user">{item.text}</div>
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div className="chat-row chat-row--assistant">
        <div className="chat-bubble chat-bubble--assistant">
          <Suspense fallback={<div className="detail-loading">Loading markdown...</div>}>
            <MarkdownView content={item.text} />
          </Suspense>
        </div>
      </div>
    );
  }

  if (item.kind === 'command') {
    return (
      <div className="chat-row chat-row--assistant">
        <button className="tool-card" type="button" onClick={() => onOpenDetail(item)}>
          $ {item.command}
        </button>
      </div>
    );
  }

  if (item.kind === 'notice') {
    return (
      <div className="chat-row chat-row--system">
        <div className="chat-notice">{item.text || item.kind}</div>
      </div>
    );
  }

  if (item.kind === 'fileChange') {
    return (
      <div className="chat-row chat-row--system">
        <button className="tool-card" type="button" onClick={() => onOpenDetail(item)}>
          File change: {item.item.status}
        </button>
      </div>
    );
  }

  return (
    <div className="chat-row chat-row--system">
      <button className="tool-card" type="button" onClick={() => onOpenDetail(item)}>
        Tool: {item.item.type}
      </button>
    </div>
  );
}
