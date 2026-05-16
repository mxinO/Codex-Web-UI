import fs from 'node:fs/promises';
import path from 'node:path';
function outsideWorkspaceError() {
    return new Error('path is outside active workspace');
}
function notFileError() {
    return new Error('path is not a file');
}
function isPathInsideRoot(resolvedRoot, resolvedTarget) {
    const relative = path.relative(resolvedRoot, resolvedTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export function assertPathInsideRoot(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(resolvedRoot, target);
    if (isPathInsideRoot(resolvedRoot, resolvedTarget)) {
        return resolvedTarget;
    }
    throw outsideWorkspaceError();
}
async function realRootAndLexicalTarget(root, target) {
    const realRoot = await fs.realpath(root);
    const lexicalTarget = assertPathInsideRoot(root, target);
    return { realRoot, lexicalTarget };
}
function assertRealPathInsideRoot(realRoot, realTarget) {
    if (!isPathInsideRoot(realRoot, realTarget))
        throw outsideWorkspaceError();
}
export async function resolveExistingPathInsideRoot(root, target) {
    const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
    const realTarget = await fs.realpath(lexicalTarget);
    assertRealPathInsideRoot(realRoot, realTarget);
    return realTarget;
}
function descriptorPathCandidates(fd) {
    return process.platform === 'linux' ? [`/proc/self/fd/${fd}`] : [`/dev/fd/${fd}`];
}
function descriptorChildPathCandidates(fd, childName) {
    return descriptorPathCandidates(fd).map((descriptorPath) => path.join(descriptorPath, childName));
}
async function realPathForOpenedFile(fd) {
    for (const candidate of descriptorPathCandidates(fd)) {
        try {
            return await fs.realpath(candidate);
        }
        catch {
            // Try the next descriptor path candidate.
        }
    }
    throw Object.assign(new Error('descriptor validation is not supported on this platform'), { statusCode: 501 });
}
async function openFirstAvailablePath(candidates, flags, mode) {
    let lastError;
    for (const candidate of candidates) {
        try {
            return await fs.open(candidate, flags, mode);
        }
        catch (error) {
            lastError = error;
            if (!isNotFoundError(error))
                throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export async function readOpenedFileFully(handle, size) {
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (bytesRead === 0)
            break;
        offset += bytesRead;
    }
    return buffer.subarray(0, offset);
}
export async function openExistingFileInsideRoot(root, target) {
    const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    const handle = await fs.open(lexicalTarget, openFlags);
    try {
        const [realPath, stats] = await Promise.all([realPathForOpenedFile(handle.fd), handle.stat()]);
        assertRealPathInsideRoot(realRoot, realPath);
        if (!stats.isFile())
            throw notFileError();
        return { handle, realPath, stats };
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
async function openRelativeToDirectory(parentHandle, childName, flags, mode) {
    return openFirstAvailablePath(descriptorChildPathCandidates(parentHandle.fd, childName), flags, mode);
}
export async function writeFileInsideRoot(root, target, data) {
    const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
    const targetName = path.basename(lexicalTarget);
    if (!targetName || targetName === '.' || targetName === '..')
        throw new Error('file name is required');
    const parentHandle = await fs.open(path.dirname(lexicalTarget), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
        const [realParent, parentStats] = await Promise.all([realPathForOpenedFile(parentHandle.fd), parentHandle.stat()]);
        assertRealPathInsideRoot(realRoot, realParent);
        if (!parentStats.isDirectory())
            throw new Error('parent path is not a directory');
        const existingFlags = fs.constants.O_RDWR | (fs.constants.O_NONBLOCK ?? 0);
        const createFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
        let handle;
        let created = false;
        try {
            handle = await openRelativeToDirectory(parentHandle, targetName, existingFlags);
        }
        catch (error) {
            if (!isNotFoundError(error))
                throw error;
            handle = await openRelativeToDirectory(parentHandle, targetName, createFlags, 0o600);
            created = true;
        }
        try {
            const [realPath, stats] = await Promise.all([realPathForOpenedFile(handle.fd), handle.stat()]);
            assertRealPathInsideRoot(realRoot, realPath);
            if (!stats.isFile())
                throw notFileError();
            if (!created)
                await handle.truncate(0);
            if (data.length > 0)
                await handle.writeFile(data);
        }
        finally {
            await handle.close().catch(() => undefined);
        }
    }
    finally {
        await parentHandle.close().catch(() => undefined);
    }
}
export async function resolveWritablePathInsideRoot(root, target) {
    const { realRoot, lexicalTarget } = await realRootAndLexicalTarget(root, target);
    const realParent = await fs.realpath(path.dirname(lexicalTarget));
    assertRealPathInsideRoot(realRoot, realParent);
    try {
        const realTarget = await fs.realpath(lexicalTarget);
        assertRealPathInsideRoot(realRoot, realTarget);
    }
    catch (error) {
        if (!isNotFoundError(error))
            throw error;
    }
    return lexicalTarget;
}
function isNotFoundError(error) {
    return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
