import type { ClientQueuedMessage } from '../hooks/useQueue';

interface QueueCardProps {
  message: ClientQueuedMessage;
  onEdit: (message: ClientQueuedMessage) => void;
  onRemove: (message: ClientQueuedMessage) => void;
}

export default function QueueCard({ message, onEdit, onRemove }: QueueCardProps) {
  return (
    <article className="queued-message">
      <div className="queued-badge">Queued</div>
      <div className="queued-text">{message.text}</div>
      <div className="queued-actions">
        <button className="text-button" type="button" onClick={() => onEdit(message)}>
          Edit
        </button>
        <button className="text-button" type="button" onClick={() => onRemove(message)}>
          Cancel
        </button>
      </div>
    </article>
  );
}
