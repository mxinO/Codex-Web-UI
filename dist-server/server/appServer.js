import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { JsonRpcPeer, } from './jsonRpc.js';
import { logError, logInfo, logWarn } from './logger.js';
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
            logInfo('Starting Codex app-server child', { cwd: this.options.cwd });
            const child = spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:0'], {
                cwd: this.options.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
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
