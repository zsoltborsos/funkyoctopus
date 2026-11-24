import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, ServerMessage } from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { TransportClient, sidecarUrl, type SocketLike } from './transport-client.ts';

class FakeSocket implements SocketLike {
  readyState = 1; // OPEN
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  lastSent(): unknown {
    return JSON.parse(this.sent[this.sent.length - 1] ?? 'null');
  }
}

function connected(): { client: TransportClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const client = new TransportClient('ws://test', () => socket);
  client.connect();
  socket.onopen?.();
  return { client, socket };
}

/** Test-only escape for synthetic method names not present in the production contract. */
function callUntypedForTest<T = unknown>(
  client: TransportClient,
  method: string,
  params?: unknown,
): Promise<T> {
  const untyped = client as unknown as {
    call<R>(name: string, rawParams?: unknown): Promise<R>;
  };
  return untyped.call<T>(method, params);
}

describe('TransportClient', () => {
  it('queues calls raised before the socket opens and flushes them on open', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0; // CONNECTING — the state a page load actually starts in
    const client = new TransportClient('ws://test', () => socket);
    client.connect();

    // Every seam client fetches on mount, which races the handshake.
    const projects = client.call('projects.discover');
    const models = client.call('models.list');
    expect(socket.sent).toHaveLength(0);

    socket.readyState = 1;
    socket.onopen?.();

    expect(socket.sent).toHaveLength(2);
    socket.emit({ kind: 'response', id: '1', ok: true, result: ['fo'] });
    socket.emit({ kind: 'response', id: '2', ok: true, result: ['deepseek'] });
    await expect(projects).resolves.toEqual(['fo']);
    await expect(models).resolves.toEqual(['deepseek']);
  });

  it('rejects a queued call when the connection attempt fails', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const client = new TransportClient('ws://test', () => socket);
    client.connect();
    const pending = client.call('models.list');

    socket.close();

    await expect(pending).rejects.toThrow('Transport disconnected');
  });

  it('resolves a call when the matching response arrives', async () => {
    const { client, socket } = connected();
    const promise = callUntypedForTest<{ value: number }>(client, 'math.double', { n: 21 });

    expect(socket.lastSent()).toMatchObject({ kind: 'request', method: 'math.double', id: '1' });
    socket.emit({ kind: 'response', id: '1', ok: true, result: { value: 42 } });

    await expect(promise).resolves.toEqual({ value: 42 });
  });

  it('rejects a call on an error response', async () => {
    const { client, socket } = connected();
    const promise = callUntypedForTest(client, 'boom');
    socket.emit({ kind: 'response', id: '1', ok: false, error: { message: 'nope' } });
    await expect(promise).rejects.toThrow('nope');
  });

  it('rejects a call with a typed WireCallError when the frame carries a code', async () => {
    const { client, socket } = connected();
    const promise = callUntypedForTest(client, 'boom');
    socket.emit({
      kind: 'response',
      id: '1',
      ok: false,
      error: { message: 'nope', code: 'helmraiser_unavailable' },
    });

    await expect(promise).rejects.toBeInstanceOf(WireCallError);
    await expect(promise).rejects.toMatchObject({
      message: 'nope',
      code: 'helmraiser_unavailable',
    });
  });

  it('delivers stream chunks then ends, and cancels on demand', () => {
    const { client, socket } = connected();
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const cancel = client.stream('chat.send', { chatId: 'main', text: 'hi' }, { onChunk, onEnd });

    socket.emit({ kind: 'stream', id: '1', chunk: 'a' });
    socket.emit({ kind: 'stream', id: '1', chunk: 'b' });
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenLastCalledWith('b');

    cancel();
    expect(socket.lastSent()).toEqual({ kind: 'cancel', id: '1' });

    socket.emit({ kind: 'stream-end', id: '1' });
    // cancelled stream is already detached, so onEnd is not called again
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('round-trips chat tool chunks', () => {
    const { client, socket } = connected();
    const chunks: ChatChunk[] = [
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'edit',
        summary: 'edit: src/App.tsx',
        args: { path: 'src/App.tsx' },
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        ok: true,
        output: 'Updated src/App.tsx',
        diff: '-old\n+new',
      },
    ];
    const received: ChatChunk[] = [];

    client.stream('chat.send', { chatId: 'main', text: 'edit the app' }, {
      onChunk: (chunk) => {
        received.push(chunk as ChatChunk);
      },
      onEnd: vi.fn(),
    });
    for (const chunk of chunks) socket.emit({ kind: 'stream', id: '1', chunk });

    expect(received).toEqual(chunks);
  });

  it('reports connection state to subscribers', () => {
    const socket = new FakeSocket();
    const client = new TransportClient('ws://test', () => socket);
    const listener = vi.fn();
    client.subscribe(listener);

    client.connect();
    expect(client.getState()).toBe('connecting');
    socket.onopen?.();
    expect(client.getState()).toBe('open');
    expect(listener).toHaveBeenCalled();
  });

  it('rejects in-flight calls when the socket closes', async () => {
    const { client, socket } = connected();
    const promise = callUntypedForTest(client, 'slow');
    socket.close();
    await expect(promise).rejects.toThrow('Transport disconnected');
  });
});

describe('TransportClient queued stream cancellation', () => {
  it('drops a stream cancelled while queued: no request and no cancel ever reach the server', () => {
    const socket = new FakeSocket();
    socket.readyState = 0; // CONNECTING
    const client = new TransportClient('ws://test', () => socket);
    client.connect();
    const onEnd = vi.fn();
    const cancel = client.stream('chat.observe', { chatId: 'main' }, { onChunk: vi.fn(), onEnd });

    cancel();
    expect(socket.sent).toHaveLength(0);

    socket.readyState = 1;
    socket.onopen?.();

    // Neither the request frame nor a cancel frame left the client, so the
    // server never opened a stream to zombie.
    expect(socket.sent).toHaveLength(0);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('keeps queued unrelated requests when a queued stream is cancelled', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const client = new TransportClient('ws://test', () => socket);
    client.connect();
    const projects = client.call('projects.discover');
    const cancel = client.stream('chat.observe', { chatId: 'main' }, { onChunk: vi.fn(), onEnd: vi.fn() });
    cancel();

    socket.readyState = 1;
    socket.onopen?.();

    // Only the unrelated call request was flushed.
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      kind: 'request',
      method: 'projects.discover',
    });
    socket.emit({ kind: 'response', id: '1', ok: true, result: [] });
    await expect(projects).resolves.toEqual([]);
  });

  it('still sends a cancel frame once the request was actually dispatched', () => {
    const { client, socket } = connected();
    const cancel = client.stream('chat.observe', { chatId: 'main' }, { onChunk: vi.fn(), onEnd: vi.fn() });

    // The request went over the wire at stream() time.
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ kind: 'request', id: '1' });
    cancel();
    expect(socket.lastSent()).toEqual({ kind: 'cancel', id: '1' });
  });

  it('ends a still-queued stream when the connection attempt fails', () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const client = new TransportClient('ws://test', () => socket);
    client.connect();
    const onEnd = vi.fn();
    client.stream('chat.observe', { chatId: 'main' }, { onChunk: vi.fn(), onEnd });

    socket.close();

    // The queued request never reached the server; the stream still reports
    // the failed connection instead of hanging silently.
    expect(onEnd).toHaveBeenCalledWith({ message: 'Transport disconnected' });
  });
});

describe('sidecarUrl', () => {
  it('lets VITE_SIDECAR_URL win in development and production', () => {
    expect(
      sidecarUrl({ override: 'ws://example:1/ws', dev: true, protocol: 'http:', host: 'dev:14174' }),
    ).toBe('ws://example:1/ws');
    expect(
      sidecarUrl({ override: 'ws://example:1/ws', dev: false, protocol: 'http:', host: 'cockpit:14787' }),
    ).toBe('ws://example:1/ws');
  });

  it('derives ws://host/ws from the page location when not served by Vite dev', () => {
    expect(sidecarUrl({ override: undefined, dev: false, protocol: 'http:', host: '127.0.0.1:14787' })).toBe(
      'ws://127.0.0.1:14787/ws',
    );
  });

  it('derives wss://host/ws for HTTPS pages', () => {
    expect(sidecarUrl({ override: undefined, dev: false, protocol: 'https:', host: 'cockpit.example' })).toBe(
      'wss://cockpit.example/ws',
    );
  });

  it('uses the explicit development URL in Vite dev without an override', () => {
    expect(sidecarUrl({ override: undefined, dev: true, protocol: 'http:', host: 'localhost:14174' })).toBe(
      'ws://127.0.0.1:14788/ws',
    );
  });
});
