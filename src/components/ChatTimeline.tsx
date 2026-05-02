import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { TimelineItem } from '../lib/timeline';
import ActivityBlock from './ActivityBlock';
import ChatItem from './ChatItem';

interface ChatTimelineProps {
  items: TimelineItem[];
  onLoadOlder: () => void;
  onJumpToLatest: () => void;
  hasOlder: boolean;
  showJumpToLatest: boolean;
  showActivityRunning?: boolean;
  loading?: boolean;
  onOpenDetail: (item: TimelineItem) => void;
  onApprovalDecision: (item: Extract<TimelineItem, { kind: 'approval' }>, decision: unknown) => Promise<void>;
  onQueuedEdit?: (message: Extract<TimelineItem, { kind: 'queued' }>['message']) => void;
  onQueuedRemove?: (id: string) => void;
  onOpenFileSummary?: (turnId: string, path: string, changeCount: number) => void;
  onOpenMentionedFile?: (path: string) => void;
}

const BOTTOM_STICKY_THRESHOLD_PX = 80;
export const INITIAL_RENDERED_GROUP_LIMIT = 60;
export const RENDERED_GROUP_INCREMENT = 40;

type ScrollPreservation =
  | { mode: 'next-layout'; scrollHeight: number }
  | { mode: 'server-prepend'; scrollHeight: number; oldestGroupKey: string | null; sawLoading: boolean };

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
    if (item.kind === 'streaming' && item.text.trim().length === 0) continue;
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

function groupKey(group: TimelineItem | TimelineItem[] | undefined): string | null {
  if (!group) return null;
  if (!Array.isArray(group)) return `item:${group.id}`;
  const first = group[0]?.id ?? 'empty';
  const last = group.at(-1)?.id ?? 'empty';
  return `activity:${first}:${last}:${group.length}`;
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
  showActivityRunning = false,
  loading = false,
  onOpenDetail,
  onApprovalDecision,
  onQueuedEdit,
  onQueuedRemove,
  onOpenFileSummary,
  onOpenMentionedFile,
}: ChatTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previousGroupLengthRef = useRef(0);
  const scrollPreservationRef = useRef<ScrollPreservation | null>(null);
  const [visibleGroupCount, setVisibleGroupCount] = useState(INITIAL_RENDERED_GROUP_LIMIT);
  const groups = useMemo(() => groupTimelineItems(items), [items]);
  const hiddenLoadedGroupCount = Math.max(0, groups.length - visibleGroupCount);
  const oldestGroupKey = groupKey(groups[0]);
  const renderedGroups = useMemo(() => {
    const start = Math.max(0, groups.length - visibleGroupCount);
    return groups.slice(start);
  }, [groups, visibleGroupCount]);
  const lastGroupIndex = renderedGroups.length - 1;
  const runningAppendsToLastActivity = showActivityRunning && lastGroupIndex >= 0 && Array.isArray(renderedGroups[lastGroupIndex]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const preservation = scrollPreservationRef.current;
    if (preservation) {
      if (preservation.mode === 'server-prepend') {
        const prependedHistory = oldestGroupKey !== preservation.oldestGroupKey;
        if (!prependedHistory) {
          preservation.scrollHeight = scroller.scrollHeight;
          if (loading) preservation.sawLoading = true;
          else if (preservation.sawLoading) scrollPreservationRef.current = null;
          return;
        }
      }
      scrollPreservationRef.current = null;
      scroller.scrollTop += scroller.scrollHeight - preservation.scrollHeight;
      return;
    }
    if (showJumpToLatest || !stickToBottomRef.current) return;
    scrollToBottom(scroller);
  }, [groups.length, loading, oldestGroupKey, renderedGroups, showActivityRunning, showJumpToLatest]);

  useEffect(() => {
    const previousLength = previousGroupLengthRef.current;
    previousGroupLengthRef.current = groups.length;

    if (groups.length === 0 || groups.length < previousLength) {
      setVisibleGroupCount(INITIAL_RENDERED_GROUP_LIMIT);
      return;
    }
    if (groups.length > previousLength && stickToBottomRef.current && !showJumpToLatest) {
      setVisibleGroupCount(INITIAL_RENDERED_GROUP_LIMIT);
    }
  }, [groups.length, showJumpToLatest]);

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

  const preserveScrollForPrepend = (scroller: HTMLDivElement, mode: ScrollPreservation['mode']) => {
    scrollPreservationRef.current = mode === 'server-prepend'
      ? { mode, scrollHeight: scroller.scrollHeight, oldestGroupKey, sawLoading: false }
      : { mode, scrollHeight: scroller.scrollHeight };
  };

  const revealOlderLoadedGroups = (scroller: HTMLDivElement): boolean => {
    if (hiddenLoadedGroupCount <= 0) return false;
    preserveScrollForPrepend(scroller, 'next-layout');
    setVisibleGroupCount((count) => Math.min(groups.length, count + RENDERED_GROUP_INCREMENT));
    return true;
  };

  const requestOlder = (scroller: HTMLDivElement) => {
    if (loading) return;
    if (hiddenLoadedGroupCount <= 0 && !hasOlder) return;
    stickToBottomRef.current = false;
    if (revealOlderLoadedGroups(scroller)) return;
    preserveScrollForPrepend(scroller, 'server-prepend');
    setVisibleGroupCount((count) => count + RENDERED_GROUP_INCREMENT);
    onLoadOlder();
  };

  const collapseOlderLoadedGroupsAtBottom = (scroller: HTMLDivElement) => {
    if (visibleGroupCount <= INITIAL_RENDERED_GROUP_LIMIT) {
      if (scrollPreservationRef.current?.mode === 'server-prepend') scrollPreservationRef.current = null;
      return;
    }
    preserveScrollForPrepend(scroller, 'next-layout');
    setVisibleGroupCount(INITIAL_RENDERED_GROUP_LIMIT);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const isAtBottom = distanceFromBottom <= BOTTOM_STICKY_THRESHOLD_PX;
    stickToBottomRef.current = isAtBottom;

    if (isAtBottom) collapseOlderLoadedGroupsAtBottom(scroller);
    if (!isAtBottom && scroller.scrollTop <= 80) requestOlder(scroller);
  };

  const handleJumpToLatest = () => {
    stickToBottomRef.current = true;
    setVisibleGroupCount(INITIAL_RENDERED_GROUP_LIMIT);
    onJumpToLatest();
  };

  const handleLoadOlderClick = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    requestOlder(scroller);
  };

  return (
    <div ref={scrollerRef} className="chat-scroll" onScroll={handleScroll}>
      <div ref={columnRef} className="chat-column">
        {(hiddenLoadedGroupCount > 0 || hasOlder || showJumpToLatest) && (
          <div className="timeline-pager">
            {(hiddenLoadedGroupCount > 0 || hasOlder) && (
              <button className="load-more" type="button" onClick={handleLoadOlderClick} disabled={loading}>
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
        {renderedGroups.map((entry, index) =>
          Array.isArray(entry) ? (
            <ActivityBlock
              key={`activity:${entry[0]?.id ?? 'empty'}`}
              items={entry}
              running={runningAppendsToLastActivity && index === lastGroupIndex}
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
              onOpenMentionedFile={onOpenMentionedFile}
            />
          ),
        )}
        {showActivityRunning && !runningAppendsToLastActivity && (
          <ActivityBlock key="activity:running" items={[]} running onOpenDetail={onOpenDetail} />
        )}
        {items.length === 0 && !showActivityRunning && <div className="chat-empty">{loading ? 'Loading messages...' : 'No messages loaded.'}</div>}
      </div>
    </div>
  );
}
