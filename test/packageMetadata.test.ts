import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};
const sourceIndexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const cliLauncher = fs.readFileSync(path.join(root, 'bin', 'codex-web-ui.mjs'), 'utf8');

describe('package metadata', () => {
  it('keeps browser bundle libraries out of runtime dependencies', () => {
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(['better-sqlite3', 'cookie', 'express', 'ws']);
    expect(packageJson.dependencies?.tsx).toBeUndefined();
  });

  it('ships prebuilt browser and server bundles without building during git install', () => {
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).toContain('dist-server');
    expect(packageJson.scripts?.prepare).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'dist', 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist-server', 'scripts', 'start.js'))).toBe(true);
  });

  it('starts installed servers from precompiled JavaScript instead of tsx', () => {
    expect(cliLauncher).toContain("dist-server', 'scripts', 'start.js");
    expect(cliLauncher).toContain('process.execPath');
    expect(cliLauncher).toContain('--no-experimental-fetch');
    expect(cliLauncher).toContain('--no-experimental-websocket');
    expect(cliLauncher).toContain('--no-experimental-eventsource');
    expect(cliLauncher).not.toContain("node_modules', '.bin'");
    expect(cliLauncher).not.toContain('--tsconfig');
  });

  it('ships and references the project icon', () => {
    expect(sourceIndexHtml).toContain('rel="icon"');
    expect(sourceIndexHtml).toContain('/icon.svg');
    expect(readme).toContain('dist/icon.svg');
    expect(fs.existsSync(path.join(root, 'public', 'icon.svg'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist', 'icon.svg'))).toBe(true);
  });
});
