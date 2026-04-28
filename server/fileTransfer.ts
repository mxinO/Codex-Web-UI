import fs from 'node:fs/promises';
import path from 'node:path';

function outsideWorkspaceError(): Error {
  return new Error('path is outside active workspace');
}

function isPathInsideRoot(resolvedRoot: string, resolvedTarget: string): boolean {
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertPathInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);

  if (isPathInsideRoot(resolvedRoot, resolvedTarget)) {
    return resolvedTarget;
  }

  throw outsideWorkspaceError();
}

async function realRootAndLexicalTarget(root: string, target: string): Promise<{ realRoot: string; lexicalTarget: string }> {
  const realRoot = await fs.realpath(root);
  const lexicalTarget = assertPathInsideRoot(root, target);
  return { realRoot, lexicalTarget };
}

function assertRealPathInsideRoot(realRoot: string, realTarget: string): void {
  if (!isPathInsideRoot(realRoot, realTarget)) throw outsideWorkspaceError();
}

export async function resolveExistingPathInsideRoot(root: string, target: string): Promise<string> {
  const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
  const realTarget = await fs.realpath(lexicalTarget);
  assertRealPathInsideRoot(realRoot, realTarget);
  return realTarget;
}

export async function resolveWritablePathInsideRoot(root: string, target: string): Promise<string> {
  const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
  const realParent = await fs.realpath(path.dirname(lexicalTarget));
  assertRealPathInsideRoot(realRoot, realParent);

  try {
    const realTarget = await fs.realpath(lexicalTarget);
    assertRealPathInsideRoot(realRoot, realTarget);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  return lexicalTarget;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
