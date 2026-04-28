import type { CodexItem, CodexTurn } from '../types/codex';

export type TimelineItem =
  | { id: string; kind: 'user'; timestamp: number; text: string }
  | { id: string; kind: 'assistant'; timestamp: number; text: string; phase: string | null }
  | { id: string; kind: 'command'; timestamp: number; command: string; cwd: string; output: string; status: string; exitCode: number | null }
  | { id: string; kind: 'fileChange'; timestamp: number; item: CodexItem }
  | { id: string; kind: 'tool'; timestamp: number; item: CodexItem }
  | { id: string; kind: 'notice'; timestamp: number; text: string };

function userText(item: Extract<CodexItem, { type: 'userMessage' }>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => part.text ?? part.path ?? part.url ?? '').join('');
}

function safeItemId(turn: CodexTurn, item: CodexItem, index: number): string {
  return `${turn.id}:${item.id ?? index}`;
}

export function turnToTimelineItems(turn: CodexTurn): TimelineItem[] {
  const timestamp = (turn.startedAt ?? 0) * 1000;
  const items = Array.isArray(turn.items) ? turn.items : [];

  return items.map((item, index) => {
    const id = safeItemId(turn, item, index);
    if (item.type === 'userMessage') return { id, kind: 'user', timestamp, text: userText(item) };
    if (item.type === 'agentMessage') return { id, kind: 'assistant', timestamp, text: item.text, phase: item.phase };
    if (item.type === 'commandExecution') {
      return {
        id,
        kind: 'command',
        timestamp,
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? '',
        status: item.status,
        exitCode: item.exitCode,
      };
    }
    if (item.type === 'fileChange') return { id, kind: 'fileChange', timestamp, item };
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      return { id, kind: 'notice', timestamp, text: [...summary, ...content].join('\n') };
    }
    if (item.type === 'plan') return { id, kind: 'notice', timestamp, text: item.text };
    return { id, kind: 'tool', timestamp, item };
  });
}

export function trimTimelineWindow<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}
