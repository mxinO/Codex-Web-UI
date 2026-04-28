import { lazy, Suspense } from 'react';
import type { TimelineItem } from '../lib/timeline';
import ApprovalCard from './ApprovalCard';
import StreamingCard from './StreamingCard';

const MarkdownView = lazy(() => import('./MarkdownView'));

interface ChatItemProps {
  item: TimelineItem;
  onOpenDetail: (item: TimelineItem) => void;
  onApprovalDecision: (item: Extract<TimelineItem, { kind: 'approval' }>, decision: unknown) => Promise<void>;
}

export default function ChatItem({ item, onOpenDetail, onApprovalDecision }: ChatItemProps) {
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

  if (item.kind === 'streaming') {
    return (
      <div className="chat-row chat-row--assistant">
        <StreamingCard text={item.text} active={item.active} />
      </div>
    );
  }

  if (item.kind === 'approval') {
    return (
      <div className="chat-row chat-row--system">
        <ApprovalCard requestId={item.requestId} method={item.method} params={item.params} onDecision={(decision) => onApprovalDecision(item, decision)} />
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
