#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdate } from './update.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function defaultStateDir() {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  return path.join(xdgStateHome && xdgStateHome.trim() ? xdgStateHome : path.join(os.homedir(), '.local', 'state'), 'codex-web-ui');
}

function printHelp() {
  const version = readPackageVersion();
  process.stdout.write(`codex-web-ui ${version}

Usage:
  codex-web-ui [--host <host>] [--port <port>] [--state-dir <path>] [--no-auth] [--mock]
  codex-web-ui --update [--source <tarball-url-or-package-spec>]

Examples:
  codex-web-ui --host 127.0.0.1 --port 3001
  codex-web-ui --host 0.0.0.0 --port 3002
  codex-web-ui --update

The command can be run from any project directory. New Codex sessions default to
the directory where this command is started.
`);
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${readPackageVersion()}\n`);
  process.exit(0);
}

if (args.includes('--update')) {
  const code = await runUpdate(args, { currentVersion: readPackageVersion() });
  process.exit(code);
}

const tsxBin = path.join(packageRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const scriptPath = path.join(packageRoot, 'scripts', 'start.ts');
const tsconfigPath = path.join(packageRoot, 'tsconfig.server.json');
const indexHtml = path.join(packageRoot, 'dist', 'index.html');

if (!fs.existsSync(tsxBin)) {
  process.stderr.write('Missing runtime dependency: tsx. Reinstall codex-web-ui before starting the server.\n');
  process.exit(1);
}

if (!fs.existsSync(indexHtml)) {
  process.stderr.write('Client bundle is missing. Run `npm run build` in the codex-web-ui repo, then reinstall or relink the command.\n');
  process.exit(1);
}

const env = {
  ...process.env,
  CODEX_WEB_UI_PACKAGE_ROOT: process.env.CODEX_WEB_UI_PACKAGE_ROOT || packageRoot,
  CODEX_WEB_UI_START_CWD: process.env.CODEX_WEB_UI_START_CWD || process.cwd(),
  CODEX_WEB_UI_STATE_DIR: process.env.CODEX_WEB_UI_STATE_DIR || defaultStateDir(),
};

const child = spawn(tsxBin, ['--tsconfig', tsconfigPath, scriptPath, ...args], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

function forwardSignal(signal) {
  if (child.killed) return;
  child.kill(signal);
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    const signalNumber = os.constants.signals[signal] ?? 1;
    process.exit(128 + signalNumber);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`Failed to start codex-web-ui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
