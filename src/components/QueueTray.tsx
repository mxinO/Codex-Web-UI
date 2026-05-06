import type { ClientQueuedMessage } from '../hooks/useQueue';
import QueueCard from './QueueCard';

interface QueueTrayProps {
  messages: ClientQueuedMessage[];
  onEdit: (message: ClientQueuedMessage) => void;
  onCancel: (message: ClientQueuedMessage) => void;
}

export default function QueueTray({ messages, onEdit, onCancel }: QueueTrayProps) {
  if (messages.length === 0) return null;

  return (
    <section className="queue-tray" aria-label="Queued messages">
      <div className="queue-tray__header">
        <span>Queued</span>
        <small>{messages.length}</small>
      </div>
      <div className="queue-tray__list">
        {messages.map((message) => (
          <QueueCard key={message.id} message={message} onEdit={onEdit} onRemove={onCancel} />
        ))}
      </div>
    </section>
  );
}
