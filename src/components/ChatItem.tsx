import type { TimelineItem } from '../lib/timeline';

export default function ChatItem({ item }: { item: TimelineItem }) {
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
        <div className="chat-bubble chat-bubble--assistant">{item.text}</div>
      </div>
    );
  }

  if (item.kind === 'command') {
    return (
      <div className="chat-row chat-row--assistant">
        <button className="tool-card" type="button">
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

  return (
    <div className="chat-row chat-row--system">
      <div className="chat-notice">{item.kind}</div>
    </div>
  );
}
