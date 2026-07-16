export interface RuntimeStatus {
  hostname: string;
  activeThreadId: string | null;
  activeCwd: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  sandbox: string | null;
}

export interface RuntimeTurnContext {
  turnId: string | null;
  model: string;
  effort: string | null;
  recordedAt: string | null;
}

export type RuntimeLastTurn =
  | { status: 'found'; context: RuntimeTurnContext; scannedBytes: number }
  | { status: 'none' | 'unavailable' | 'scanLimit'; context: null; scannedBytes: number; detail?: string };

export type RuntimeStatusConfirmationSource = 'threadStart' | 'threadResume' | 'settingsUpdated';

export interface RuntimeStatusResult {
  hostname: string;
  threadId: string | null;
  cwd: string | null;
  activeTurnId: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  sandbox: string | null;
  confirmed: boolean;
  confirmationSource: RuntimeStatusConfirmationSource | null;
  confirmedAt: string | null;
  lastTurn: RuntimeLastTurn;
}

export interface CodexRunOptions {
  model: string | null;
  mode: string | null;
  effort: string | null;
  sandbox: string | null;
}

export interface ModelCapacityRetry {
  status: 'scheduled' | 'starting' | 'inFlight';
  threadId: string;
  failedTurnId: string;
  attempt: number;
  retryAt: number | null;
  claimedAt: number | null;
  operationId: string;
  retryTurnId: string | null;
  reconcileCursor: string | null;
  cancelRequested: boolean;
  options?: Partial<CodexRunOptions>;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
}

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
