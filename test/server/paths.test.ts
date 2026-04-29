import { describe, expect, it } from 'vitest';
import { resolvePackageRoot, resolveStartCwd } from '../../server/paths.js';

describe('server paths', () => {
  it('uses the current process directory by default', () => {
    expect(resolvePackageRoot({}, '/work/repo')).toBe('/work/repo');
    expect(resolveStartCwd({}, '/work/repo')).toBe('/work/repo');
  });

  it('separates installed package assets from the launch workspace', () => {
    expect(resolvePackageRoot({ CODEX_WEB_UI_PACKAGE_ROOT: '/opt/codex-web-ui' }, '/work/project')).toBe('/opt/codex-web-ui');
    expect(resolveStartCwd({ CODEX_WEB_UI_START_CWD: '/work/project' }, '/opt/codex-web-ui')).toBe('/work/project');
  });

  it('ignores blank env values', () => {
    expect(resolvePackageRoot({ CODEX_WEB_UI_PACKAGE_ROOT: '   ' }, '/work/repo')).toBe('/work/repo');
    expect(resolveStartCwd({ CODEX_WEB_UI_START_CWD: '   ' }, '/work/repo')).toBe('/work/repo');
  });
});
