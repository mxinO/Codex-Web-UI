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
const NODE_WEB_API_MEMORY_OPTIONS = [NODE_FETCH_MEMORY_OPTION, NODE_WEBSOCKET_MEMORY_OPTION];
function truthyEnv(value) {
    return /^(1|true|yes)$/i.test(value ?? '');
}
function preserveNodeWebApis(env) {
    return truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_FETCH) || truthyEnv(env.CODEX_WEB_UI_PRESERVE_NODE_WEB_APIS);
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
        childEnv.NODE_OPTIONS = appendNodeOptions(childEnv.NODE_OPTIONS, NODE_WEB_API_MEMORY_OPTIONS);
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
    const options = NODE_WEB_API_MEMORY_OPTIONS.join(' ');
    const content = platform === 'win32'
        ? `@echo off\r\nset "NODE_OPTIONS=%NODE_OPTIONS% ${options}"\r\n"${realNode}" %*\r\n`
        : `#!/bin/sh
add_node_option() {
  case " \${NODE_OPTIONS:-} " in
    *" $1 "*) ;;
    *) NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }$1" ;;
  esac
}
add_node_option ${NODE_FETCH_MEMORY_OPTION}
add_node_option ${NODE_WEBSOCKET_MEMORY_OPTION}
export NODE_OPTIONS
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
export function prepareCodexChildRuntimeEnv(env, platform = process.platform, realNode = process.execPath) {
    if (preserveNodeWebApis(env))
        return { env, nodeWrapperPath: null, cleanup: () => undefined };
    const wrapper = createNodeWrapper(realNode, platform);
    if (!wrapper)
        return { env, nodeWrapperPath: null, cleanup: () => undefined };
    return {
        env: {
            ...env,
            PATH: [wrapper.directory, ...pathEntries(env)].join(path.delimiter),
        },
        nodeWrapperPath: wrapper.path,
        cleanup: wrapper.cleanup,
    };
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
    const targetTriple = targetTripleFor(platform, arch);
    const platformPackage = targetTriple ? PLATFORM_PACKAGE_BY_TARGET[targetTriple] : null;
    const launcherPath = findOnPath('codex', baseEnv, platform);
    const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
    if (targetTriple && platformPackage && launcherPath) {
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
            const runtimeEnv = prepareCodexChildRuntimeEnv(codexSpawn.env);
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
                nodeWebApis: NODE_WEB_API_MEMORY_OPTIONS.every((option) => runtimeEnv.env.NODE_OPTIONS?.split(/\s+/).includes(option)) ? 'disabled' : 'default',
                nodeWrapper: runtimeEnv.nodeWrapperPath ? 'enabled' : 'disabled',
            });
            let child;
            try {
                child = spawn(codexSpawn.command, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
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
            let settled = false;
            let connecting = false;
            const stdoutBuffer = new StartupOutputBuffer((line) => handleOutputLine('stdout', line));
            const stderrBuffer = new StartupOutputBuffer((line) => handleOutputLine('stderr', line));
            const startupTimeout = setTimeout(() => {
                fail(new Error('Timed out waiting for Codex app-server startup'));
            }, 15000);
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
        this.url = url;
        const socket = await this.openSocket(url, isCancelled);
        if (isCancelled()) {
            socket.close();
            throw new Error('Codex app-server startup was cancelled');
        }
        this.socket = socket;
        this.peer = new JsonRpcPeer(socket);
        this.peer.onNotification((message) => this.forwardNotification(message));
        this.peer.onServerRequest((message) => this.forwardServerRequest(message));
        return this.peer.request('initialize', {
            clientInfo: { name: 'codex-web-ui', version: '0.1.0' },
            capabilities: { experimentalApi: true },
        });
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
