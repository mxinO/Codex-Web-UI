export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface HostRuntimeState {
  hostname: string;
  activeThreadId: string | null;
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
