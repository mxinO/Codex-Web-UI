import { describe, expect, it } from 'vitest';
import { newSessionInitialCwd } from '../../src/lib/sessionDefaults';

describe('newSessionInitialCwd', () => {
  it('uses the active session cwd when a session is loaded', () => {
    expect(newSessionInitialCwd('/active/project', '/server/start')).toBe('/active/project');
  });

  it('falls back to the server start cwd when no session is loaded', () => {
    expect(newSessionInitialCwd(null, '/server/start')).toBe('/server/start');
  });

  it('uses root only when neither cwd is known', () => {
    expect(newSessionInitialCwd(null, null)).toBe('/');
  });
});
