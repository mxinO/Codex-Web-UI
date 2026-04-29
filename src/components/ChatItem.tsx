import { lazy, Suspense } from 'react';
import { FileDiff } from 'lucide-react';
import type { TimelineItem } from '../lib/timeline';
import ApprovalCard from './ApprovalCard';
import QueueCard from './QueueCard';
import StreamingCard from './StreamingCard';

const MarkdownView = lazy(() => import('./MarkdownView'));

interface ChatItemProps {
  item: TimelineItem;
  onOpenDetail: (item: TimelineItem) => void;
  onApprovalDecision: (item: Extract<TimelineItem, { kind: 'approval' }>, decision: unknown) => Promise<void>;
  onQueuedEdit?: (message: Extract<TimelineItem, { kind: 'queued' }>['message']) => void;
  onQueuedRemove?: (id: string) => void;
  onOpenFileSummary?: (turnId: string, path: string, changeCount: number) => void;
}

function itemString(value: unknown, key: string, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
}

function basename(path: string | null): string {
  if (!path) return 'file';
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function toolLabel(item: TimelineItem): string {
  if (item.kind !== 'tool') return 'Tool';
  const raw = item.item;
  const type = itemString(raw, 'type', 'unknown');
  if (type === 'mcpToolCall') {
    const server = itemString(raw, 'server', '');
    const tool = itemString(raw, 'tool', 'tool');
    return `MCP: ${server ? `${server}.` : ''}${tool}`;
  }
  if (/web.*search|search/i.test(type)) {
    const query = itemString(raw, 'query', itemString(raw, 'text', 'search'));
    return `Web search: ${query}`;
  }
  return `Tool: ${type}`;
}

export default function ChatItem({ item, onOpenDetail, onApprovalDecision, onQueuedEdit, onQueuedRemove, onOpenFileSummary }: ChatItemProps) {
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

  if (item.kind === 'bangCommand') {
    const failed = item.exitCode !== null && item.exitCode !== 0;
    return (
      <div className="chat-row chat-row--user">
        <article className={`bang-card${failed ? ' bang-card--failed' : ''}`}>
          <button className="bang-card__header" type="button" onClick={() => onOpenDetail(item)} title={item.cwd}>
            <span>$ {item.command}</span>
            <small>{item.exitCode === null ? item.status : item.exitCode === 0 ? 'ok' : `exit ${item.exitCode}`}</small>
          </button>
          {item.output && <pre className="bang-card__output">{item.output}</pre>}
        </article>
      </div>
    );
  }

  if (item.kind === 'queued') {
    return (
      <div className="chat-row chat-row--user">
        <QueueCard
          message={item.message}
          onEdit={(message) => onQueuedEdit?.(message)}
          onRemove={(id) => onQueuedRemove?.(id)}
        />
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

  if (item.kind === 'warning' || item.kind === 'error') {
    return (
      <div className="chat-row chat-row--system">
        <div className={`chat-notice chat-notice--${item.kind}`}>{item.text || item.kind}</div>
      </div>
    );
  }

  if (item.kind === 'fileChangeSummary') {
    const totalEdits = item.files.reduce((sum, file) => sum + file.changeCount, 0);
    return (
      <div className="chat-row chat-row--system">
        <article className="file-summary-card">
          <div className="file-summary-card__header">
            <span>Files changed</span>
            <small>{item.files.length} files - {totalEdits} edits</small>
          </div>
          <div className="file-summary-card__list">
            {item.files.map((file) => (
              <div className="file-summary-card__row" key={file.path} title={file.path}>
                <span>{basename(file.path)}</span>
                <small>{file.changeCount > 1 ? `${file.changeCount} edits` : '1 edit'}</small>
                <button
                  className="file-summary-card__diff"
                  type="button"
                  title="See diff"
                  aria-label={`See diff for ${file.path}`}
                  onClick={() => onOpenFileSummary?.(item.turnId, file.path, file.changeCount)}
                >
                  <FileDiff size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </article>
      </div>
    );
  }

  if (item.kind === 'fileChange') {
    const label = item.filePath ? basename(item.filePath) : itemString(item.item, 'status', 'updated');
    const count = (item.changeCount ?? 1) > 1 ? ` (${item.changeCount} edits)` : '';
    return (
      <div className="chat-row chat-row--system">
        <button className="tool-card" type="button" onClick={() => onOpenDetail(item)}>
          File change: {label}{count}
        </button>
      </div>
    );
  }

  return (
    <div className="chat-row chat-row--system">
      <button className="tool-card" type="button" onClick={() => onOpenDetail(item)}>
        {toolLabel(item)}
      </button>
    </div>
  );
}
