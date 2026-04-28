import { describe, expect, it } from 'vitest';
import {
  createAuthToken,
  hashToken,
  isTokenHashValid,
  isTokenValid,
  parseTokenFromCookie,
} from '../../server/auth.js';

describe('auth helpers', () => {
  it('creates random tokens with enough entropy', () => {
    const a = createAuthToken();
    const b = createAuthToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('validates exact token matches only', () => {
    const token = createAuthToken();
    expect(isTokenValid(token, token)).toBe(true);
    expect(isTokenValid(token, `${token}x`)).toBe(false);
    expect(isTokenValid(token, '')).toBe(false);
  });

  it('validates persisted token hashes against raw tokens', () => {
    const token = createAuthToken();
    const expectedHash = hashToken(token);

    expect(isTokenHashValid(expectedHash, token)).toBe(true);
    expect(isTokenHashValid(expectedHash, createAuthToken())).toBe(false);
    expect(isTokenHashValid(expectedHash, '')).toBe(false);
    expect(isTokenHashValid(null, token)).toBe(false);
  });

  it('parses cookie token', () => {
    expect(parseTokenFromCookie('codex_webui_token=abc; theme=dark')).toBe('abc');
    expect(parseTokenFromCookie('theme=dark')).toBeNull();
  });
});
