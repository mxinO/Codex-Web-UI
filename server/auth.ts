import crypto from 'node:crypto';
import cookie from 'cookie';

export const AUTH_COOKIE = 'codex_webui_token';
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function authCookieName(scope?: string | null): string {
  if (!scope) return AUTH_COOKIE;
  const suffix = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 12);
  return `${AUTH_COOKIE}_${suffix}`;
}

export function authScopeFromHostHeader(hostHeader: string | undefined, fallbackScope?: string | null): string | null {
  const host = hostHeader?.split(',')[0]?.trim().toLowerCase();
  return host || fallbackScope || null;
}

export function createAuthToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isTokenValid(expected: string, actual: string | null | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isTokenHashValid(
  expectedHash: string | null | undefined,
  actualToken: string | null | undefined,
): boolean {
  if (!expectedHash || !actualToken) return false;
  return isTokenValid(expectedHash, hashToken(actualToken));
}

export function isTokenAuthorized(
  currentToken: string,
  acceptedTokenHashes: Iterable<string | null | undefined>,
  actualToken: string | null | undefined,
): boolean {
  if (isTokenValid(currentToken, actualToken)) return true;
  for (const expectedHash of acceptedTokenHashes) {
    if (isTokenHashValid(expectedHash, actualToken)) return true;
  }
  return false;
}

export function parseTokenFromCookie(header: string | undefined, scope?: string | null): string | null {
  return parseTokenFromCookieScopes(header, [scope]);
}

export function parseTokenFromCookieScopes(
  header: string | undefined,
  scopes: Iterable<string | null | undefined>,
): string | null {
  if (!header) return null;
  const parsed = cookie.parse(header);
  for (const scope of scopes) {
    if (!scope) continue;
    const scopedToken = parsed[authCookieName(scope)];
    if (scopedToken) return scopedToken;
  }
  return parsed[AUTH_COOKIE] ?? null;
}

export function authCookie(token: string, scope?: string | null): string {
  return cookie.serialize(authCookieName(scope), token, {
    httpOnly: true,
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    path: '/',
  });
}
