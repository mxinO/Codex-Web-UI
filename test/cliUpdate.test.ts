import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

type FakeChild = EventEmitter & {
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  emitStderr: (value: string) => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

type CapturedWriter = {
  write: ReturnType<typeof vi.fn>;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.killed = false;
  child.emitStderr = (value) => child.stderr.emit('data', Buffer.from(value));
  child.exit = (code, signal = null) => child.emit('exit', code, signal);
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.killed = true;
    child.exit(null, signal);
    return true;
  });
  return child;
}

function createStreamChild(): FakeChild & { stderr: PassThrough } {
  const child = createFakeChild() as FakeChild & { stderr: PassThrough };
  child.stderr = new PassThrough();
  child.emitStderr = (value) => {
    child.stderr.write(Buffer.from(value));
  };
  return child;
}

function capturedWrites(writer: CapturedWriter): string[] {
  return writer.write.mock.calls.map(([value]) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)));
}

function capturedText(writer: CapturedWriter): string {
  return capturedWrites(writer).join('');
}

function npmFailureDiagnostic(code: string, syscall: string, reportedRoot = '/untrusted/from-npm-stderr'): string {
  return [
    `npm error code ${code}\n`,
    `npm error syscall ${syscall}\n`,
    `npm error path ${reportedRoot}/codex-web-ui\n`,
    `npm error dest ${reportedRoot}/.codex-web-ui-Untrusted\n`,
  ].join('');
}

function emitStderrInTwoChunks(child: FakeChild, diagnostic: string): void {
  const splitAt = diagnostic.indexOf('\n') + 1;
  child.emitStderr(diagnostic.slice(0, splitAt));
  child.emitStderr(diagnostic.slice(splitAt));
}

function expectedNpmRetirementPath(activePath: string): string {
  const hash = createHash('sha1').update(activePath).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return join(dirname(activePath), `.${basename(activePath)}-${hash}`);
}

describe('CLI update helper', () => {
  it('builds a global npm install for the default GitHub tarball', async () => {
    const { DEFAULT_UPDATE_SOURCE, runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const spawn = vi.fn(() => child);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const resultPromise = runUpdate(['--update'], {
      currentVersion: '0.1.0',
      platform: 'linux',
      spawn,
      stdout,
      stderr,
    });
    child.exit(0);

    await expect(resultPromise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith('npm', ['install', '-g', DEFAULT_UPDATE_SOURCE], expect.objectContaining({
      stdio: ['inherit', 'inherit', 'pipe'],
    }));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Updating codex-web-ui 0.1.0'));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    expect(capturedText(stderr)).toBe('');
  });

  it('ignores late child errors after a successful update has settled', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const processEvents = new EventEmitter();
    const spawn = vi.fn(() => child);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn,
      stdout,
      stderr,
    });
    child.exit(0);

    await expect(resultPromise).resolves.toBe(0);
    const stderrBeforeLateErrors = capturedText(stderr);
    const thrown = [new Error('first late child error'), new Error('second late child error')].map((error) => {
      try {
        child.emit('error', error);
        return undefined;
      } catch (emittedError) {
        return emittedError;
      }
    });

    await expect(resultPromise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(capturedText(stderr)).toBe(stderrBeforeLateErrors);
    expect(capturedText(stderr)).not.toContain('Failed to update codex-web-ui');
    expect(capturedWrites(stdout).filter((value) => value.includes('Update complete'))).toHaveLength(1);
    expect(thrown).toEqual([undefined, undefined]);
  });

  it('pauses npm stderr for destination backpressure and waits for drain', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createStreamChild();
    const stderr = new EventEmitter() as EventEmitter & CapturedWriter;
    stderr.write = vi.fn(() => false);

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr,
    });

    try {
      child.emitStderr('blocked npm stderr\n');
      expect(stderr.write).toHaveBeenCalledTimes(1);
      expect(child.stderr.isPaused()).toBe(true);

      child.exit(17);
      child.stderr.end();
      const beforeDrain = await Promise.race([
        resultPromise.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
      ]);
      expect(beforeDrain).toBe('pending');

      stderr.emit('drain');
      await expect(resultPromise).resolves.toBe(17);
    } finally {
      stderr.emit('drain');
      child.stderr.destroy();
    }
  });

  it('bounds post-exit stderr draining when a descendant keeps the descriptor open', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createStreamChild();
    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      stderrDrainTimeoutMs: 10,
    });

    child.exit(19);

    try {
      const result = await Promise.race([
        resultPromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]);
      expect(result).toBe(19);
      expect(child.stderr.destroyed).toBe(true);
    } finally {
      child.stderr.destroy();
      await resultPromise;
    }
  });

  it('accepts an explicit update source', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const spawn = vi.fn(() => child);

    const resultPromise = runUpdate(['--update', '--source', 'file:///tmp/codex-web-ui.tgz'], {
      platform: 'linux',
      spawn,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });
    child.exit(0);

    await expect(resultPromise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith('npm', ['install', '-g', 'file:///tmp/codex-web-ui.tgz'], expect.any(Object));
  });

  it('rejects a missing update source value before spawning npm', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const spawn = vi.fn();
    const stderr = { write: vi.fn() };

    await expect(
      runUpdate(['--update', '--source'], {
        spawn,
        stdout: { write: vi.fn() },
        stderr,
      }),
    ).resolves.toBe(2);

    expect(spawn).not.toHaveBeenCalled();
    expect(capturedText(stderr)).toContain('Usage: codex-web-ui --update');
  });

  it.each(['EISDIR', 'ENOTEMPTY'])(
    'recovers once from an npm %s rename collision using the trusted global root',
    async (errorCode) => {
      const { DEFAULT_UPDATE_SOURCE, runUpdate } = await import('../bin/update.mjs');
      const firstChild = createFakeChild();
      const secondChild = createFakeChild();
      const children = [firstChild, secondChild];
      const spawn = vi.fn(() => children.shift()!);
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const trustedGlobalRoot = '/trusted/npm/global/node_modules';
      const artifact = `${trustedGlobalRoot}/.codex-web-ui-AbCd1234`;
      const resolveNpmGlobalRoot = vi.fn().mockResolvedValue(trustedGlobalRoot);
      const cleanupCodexRetirementArtifacts = vi.fn().mockResolvedValue([artifact]);
      const diagnostic = npmFailureDiagnostic(errorCode, 'rename');

      const resultPromise = runUpdate(['--update'], {
        currentVersion: '0.1.0',
        platform: 'linux',
        spawn,
        stdout,
        stderr,
        resolveNpmGlobalRoot,
        cleanupCodexRetirementArtifacts,
      });
      emitStderrInTwoChunks(firstChild, diagnostic);

      expect(resolveNpmGlobalRoot).not.toHaveBeenCalled();
      expect(cleanupCodexRetirementArtifacts).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);

      firstChild.exit(235);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      secondChild.exit(0);

      await expect(resultPromise).resolves.toBe(0);
      expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1);
      expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledTimes(1);
      expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledWith(trustedGlobalRoot, 'linux');
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        'npm',
        ['install', '-g', DEFAULT_UPDATE_SOURCE],
        expect.objectContaining({ stdio: ['inherit', 'inherit', 'pipe'] }),
      );
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        'npm',
        ['install', '-g', DEFAULT_UPDATE_SOURCE],
        expect.objectContaining({ stdio: ['inherit', 'inherit', 'pipe'] }),
      );
      expect(capturedText(stderr)).toBe(diagnostic);

      const writes = capturedWrites(stdout);
      expect(writes.filter((value) => value.includes(artifact) && /retry/i.test(value))).toHaveLength(1);
      expect(writes.filter((value) => value.includes('Update complete'))).toHaveLength(1);
    },
  );

  it.each([
    ['EISDIR with unlink', npmFailureDiagnostic('EISDIR', 'unlink')],
    ['ENOTEMPTY with unlink', npmFailureDiagnostic('ENOTEMPTY', 'unlink')],
    ['EACCES with rename', npmFailureDiagnostic('EACCES', 'rename')],
    [
      'eligible code and rename from different npm error stanzas',
      npmFailureDiagnostic('EISDIR', 'unlink') + npmFailureDiagnostic('EACCES', 'rename'),
    ],
  ])('does not clean up or retry the ineligible npm failure: %s', async (_label, diagnostic) => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const spawn = vi.fn(() => child);
    const stderr = { write: vi.fn() };
    const resolveNpmGlobalRoot = vi.fn();
    const cleanupCodexRetirementArtifacts = vi.fn();

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      spawn,
      stdout: { write: vi.fn() },
      stderr,
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts,
    });
    emitStderrInTwoChunks(child, diagnostic);
    child.exit(243);

    await expect(resultPromise).resolves.toBe(243);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(resolveNpmGlobalRoot).not.toHaveBeenCalled();
    expect(cleanupCodexRetirementArtifacts).not.toHaveBeenCalled();
    expect(capturedText(stderr)).toBe(diagnostic);
  });

  it('does not recover more than once when the retry has another eligible collision', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const firstChild = createFakeChild();
    const secondChild = createFakeChild();
    const unexpectedThirdChild = createFakeChild();
    const children = [firstChild, secondChild, unexpectedThirdChild];
    const spawn = vi.fn(() => {
      const child = children.shift();
      if (!child) throw new Error('unexpected fourth npm install attempt');
      if (child === unexpectedThirdChild) queueMicrotask(() => child.exit(0));
      return child;
    });
    const stderr = { write: vi.fn() };
    const trustedGlobalRoot = '/trusted/npm/global/node_modules';
    const artifact = `${trustedGlobalRoot}/.codex-web-ui-AbCd1234`;
    const resolveNpmGlobalRoot = vi.fn().mockResolvedValue(trustedGlobalRoot);
    const cleanupCodexRetirementArtifacts = vi.fn().mockResolvedValue([artifact]);
    const diagnostic = npmFailureDiagnostic('EISDIR', 'rename');

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      spawn,
      stdout: { write: vi.fn() },
      stderr,
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts,
    });
    emitStderrInTwoChunks(firstChild, diagnostic);
    firstChild.exit(235);

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emitStderrInTwoChunks(secondChild, diagnostic);
    secondChild.exit(235);

    await expect(resultPromise).resolves.toBe(235);
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1);
    expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledTimes(1);
    expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledWith(trustedGlobalRoot, 'linux');
    expect(capturedText(stderr)).toBe(diagnostic + diagnostic);
  });

  it('removes only exact Codex Web UI retirement artifacts and preserves active symlinks', async () => {
    const { cleanupCodexRetirementArtifacts, npmRetirementPath } = await import('../bin/update.mjs');
    const fixture = await mkdtemp(join(tmpdir(), 'codex-web-ui-update-'));

    try {
      const prefix = join(fixture, 'prefix');
      const globalRoot = join(prefix, 'lib', 'node_modules');
      const binRoot = join(prefix, 'bin');
      const packageTarget = join(fixture, 'package-source');
      const packagePath = join(globalRoot, 'codex-web-ui');
      const binPath = join(binRoot, 'codex-web-ui');
      const binTarget = join(packageTarget, 'bin', 'codex-web-ui.mjs');
      const packageManifestPath = join(packageTarget, 'package.json');
      const packageManifest = '{"name":"codex-web-ui","fixture":"active"}\n';
      const binScript = '#!/usr/bin/env node\nconsole.log("active");\n';
      const packageArtifact = expectedNpmRetirementPath(packagePath);
      const binArtifact = expectedNpmRetirementPath(binPath);
      const packageArtifactFile = join(packageArtifact, 'node_modules', 'stale-package', 'package.json');
      const binArtifactFile = join(binArtifact, 'nested', 'stale-launcher.txt');
      const unrelatedPackageArtifact = join(globalRoot, '.codex-web-ui-not-the-hash');
      const unrelatedBinArtifact = join(binRoot, '.codex-web-ui-not-the-hash');
      const unrelatedPackageFile = join(unrelatedPackageArtifact, 'nested', 'keep.txt');
      const unrelatedBinFile = join(unrelatedBinArtifact, 'nested', 'keep.txt');

      await mkdir(globalRoot, { recursive: true });
      await mkdir(binRoot, { recursive: true });
      await mkdir(dirname(binTarget), { recursive: true });
      await writeFile(packageManifestPath, packageManifest);
      await writeFile(binTarget, binScript);
      await symlink(packageTarget, packagePath, 'dir');
      await symlink(binTarget, binPath, 'file');
      await mkdir(dirname(packageArtifactFile), { recursive: true });
      await mkdir(dirname(binArtifactFile), { recursive: true });
      await mkdir(dirname(unrelatedPackageFile), { recursive: true });
      await mkdir(dirname(unrelatedBinFile), { recursive: true });
      await writeFile(packageArtifactFile, '{"stale":true}\n');
      await writeFile(binArtifactFile, 'stale launcher\n');
      await writeFile(unrelatedPackageFile, 'keep package decoy\n');
      await writeFile(unrelatedBinFile, 'keep bin decoy\n');

      expect(await readFile(packageArtifactFile, 'utf8')).toBe('{"stale":true}\n');
      expect(await readFile(binArtifactFile, 'utf8')).toBe('stale launcher\n');
      expect(npmRetirementPath(packagePath)).toBe(packageArtifact);
      expect(npmRetirementPath(binPath)).toBe(binArtifact);

      const removed = await cleanupCodexRetirementArtifacts(globalRoot, 'linux');

      expect([...removed].sort()).toEqual([binArtifact, packageArtifact].sort());
      await expect(lstat(packageArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(binArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(packagePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(binPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(packagePath)).toBe(packageTarget);
      expect(await readlink(binPath)).toBe(binTarget);
      expect(await readFile(join(packagePath, 'package.json'), 'utf8')).toBe(packageManifest);
      expect(await readFile(binPath, 'utf8')).toBe(binScript);
      expect(await readFile(unrelatedPackageFile, 'utf8')).toBe('keep package decoy\n');
      expect(await readFile(unrelatedBinFile, 'utf8')).toBe('keep bin decoy\n');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('canonicalizes a symlinked npm global root before removing retirement artifacts', async () => {
    const { cleanupCodexRetirementArtifacts } = await import('../bin/update.mjs');
    const fixture = await mkdtemp(join(tmpdir(), 'codex-web-ui-canonical-root-'));

    try {
      const canonicalFixture = await realpath(fixture);
      const physicalPrefix = join(canonicalFixture, 'physical-prefix');
      const symlinkedPrefix = join(fixture, 'symlinked-prefix');
      const physicalGlobalRoot = join(physicalPrefix, 'lib', 'node_modules');
      const physicalBinRoot = join(physicalPrefix, 'bin');
      const symlinkedGlobalRoot = join(symlinkedPrefix, 'lib', 'node_modules');
      const physicalPackagePath = join(physicalGlobalRoot, 'codex-web-ui');
      const physicalBinPath = join(physicalBinRoot, 'codex-web-ui');
      const symlinkedPackagePath = join(symlinkedGlobalRoot, 'codex-web-ui');
      const symlinkedBinPath = join(symlinkedPrefix, 'bin', 'codex-web-ui');
      const packageTarget = join(canonicalFixture, 'active-package-source');
      const packageManifestPath = join(packageTarget, 'package.json');
      const binTarget = join(packageTarget, 'bin', 'codex-web-ui.mjs');
      const packageManifest = '{"name":"codex-web-ui","fixture":"canonical"}\n';
      const binScript = '#!/usr/bin/env node\nconsole.log("canonical");\n';
      const packageArtifact = expectedNpmRetirementPath(physicalPackagePath);
      const binArtifact = expectedNpmRetirementPath(physicalBinPath);
      const packageArtifactFile = join(packageArtifact, 'nested', 'stale-package.txt');
      const binArtifactFile = join(binArtifact, 'nested', 'stale-launcher.txt');
      const lexicalPackageDecoy = expectedNpmRetirementPath(symlinkedPackagePath);
      const lexicalBinDecoy = expectedNpmRetirementPath(symlinkedBinPath);
      const lexicalPackageDecoyFile = join(lexicalPackageDecoy, 'nested', 'keep.txt');
      const lexicalBinDecoyFile = join(lexicalBinDecoy, 'nested', 'keep.txt');

      await mkdir(physicalGlobalRoot, { recursive: true });
      await mkdir(physicalBinRoot, { recursive: true });
      await mkdir(dirname(binTarget), { recursive: true });
      await writeFile(packageManifestPath, packageManifest);
      await writeFile(binTarget, binScript);
      await symlink(physicalPrefix, symlinkedPrefix, 'dir');
      await symlink(packageTarget, physicalPackagePath, 'dir');
      await symlink(binTarget, physicalBinPath, 'file');
      await mkdir(dirname(packageArtifactFile), { recursive: true });
      await mkdir(dirname(binArtifactFile), { recursive: true });
      await mkdir(dirname(lexicalPackageDecoyFile), { recursive: true });
      await mkdir(dirname(lexicalBinDecoyFile), { recursive: true });
      await writeFile(packageArtifactFile, 'stale canonical package\n');
      await writeFile(binArtifactFile, 'stale canonical launcher\n');
      await writeFile(lexicalPackageDecoyFile, 'keep lexical package decoy\n');
      await writeFile(lexicalBinDecoyFile, 'keep lexical bin decoy\n');

      expect(await realpath(symlinkedGlobalRoot)).toBe(physicalGlobalRoot);
      expect(basename(lexicalPackageDecoy)).not.toBe(basename(packageArtifact));
      expect(basename(lexicalBinDecoy)).not.toBe(basename(binArtifact));

      const removed = await cleanupCodexRetirementArtifacts(symlinkedGlobalRoot, 'linux');

      expect([...removed].sort()).toEqual([binArtifact, packageArtifact].sort());
      await expect(lstat(packageArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(binArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(physicalPackagePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(physicalBinPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(physicalPackagePath)).toBe(packageTarget);
      expect(await readlink(physicalBinPath)).toBe(binTarget);
      expect(await readFile(join(symlinkedPackagePath, 'package.json'), 'utf8')).toBe(packageManifest);
      expect(await readFile(symlinkedBinPath, 'utf8')).toBe(binScript);
      expect(await readFile(lexicalPackageDecoyFile, 'utf8')).toBe('keep lexical package decoy\n');
      expect(await readFile(lexicalBinDecoyFile, 'utf8')).toBe('keep lexical bin decoy\n');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('preserves a lexical node_modules symlink when only that directory is linked', async () => {
    const { cleanupCodexRetirementArtifacts, npmRetirementPath } = await import('../bin/update.mjs');
    const fixture = await mkdtemp(join(tmpdir(), 'codex-web-ui-node-modules-link-'));

    try {
      const prefix = join(fixture, 'prefix');
      const physicalNodeModules = join(fixture, 'package-storage', 'node_modules');
      const lexicalGlobalRoot = join(prefix, 'lib', 'node_modules');
      const lexicalPackagePath = join(lexicalGlobalRoot, 'codex-web-ui');
      const physicalPackagePath = join(physicalNodeModules, 'codex-web-ui');
      const lexicalBinPath = join(prefix, 'bin', 'codex-web-ui');
      const packageTarget = join(fixture, 'package-source');
      const binTarget = join(packageTarget, 'bin', 'codex-web-ui.mjs');
      const lexicalPackageArtifact = expectedNpmRetirementPath(lexicalPackagePath);
      const physicalHashDecoy = expectedNpmRetirementPath(physicalPackagePath);
      const binArtifact = expectedNpmRetirementPath(lexicalBinPath);
      const lexicalArtifactFile = join(lexicalPackageArtifact, 'nested', 'stale.txt');
      const physicalDecoyFile = join(physicalHashDecoy, 'nested', 'keep.txt');
      const binArtifactFile = join(binArtifact, 'nested', 'stale.txt');

      await mkdir(join(prefix, 'lib'), { recursive: true });
      await mkdir(join(prefix, 'bin'), { recursive: true });
      await mkdir(physicalNodeModules, { recursive: true });
      await mkdir(dirname(binTarget), { recursive: true });
      await writeFile(join(packageTarget, 'package.json'), '{"name":"codex-web-ui"}\n');
      await writeFile(binTarget, '#!/usr/bin/env node\n');
      await symlink(physicalNodeModules, lexicalGlobalRoot, 'dir');
      await symlink(packageTarget, physicalPackagePath, 'dir');
      await symlink(binTarget, lexicalBinPath, 'file');
      await mkdir(dirname(lexicalArtifactFile), { recursive: true });
      await mkdir(dirname(physicalDecoyFile), { recursive: true });
      await mkdir(dirname(binArtifactFile), { recursive: true });
      await writeFile(lexicalArtifactFile, 'remove lexical artifact\n');
      await writeFile(physicalDecoyFile, 'keep physical-hash decoy\n');
      await writeFile(binArtifactFile, 'remove bin artifact\n');

      expect(await realpath(lexicalGlobalRoot)).toBe(physicalNodeModules);
      expect(lexicalPackageArtifact).not.toBe(physicalHashDecoy);
      expect(npmRetirementPath(lexicalPackagePath)).toBe(lexicalPackageArtifact);

      const removed = await cleanupCodexRetirementArtifacts(lexicalGlobalRoot, 'linux');

      expect([...removed].sort()).toEqual([binArtifact, lexicalPackageArtifact].sort());
      await expect(lstat(lexicalPackageArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(binArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(physicalDecoyFile, 'utf8')).toBe('keep physical-hash decoy\n');
      expect((await lstat(physicalPackagePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(lexicalBinPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('canonicalizes the Arborist global tree top when only lib is linked', async () => {
    const { cleanupCodexRetirementArtifacts } = await import('../bin/update.mjs');
    const fixture = await mkdtemp(join(tmpdir(), 'codex-web-ui-lib-link-'));

    try {
      const prefix = join(fixture, 'prefix');
      const physicalGlobalTop = join(fixture, 'package-storage', 'lib');
      const lexicalGlobalTop = join(prefix, 'lib');
      const lexicalGlobalRoot = join(lexicalGlobalTop, 'node_modules');
      const physicalGlobalRoot = join(physicalGlobalTop, 'node_modules');
      const lexicalPackagePath = join(lexicalGlobalRoot, 'codex-web-ui');
      const physicalPackagePath = join(physicalGlobalRoot, 'codex-web-ui');
      const physicalBinPath = join(dirname(physicalGlobalTop), 'bin', 'codex-web-ui');
      const packageTarget = join(fixture, 'package-source');
      const binTarget = join(packageTarget, 'bin', 'codex-web-ui.mjs');
      const physicalPackageArtifact = expectedNpmRetirementPath(physicalPackagePath);
      const physicalBinArtifact = expectedNpmRetirementPath(physicalBinPath);
      const lexicalPackageDecoy = expectedNpmRetirementPath(lexicalPackagePath);
      const physicalPackageFile = join(physicalPackageArtifact, 'nested', 'stale.txt');
      const physicalBinFile = join(physicalBinArtifact, 'nested', 'stale.txt');
      const lexicalDecoyFile = join(lexicalPackageDecoy, 'nested', 'keep.txt');

      await mkdir(prefix, { recursive: true });
      await mkdir(physicalGlobalRoot, { recursive: true });
      await mkdir(dirname(physicalBinPath), { recursive: true });
      await mkdir(dirname(binTarget), { recursive: true });
      await writeFile(join(packageTarget, 'package.json'), '{"name":"codex-web-ui"}\n');
      await writeFile(binTarget, '#!/usr/bin/env node\n');
      await symlink(physicalGlobalTop, lexicalGlobalTop, 'dir');
      await symlink(packageTarget, physicalPackagePath, 'dir');
      await symlink(binTarget, physicalBinPath, 'file');
      await mkdir(dirname(physicalPackageFile), { recursive: true });
      await mkdir(dirname(physicalBinFile), { recursive: true });
      await mkdir(dirname(lexicalDecoyFile), { recursive: true });
      await writeFile(physicalPackageFile, 'remove package artifact\n');
      await writeFile(physicalBinFile, 'remove bin artifact\n');
      await writeFile(lexicalDecoyFile, 'keep lexical-hash decoy\n');

      expect(await realpath(lexicalGlobalTop)).toBe(physicalGlobalTop);
      expect(physicalPackageArtifact).not.toBe(lexicalPackageDecoy);

      const removed = await cleanupCodexRetirementArtifacts(lexicalGlobalRoot, 'linux');

      expect([...removed].sort()).toEqual([physicalBinArtifact, physicalPackageArtifact].sort());
      await expect(lstat(physicalPackageArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(physicalBinArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(lexicalDecoyFile, 'utf8')).toBe('keep lexical-hash decoy\n');
      expect((await lstat(physicalPackagePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(physicalBinPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('returns promptly when a signal arrives during a hung global-root resolver', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const processEvents = new EventEmitter();
    const resolverDeferred = createDeferred<string>();
    const resolveNpmGlobalRoot = vi.fn(() => resolverDeferred.promise);
    const diagnostic = npmFailureDiagnostic('EISDIR', 'rename');
    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts: vi.fn(),
    });
    emitStderrInTwoChunks(child, diagnostic);
    child.exit(235);

    await vi.waitFor(() => expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1));
    processEvents.emit('SIGTERM');

    try {
      const result = await Promise.race([
        resultPromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]);
      expect(result).toBe(143);
      expect(processEvents.listenerCount('SIGTERM')).toBe(0);
      expect(processEvents.listenerCount('SIGINT')).toBe(0);
    } finally {
      resolverDeferred.reject(new Error('release hung resolver'));
      await resultPromise;
    }
  });

  it('latches the first requested signal while npm termination is pending', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const processEvents = new EventEmitter();
    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    processEvents.emit('SIGTERM');
    processEvents.emit('SIGINT');
    child.exit(null, 'SIGTERM');

    await expect(resultPromise).resolves.toBe(143);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('prefers the actual child termination signal over the requested signal', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const processEvents = new EventEmitter();
    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn: vi.fn(() => child),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    processEvents.emit('SIGTERM');
    child.exit(null, 'SIGINT');

    await expect(resultPromise).resolves.toBe(130);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns the SIGTERM exit code when global-root resolution rejects after the signal', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const processEvents = new EventEmitter();
    const spawn = vi.fn(() => child);
    const resolverDeferred = createDeferred<string>();
    const resolveNpmGlobalRoot = vi.fn(() => resolverDeferred.promise);
    const cleanupCodexRetirementArtifacts = vi.fn();
    const diagnostic = npmFailureDiagnostic('EISDIR', 'rename');

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts,
    });
    emitStderrInTwoChunks(child, diagnostic);
    child.exit(235);

    await vi.waitFor(() => expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1));
    processEvents.emit('SIGTERM');
    resolverDeferred.reject(new Error('global root failed after SIGTERM'));
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1);
    expect(cleanupCodexRetirementArtifacts).not.toHaveBeenCalled();
    expect(processEvents.listenerCount('SIGTERM')).toBe(0);
    expect(processEvents.listenerCount('SIGINT')).toBe(0);
    expect(result).toBe(143);
  });

  it('returns the SIGINT exit code when artifact cleanup rejects after the signal', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const processEvents = new EventEmitter();
    const spawn = vi.fn(() => child);
    const trustedGlobalRoot = '/trusted/npm/global/node_modules';
    const resolveNpmGlobalRoot = vi.fn().mockResolvedValue(trustedGlobalRoot);
    const cleanupDeferred = createDeferred<string[]>();
    const cleanupCodexRetirementArtifacts = vi.fn(() => cleanupDeferred.promise);
    const diagnostic = npmFailureDiagnostic('EISDIR', 'rename');

    const resultPromise = runUpdate(['--update'], {
      platform: 'linux',
      process: processEvents,
      spawn,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts,
    });
    emitStderrInTwoChunks(child, diagnostic);
    child.exit(235);

    await vi.waitFor(() => expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledTimes(1));
    processEvents.emit('SIGINT');
    cleanupDeferred.reject(new Error('cleanup failed after SIGINT'));
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(resolveNpmGlobalRoot).toHaveBeenCalledTimes(1);
    expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledTimes(1);
    expect(cleanupCodexRetirementArtifacts).toHaveBeenCalledWith(trustedGlobalRoot, 'linux');
    expect(processEvents.listenerCount('SIGTERM')).toBe(0);
    expect(processEvents.listenerCount('SIGINT')).toBe(0);
    expect(result).toBe(130);
  });

  it('forwards termination signals to the npm update child while it is running', async () => {
    const { runUpdate } = await import('../bin/update.mjs');
    const child = createFakeChild();
    const processEvents = new EventEmitter();
    const spawn = vi.fn(() => child);
    const resolveNpmGlobalRoot = vi.fn();
    const cleanupCodexRetirementArtifacts = vi.fn();
    const stderr = { write: vi.fn() };
    const diagnostic = npmFailureDiagnostic('EISDIR', 'rename');

    const resultPromise = runUpdate(['--update'], {
      currentVersion: '0.1.0',
      platform: 'linux',
      process: processEvents,
      spawn,
      stdout: { write: vi.fn() },
      stderr,
      resolveNpmGlobalRoot,
      cleanupCodexRetirementArtifacts,
    });

    emitStderrInTwoChunks(child, diagnostic);
    processEvents.emit('SIGTERM');

    await expect(resultPromise).resolves.toBe(143);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(resolveNpmGlobalRoot).not.toHaveBeenCalled();
    expect(cleanupCodexRetirementArtifacts).not.toHaveBeenCalled();
    expect(processEvents.listenerCount('SIGTERM')).toBe(0);
    expect(processEvents.listenerCount('SIGINT')).toBe(0);
    expect(capturedText(stderr)).toBe(diagnostic);
  });
});
