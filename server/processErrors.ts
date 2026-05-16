import { logError, logInfo, logWarn } from './logger.js';

let installed = false;
let startupComplete = false;

export function isNodeUndiciWasmAllocationFailure(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;

  return (
    reason.name === 'RangeError' &&
    reason.message.includes('WebAssembly.instantiate(): Out of memory') &&
    reason.message.includes('Cannot allocate Wasm memory') &&
    /(?:node:internal\/deps\/undici\/undici|lazyllhttp)/.test(reason.stack ?? '')
  );
}

export function shouldExitForUnhandledRejection(reason: unknown, options: { startupComplete: boolean }): boolean {
  return !options.startupComplete && !isNodeUndiciWasmAllocationFailure(reason);
}

export function markProcessStartupComplete(): void {
  startupComplete = true;
}

export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (error) => {
    logError('Uncaught exception', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (!startupComplete && isNodeUndiciWasmAllocationFailure(reason)) {
      logWarn('Suppressed Node undici WebAssembly allocation failure', reason);
      return;
    }
    logError('Unhandled rejection', reason);
    if (shouldExitForUnhandledRejection(reason, { startupComplete })) {
      process.exit(1);
    }
  });

  process.on('exit', (code) => {
    logInfo('Codex Web UI process exiting', { code, pid: process.pid });
  });
}
