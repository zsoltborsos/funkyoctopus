import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { WS_PATH } from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { DEFAULT_WS_ALLOWED_ORIGINS } from '../config.ts';
import { untypedRegistryForTest } from '../test/untyped-registry.ts';
import { MethodRegistry } from '../transport/registry.ts';
import { attachTransport } from '../transport/server.ts';
import { CallTimeoutError, FoClient } from './fo-client.ts';

const apps: FastifyInstance[] = [];

async function startTransport(
  registry: MethodRegistry,
): Promise<string> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  attachTransport(app, registry, DEFAULT_WS_ALLOWED_ORIGINS);
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}${WS_PATH}`;
}

const clients: FoClient[] = [];

function track(client: FoClient): FoClient {
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('FoClient', () => {
  it('round-trips a call: params reach the handler, result is returned', async () => {
    const registry = untypedRegistryForTest();
    let seen: unknown = null;
    registry.call('echo', (params) => {
      seen = params;
      return { echoed: params };
    });
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    const result = await client.callRaw<{ echoed: string }>('echo', { hello: 'world' });
    expect(result).toEqual({ echoed: { hello: 'world' } });
    expect(seen).toEqual({ hello: 'world' });
  });

  it('rejects a throwing handler with WireCallError carrying message and code', async () => {
    const registry = untypedRegistryForTest();
    registry.call('boom', () => {
      throw new WireCallError('nope', 'folder_not_found');
    });
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    await expect(client.callRaw('boom', null)).rejects.toMatchObject({
      name: 'WireCallError',
      message: 'nope',
      code: 'folder_not_found',
    });
  });

  it('delivers stream chunks in order and resolves on a clean stream-end', async () => {
    async function* streamFactory(): AsyncIterable<unknown> {
      await Promise.resolve();
      yield 1;
      yield 2;
      yield 3;
    }
    const registry = new MethodRegistry();
    registry.stream('nums', () => streamFactory());
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    const chunks: unknown[] = [];
    await client.streamRaw('nums', null, (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([1, 2, 3]);
  });

  it('rejects a throwing stream with the stream-end error', async () => {
    async function* streamFactory(): AsyncIterable<unknown> {
      yield 'first';
      await Promise.reject(new WireCallError('turned bad', 'folder_not_found'));
    }
    const registry = new MethodRegistry();
    registry.stream('bad', () => streamFactory());
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    const chunks: unknown[] = [];
    await expect(client.streamRaw('bad', null, (c) => chunks.push(c))).rejects.toMatchObject({
      name: 'WireCallError',
      message: 'turned bad',
      code: 'folder_not_found',
    });
    expect(chunks).toEqual(['first']);
  });

  it('abort sends a cancel frame the handler observes through ctx.signal', async () => {
    let observedAbort = false;
    async function* streamFactory(_params: unknown, ctx: { signal: AbortSignal }): AsyncIterable<unknown> {
      yield 'first';
      await once(ctx.signal, 'abort');
      observedAbort = ctx.signal.aborted;
      yield 'after';
    }
    const registry = new MethodRegistry();
    registry.stream('slow', streamFactory);
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    const controller = new AbortController();
    const chunks: unknown[] = [];
    const done = client.streamRaw('slow', null, (c) => chunks.push(c), controller.signal);
    // Wait for the first chunk so the server generator is registered, then cancel.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await done;
    expect(observedAbort).toBe(true);
  });

  it('a call past its timeout rejects CallTimeoutError and cancels the handler', async () => {
    let aborted = false;
    const registry = untypedRegistryForTest();
    registry.call('sleepy', async (_params, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 5_000));
      return 'late';
    });
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    await expect(client.callRaw('sleepy', null, 100)).rejects.toBeInstanceOf(CallTimeoutError);
    // The cancel frame gives the server a moment to abort the handler.
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  it('rejects a stream started after the socket was closed', async () => {
    const registry = new MethodRegistry();
    registry.stream('never', async function* stream() {
      yield undefined;
      await new Promise<void>(() => undefined);
    });
    const url = await startTransport(registry);
    const client = track(await FoClient.connect(url));
    client.close();
    await expect(client.streamRaw('never', null, () => undefined)).rejects.toMatchObject({
      name: 'SidecarUnreachable',
      url,
    });
  });

  it('a refused connection rejects SidecarUnreachable naming the url', async () => {
    // Port 1 on loopback: nothing listens there.
    await expect(FoClient.connect('ws://127.0.0.1:1/ws')).rejects.toMatchObject({
      name: 'SidecarUnreachable',
      url: 'ws://127.0.0.1:1/ws',
    });
  });
});
