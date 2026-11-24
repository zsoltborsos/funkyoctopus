import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_PATH, type ServerMessage } from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { DEFAULT_WS_ALLOWED_ORIGINS } from '../config.ts';
import { untypedRegistryForTest } from '../test/untyped-registry.ts';
import { MethodRegistry } from './registry.ts';
import { attachTransport } from './server.ts';

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];

async function connect(registry: MethodRegistry): Promise<WebSocket> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  attachTransport(app, registry, DEFAULT_WS_ALLOWED_ORIGINS);
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);

  const address = app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WS_PATH}`);
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8');
        resolve(JSON.parse(text) as ServerMessage);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Socket closed before receiving a message'));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

function request(socket: WebSocket, id: string, method: string, params: unknown = null): void {
  socket.send(JSON.stringify({ kind: 'request', id, method, params }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const malformedFrames = [
  { name: 'malformed JSON', frame: '{ definitely not json' },
  ...[
    { name: 'null', value: null },
    { name: 'empty array', value: [] },
    { name: 'array containing a request', value: [{ kind: 'request', id: 'active', method: 'health' }] },
    { name: 'string primitive', value: 'request' },
    { name: 'number primitive', value: 42 },
    { name: 'boolean primitive', value: true },
    { name: 'empty record', value: {} },
    { name: 'missing kind', value: { id: 'active', method: 'health' } },
    { name: 'null kind', value: { kind: null, id: 'active', method: 'health' } },
    { name: 'number kind', value: { kind: 1, id: 'active', method: 'health' } },
    { name: 'unknown kind', value: { kind: 'unknown', id: 'active', method: 'health' } },
    { name: 'server response kind', value: { kind: 'response', id: 'active', method: 'health' } },
    ...['request', 'cancel'].flatMap((kind) => [
      { name: `${kind} missing ID`, value: { kind, method: 'health' } },
      ...[null, 42, true, [], {}].map((id) => ({
        name: `${kind} ${JSON.stringify(id)} ID`,
        value: { kind, id, method: 'health' },
      })),
    ]),
    { name: 'request missing method', value: { kind: 'request', id: 'active' } },
    ...[null, 42, true, [], {}].map((method) => ({
      name: `request ${JSON.stringify(method)} method`,
      value: { kind: 'request', id: 'active', method },
    })),
  ].map(({ name, value }) => ({ name, frame: JSON.stringify(value) })),
];

// The pong is a processing barrier: all preceding frames reached the server.
async function sendMalformedFrame(socket: WebSocket, frame: string): Promise<void> {
  const pong = once(socket, 'pong');
  socket.send(frame);
  socket.ping();
  await pong;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('WebSocket server transport', () => {
  it('aborts a cancelled stream and emits its terminal event', async () => {
    const started = deferred();
    const aborted = deferred();
    const registry = new MethodRegistry().stream('stream.wait', async function* (_params, ctx) {
      started.resolve();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      yield null;
    });
    const socket = await connect(registry);

    request(socket, 'cancel-me', 'stream.wait');
    await started.promise;
    const terminal = nextMessage(socket);
    socket.send(JSON.stringify({ kind: 'cancel', id: 'cancel-me' }));

    await expect(aborted.promise).resolves.toBeUndefined();
    await expect(terminal).resolves.toEqual({ kind: 'stream-end', id: 'cancel-me' });
  });

  it('aborts every in-flight handler when its connection closes', async () => {
    const started = [deferred(), deferred()] as const;
    const aborted = [deferred(), deferred()] as const;
    const registry = untypedRegistryForTest();
    for (const index of [0, 1] as const) {
      registry.call(`call.wait-${index}`, async (_params, ctx) => {
        started[index].resolve();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted[index].resolve();
              resolve();
            },
            { once: true },
          );
        });
        return null;
      });
    }
    const socket = await connect(registry);

    request(socket, 'one', 'call.wait-0');
    request(socket, 'two', 'call.wait-1');
    await Promise.all(started.map((item) => item.promise));
    socket.close();
    await once(socket, 'close');

    await expect(Promise.all(aborted.map((item) => item.promise))).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each(malformedFrames)('ignores $name and recovers on the same connection', async ({ frame }) => {
    const handler = vi.fn(() => ({ alive: true }));
    const socket = await connect(untypedRegistryForTest().call('health', handler));
    const onMessage = vi.fn();
    socket.on('message', onMessage);

    await sendMalformedFrame(socket, frame);
    expect(onMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    const response = nextMessage(socket);
    request(socket, 'healthy', 'health');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'healthy',
      ok: true,
      result: { alive: true },
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(malformedFrames)('$name cannot replace or remove active cancellation tracking', async ({ frame }) => {
    const started = deferred();
    const aborted = deferred();
    const handler = vi.fn(() => null);
    const registry = untypedRegistryForTest().call('health', handler);
    registry.stream('stream.wait', async function* (_params, ctx) {
      ctx.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      yield null;
    });
    const socket = await connect(registry);
    const onMessage = vi.fn();
    socket.on('message', onMessage);

    request(socket, 'active', 'stream.wait');
    await started.promise;
    await sendMalformedFrame(socket, frame);
    expect(onMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    const terminal = nextMessage(socket);
    socket.send(JSON.stringify({ kind: 'cancel', id: 'active' }));
    await expect(aborted.promise).resolves.toBeUndefined();
    await expect(terminal).resolves.toEqual({ kind: 'stream-end', id: 'active' });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('returns a correlated error response for an unknown method', async () => {
    const socket = await connect(new MethodRegistry());
    const response = nextMessage(socket);

    request(socket, 'missing-id', 'missing.method');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'missing-id',
      ok: false,
      error: { message: 'Unknown method: missing.method' },
    });
  });

  it('carries a typed error code from a throwing call handler onto the wire', async () => {
    const registry = untypedRegistryForTest().call('boom.typed', () => {
      throw new WireCallError('nope', 'helmraiser_unavailable');
    });
    const socket = await connect(registry);
    const response = nextMessage(socket);

    request(socket, 'typed-error', 'boom.typed');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'typed-error',
      ok: false,
      error: { message: 'nope', code: 'helmraiser_unavailable' },
    });
  });

  it('omits the code key when a call handler throws a plain Error', async () => {
    const registry = untypedRegistryForTest().call('boom.plain', () => {
      throw new Error('nope');
    });
    const socket = await connect(registry);
    const response = nextMessage(socket);

    request(socket, 'plain-error', 'boom.plain');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'plain-error',
      ok: false,
      error: { message: 'nope' },
    });
  });

  it('turns streaming handler failures into stream-end errors', async () => {
    const registry = new MethodRegistry().stream('stream.fail', async function* () {
      await Promise.reject(new Error('stream exploded'));
      yield null;
    });
    const socket = await connect(registry);
    const response = nextMessage(socket);

    request(socket, 'failed-stream', 'stream.fail');

    await expect(response).resolves.toEqual({
      kind: 'stream-end',
      id: 'failed-stream',
      error: { message: 'stream exploded' },
    });
  });

  it('round-trips ordinary calls', async () => {
    const registry = untypedRegistryForTest().call('math.double', (params) => {
      const input = params as { value: number };
      return { value: input.value * 2 };
    });
    const socket = await connect(registry);
    const response = nextMessage(socket);

    request(socket, 'ordinary', 'math.double', { value: 21 });

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'ordinary',
      ok: true,
      result: { value: 42 },
    });
  });
});
