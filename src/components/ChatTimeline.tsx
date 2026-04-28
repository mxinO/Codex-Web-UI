import type { TimelineItem } from '../lib/timeline';
import ChatItem from './ChatItem';

interface ChatTimelineProps {
  items: TimelineItem[];
  onLoadOlder: () => void;
  hasOlder: boolean;
  loading?: boolean;
}

export default function ChatTimeline({ items, onLoadOlder, hasOlder, loading = false }: ChatTimelineProps) {
  return (
    <div className="chat-scroll">
      <div className="chat-column">
        {hasOlder && (
          <button className="load-more" type="button" onClick={onLoadOlder} disabled={loading}>
            {loading ? 'Loading...' : 'Load older'}
          </button>
        )}
        {items.map((item) => (
          <ChatItem key={item.id} item={item} />
        ))}
        {items.length === 0 && <div className="chat-empty">{loading ? 'Loading messages...' : 'No messages loaded.'}</div>}
      </div>
    </div>
  );
}
