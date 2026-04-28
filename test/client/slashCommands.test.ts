import { describe, expect, it } from 'vitest';
import { classifySlashCommand } from '../../src/lib/slashCommands';

describe('slash commands', () => {
  it('allows local commands while turn is active', () => {
    expect(classifySlashCommand('/status', true).allowed).toBe(true);
  });

  it('blocks state-changing commands while turn is active', () => {
    expect(classifySlashCommand('/model gpt-5.4', true).allowed).toBe(false);
  });
});
