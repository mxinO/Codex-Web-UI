import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react';
import type { TimelineItem } from '../lib/timeline';
import ActivityBlock from './ActivityBlock';
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
  onOpenFileSummary?: (turnId: string, path: string, changeCount: number) => void;
}

const BOTTOM_STICKY_THRESHOLD_PX = 80;

function isActivityItem(item: TimelineItem): boolean {
  return (
    item.kind === 'command' ||
    item.kind === 'tool' ||
    item.kind === 'fileChange' ||
    item.kind === 'notice' ||
    item.kind === 'warning' ||
    item.kind === 'error'
  );
}

function groupTimelineItems(items: TimelineItem[]): Array<TimelineItem | TimelineItem[]> {
  const groups: Array<TimelineItem | TimelineItem[]> = [];
  let activityRun: TimelineItem[] = [];

  for (const item of items) {
    if (isActivityItem(item)) {
      activityRun.push(item);
      continue;
    }
    if (activityRun.length > 0) {
      groups.push(activityRun);
      activityRun = [];
    }
    groups.push(item);
  }

  if (activityRun.length > 0) groups.push(activityRun);
  return groups;
}

function scrollToBottom(scroller: HTMLDivElement) {
  scroller.scrollTop = scroller.scrollHeight;
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
  onOpenFileSummary,
}: ChatTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || showJumpToLatest || !stickToBottomRef.current) return;
    scrollToBottom(scroller);
  }, [items, showJumpToLatest]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const column = columnRef.current;
    if (!scroller || !column || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (showJumpToLatest || !stickToBottomRef.current) return;
      scrollToBottom(scroller);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [showJumpToLatest]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    stickToBottomRef.current = distanceFromBottom <= BOTTOM_STICKY_THRESHOLD_PX;

    if (!hasOlder || loading) return;
    if (scroller.scrollTop <= 80) onLoadOlder();
  };

  const handleJumpToLatest = () => {
    stickToBottomRef.current = true;
    onJumpToLatest();
  };

  return (
    <div ref={scrollerRef} className="chat-scroll" onScroll={handleScroll}>
      <div ref={columnRef} className="chat-column">
        {(hasOlder || showJumpToLatest) && (
          <div className="timeline-pager">
            {hasOlder && (
              <button className="load-more" type="button" onClick={onLoadOlder} disabled={loading}>
                {loading ? 'Loading...' : 'Load older'}
              </button>
            )}
            {showJumpToLatest && (
              <button className="load-more" type="button" onClick={handleJumpToLatest} disabled={loading}>
                Jump to latest
              </button>
            )}
          </div>
        )}
        {groupTimelineItems(items).map((entry) =>
          Array.isArray(entry) ? (
            <ActivityBlock
              key={`activity:${entry.map((item) => item.id).join('|')}`}
              items={entry}
              onOpenDetail={onOpenDetail}
            />
          ) : (
            <ChatItem
              key={entry.id}
              item={entry}
              onOpenDetail={onOpenDetail}
              onApprovalDecision={onApprovalDecision}
              onQueuedEdit={onQueuedEdit}
              onQueuedRemove={onQueuedRemove}
              onOpenFileSummary={onOpenFileSummary}
            />
          ),
        )}
        {items.length === 0 && <div className="chat-empty">{loading ? 'Loading messages...' : 'No messages loaded.'}</div>}
      </div>
    </div>
  );
}
