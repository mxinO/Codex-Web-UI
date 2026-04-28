export interface RuntimeStatus {
  hostname: string;
  activeThreadId: string | null;
  activeCwd: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  sandbox: string | null;
}

export interface CodexRunOptions {
  model: string | null;
  mode: string | null;
  effort: string | null;
  sandbox: string | null;
}
