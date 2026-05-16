import { describe, expect, it } from 'vitest';
import { isNodeUndiciWasmAllocationFailure, shouldExitForUnhandledRejection } from '../../server/processErrors.js';

describe('process error handling', () => {
  it('recognizes Node undici wasm allocation failures', () => {
    const error = new RangeError('WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance');
    error.stack = `${error.name}: ${error.message}\n    at lazyllhttp (node:internal/deps/undici/undici:5971:32)`;

    expect(isNodeUndiciWasmAllocationFailure(error)).toBe(true);
  });

  it('does not classify unrelated range errors as ignorable undici startup failures', () => {
    const error = new RangeError('Maximum call stack size exceeded');
    error.stack = `${error.name}: ${error.message}\n    at app (server/index.ts:1:1)`;

    expect(isNodeUndiciWasmAllocationFailure(error)).toBe(false);
    expect(isNodeUndiciWasmAllocationFailure('WebAssembly.instantiate(): Out of memory')).toBe(false);
  });

  it('exits for unknown startup rejections but keeps runtime log-only behavior', () => {
    const error = new Error('database migration failed');

    expect(shouldExitForUnhandledRejection(error, { startupComplete: false })).toBe(true);
    expect(shouldExitForUnhandledRejection(error, { startupComplete: true })).toBe(false);
  });

  it('does not exit for the known undici wasm allocation rejection during startup', () => {
    const error = new RangeError('WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance');
    error.stack = `${error.name}: ${error.message}\n    at lazyllhttp (node:internal/deps/undici/undici:5971:32)`;

    expect(shouldExitForUnhandledRejection(error, { startupComplete: false })).toBe(false);
    expect(shouldExitForUnhandledRejection(error, { startupComplete: true })).toBe(false);
  });
});
