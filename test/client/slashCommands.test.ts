import { describe, expect, it } from 'vitest';
import { classifySlashCommand, parseSlashCommand } from '../../src/lib/slashCommands';

describe('slash commands', () => {
  it('allows local commands while turn is active', () => {
    expect(classifySlashCommand('/status', true).allowed).toBe(true);
  });

  it('blocks state-changing commands while turn is active', () => {
    expect(classifySlashCommand('/model gpt-5.4', true).allowed).toBe(false);
  });

  it('allows compact and diff as supported compatibility-gated commands', () => {
    expect(classifySlashCommand('/compact', false)).toEqual({
      command: '/compact',
      allowed: true,
      reason: null,
    });
    expect(classifySlashCommand('/diff', false)).toEqual({ command: '/diff', allowed: true, reason: null });
  });

  it('rejects unsupported commands instead of dispatching placeholders', () => {
    expect(classifySlashCommand('/unknown', false)).toEqual({
      command: '/unknown',
      allowed: false,
      reason: '/unknown is not supported in the web UI',
    });
  });

  it('parses command values for local handlers', () => {
    expect(parseSlashCommand('/model gpt-5.4 mini')).toEqual({
      command: '/model',
      args: ['gpt-5.4', 'mini'],
      value: 'gpt-5.4 mini',
    });
  });
});
