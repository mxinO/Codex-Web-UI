export class JsonRpcPeer {
    socket;
    nextId = 1;
    closed = false;
    pending = new Map();
    notificationHandlers = new Set();
    serverRequestHandlers = new Set();
    constructor(socket) {
        this.socket = socket;
        this.socket.on('message', (data) => this.handleMessage(data));
        this.socket.on('close', () => this.closePending(new Error('JSON-RPC socket closed')));
        this.socket.on('error', (error) => this.closePending(error));
    }
    request(method, params, timeoutMs = 30000) {
        if (this.closed) {
            return Promise.reject(new Error('JSON-RPC socket is closed'));
        }
        const id = this.nextId++;
        const request = { jsonrpc: '2.0', id, method };
        if (params !== undefined)
            request.params = params;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`JSON-RPC request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
            });
            try {
                this.socket.send(JSON.stringify(request));
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    notify(method, params) {
        if (this.closed) {
            throw new Error('JSON-RPC socket is closed');
        }
        const notification = { jsonrpc: '2.0', method };
        if (params !== undefined)
            notification.params = params;
        this.socket.send(JSON.stringify(notification));
    }
    respond(id, result) {
        if (this.closed) {
            throw new Error('JSON-RPC socket is closed');
        }
        const response = { jsonrpc: '2.0', id, result: result === undefined ? null : result };
        this.socket.send(JSON.stringify(response));
    }
    respondError(id, code, message, data) {
        if (this.closed) {
            throw new Error('JSON-RPC socket is closed');
        }
        const error = { code, message };
        if (data !== undefined)
            error.data = data;
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
    }
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => {
            this.notificationHandlers.delete(handler);
        };
    }
    onServerRequest(handler) {
        this.serverRequestHandlers.add(handler);
        return () => {
            this.serverRequestHandlers.delete(handler);
        };
    }
    handleMessage(data) {
        const text = this.messageToString(data);
        if (text === null)
            return;
        let message;
        try {
            message = JSON.parse(text);
        }
        catch {
            return;
        }
        if (!this.isRecord(message) || ('jsonrpc' in message && message.jsonrpc !== '2.0'))
            return;
        const normalized = { jsonrpc: '2.0', ...message };
        if (this.isResponse(normalized)) {
            this.handleResponse(normalized);
            return;
        }
        if (this.isServerRequest(normalized)) {
            for (const handler of this.serverRequestHandlers)
                handler(normalized);
            return;
        }
        if (this.isNotification(normalized)) {
            for (const handler of this.notificationHandlers)
                handler(normalized);
        }
    }
    handleResponse(response) {
        if (typeof response.id !== 'number')
            return;
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) {
            pending.reject(new Error(response.error.message));
        }
        else {
            pending.resolve(response.result);
        }
    }
    closePending(error) {
        if (this.closed)
            return;
        this.closed = true;
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
        }
    }
    messageToString(data) {
        if (typeof data === 'string')
            return data;
        if (Buffer.isBuffer(data))
            return data.toString('utf8');
        if (data instanceof ArrayBuffer)
            return Buffer.from(data).toString('utf8');
        if (Array.isArray(data))
            return Buffer.concat(data).toString('utf8');
        return null;
    }
    isRecord(value) {
        return typeof value === 'object' && value !== null;
    }
    isResponse(value) {
        return (typeof value.id === 'number' || typeof value.id === 'string') && ('result' in value || 'error' in value);
    }
    isNotification(value) {
        return typeof value.method === 'string' && !('id' in value);
    }
    isServerRequest(value) {
        return (typeof value.id === 'number' || typeof value.id === 'string') && typeof value.method === 'string';
    }
}
