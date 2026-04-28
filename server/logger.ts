export function logInfo(message: string, meta?: unknown) {
  if (meta === undefined) console.log(`[info] ${message}`);
  else console.log(`[info] ${message}`, meta);
}

export function logWarn(message: string, meta?: unknown) {
  if (meta === undefined) console.warn(`[warn] ${message}`);
  else console.warn(`[warn] ${message}`, meta);
}

export function logError(message: string, meta?: unknown) {
  if (meta === undefined) console.error(`[error] ${message}`);
  else console.error(`[error] ${message}`, meta);
}
