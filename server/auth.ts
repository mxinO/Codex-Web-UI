import crypto from 'node:crypto';
import cookie from 'cookie';

export const AUTH_COOKIE = 'codex_webui_token';

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

export function parseTokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  return cookie.parse(header)[AUTH_COOKIE] ?? null;
}

export function authCookie(token: string): string {
  return cookie.serialize(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}
