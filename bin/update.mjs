import { spawn as defaultSpawn } from 'node:child_process';
import os from 'node:os';

export const DEFAULT_UPDATE_SOURCE = 'https://github.com/mxinO/Codex-Web-UI/archive/refs/heads/main.tar.gz';

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

export function runUpdate(args, options = {}) {
  const spawn = options.spawn ?? defaultSpawn;
  const processLike = options.process ?? process;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const platform = options.platform ?? process.platform;
  const currentVersion = options.currentVersion ?? 'unknown';
  let updateOptions;

  try {
    updateOptions = parseUpdateOptions(args);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return Promise.resolve(2);
  }

  stdout.write(`Updating codex-web-ui ${currentVersion} from ${updateOptions.source}\n`);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(npmCommand(platform), ['install', '-g', updateOptions.source], {
      env: process.env,
      stdio: 'inherit',
    });

    const cleanup = () => {
      processLike.off?.('SIGINT', forwardSigint);
      processLike.off?.('SIGTERM', forwardSigterm);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const forwardSignal = (signal) => {
      if (child.killed) return;
      child.kill(signal);
    };
    const forwardSigint = () => forwardSignal('SIGINT');
    const forwardSigterm = () => forwardSignal('SIGTERM');

    processLike.on?.('SIGINT', forwardSigint);
    processLike.on?.('SIGTERM', forwardSigterm);

    child.on('exit', (code, signal) => {
      if (signal) {
        const signalNumber = os.constants.signals[signal] ?? 1;
        finish(128 + signalNumber);
        return;
      }
      if ((code ?? 1) === 0) {
        stdout.write('Update complete. Run `codex-web-ui --version` to verify the installed version.\n');
      }
      finish(code ?? 1);
    });

    child.on('error', (error) => {
      stderr.write(`Failed to update codex-web-ui: ${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    });
  });
}
