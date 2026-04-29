export interface CodexThread {
  id: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  path?: string | null;
  cwd: string;
  name: string | null;
  turns: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: CodexItem[];
  startedAt: number | null;
  completedAt: number | null;
}

export type CodexItem =
  | { type: 'userMessage'; id: string; content: Array<{ type: string; text?: string; path?: string; url?: string }> }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: unknown[]; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; result: unknown; error: unknown }
  | { type: string; id: string; [key: string]: unknown };
