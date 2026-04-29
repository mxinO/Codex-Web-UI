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

describe('package metadata', () => {
  it('keeps browser bundle libraries out of runtime dependencies', () => {
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(['better-sqlite3', 'cookie', 'express', 'tsx', 'ws']);
  });

  it('ships the browser bundle without building during git install', () => {
    expect(packageJson.files).toContain('dist');
    expect(packageJson.scripts?.prepare).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'dist', 'index.html'))).toBe(true);
  });
});
