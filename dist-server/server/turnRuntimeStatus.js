import fs from 'node:fs/promises';
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const TURN_CONTEXT_MARKER = Buffer.from('"type":"turn_context"', 'ascii');
function byteLimit(value, fallback, allowZero) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value))
        return fallback;
    const integer = Math.floor(value);
    return integer >= (allowZero ? 0 : 1) ? integer : fallback;
}
function errorDetail(error) {
    return error instanceof Error ? error.message : String(error);
}
function nonEmptyString(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function contextFromLine(line) {
    const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (content.length === 0 || content.indexOf(TURN_CONTEXT_MARKER) === -1)
        return null;
    try {
        const entry = JSON.parse(content.toString('utf8'));
        if (!entry || typeof entry !== 'object')
            return null;
        const record = entry;
        if (record.type !== 'turn_context' || !record.payload || typeof record.payload !== 'object')
            return null;
        const payload = record.payload;
        const model = nonEmptyString(payload.model);
        if (!model)
            return null;
        return {
            turnId: nonEmptyString(payload.turn_id),
            model,
            effort: nonEmptyString(payload.effort),
            recordedAt: nonEmptyString(record.timestamp),
        };
    }
    catch {
        return null;
    }
}
async function readCompleteChunk(handle, buffer, position) {
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, position + bytesRead);
        if (read.bytesRead === 0)
            break;
        bytesRead += read.bytesRead;
    }
    return bytesRead;
}
export async function readLatestTurnRuntimeContext(rolloutPath, options = {}) {
    if (!rolloutPath)
        return { status: 'none', context: null, scannedBytes: 0 };
    const maxScanBytes = byteLimit(options.maxScanBytes, DEFAULT_MAX_SCAN_BYTES, true);
    const chunkBytes = byteLimit(options.chunkBytes, DEFAULT_CHUNK_BYTES, false);
    let scannedBytes = 0;
    let handle;
    try {
        handle = await fs.open(rolloutPath, 'r');
    }
    catch (error) {
        return { status: 'unavailable', context: null, scannedBytes, detail: errorDetail(error) };
    }
    let lookup;
    try {
        const { size } = await handle.stat();
        let position = size;
        let carry = Buffer.alloc(0);
        let found = null;
        while (position > 0 && scannedBytes < maxScanBytes && !found) {
            const readBytes = Math.min(chunkBytes, maxScanBytes - scannedBytes, position);
            const readPosition = position - readBytes;
            const buffer = Buffer.allocUnsafe(readBytes);
            const bytesRead = await readCompleteChunk(handle, buffer, readPosition);
            scannedBytes += bytesRead;
            if (bytesRead !== readBytes) {
                throw new Error('rollout file changed during runtime context lookup');
            }
            position = readPosition;
            const combined = Buffer.concat([buffer, carry]);
            const newlines = [];
            for (let index = 0; index < combined.length; index += 1) {
                if (combined[index] === 0x0a)
                    newlines.push(index);
            }
            for (let index = newlines.length - 1; index > 0 && !found; index -= 1) {
                found = contextFromLine(combined.subarray(newlines[index - 1] + 1, newlines[index]));
            }
            if (!found && position === 0 && newlines.length > 0) {
                found = contextFromLine(combined.subarray(0, newlines[0]));
            }
            carry = newlines.length > 0 ? combined.subarray(0, newlines[0] + 1) : combined;
        }
        lookup = found
            ? { status: 'found', context: found, scannedBytes }
            : position > 0
                ? { status: 'scanLimit', context: null, scannedBytes }
                : { status: 'none', context: null, scannedBytes };
    }
    catch (error) {
        lookup = { status: 'unavailable', context: null, scannedBytes, detail: errorDetail(error) };
    }
    try {
        await handle.close();
    }
    catch (error) {
        lookup = { status: 'unavailable', context: null, scannedBytes, detail: errorDetail(error) };
    }
    return lookup;
}
