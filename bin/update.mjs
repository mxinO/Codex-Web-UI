import { spawn as defaultSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

export const DEFAULT_UPDATE_SOURCE = 'https://github.com/mxinO/Codex-Web-UI/archive/refs/heads/main.tar.gz';

const MAX_NPM_ROOT_STDOUT_BYTES = 16 * 1024;
const MAX_INSTALL_STDERR_BYTES = 64 * 1024;
const DEFAULT_STDERR_DRAIN_TIMEOUT_MS = 2_000;

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseUpdateOptions(args) {
  const sourceIndex = args.indexOf('--source');
  if (sourceIndex < 0) return { source: DEFAULT_UPDATE_SOURCE };

  const source = args[sourceIndex + 1];
  if (!source || source.startsWith('--')) {
    throw new Error('Usage: codex-web-ui --update [--source <tarball-url-or-package-spec>]');
  }
  return { source };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateAbsolutePath(value, source) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value) || !isAbsolute(value)) {
    throw new Error(`${source} did not return a valid absolute path`);
  }
  return value;
}

function commandStdout(command, args, onChild) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = defaultSpawn(command, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      onChild?.(child);
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let byteLength = 0;
    let outputTooLarge = false;
    let settled = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      onChild?.(null, child);
      callback(value);
    };

    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_NPM_ROOT_STDOUT_BYTES - byteLength;

      if (remaining > 0) {
        chunks.push(Buffer.from(buffer.subarray(0, remaining)));
        byteLength += Math.min(buffer.length, remaining);
      }

      if (!outputTooLarge && buffer.length > remaining) {
        outputTooLarge = true;
        try {
          child.kill();
        } catch {
          // The close/error event still determines command settlement.
        }
      }
    });

    child.once('error', (error) => settle(reject, error));
    child.once('close', (code, signal) => {
      if (outputTooLarge) {
        settle(reject, new Error(`npm root -g output exceeded ${MAX_NPM_ROOT_STDOUT_BYTES} bytes`));
        return;
      }
      if (signal) {
        settle(reject, new Error(`npm root -g terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        settle(reject, new Error(`npm root -g exited with code ${code ?? 1}`));
        return;
      }
      settle(resolve, Buffer.concat(chunks, byteLength).toString('utf8'));
    });
  });
}

async function resolveNpmGlobalRoot(platform, onChild) {
  const output = await commandStdout(npmCommand(platform), ['root', '-g'], onChild);
  return validateAbsolutePath(output.trim(), 'npm root -g');
}

export function npmRetirementPath(activePath) {
  const absolutePath = resolvePath(activePath);
  const hash = createHash('sha1')
    .update(absolutePath)
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8);
  return join(dirname(absolutePath), `.${basename(absolutePath)}-${hash}`);
}

async function existsViaLstat(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function npmGlobalTreeLayout(globalRoot, platform) {
  const treeTop = dirname(globalRoot);
  if (basename(globalRoot) !== 'node_modules' || (platform !== 'win32' && basename(treeTop) !== 'lib')) {
    throw new Error(`npm global root has an unexpected layout: ${globalRoot}`);
  }
  return { treeTop, rootFromTreeTop: relative(treeTop, globalRoot) };
}

function cleanupActivePaths(globalRoot, platform) {
  const activePaths = [join(globalRoot, 'codex-web-ui')];

  if (platform === 'win32') {
    const prefix = dirname(globalRoot);
    activePaths.push(
      join(prefix, 'codex-web-ui'),
      join(prefix, 'codex-web-ui.cmd'),
      join(prefix, 'codex-web-ui.ps1'),
    );
    return activePaths;
  }

  const libRoot = dirname(globalRoot);
  activePaths.push(join(dirname(libRoot), 'bin', 'codex-web-ui'));
  return activePaths;
}

export async function cleanupCodexRetirementArtifacts(globalRoot, platform = process.platform) {
  const lexicalGlobalRoot = resolvePath(validateAbsolutePath(globalRoot, 'npm global root'));
  const { treeTop, rootFromTreeTop } = npmGlobalTreeLayout(lexicalGlobalRoot, platform);
  if (!rootFromTreeTop || rootFromTreeTop.startsWith('..') || isAbsolute(rootFromTreeTop)) {
    throw new Error(`npm global root is outside its tree top: ${lexicalGlobalRoot}`);
  }
  const canonicalTreeTop = validateAbsolutePath(await realpath(treeTop), 'canonical npm global tree top');
  const arboristGlobalRoot = resolvePath(canonicalTreeTop, rootFromTreeTop);
  const removed = [];

  for (const activePath of cleanupActivePaths(arboristGlobalRoot, platform)) {
    const artifactPath = npmRetirementPath(activePath);
    if (!await existsViaLstat(activePath)) continue;
    if (!await existsViaLstat(artifactPath)) continue;

    await rm(artifactPath, { force: true, recursive: true });
    removed.push(artifactPath);
  }

  return removed;
}

function appendBoundedTail(tail, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const incomingLength = Math.min(buffer.length, MAX_INSTALL_STDERR_BYTES);
  const incoming = buffer.subarray(buffer.length - incomingLength);

  if (incomingLength === MAX_INSTALL_STDERR_BYTES) return Buffer.from(incoming);

  const existingLength = Math.min(tail.length, MAX_INSTALL_STDERR_BYTES - incomingLength);
  const existing = tail.subarray(tail.length - existingLength);
  return Buffer.concat([existing, incoming], existingLength + incomingLength);
}

function isRecoverableRenameCollision(stderrTail) {
  const diagnostic = stderrTail.toString('utf8').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  let finalError = null;

  for (const line of diagnostic.split(/\r?\n/)) {
    const npmLine = /^\s*npm\s+(?:error|ERR!)\s+(.+)$/i.exec(line);
    if (!npmLine) continue;

    const code = /^code\s+([A-Z0-9_-]+)\b/i.exec(npmLine[1]);
    if (code) {
      finalError = { code: code[1].toUpperCase(), syscall: null };
      continue;
    }

    const syscall = /^syscall\s+([A-Z0-9_-]+)\b/i.exec(npmLine[1]);
    if (syscall && finalError) finalError.syscall = syscall[1].toLowerCase();
  }

  return finalError?.syscall === 'rename' && (finalError.code === 'EISDIR' || finalError.code === 'ENOTEMPTY');
}

function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 1);
}

export async function runUpdate(args, options = {}) {
  const spawn = options.spawn ?? defaultSpawn;
  const processLike = options.process ?? process;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const platform = options.platform ?? process.platform;
  const currentVersion = options.currentVersion ?? 'unknown';
  const cleanupArtifacts = options.cleanupCodexRetirementArtifacts ?? cleanupCodexRetirementArtifacts;
  const stderrDrainTimeoutMs = Number.isFinite(options.stderrDrainTimeoutMs) && options.stderrDrainTimeoutMs >= 0
    ? options.stderrDrainTimeoutMs
    : DEFAULT_STDERR_DRAIN_TIMEOUT_MS;
  let updateOptions;

  try {
    updateOptions = parseUpdateOptions(args);
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  stdout.write(`Updating codex-web-ui ${currentVersion} from ${updateOptions.source}\n`);

  let currentChild = null;
  let recoveryChild = null;
  let cancelCurrentAttempt = null;
  let requestedSignal = null;
  let resolveRequestedSignal;
  const requestedSignalPromise = new Promise((resolve) => {
    resolveRequestedSignal = resolve;
  });
  const setRecoveryChild = (nextChild, previousChild) => {
    if (nextChild) {
      recoveryChild = nextChild;
      return;
    }
    if (!previousChild || recoveryChild === previousChild) recoveryChild = null;
  };
  const resolveGlobalRoot = options.resolveNpmGlobalRoot
    ?? (() => resolveNpmGlobalRoot(platform, setRecoveryChild));

  const killChild = (child, signal) => {
    if (!child || child.killed) return;
    try {
      child.kill(signal);
    } catch {
      // The child exit/error event remains authoritative.
    }
  };

  const forwardSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    resolveRequestedSignal(signal);
    killChild(currentChild, signal);
    killChild(recoveryChild, signal);
    cancelCurrentAttempt?.();
  };
  const forwardSigint = () => forwardSignal('SIGINT');
  const forwardSigterm = () => forwardSignal('SIGTERM');

  const runInstallAttempt = () => new Promise((resolveAttempt) => {
    let child;

    try {
      child = spawn(npmCommand(platform), ['install', '-g', '--dangerously-allow-all-scripts', updateOptions.source], {
        env: process.env,
        stdio: ['inherit', 'inherit', 'pipe'],
      });
    } catch (error) {
      stderr.write(`Failed to update codex-web-ui: ${errorMessage(error)}\n`);
      resolveAttempt({ type: 'spawn-error', code: 1, stderrTail: Buffer.alloc(0) });
      return;
    }

    currentChild = child;
    let attemptSettled = false;
    let exitObserved = false;
    let exitResult = null;
    let stderrTail = Buffer.alloc(0);
    const tracksStderrEnd = Boolean(child.stderr && typeof child.stderr.readableEnded === 'boolean');
    let stderrEnded = !tracksStderrEnd || child.stderr.readableEnded;
    let waitingForDrain = false;
    let drainTimer = null;

    const onStderr = (chunk) => {
      stderrTail = appendBoundedTail(stderrTail, chunk);
      const accepted = stderr.write(chunk);
      if (accepted !== false || waitingForDrain || typeof stderr.once !== 'function') return;

      waitingForDrain = true;
      child.stderr?.pause?.();
      stderr.once('drain', onDestinationDrain);
    };
    const clearDestinationDrain = () => {
      if (!waitingForDrain) return;
      waitingForDrain = false;
      stderr.off?.('drain', onDestinationDrain);
      stderr.removeListener?.('drain', onDestinationDrain);
    };
    const cleanupAttemptListeners = () => {
      child.off?.('exit', onExit);
      child.stderr?.off?.('data', onStderr);
      child.stderr?.off?.('end', onStderrEnd);
      child.stderr?.off?.('close', onStderrEnd);
      clearDestinationDrain();
      if (drainTimer) clearTimeout(drainTimer);
    };
    const settleAttempt = (result) => {
      if (attemptSettled) return;
      attemptSettled = true;
      if (currentChild === child) currentChild = null;
      if (cancelCurrentAttempt === cancelAttempt) cancelCurrentAttempt = null;
      cleanupAttemptListeners();
      resolveAttempt({ ...result, stderrTail });
    };
    const finishExitedAttempt = () => {
      if (!exitResult || !stderrEnded || waitingForDrain) return;
      settleAttempt(exitResult);
    };
    const forceFinishDrain = () => {
      if (!exitResult || attemptSettled) return;
      clearDestinationDrain();
      stderrEnded = true;
      child.stderr?.destroy?.();
      settleAttempt(exitResult);
    };
    const onDestinationDrain = () => {
      if (!waitingForDrain) return;
      clearDestinationDrain();
      child.stderr?.resume?.();
      finishExitedAttempt();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      finishExitedAttempt();
    };
    const onError = (error) => {
      if (exitObserved || attemptSettled) return;
      stderr.write(`Failed to update codex-web-ui: ${errorMessage(error)}\n`);
      child.stderr?.destroy?.();
      settleAttempt({ type: 'spawn-error', code: 1 });
    };
    const onExit = (code, signal) => {
      if (exitObserved || attemptSettled) return;
      exitObserved = true;
      exitResult = {
        type: 'exit',
        code: code ?? 1,
        signal,
      };
      if (tracksStderrEnd && (child.stderr.readableEnded || child.stderr.destroyed)) stderrEnded = true;
      if (!stderrEnded || waitingForDrain) {
        drainTimer = setTimeout(forceFinishDrain, stderrDrainTimeoutMs);
      }
      finishExitedAttempt();
    };
    const cancelAttempt = () => {
      if (exitObserved) forceFinishDrain();
    };

    child.stderr?.on('data', onStderr);
    if (tracksStderrEnd) {
      child.stderr.on('end', onStderrEnd);
      child.stderr.on('close', onStderrEnd);
    }
    child.on('error', onError);
    child.once('exit', onExit);
    cancelCurrentAttempt = cancelAttempt;

    if (requestedSignal) killChild(child, requestedSignal);
  });

  const finishAttempt = (attempt) => {
    if (attempt.signal) return signalExitCode(attempt.signal);
    if (requestedSignal) return signalExitCode(requestedSignal);
    if (attempt.type === 'spawn-error') return attempt.code;
    return attempt.code;
  };

  const waitForRecoveryOperation = (operation) => Promise.race([
    Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ type: 'value', value }),
        (error) => ({ type: 'error', error }),
      ),
    requestedSignalPromise.then((signal) => ({ type: 'signal', signal })),
  ]);

  const removeProcessListener = (event, listener) => {
    if (typeof processLike.off === 'function') {
      processLike.off(event, listener);
      return;
    }
    processLike.removeListener?.(event, listener);
  };
  let listeningForSigint = false;
  let listeningForSigterm = false;

  try {
    if (typeof processLike.on === 'function') {
      processLike.on('SIGINT', forwardSigint);
      listeningForSigint = true;
      processLike.on('SIGTERM', forwardSigterm);
      listeningForSigterm = true;
    }

    const firstAttempt = await runInstallAttempt();
    const firstCode = finishAttempt(firstAttempt);

    if (requestedSignal || firstAttempt.type === 'spawn-error' || firstAttempt.signal) return firstCode;
    if (firstCode === 0) {
      stdout.write('Update complete. Run `codex-web-ui --version` to verify the installed version.\n');
      return 0;
    }
    if (!isRecoverableRenameCollision(firstAttempt.stderrTail)) return firstCode;

    let removed;
    try {
      const rootOutcome = await waitForRecoveryOperation(() => resolveGlobalRoot());
      if (rootOutcome.type === 'signal') return signalExitCode(rootOutcome.signal);
      if (rootOutcome.type === 'error') throw rootOutcome.error;
      const globalRoot = validateAbsolutePath(rootOutcome.value, 'npm global root resolver');

      const cleanupOutcome = await waitForRecoveryOperation(() => cleanupArtifacts(globalRoot, platform));
      if (cleanupOutcome.type === 'signal') return signalExitCode(cleanupOutcome.signal);
      if (cleanupOutcome.type === 'error') throw cleanupOutcome.error;
      removed = cleanupOutcome.value;
      if (!Array.isArray(removed) || removed.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
        throw new Error('retirement artifact cleanup returned an invalid result');
      }
    } catch (error) {
      if (requestedSignal) return signalExitCode(requestedSignal);
      stderr.write(`Unable to recover npm update collision: ${errorMessage(error)}\n`);
      return firstCode;
    }

    if (requestedSignal) return signalExitCode(requestedSignal);
    if (removed.length === 0) return firstCode;

    stdout.write(`Removed stale npm retirement artifacts: ${removed.join(', ')}; retrying update once.\n`);
    if (requestedSignal) return signalExitCode(requestedSignal);

    const secondAttempt = await runInstallAttempt();
    const secondCode = finishAttempt(secondAttempt);
    if (secondCode === 0) {
      stdout.write('Update complete. Run `codex-web-ui --version` to verify the installed version.\n');
    }
    return secondCode;
  } finally {
    if (listeningForSigint) removeProcessListener('SIGINT', forwardSigint);
    if (listeningForSigterm) removeProcessListener('SIGTERM', forwardSigterm);
  }
}
