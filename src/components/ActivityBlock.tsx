import { AlertTriangle, FileDiff, Files, Info, Terminal, Wrench, XCircle } from 'lucide-react';
import type { TimelineItem } from '../lib/timeline';

interface ActivityBlockProps {
  items: TimelineItem[];
  onOpenDetail: (item: TimelineItem) => void;
  onOpenFileSummary?: (turnId: string, path: string, changeCount: number) => void;
}

type ActivityRowProps = Omit<ActivityBlockProps, 'items'> & { item: TimelineItem };

function itemString(value: unknown, key: string, fallback = ''): string {
  if (typeof value !== 'object' || value === null) return fallback;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
}

function basename(path: string | null | undefined): string {
  if (!path) return 'file';
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function compactPath(path: string | null | undefined): string {
  if (!path) return '';
  return path.length > 58 ? `...${path.slice(-55)}` : path;
}

function toolTitle(item: Extract<TimelineItem, { kind: 'tool' }>): string {
  const raw = item.item;
  const type = itemString(raw, 'type', 'unknown');
  if (type === 'mcpToolCall') {
    const server = itemString(raw, 'server');
    const tool = itemString(raw, 'tool', 'tool');
    return `MCP: ${server ? `${server}.` : ''}${tool}`;
  }
  if (/web.*search|search/i.test(type)) {
    const query = itemString(raw, 'query', itemString(raw, 'text', 'search'));
    return `Web search: ${query}`;
  }
  return `Tool: ${type}`;
}

function toolMeta(item: Extract<TimelineItem, { kind: 'tool' }>): string {
  const status = itemString(item.item, 'status', '');
  if (status === 'completed' || status === 'success' || status === 'ok') return 'Tool result';
  if (status === 'running' || status === 'pending') return 'Tool call running';
  return status ? `Tool ${status}` : 'Tool call';
}

function commandStatus(item: Extract<TimelineItem, { kind: 'command' }>): string {
  if (item.exitCode === null) return item.status || 'running';
  return item.exitCode === 0 ? 'ok' : `exit ${item.exitCode}`;
}

function ActivityIcon({ item }: { item: TimelineItem }) {
  const size = 15;
  if (item.kind === 'command') return <Terminal size={size} aria-hidden="true" />;
  if (item.kind === 'tool') return <Wrench size={size} aria-hidden="true" />;
  if (item.kind === 'fileChange') return <FileDiff size={size} aria-hidden="true" />;
  if (item.kind === 'fileChangeSummary') return <Files size={size} aria-hidden="true" />;
  if (item.kind === 'warning') return <AlertTriangle size={size} aria-hidden="true" />;
  if (item.kind === 'error') return <XCircle size={size} aria-hidden="true" />;
  return <Info size={size} aria-hidden="true" />;
}

function activityClass(item: TimelineItem): string {
  if (item.kind === 'command') return item.exitCode !== null && item.exitCode !== 0 ? 'activity-card--error' : 'activity-card--command';
  if (item.kind === 'tool') return toolMeta(item).includes('result') ? 'activity-card--tool-result' : 'activity-card--tool';
  if (item.kind === 'fileChange' || item.kind === 'fileChangeSummary') return 'activity-card--edit';
  if (item.kind === 'warning') return 'activity-card--warning';
  if (item.kind === 'error') return 'activity-card--error';
  return 'activity-card--notice';
}

function activityContent(item: TimelineItem): { title: string; meta: string; badge: string; clickable: boolean } {
  if (item.kind === 'command') {
    return { title: `$ ${item.command}`, meta: 'Command execution', badge: commandStatus(item), clickable: true };
  }
  if (item.kind === 'tool') {
    return { title: toolTitle(item), meta: toolMeta(item), badge: 'details', clickable: true };
  }
  if (item.kind === 'fileChange') {
    const count = item.changeCount ?? 1;
    return {
      title: `Edited ${basename(item.filePath)}`,
      meta: compactPath(item.filePath) || 'File edit',
      badge: count > 1 ? `${count} edits` : 'diff',
      clickable: true,
    };
  }
  if (item.kind === 'fileChangeSummary') {
    const edits = item.files.reduce((sum, file) => sum + file.changeCount, 0);
    return { title: 'Files changed', meta: `${item.files.length} files, ${edits} edits`, badge: 'summary', clickable: false };
  }
  if (item.kind === 'warning') return { title: item.text || 'Warning', meta: 'Warning', badge: 'warn', clickable: false };
  if (item.kind === 'error') return { title: item.text || 'Error', meta: 'Error', badge: 'error', clickable: false };
  if (item.kind === 'notice') return { title: item.text || 'Notice', meta: 'Notice', badge: 'info', clickable: false };
  return { title: 'Activity', meta: item.kind, badge: 'details', clickable: false };
}

function ActivityRow({ item, onOpenDetail, onOpenFileSummary }: ActivityRowProps) {
  const content = activityContent(item);
  const rowClass = `activity-card ${activityClass(item)}`;
  const body = (
    <>
      <span className="activity-card__icon">
        <ActivityIcon item={item} />
      </span>
      <span className="activity-card__body">
        <strong>{content.title}</strong>
        <small>{content.meta}</small>
        {item.kind === 'fileChangeSummary' && (
          <span className="activity-card__files">
            {item.files.map((file) => (
              <span className="activity-file" key={file.path} title={file.path}>
                <span>{basename(file.path)}</span>
                <small>{file.changeCount > 1 ? `${file.changeCount} edits` : '1 edit'}</small>
                <button
                  className="activity-file__diff"
                  type="button"
                  title="See diff"
                  aria-label={`See diff for ${file.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenFileSummary?.(item.turnId, file.path, file.changeCount);
                  }}
                >
                  <FileDiff size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="activity-card__badge">{content.badge}</span>
    </>
  );

  if (content.clickable) {
    return (
      <button className={rowClass} type="button" onClick={() => onOpenDetail(item)}>
        {body}
      </button>
    );
  }

  return <div className={rowClass}>{body}</div>;
}

export default function ActivityBlock({ items, onOpenDetail, onOpenFileSummary }: ActivityBlockProps) {
  const label = items.length === 1 ? 'Activity' : 'Activity';
  return (
    <div className="activity-block">
      <div className="activity-block__header">
        <span>{label}</span>
        <small>{items.length === 1 ? '1 event' : `${items.length} events`}</small>
      </div>
      <div className="activity-block__list">
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} onOpenDetail={onOpenDetail} onOpenFileSummary={onOpenFileSummary} />
        ))}
      </div>
    </div>
  );
}
