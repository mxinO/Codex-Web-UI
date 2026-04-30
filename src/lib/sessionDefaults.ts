export function newSessionInitialCwd(activeCwd: string | null | undefined, startCwd: string | null | undefined): string {
  const active = activeCwd?.trim();
  if (active) return active;
  const started = startCwd?.trim();
  return started || '/';
}
