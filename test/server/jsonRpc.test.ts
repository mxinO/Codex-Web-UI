import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { JsonRpcPeer } from '../../server/jsonRpc.js';

class FakeSocket extends EventEmitter {
  public sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit('close');
  }
}

describe('JsonRpcPeer', () => {
  it('resolves responses by id', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const promise = peer.request('ping', { ok: true });
    const sent = JSON.parse(socket.sent[0]);
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { pong: true } }));
    await expect(promise).resolves.toEqual({ pong: true });
  });

  it('resolves app-server responses that omit jsonrpc', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const promise = peer.request('initialize');
    const sent = JSON.parse(socket.sent[0]);
    socket.emit('message', JSON.stringify({ id: sent.id, result: { server: 'ready' } }));
    await expect(promise).resolves.toEqual({ server: 'ready' });
  });

  it('emits notifications', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const seen: unknown[] = [];
    peer.onNotification((msg) => seen.push(msg));
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'thread/started', params: { id: 't' } }));
    expect(seen).toEqual([{ jsonrpc: '2.0', method: 'thread/started', params: { id: 't' } }]);
  });

  it('normalizes notifications that omit jsonrpc', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const seen: unknown[] = [];
    peer.onNotification((msg) => seen.push(msg));
    socket.emit('message', JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } }));
    expect(seen).toEqual([{ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't' } }]);
  });

  it('emits server requests and sends responses', () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const seen: unknown[] = [];
    peer.onServerRequest((msg) => {
      seen.push(msg);
      peer.respond(msg.id, { approved: true });
    });

    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 'approval-1', method: 'approval/requested' }));

    expect(seen).toEqual([{ jsonrpc: '2.0', id: 'approval-1', method: 'approval/requested' }]);
    expect(JSON.parse(socket.sent[0])).toEqual({
      jsonrpc: '2.0',
      id: 'approval-1',
      result: { approved: true },
    });
  });

  it('normalizes server requests that omit jsonrpc', () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const seen: unknown[] = [];
    peer.onServerRequest((msg) => seen.push(msg));

    socket.emit('message', JSON.stringify({ id: 'approval-1', method: 'approval/requested' }));

    expect(seen).toEqual([{ jsonrpc: '2.0', id: 'approval-1', method: 'approval/requested' }]);
  });

  it('sends server request error responses', () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);

    peer.respondError('approval-1', -32000, 'Denied', { reason: 'policy' });

    expect(JSON.parse(socket.sent[0])).toEqual({
      jsonrpc: '2.0',
      id: 'approval-1',
      error: { code: -32000, message: 'Denied', data: { reason: 'policy' } },
    });
  });

  it('rejects response errors', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const promise = peer.request('ping');
    const sent = JSON.parse(socket.sent[0]);

    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32000, message: 'Nope' } }));

    await expect(promise).rejects.toThrow('Nope');
  });

  it('rejects pending requests on close', async () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const promise = peer.request('ping');

    socket.close();

    await expect(promise).rejects.toThrow('JSON-RPC socket closed');
  });

  it('ignores invalid JSON', () => {
    const socket = new FakeSocket();
    const peer = new JsonRpcPeer(socket as never);
    const seen: unknown[] = [];
    peer.onNotification((msg) => seen.push(msg));

    socket.emit('message', '{');

    expect(seen).toEqual([]);
  });
});
