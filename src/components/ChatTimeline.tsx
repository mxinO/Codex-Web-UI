import type { UIEvent } from 'react';
import type { TimelineItem } from '../lib/timeline';
import ChatItem from './ChatItem';

interface ChatTimelineProps {
  items: TimelineItem[];
  onLoadOlder: () => void;
  onJumpToLatest: () => void;
  hasOlder: boolean;
  showJumpToLatest: boolean;
  loading?: boolean;
  onOpenDetail: (item: TimelineItem) => void;
  onApprovalDecision: (item: Extract<TimelineItem, { kind: 'approval' }>, decision: unknown) => Promise<void>;
  onQueuedEdit?: (message: Extract<TimelineItem, { kind: 'queued' }>['message']) => void;
  onQueuedRemove?: (id: string) => void;
}

export default function ChatTimeline({
  items,
  onLoadOlder,
  onJumpToLatest,
  hasOlder,
  showJumpToLatest,
  loading = false,
  onOpenDetail,
  onApprovalDecision,
  onQueuedEdit,
  onQueuedRemove,
}: ChatTimelineProps) {
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!hasOlder || loading) return;
    if (event.currentTarget.scrollTop <= 80) onLoadOlder();
  };

  return (
    <div className="chat-scroll" onScroll={handleScroll}>
      <div className="chat-column">
        {(hasOlder || showJumpToLatest) && (
          <div className="timeline-pager">
            {hasOlder && (
              <button className="load-more" type="button" onClick={onLoadOlder} disabled={loading}>
                {loading ? 'Loading...' : 'Load older'}
              </button>
            )}
            {showJumpToLatest && (
              <button className="load-more" type="button" onClick={onJumpToLatest} disabled={loading}>
                Jump to latest
              </button>
            )}
          </div>
        )}
        {items.map((item) => (
          <ChatItem
            key={item.id}
            item={item}
            onOpenDetail={onOpenDetail}
            onApprovalDecision={onApprovalDecision}
            onQueuedEdit={onQueuedEdit}
            onQueuedRemove={onQueuedRemove}
          />
        ))}
        {items.length === 0 && <div className="chat-empty">{loading ? 'Loading messages...' : 'No messages loaded.'}</div>}
      </div>
    </div>
  );
}
