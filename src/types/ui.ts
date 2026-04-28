export interface RuntimeStatus {
  hostname: string;
  activeThreadId: string | null;
  activeCwd: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
}
