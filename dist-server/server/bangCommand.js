import { spawn } from 'node:child_process';
const INTERACTIVE_COMMAND_PATTERN = /(^|[;&|]\s*)(?:\S+\/)?(?:vi|vim|nano|emacs|less|more|top|htop|ssh|sftp|ftp|python(?:\d+(?:\.\d+)?)?|node|bash|zsh|fish)(?:\s|$)/i;
export function isInteractiveCommandBlocked(command) {
    return INTERACTIVE_COMMAND_PATTERN.test(command.trim());
}
export function runBangCommand(command, cwd, timeoutMs, outputBytesCap) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-lc', command], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                TERM: 'dumb',
                PAGER: 'cat',
                GIT_PAGER: 'cat',
                MANPAGER: 'cat',
            },
        });
        let stdout = '';
        let stderr = '';
        let remainingBytes = Math.max(0, outputBytesCap);
        let outputTruncated = false;
        let killed = false;
        let settled = false;
        let escalationTimer = null;
        const append = (stream, chunk) => {
            if (remainingBytes <= 0) {
                outputTruncated = true;
                return;
            }
            const slice = chunk.byteLength <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes);
            remainingBytes -= slice.byteLength;
            if (slice.byteLength < chunk.byteLength)
                outputTruncated = true;
            if (stream === 'stdout')
                stdout += slice.toString('utf8');
            else
                stderr += slice.toString('utf8');
        };
        const timeout = setTimeout(() => {
            killed = true;
            child.kill('SIGTERM');
            escalationTimer = setTimeout(() => {
                if (!settled)
                    child.kill('SIGKILL');
            }, 2000);
        }, timeoutMs);
        child.stdout.on('data', (chunk) => append('stdout', chunk));
        child.stderr.on('data', (chunk) => append('stderr', chunk));
        child.on('error', (error) => {
            clearTimeout(timeout);
            if (escalationTimer)
                clearTimeout(escalationTimer);
            reject(error);
        });
        child.on('exit', (code, signal) => {
            settled = true;
            clearTimeout(timeout);
            if (escalationTimer)
                clearTimeout(escalationTimer);
            resolve({
                stdout,
                stderr,
                exitCode: typeof code === 'number' ? code : signal ? 1 : null,
                killed,
                cwd,
                outputTruncated,
            });
        });
    });
}
