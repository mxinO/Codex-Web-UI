#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const PACKAGE_PATHS = ['dist', 'dist-server'];

function commandName(base) {
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
  });
  if (result.error) {
    process.stderr.write(`${command} failed: ${result.error.message}\n`);
    process.exit(1);
  }
  return result;
}

process.stdout.write('Checking installable package bundles with `npm run build`...\n');
const build = run(commandName('npm'), ['run', 'build']);
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);

const status = run('git', ['status', '--porcelain', '--', ...PACKAGE_PATHS], {
  stdio: 'pipe',
  encoding: 'utf8',
});
if ((status.status ?? 1) !== 0) process.exit(status.status ?? 1);

const output = status.stdout.trim();
if (output) {
  process.stderr.write(
    [
      '',
      'Installable package bundles are stale.',
      '',
      '`npm run build` changed files that are served by `codex-web-ui --update`:',
      output,
      '',
      'Add and commit these generated bundle changes before pushing.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write('Installable package bundles are current.\n');
