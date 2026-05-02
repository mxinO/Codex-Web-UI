export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const COLLABORATION_MODES = ['default', 'plan'] as const;
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);
const COLLABORATION_MODE_SET = new Set<string>(COLLABORATION_MODES);
const SANDBOX_MODE_SET = new Set<string>(SANDBOX_MODES);

function validStoredValue(value: string | null, allowed: Set<string>): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return allowed.has(trimmed) ? trimmed : null;
}

export function sanitizeStoredModel(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function sanitizeStoredEffort(value: string | null): string | null {
  return validStoredValue(value, REASONING_EFFORT_SET);
}

export function sanitizeStoredMode(value: string | null): string | null {
  return validStoredValue(value, COLLABORATION_MODE_SET);
}

export function sanitizeStoredSandbox(value: string | null): string | null {
  return validStoredValue(value, SANDBOX_MODE_SET);
}

export function legacySandboxFromMode(value: string | null): string | null {
  const prefix = 'sandbox:';
  if (!value?.startsWith(prefix)) return null;
  return sanitizeStoredSandbox(value.slice(prefix.length));
}

export function effectiveMode(mode: string | null, model: string | null): string | null {
  return model ? sanitizeStoredMode(mode) : null;
}

export function displayRuntimeValue(activeThreadId: string | null | undefined, serverValue: string | null, localValue: string | null): string | null {
  return activeThreadId ? serverValue : localValue ?? serverValue;
}
