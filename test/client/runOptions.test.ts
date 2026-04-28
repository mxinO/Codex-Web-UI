import { describe, expect, it } from 'vitest';
import { effectiveMode, legacySandboxFromMode, sanitizeStoredEffort, sanitizeStoredMode, sanitizeStoredSandbox } from '../../src/lib/runOptions';

describe('run option storage helpers', () => {
  it('drops legacy sandbox mode values from collaboration mode storage', () => {
    expect(sanitizeStoredMode('sandbox:workspace-write')).toBeNull();
    expect(legacySandboxFromMode('sandbox:workspace-write')).toBe('workspace-write');
  });

  it('keeps only protocol-supported run option values', () => {
    expect(sanitizeStoredMode('plan')).toBe('plan');
    expect(sanitizeStoredMode('review')).toBeNull();
    expect(sanitizeStoredEffort('xhigh')).toBe('xhigh');
    expect(sanitizeStoredEffort('maximum')).toBeNull();
    expect(sanitizeStoredSandbox('danger-full-access')).toBe('danger-full-access');
    expect(sanitizeStoredSandbox('sandbox:workspace-write')).toBeNull();
  });

  it('drops collaboration mode when no model is set', () => {
    expect(effectiveMode('plan', null)).toBeNull();
    expect(effectiveMode('plan', 'gpt-5.5')).toBe('plan');
  });
});
