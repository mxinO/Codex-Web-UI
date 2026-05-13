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

export type GitUntrackedMode = 'normal' | 'all' | 'no';

export interface GitTrackedRepo {
  id: string;
  path: string;
  label: string;
  addedAt: number;
  untrackedMode?: GitUntrackedMode;
}

export interface GitWorkspaceState {
  cwd: string;
  repos: GitTrackedRepo[];
}

export type GitStatusKind = 'staged' | 'unstaged' | 'untracked' | 'ignored' | 'conflict';

export interface GitStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: GitStatusKind;
  isDirectory?: boolean;
  submodule?: string;
}

export interface GitStatusResult {
  repoId: string;
  path: string;
  branch: string | null;
  headOid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: GitStatusEntry[];
  refreshedAt: number;
  truncated: boolean;
}

export interface GitDiffResult {
  repoId: string;
  path: string;
  scope: 'staged' | 'unstaged' | 'untracked';
  patch: string;
  truncated: boolean;
  binary?: boolean;
  before?: string;
  after?: string;
}

export interface HostRuntimeState {
  hostname: string;
  activeThreadId: string | null;
  activeThreadPath: string | null;
  activeTurnId: string | null;
  activeCwd: string | null;
  model: string | null;
  effort: CodexReasoningEffort | null;
  mode: CodexCollaborationMode | null;
  sandbox: CodexSandboxMode | null;
  authTokenHash: string | null;
  appServerUrl: string | null;
  appServerPid: number | null;
  queue: QueuedMessage[];
  recentCwds: string[];
  gitWorkspaces: GitWorkspaceState[];
  theme: 'dark' | 'light';
}

export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}
