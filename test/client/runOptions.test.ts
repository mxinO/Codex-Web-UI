import { describe, expect, it } from 'vitest';
import {
  displayRuntimeValue,
  effectiveMode,
  legacySandboxFromMode,
  sanitizeStoredEffort,
  sanitizeStoredMode,
  sanitizeStoredSandbox,
} from '../../src/lib/runOptions';

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

  it('does not let local launch settings mask cleared active-session runtime status', () => {
    expect(displayRuntimeValue('thread-1', null, 'gpt-5.5')).toBeNull();
    expect(displayRuntimeValue('thread-1', 'gpt-5.4', 'gpt-5.5')).toBe('gpt-5.4');
    expect(displayRuntimeValue(null, null, 'gpt-5.5')).toBe('gpt-5.5');
  });
});
