import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { JsonRpcPeer, } from './jsonRpc.js';
import { logError, logInfo, logWarn } from './logger.js';
const PLATFORM_PACKAGE_BY_TARGET = {
    'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
    'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
    'x86_64-apple-darwin': '@openai/codex-darwin-x64',
    'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
    'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
    'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};
const NODE_FETCH_MEMORY_OPTION = '--no-experimental-fetch';
const NODE_WEBSOCKET_MEMORY_OPTION = '--no-experimental-websocket';
const NODE_EVENTSOURCE_MEMORY_OPTION = '--no-experimental-eventsource';
const NODE_WEB_API_MEMORY_OPTIONS = [NODE_FETCH_MEMORY_OPTION, NODE_WEBSOCKET_MEMORY_OPTION, NODE_EVENTSOURCE_MEMORY_OPTION];
const ACTIVE_NODE_WEB_API_MEMORY_OPTIONS = NODE_WEB_API_MEMORY_OPTIONS.filter((option) => process.allowedNodeEnvironmentFlags.has(option));
export const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 60_000;
function truthyEnv(value) {
    return /^(1|true|yes)$/i.test(value ?? '');
}
function preserveNodeWebApis(env) {
    return truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_FETCH) || truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_WEB_APIS);
}
function codexLaunchMode(env) {
    const value = env.CODEX_WEB_UI_CODEX_LAUNCH_MODE?.trim().toLowerCase();
    return value === 'native' || value === 'path' ? value : 'auto';
}
function appendNodeOptions(options, nextOptions) {
    const trimmed = options?.trim();
    const tokens = trimmed ? trimmed.split(/\s+/) : [];
    for (const option of nextOptions) {
        if (!tokens.includes(option))
            tokens.push(option);
    }
    return tokens.join(' ');
}
function codexChildBaseEnv(env) {
    const childEnv = { ...env };
    if (!preserveNodeWebApis(childEnv)) {
        childEnv.NODE_OPTIONS = appendNodeOptions(childEnv.NODE_OPTIONS, ACTIVE_NODE_WEB_API_MEMORY_OPTIONS);
    }
    return childEnv;
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function createNodeWrapper(realNode, platform = process.platform) {
    if (!realNode || !path.isAbsolute(realNode) || !fs.existsSync(realNode))
        return null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-webui-node-'));
    const wrapperPath = path.join(directory, platform === 'win32' ? 'node.cmd' : 'node');
    const options = ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.join(' ');
    const posixAddOptions = ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.map((option) => `add_node_option ${option}`).join('\n');
    const content = platform === 'win32'
        ? `@echo off\r\nset "NODE_OPTIONS=%NODE_OPTIONS% ${options}"\r\n"${realNode}" %*\r\n`
        : `#!/bin/sh
add_node_option() {
  case " \${NODE_OPTIONS:-} " in
    *" $1 "*) ;;
    *) NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }$1" ;;
  esac
}
${posixAddOptions}
export NODE_OPTIONS
trace_enabled() {
  case "\${CODEX_WEB_UI_TRACE_CODEX_PROCESSES:-}" in
    1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}
trace_sanitize_arg() {
  lower_arg=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  case "$lower_arg" in
    *api-key*|*api_key*|*apikey*|*token*|*secret*|*password*|*passwd*|*credential*|*authorization*|*cookie*|sk-*|ghp_*|gho_*|ghu_*|ghs_*|ghr_*|github_pat_*|github_pat-*|xox*|nvapi-*) printf '<redacted>' ;;
    *) printf '%s' "$1" | LC_ALL=C tr '\\r\\n\\t' '   ' ;;
  esac
}
trace_sanitize_text() {
  printf '%s' "$1" | LC_ALL=C tr '\\r\\n\\t' '   '
}
if trace_enabled; then
  path_head=''
  old_ifs=$IFS
  IFS=:
  count=0
  for dir in \${PATH:-}; do
    count=$((count + 1))
    [ "$count" -gt 5 ] && break
    path_head="\${path_head}\${path_head:+|}$dir"
  done
  IFS=$old_ifs
  first_arg=$(trace_sanitize_arg "\${1:-}")
  real_node=$(trace_sanitize_text ${shellQuote(realNode)})
  cwd=$(trace_sanitize_text "$(pwd -P 2>/dev/null || pwd)")
  node_options=$(trace_sanitize_arg "\${NODE_OPTIONS:-}")
  path_head=$(trace_sanitize_text "$path_head")
  printf '[codex-web-ui-node-wrapper] pid=%s ppid=%s real_node=%s cwd=%s node_options=%s path_head=%s argc=%s first_arg=%s\\n' "$$" "$PPID" "$real_node" "$cwd" "$node_options" "$path_head" "$#" "$first_arg" >&2
fi
exec ${shellQuote(realNode)} "$@"
`;
    fs.writeFileSync(wrapperPath, content, { encoding: 'utf8', mode: platform === 'win32' ? 0o600 : 0o700 });
    if (platform !== 'win32')
        fs.chmodSync(wrapperPath, 0o700);
    return {
        directory,
        path: wrapperPath,
        cleanup: () => {
            fs.rmSync(directory, { recursive: true, force: true });
        },
    };
}
export function prepareCodexChildRuntimeEnv(env, platform = process.platform, realNode = process.execPath, sqliteHome) {
    const childEnv = sqliteHome ? { ...env, CODEX_SQLITE_HOME: sqliteHome } : env;
    if (preserveNodeWebApis(childEnv))
        return { env: childEnv, nodeWrapperPath: null, cleanup: () => undefined };
    const wrapper = createNodeWrapper(realNode, platform);
    if (!wrapper)
        return { env: childEnv, nodeWrapperPath: null, cleanup: () => undefined };
    return {
        env: {
            ...childEnv,
            PATH: [wrapper.directory, ...pathEntries(childEnv)].join(path.delimiter),
        },
        nodeWrapperPath: wrapper.path,
        cleanup: wrapper.cleanup,
    };
}
export function codexAppServerArgs(sqliteHome) {
    const configArgs = sqliteHome ? ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`] : [];
    return [...configArgs, 'app-server', '--listen', 'ws://127.0.0.1:0'];
}
function selectedTraceEnv(pid) {
    const result = {};
    let raw = '';
    try {
        raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    }
    catch {
        return result;
    }
    for (const entry of raw.split('\0')) {
        const separator = entry.indexOf('=');
        if (separator <= 0)
            continue;
        const key = entry.slice(0, separator);
        const value = entry.slice(separator + 1);
        if (key === 'NODE_OPTIONS')
            result.NODE_OPTIONS = value;
        if (key === 'PATH')
            result.PATH_HEAD = value.split(path.delimiter).slice(0, 5);
        if (key === 'npm_execpath')
            result.npm_execpath = value;
        if (key === 'npm_config_user_agent')
            result.npm_config_user_agent = value;
        if (key === 'CODEX_MANAGED_BY_NPM')
            result.CODEX_MANAGED_BY_NPM = value;
        if (key === 'CODEX_MANAGED_BY_BUN')
            result.CODEX_MANAGED_BY_BUN = value;
        if (key === 'CODEX_WEB_UI_CODEX_LAUNCH_MODE')
            result.CODEX_WEB_UI_CODEX_LAUNCH_MODE = value;
        if (key === 'CODEX_WEB_UI_TRACE_CODEX_PROCESSES')
            result.CODEX_WEB_UI_TRACE_CODEX_PROCESSES = value;
    }
    return result;
}
const TRACE_SECRET_KEY_PATTERN = /(?:api[-_]?key|token|secret|password|passwd|credential|authorization|cookie)/i;
function redactTraceArgValue(value) {
    return value
        .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1<redacted>')
        .replace(/(cookie:\s*)[^\s"']+/gi, '$1<redacted>')
        .replace(/((?:api[-_]?key|token|secret|password|passwd|credential)\s*[:=]\s*)[^\s"']+/gi, '$1<redacted>')
        .replace(/\bsk-[A-Za-z0-9_=-]{16,}/g, '<redacted>')
        .replace(/\bgh[pousr]_[A-Za-z0-9_=-]{16,}/g, '<redacted>')
        .replace(/\bgithub_pat_[A-Za-z0-9_=-]{16,}/g, '<redacted>')
        .replace(/\bxox[baprs]-[A-Za-z0-9_=-]{16,}/g, '<redacted>')
        .replace(/\bnvapi-[A-Za-z0-9_=-]{16,}/g, '<redacted>');
}
export function sanitizeProcessArgvForTrace(argv) {
    const maxArgs = 64;
    const sanitized = [];
    let redactNext = false;
    for (const arg of argv.slice(0, maxArgs)) {
        if (redactNext) {
            sanitized.push('<redacted>');
            redactNext = false;
            continue;
        }
        const separator = arg.indexOf('=');
        if (separator > 0 && TRACE_SECRET_KEY_PATTERN.test(arg.slice(0, separator))) {
            sanitized.push(`${arg.slice(0, separator)}=<redacted>`);
            continue;
        }
        if (/^--?/.test(arg) && TRACE_SECRET_KEY_PATTERN.test(arg)) {
            sanitized.push(arg);
            redactNext = true;
            continue;
        }
        sanitized.push(redactTraceArgValue(arg));
    }
    if (argv.length > maxArgs)
        sanitized.push(`<truncated ${argv.length - maxArgs} args>`);
    return sanitized;
}
function readProcStatSnapshot(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0)
            return null;
        const comm = stat.slice(stat.indexOf('(') + 1, close);
        const rest = stat.slice(close + 2).split(' ');
        const ppid = Number(rest[1]);
        if (!Number.isFinite(ppid))
            return null;
        const startTime = rest[19] ?? '';
        return { pid, ppid, startTime, comm };
    }
    catch {
        return null;
    }
}
function readProcSnapshot(stat) {
    let argv = [];
    let exe = null;
    try {
        argv = sanitizeProcessArgvForTrace(fs.readFileSync(`/proc/${stat.pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
    }
    catch {
        argv = [];
    }
    try {
        exe = fs.readlinkSync(`/proc/${stat.pid}/exe`);
    }
    catch {
        exe = null;
    }
    return { ...stat, argv, exe };
}
function codexTraceDurationMs(env) {
    const parsed = Number(env.CODEX_WEB_UI_TRACE_CODEX_PROCESSES_MS ?? 5000);
    if (!Number.isFinite(parsed))
        return 5000;
    return Math.max(1000, Math.min(30000, parsed));
}
function codexTraceIntervalMs(env) {
    const parsed = Number(env.CODEX_WEB_UI_TRACE_CODEX_PROCESSES_INTERVAL_MS ?? 10);
    if (!Number.isFinite(parsed))
        return 10;
    return Math.max(5, Math.min(1000, parsed));
}
function startCodexProcessTrace(rootPid, env = process.env) {
    if (!rootPid || process.platform !== 'linux' || !truthyEnv(env.CODEX_WEB_UI_TRACE_CODEX_PROCESSES))
        return () => undefined;
    const seenIdentities = new Map();
    const durationMs = codexTraceDurationMs(env);
    const intervalMs = codexTraceIntervalMs(env);
    let stopped = false;
    const sample = () => {
        if (stopped)
            return;
        const statSnapshots = new Map();
        let procEntries;
        try {
            procEntries = fs.readdirSync('/proc');
        }
        catch {
            stop();
            return;
        }
        for (const entry of procEntries) {
            if (!/^\d+$/.test(entry))
                continue;
            const snapshot = readProcStatSnapshot(Number(entry));
            if (snapshot)
                statSnapshots.set(snapshot.pid, snapshot);
        }
        const descendants = new Set([rootPid]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const snapshot of statSnapshots.values()) {
                if (!descendants.has(snapshot.pid) && descendants.has(snapshot.ppid)) {
                    descendants.add(snapshot.pid);
                    changed = true;
                }
            }
        }
        for (const pid of descendants) {
            const statSnapshot = statSnapshots.get(pid);
            if (!statSnapshot)
                continue;
            const snapshot = readProcSnapshot(statSnapshot);
            const identity = [snapshot.startTime, snapshot.exe ?? '', ...snapshot.argv].join('\0');
            const previousIdentity = seenIdentities.get(pid);
            if (previousIdentity === identity)
                continue;
            seenIdentities.set(pid, identity);
            logWarn('Codex process trace observed process', {
                pid: snapshot.pid,
                ppid: snapshot.ppid,
                startTime: snapshot.startTime,
                comm: snapshot.comm,
                exe: snapshot.exe,
                argv: snapshot.argv,
                selectedEnv: selectedTraceEnv(snapshot.pid),
                identityChanged: previousIdentity !== undefined,
            });
        }
    };
    logWarn('Codex process tracing enabled', { rootPid, durationMs, intervalMs });
    const interval = setInterval(sample, intervalMs);
    const timeout = setTimeout(stop, durationMs);
    interval.unref();
    timeout.unref();
    sample();
    function stop() {
        if (stopped)
            return;
        stopped = true;
        clearInterval(interval);
        clearTimeout(timeout);
        logWarn('Codex process tracing stopped', { rootPid, observedProcesses: seenIdentities.size });
    }
    return stop;
}
function targetTripleFor(platform = process.platform, arch = process.arch) {
    if (platform === 'linux' || platform === 'android') {
        if (arch === 'x64')
            return 'x86_64-unknown-linux-musl';
        if (arch === 'arm64')
            return 'aarch64-unknown-linux-musl';
    }
    if (platform === 'darwin') {
        if (arch === 'x64')
            return 'x86_64-apple-darwin';
        if (arch === 'arm64')
            return 'aarch64-apple-darwin';
    }
    if (platform === 'win32') {
        if (arch === 'x64')
            return 'x86_64-pc-windows-msvc';
        if (arch === 'arm64')
            return 'aarch64-pc-windows-msvc';
    }
    return null;
}
function pathEntries(env) {
    return (env.PATH ?? '').split(path.delimiter).filter(Boolean);
}
function isExecutableFile(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
function findOnPath(command, env, platform = process.platform) {
    if (path.isAbsolute(command) || command.includes(path.sep)) {
        return isExecutableFile(command) ? command : null;
    }
    const extensions = platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
    for (const dir of pathEntries(env)) {
        for (const extension of extensions) {
            const candidate = path.join(dir, `${command}${extension}`);
            if (isExecutableFile(candidate))
                return candidate;
        }
    }
    return null;
}
function safeRealPath(filePath) {
    try {
        return fs.realpathSync.native(filePath);
    }
    catch {
        return null;
    }
}
function managedByEnvVar(launcherPath, env) {
    if (/\bbun\//.test(env.npm_config_user_agent ?? ''))
        return 'CODEX_MANAGED_BY_BUN';
    if ((env.npm_execpath ?? '').includes('bun'))
        return 'CODEX_MANAGED_BY_BUN';
    if (launcherPath.includes('.bun/install/global') || launcherPath.includes('.bun\\install\\global'))
        return 'CODEX_MANAGED_BY_BUN';
    return 'CODEX_MANAGED_BY_NPM';
}
function nativeBinaryFromCodexLauncher(launcherPath, targetTriple, platformPackage, binaryName) {
    const candidates = Array.from(new Set([launcherPath, safeRealPath(launcherPath)].filter((candidate) => Boolean(candidate))));
    for (const candidate of candidates) {
        try {
            const requireFromLauncher = createRequire(pathToFileURL(candidate));
            const packageJsonPath = requireFromLauncher.resolve(`${platformPackage}/package.json`);
            const binaryPath = path.join(path.dirname(packageJsonPath), 'vendor', targetTriple, 'codex', binaryName);
            if (isExecutableFile(binaryPath))
                return binaryPath;
        }
        catch {
            // Fall through to local vendor layout below.
        }
        const localBinaryPath = path.join(path.dirname(candidate), '..', 'vendor', targetTriple, 'codex', binaryName);
        if (isExecutableFile(localBinaryPath))
            return localBinaryPath;
    }
    return null;
}
export function resolveCodexSpawnConfig(env = process.env, platform = process.platform, arch = process.arch) {
    const baseEnv = codexChildBaseEnv(env);
    const override = env.CODEX_WEB_UI_CODEX_BIN?.trim();
    if (override)
        return { command: override, env: baseEnv, source: 'env' };
    const launchMode = codexLaunchMode(env);
    const targetTriple = targetTripleFor(platform, arch);
    const platformPackage = targetTriple ? PLATFORM_PACKAGE_BY_TARGET[targetTriple] : null;
    const launcherPath = findOnPath('codex', baseEnv, platform);
    const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
    if (launchMode !== 'path' && targetTriple && platformPackage && launcherPath) {
        const binaryPath = nativeBinaryFromCodexLauncher(launcherPath, targetTriple, platformPackage, binaryName);
        if (binaryPath) {
            const archRoot = path.dirname(path.dirname(binaryPath));
            const pathDir = path.join(archRoot, 'path');
            const nextPath = fs.existsSync(pathDir) ? [pathDir, ...pathEntries(baseEnv)].join(path.delimiter) : baseEnv.PATH;
            const managerEnvVar = managedByEnvVar(launcherPath, baseEnv);
            return {
                command: binaryPath,
                env: {
                    ...baseEnv,
                    ...(nextPath ? { PATH: nextPath } : {}),
                    [managerEnvVar]: baseEnv[managerEnvVar] ?? '1',
                },
                source: 'native-package',
            };
        }
    }
    return { command: launcherPath ?? 'codex', env: baseEnv, source: 'path' };
}
export class CodexAppServer {
    options;
    child = null;
    peer = null;
    socket = null;
    openingSocket = null;
    url = null;
    readyzUrl = null;
    deadError = null;
    startPromise = null;
    restartPromise = null;
    initialized = false;
    lifecycleId = 0;
    healthHandlers = new Set();
    notificationHandlers = new Set();
    requestHandlers = new Set();
    constructor(options) {
        this.options = options;
    }
    start() {
        if (this.restartPromise)
            return this.restartPromise;
        if (this.isConnected())
            return Promise.resolve();
        if (this.startPromise)
            return this.startPromise;
        this.deadError = null;
        this.initialized = false;
        if (this.options.mock) {
            this.url = 'mock://codex-app-server';
            this.initialized = true;
            this.emitHealthChange();
            return Promise.resolve();
        }
        const startup = this.startReal();
        this.startPromise = startup;
        void startup.then(() => {
            if (this.startPromise === startup)
                this.startPromise = null;
        }, () => {
            if (this.startPromise === startup)
                this.startPromise = null;
        });
        return startup;
    }
    async request(method, params, timeoutMs) {
        if (!this.peer || !this.isConnected()) {
            throw this.deadError ?? new Error('Codex app-server is not connected');
        }
        return this.peer.request(method, params, timeoutMs);
    }
    respond(id, result) {
        if (!this.peer || !this.isConnected()) {
            throw this.deadError ?? new Error('Codex app-server is not connected');
        }
        this.peer.respond(id, result);
    }
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => {
            this.notificationHandlers.delete(handler);
        };
    }
    onServerRequest(handler) {
        this.requestHandlers.add(handler);
        return () => {
            this.requestHandlers.delete(handler);
        };
    }
    onHealthChange(handler) {
        this.healthHandlers.add(handler);
        return () => {
            this.healthHandlers.delete(handler);
        };
    }
    health() {
        return {
            connected: this.isConnected(),
            dead: this.deadError !== null,
            error: this.deadError?.message ?? null,
            readyzUrl: this.readyzUrl,
            url: this.url,
        };
    }
    getUrl() {
        return this.url;
    }
    getPid() {
        return this.child?.pid ?? null;
    }
    stop() {
        this.lifecycleId++;
        const child = this.child;
        const socket = this.socket;
        const openingSocket = this.openingSocket;
        this.child = null;
        this.startPromise = null;
        this.initialized = false;
        this.url = null;
        this.readyzUrl = null;
        this.deadError = null;
        this.socket = null;
        this.openingSocket = null;
        this.peer = null;
        socket?.close();
        openingSocket?.close();
        if (child && !child.killed) {
            logInfo('Stopping Codex app-server child', { pid: child.pid });
            child.kill();
        }
        this.emitHealthChange();
    }
    async restart() {
        if (this.restartPromise)
            return this.restartPromise;
        let restart;
        const operation = (async () => {
            const child = this.child;
            this.stop();
            if (child)
                await this.waitForChildExit(child);
            this.restartPromise = null;
            return this.start();
        })();
        restart = operation.finally(() => {
            if (this.restartPromise === restart)
                this.restartPromise = null;
        });
        this.restartPromise = restart;
        return this.restartPromise;
    }
    startReal() {
        return new Promise((resolve, reject) => {
            const lifecycleId = ++this.lifecycleId;
            const codexSpawn = resolveCodexSpawnConfig();
            if (this.options.sqliteHome) {
                fs.mkdirSync(this.options.sqliteHome, { recursive: true, mode: 0o700 });
                fs.chmodSync(this.options.sqliteHome, 0o700);
            }
            const runtimeEnv = prepareCodexChildRuntimeEnv(codexSpawn.env, process.platform, process.execPath, this.options.sqliteHome);
            const runtimeNodeOptions = runtimeEnv.env.NODE_OPTIONS?.split(/\s+/).filter(Boolean) ?? [];
            let runtimeCleaned = false;
            const cleanupRuntime = () => {
                if (runtimeCleaned)
                    return;
                runtimeCleaned = true;
                runtimeEnv.cleanup();
            };
            logInfo('Starting Codex app-server child', {
                cwd: this.options.cwd,
                command: codexSpawn.command,
                source: codexSpawn.source,
                sqliteHome: this.options.sqliteHome ?? null,
                launchMode: codexLaunchMode(process.env),
                nodeWebApis: ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.length > 0 && ACTIVE_NODE_WEB_API_MEMORY_OPTIONS.every((option) => runtimeNodeOptions.includes(option)) ? 'disabled' : 'default',
                nodeWrapper: runtimeEnv.nodeWrapperPath ? 'enabled' : 'disabled',
            });
            let child;
            try {
                child = spawn(codexSpawn.command, codexAppServerArgs(this.options.sqliteHome), {
                    cwd: this.options.cwd,
                    env: runtimeEnv.env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            }
            catch (error) {
                cleanupRuntime();
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.child = child;
            logInfo('Codex app-server child spawned', { pid: child.pid });
            const cleanupProcessTrace = startCodexProcessTrace(child.pid);
            let settled = false;
            let connecting = false;
            const stdoutBuffer = new StartupOutputBuffer((line) => handleOutputLine('stdout', line));
            const stderrBuffer = new StartupOutputBuffer((line) => handleOutputLine('stderr', line));
            const startupTimeout = setTimeout(() => {
                fail(new Error('Timed out waiting for Codex app-server startup'));
            }, CODEX_APP_SERVER_STARTUP_TIMEOUT_MS);
            const cleanupStartup = () => {
                clearTimeout(startupTimeout);
                child.off('exit', onStartupExit);
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                const current = this.isCurrentLifecycle(lifecycleId, child);
                cleanupStartup();
                cleanupProcessTrace();
                logError('Codex app-server startup failed', { pid: child.pid, error });
                if (current) {
                    this.closeSockets();
                }
                this.stopChild(child);
                if (current) {
                    this.deadError = error;
                    this.startPromise = null;
                    this.initialized = false;
                    this.emitHealthChange();
                }
                reject(error);
            };
            const succeed = (response) => {
                if (settled)
                    return;
                settled = true;
                cleanupStartup();
                if (this.isCurrentLifecycle(lifecycleId, child)) {
                    this.initialized = true;
                    logInfo('Codex app-server initialized', { pid: child.pid, url: this.url, readyzUrl: this.readyzUrl });
                    this.emitHealthChange();
                }
                resolve(response);
            };
            const onError = (error) => {
                if (!settled) {
                    cleanupRuntime();
                    fail(error);
                    return;
                }
                if (this.isCurrentLifecycle(lifecycleId, child)) {
                    logError('Codex app-server child error', { pid: child.pid, error });
                }
            };
            const onStartupExit = (code, signal) => {
                fail(new Error(`Codex app-server exited during startup: ${this.formatExit(code, signal)}`));
            };
            const handleOutputLine = (stream, line) => {
                if (!this.isCurrentLifecycle(lifecycleId, child))
                    return;
                this.captureReadyz(line);
                if (line.trim()) {
                    const meta = { pid: child.pid, line };
                    if (stream === 'stderr')
                        logWarn('Codex app-server stderr', meta);
                    else
                        logInfo('Codex app-server stdout', meta);
                }
                const url = this.captureListeningUrl(line);
                if (!url || connecting)
                    return;
                connecting = true;
                this.connect(url, () => !this.isCurrentLifecycle(lifecycleId, child)).then(succeed, fail);
            };
            const onStdoutOutput = (chunk) => stdoutBuffer.feed(chunk);
            const onStderrOutput = (chunk) => stderrBuffer.feed(chunk);
            child.stdout.on('data', onStdoutOutput);
            child.stderr.on('data', onStderrOutput);
            child.on('error', onError);
            child.once('exit', cleanupRuntime);
            child.once('exit', cleanupProcessTrace);
            child.once('exit', onStartupExit);
            child.once('exit', (code, signal) => {
                if (!this.isCurrentLifecycle(lifecycleId, child))
                    return;
                const error = new Error(`Codex app-server exited: ${this.formatExit(code, signal)}`);
                logError('Codex app-server child exited', { pid: child.pid, code, signal, error });
                this.deadError = error;
                this.peer = null;
                this.socket = null;
                this.child = null;
                this.startPromise = null;
                this.initialized = false;
                this.emitHealthChange();
            });
        });
    }
    async connect(url, isCancelled) {
        if (isCancelled()) {
            throw new Error('Codex app-server startup was cancelled');
        }
        const lifecycleId = this.lifecycleId;
        this.url = url;
        const socket = await this.openSocket(url, isCancelled);
        if (isCancelled()) {
            socket.close();
            throw new Error('Codex app-server startup was cancelled');
        }
        const peer = new JsonRpcPeer(socket);
        const isCurrentPeer = () => (this.lifecycleId === lifecycleId
            && this.socket === socket
            && this.peer === peer);
        this.socket = socket;
        this.peer = peer;
        peer.onNotification((message) => {
            if (isCurrentPeer()) {
                this.forwardNotification(message);
            }
        });
        peer.onServerRequest((message) => {
            if (isCurrentPeer()) {
                this.forwardServerRequest(message);
            }
        });
        const response = await peer.request('initialize', {
            clientInfo: { name: 'codex-web-ui', version: '0.1.0' },
            capabilities: { experimentalApi: true },
        });
        if (isCancelled() || !isCurrentPeer()) {
            throw new Error('Codex app-server startup was cancelled');
        }
        peer.notify('initialized');
        return response;
    }
    openSocket(url, isCancelled) {
        return new Promise((resolve, reject) => {
            if (isCancelled()) {
                reject(new Error('Codex app-server startup was cancelled'));
                return;
            }
            const socket = new WebSocket(url);
            this.openingSocket = socket;
            const cleanup = () => {
                socket.off('open', onOpen);
                socket.off('error', onError);
                socket.off('close', onClose);
                if (this.openingSocket === socket) {
                    this.openingSocket = null;
                }
            };
            const onOpen = () => {
                cleanup();
                if (isCancelled()) {
                    socket.close();
                    reject(new Error('Codex app-server startup was cancelled'));
                    return;
                }
                this.handleSocketOpen(socket);
                resolve(socket);
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(new Error('Codex app-server WebSocket closed during startup'));
            };
            socket.once('open', onOpen);
            socket.once('error', onError);
            socket.once('close', onClose);
        });
    }
    isCurrentLifecycle(lifecycleId, child) {
        return this.lifecycleId === lifecycleId && this.child === child;
    }
    isConnected() {
        if (this.options.mock)
            return this.initialized;
        return this.initialized && this.socket?.readyState === WebSocket.OPEN && this.peer !== null;
    }
    handleSocketOpen(socket) {
        socket.on('close', () => {
            this.failCurrentSocket(socket, new Error('Codex app-server WebSocket closed'));
        });
        socket.on('error', (error) => {
            this.failCurrentSocket(socket, error);
        });
    }
    failCurrentSocket(socket, error) {
        if (this.socket !== socket)
            return;
        const child = this.child;
        logError('Codex app-server WebSocket failed', { pid: child?.pid ?? null, error });
        this.deadError = error;
        this.peer = null;
        this.socket = null;
        this.startPromise = null;
        this.initialized = false;
        this.url = null;
        this.readyzUrl = null;
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
            socket.close();
        }
        if (child)
            this.stopChild(child);
        this.emitHealthChange();
    }
    stopChild(child) {
        if (this.child === child) {
            this.child = null;
        }
        if (!child.killed) {
            child.kill();
        }
    }
    waitForChildExit(child, timeoutMs = 3000) {
        if (child.exitCode !== null || child.signalCode !== null)
            return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            let killTimer = null;
            let forceResolveTimer = null;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                if (killTimer)
                    clearTimeout(killTimer);
                if (forceResolveTimer)
                    clearTimeout(forceResolveTimer);
                child.off('exit', finish);
                resolve();
            };
            killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    logWarn('Force killing Codex app-server child after restart timeout', { pid: child.pid });
                    child.kill('SIGKILL');
                }
                forceResolveTimer = setTimeout(finish, 1000);
            }, timeoutMs);
            child.once('exit', finish);
        });
    }
    closeSockets() {
        const socket = this.socket;
        const openingSocket = this.openingSocket;
        this.socket = null;
        this.openingSocket = null;
        this.peer = null;
        this.initialized = false;
        socket?.close();
        openingSocket?.close();
    }
    emitHealthChange() {
        for (const handler of this.healthHandlers)
            handler();
    }
    forwardNotification(message) {
        for (const handler of this.notificationHandlers)
            handler(message);
    }
    forwardServerRequest(message) {
        for (const handler of this.requestHandlers)
            handler(message);
    }
    captureReadyz(output) {
        const match = output.match(/readyz:\s*(https?:\/\/\S+)/i);
        if (match)
            this.readyzUrl = match[1];
    }
    captureListeningUrl(output) {
        const match = output.match(/listening on:\s*(ws:\/\/\S+)/i);
        if (!match)
            return null;
        this.url = match[1];
        return match[1];
    }
    formatExit(code, signal) {
        if (code !== null)
            return `code ${code}`;
        if (signal !== null)
            return `signal ${signal}`;
        return 'unknown status';
    }
}
class StartupOutputBuffer {
    onLine;
    pending = '';
    maxPendingChars = 4096;
    constructor(onLine) {
        this.onLine = onLine;
    }
    feed(chunk) {
        this.pending += chunk.toString('utf8');
        const lines = this.pending.split(/\r?\n/);
        this.pending = lines.pop() ?? '';
        if (this.pending.length > this.maxPendingChars) {
            this.pending = this.pending.slice(-this.maxPendingChars);
        }
        for (const line of lines) {
            this.onLine(line);
        }
    }
}
