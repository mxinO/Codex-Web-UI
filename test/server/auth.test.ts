import { describe, expect, it } from 'vitest';
import {
  createAuthToken,
  authCookie,
  authCookieName,
  authScopeFromHostHeader,
  hashToken,
  isTokenAuthorized,
  isTokenHashValid,
  isTokenValid,
  parseTokenFromCookie,
  parseTokenFromCookieScopes,
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

  it('authorizes the current token and accepted persisted token hashes', () => {
    const current = createAuthToken();
    const previous = createAuthToken();

    expect(isTokenAuthorized(current, [hashToken(previous)], current)).toBe(true);
    expect(isTokenAuthorized(current, [hashToken(previous)], previous)).toBe(true);
    expect(isTokenAuthorized(current, [hashToken(previous)], createAuthToken())).toBe(false);
  });

  it('parses cookie token', () => {
    expect(parseTokenFromCookie('codex_webui_token=abc; theme=dark')).toBe('abc');
    expect(parseTokenFromCookie('theme=dark')).toBeNull();
  });

  it('uses scoped cookie names while keeping legacy cookie fallback', () => {
    const scopedName = authCookieName('host-a:3002');
    expect(scopedName).toMatch(/^codex_webui_token_[a-f0-9]{12}$/);
    expect(parseTokenFromCookie(`${scopedName}=scoped; codex_webui_token=legacy`, 'host-a:3002')).toBe('scoped');
    expect(parseTokenFromCookie('codex_webui_token=legacy', 'host-a:3002')).toBe('legacy');
    expect(authCookie('secret', 'host-a:3002')).toContain(`${scopedName}=secret`);
  });

  it('derives cookie scope from request host and falls back to compatible scopes', () => {
    const requestScope = authScopeFromHostHeader('Example.test:3002', 'fallback:3002');
    const requestCookie = `${authCookieName('example.test:3002')}=request`;
    const fallbackCookie = `${authCookieName('fallback:3002')}=fallback`;

    expect(requestScope).toBe('example.test:3002');
    expect(authScopeFromHostHeader(undefined, 'fallback:3002')).toBe('fallback:3002');
    expect(parseTokenFromCookieScopes(`${requestCookie}; ${fallbackCookie}`, ['example.test:3002', 'fallback:3002'])).toBe('request');
    expect(parseTokenFromCookieScopes(fallbackCookie, ['example.test:3002', 'fallback:3002'])).toBe('fallback');
  });
});
