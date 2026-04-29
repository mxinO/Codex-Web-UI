import path from 'node:path';

function cleanEnvPath(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return path.resolve(value);
}

export function resolvePackageRoot(env = process.env, cwd = process.cwd()): string {
  return cleanEnvPath(env.CODEX_WEB_UI_PACKAGE_ROOT) ?? cwd;
}

export function resolveStartCwd(env = process.env, cwd = process.cwd()): string {
  return cleanEnvPath(env.CODEX_WEB_UI_START_CWD) ?? cwd;
}
