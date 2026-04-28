export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface SocketLike {
  send(data: string): void;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export type JsonRpcNotificationHandler = (message: JsonRpcNotification) => void;
export type JsonRpcServerRequestHandler = (message: JsonRpcServerRequest) => void;

export class JsonRpcPeer {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private readonly serverRequestHandlers = new Set<JsonRpcServerRequestHandler>();

  constructor(private readonly socket: SocketLike) {
    this.socket.on('message', (data) => this.handleMessage(data));
    this.socket.on('close', () => this.closePending(new Error('JSON-RPC socket closed')));
    this.socket.on('error', (error) => this.closePending(error));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC socket is closed'));
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method };
    if (params !== undefined) request.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.socket.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new Error('JSON-RPC socket is closed');
    }

    const notification: JsonRpcNotification = { jsonrpc: '2.0', method };
    if (params !== undefined) notification.params = params;
    this.socket.send(JSON.stringify(notification));
  }

  respond(id: number | string, result?: unknown): void {
    if (this.closed) {
      throw new Error('JSON-RPC socket is closed');
    }

    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result: result === undefined ? null : result };
    this.socket.send(JSON.stringify(response));
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    if (this.closed) {
      throw new Error('JSON-RPC socket is closed');
    }

    const error: JsonRpcError = { code, message };
    if (data !== undefined) error.data = data;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, error } satisfies JsonRpcResponse));
  }

  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: JsonRpcServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  private handleMessage(data: unknown): void {
    const text = this.messageToString(data);
    if (text === null) return;

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!this.isRecord(message) || ('jsonrpc' in message && message.jsonrpc !== '2.0')) return;
    const normalized = { jsonrpc: '2.0' as const, ...message };

    if (this.isResponse(normalized)) {
      this.handleResponse(normalized);
      return;
    }

    if (this.isServerRequest(normalized)) {
      for (const handler of this.serverRequestHandlers) handler(normalized);
      return;
    }

    if (this.isNotification(normalized)) {
      for (const handler of this.notificationHandlers) handler(normalized);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== 'number') return;

    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private closePending(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private messageToString(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isResponse(value: Record<string, unknown>): value is Record<string, unknown> & JsonRpcResponse {
    return (typeof value.id === 'number' || typeof value.id === 'string') && ('result' in value || 'error' in value);
  }

  private isNotification(value: Record<string, unknown>): value is Record<string, unknown> & JsonRpcNotification {
    return typeof value.method === 'string' && !('id' in value);
  }

  private isServerRequest(value: Record<string, unknown>): value is Record<string, unknown> & JsonRpcServerRequest {
    return (typeof value.id === 'number' || typeof value.id === 'string') && typeof value.method === 'string';
  }
}
