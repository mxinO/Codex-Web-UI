import { describe, expect, it } from 'vitest';
import { readConfig } from '../../server/config.js';

describe('readConfig', () => {
  it('accepts a state directory from argv', () => {
    expect(readConfig(['--state-dir', '/tmp/codex-web-ui-state'], {}).stateDir).toBe('/tmp/codex-web-ui-state');
  });

  it('keeps the environment state directory fallback', () => {
    expect(readConfig([], { CODEX_WEB_UI_STATE_DIR: '/tmp/env-state' }).stateDir).toBe('/tmp/env-state');
  });
});
