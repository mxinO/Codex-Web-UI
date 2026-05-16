import { spawn } from 'node:child_process';
let gitQueue = Promise.resolve();
let queuedGitJobs = 0;
export const MAX_GIT_QUEUE_DEPTH = 8;
function appendCapped(output, chunk, limit) {
    if (limit <= 0) {
        if (chunk.length > 0)
            output.truncated = true;
        return;
    }
    const remaining = limit - output.bytes;
    if (remaining <= 0) {
        if (chunk.length > 0)
            output.truncated = true;
        return;
    }
    if (chunk.length <= remaining) {
        output.chunks.push(chunk);
        output.bytes += chunk.length;
        return;
    }
    output.chunks.push(chunk.subarray(0, remaining));
    output.bytes += remaining;
    output.truncated = true;
}
function decodeOutput(output) {
    return Buffer.concat(output.chunks, output.bytes).toString('utf8');
}
function runGitChild(options) {
    return new Promise((resolve) => {
        options.beforeSpawn?.();
        const stdout = { chunks: [], bytes: 0, truncated: false };
        const stderr = { chunks: [], bytes: 0, truncated: false };
        let timedOut = false;
        let settled = false;
        let sigkillTimer = null;
        const child = spawn('git', options.args, {
            cwd: options.cwd,
            shell: false,
            env: options.readOnly ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' } : process.env,
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            sigkillTimer = setTimeout(() => {
                if (!settled)
                    child.kill('SIGKILL');
            }, 1_000);
        }, Math.max(1, options.timeoutMs));
        child.stdout.on('data', (chunk) => appendCapped(stdout, chunk, options.outputLimitBytes));
        child.stderr.on('data', (chunk) => appendCapped(stderr, chunk, options.outputLimitBytes));
        child.stdin.on('error', () => undefined);
        child.on('error', (error) => {
            appendCapped(stderr, Buffer.from(error.message), options.outputLimitBytes);
        });
        child.on('close', (code, signal) => {
            settled = true;
            clearTimeout(timeout);
            if (sigkillTimer)
                clearTimeout(sigkillTimer);
            resolve({
                stdout: decodeOutput(stdout),
                stderr: decodeOutput(stderr),
                exitCode: timedOut ? null : code,
                timedOut,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
            });
        });
        if (options.stdin !== undefined) {
            child.stdin.end(options.stdin);
        }
        else {
            child.stdin.end();
        }
    });
}
export function runGit(options) {
    if (queuedGitJobs >= MAX_GIT_QUEUE_DEPTH) {
        return Promise.reject(new Error('too many git jobs queued'));
    }
    queuedGitJobs += 1;
    const run = gitQueue
        .catch(() => undefined)
        .then(() => runGitChild(options))
        .finally(() => {
        queuedGitJobs -= 1;
    });
    gitQueue = run.then(() => undefined, () => undefined);
    return run;
}
