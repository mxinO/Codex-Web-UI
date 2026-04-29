export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexCollaborationMode = 'default' | 'plan';

export interface CodexRunOptions {
  model?: string;
  effort?: CodexReasoningEffort;
  mode?: CodexCollaborationMode;
  sandbox?: CodexSandboxMode;
}

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  options?: CodexRunOptions;
}

export interface HostRuntimeState {
  hostname: string;
  activeThreadId: string | null;
  activeThreadPath: string | null;
  activeTurnId: string | null;
  activeCwd: string | null;
  authTokenHash: string | null;
  appServerUrl: string | null;
  appServerPid: number | null;
  queue: QueuedMessage[];
  recentCwds: string[];
  theme: 'dark' | 'light';
}

export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}
