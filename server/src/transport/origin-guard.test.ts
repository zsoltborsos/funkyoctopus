import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_PATH, type ServerMessage } from '../../../src/shared/transport/protocol.ts';
import { DEFAULT_WS_ALLOWED_ORIGINS } from '../config.ts';
import { untypedRegistryForTest } from '../test/untyped-registry.ts';
import { MethodRegistry } from './registry.ts';
import { attachTransport } from './server.ts';

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];

/** Real Fastify + real ws on the production transport path, bound to a random port. */
async function startUrl(registry: MethodRegistry): Promise<string> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  attachTransport(app, registry, DEFAULT_WS_ALLOWED_ORIGINS);
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}${WS_PATH}`;
}

async function connect(url: string, origin?: string): Promise<WebSocket> {
  const socket =
    origin === undefined
      ? new WebSocket(url)
      : new WebSocket(url, { headers: { origin } });
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
}

/**
 * The HTTP status a rejected upgrade receives. Racing against `open` keeps the
 * assertion fast even if the server wrongly upgrades (a pre-guard red state);
 * with the guard in place the client's `unexpected-response` listener (ws line
 * 929) suppresses the follow-up `error` event.
 */
async function rejectionStatus(url: string, origin: string): Promise<number> {
  const socket = new WebSocket(url, { headers: { origin } });
  sockets.push(socket);
  return Promise.race([
    once(socket, 'unexpected-response').then(
      ([, response]) => (response as { statusCode: number }).statusCode,
    ),
    once(socket, 'open').then(() => 101),
  ]);
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

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('WebSocket Origin guard', () => {
  it('upgrades and round-trips a registry call from an allowlisted Origin', async () => {
    const registry = untypedRegistryForTest().call('origin.echo', (params) => {
      const input = params as { value: number };
      return { value: input.value };
    });
    const url = await startUrl(registry);
    const socket = await connect(url, 'http://localhost:14174');
    const response = nextMessage(socket);

    request(socket, 'allowed', 'origin.echo', { value: 7 });

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'allowed',
      ok: true,
      result: { value: 7 },
    });
  });

  it('upgrades from the second default Origin (127.0.0.1)', async () => {
    const url = await startUrl(untypedRegistryForTest().call('origin.echo', () => ({ ok: true })));
    const socket = await connect(url, 'http://127.0.0.1:14174');
    const response = nextMessage(socket);

    request(socket, 'loopback', 'origin.echo');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'loopback',
      ok: true,
      result: { ok: true },
    });
  });

  it('upgrades and round-trips with no Origin header (non-browser automation)', async () => {
    const registry = untypedRegistryForTest().call('origin.echo', (params) => {
      const input = params as { value: number };
      return { value: input.value * 2 };
    });
    const url = await startUrl(registry);
    const socket = await connect(url);
    const response = nextMessage(socket);

    request(socket, 'headless', 'origin.echo', { value: 21 });

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'headless',
      ok: true,
      result: { value: 42 },
    });
  });

  it('rejects a foreign Origin with HTTP 403 before the upgrade', async () => {
    const url = await startUrl(new MethodRegistry());
    await expect(rejectionStatus(url, 'http://evil.example')).resolves.toBe(403);
  });

  it('rejects an Origin of null with HTTP 403 before the upgrade', async () => {
    const url = await startUrl(new MethodRegistry());
    await expect(rejectionStatus(url, 'null')).resolves.toBe(403);
  });

  it('requires an exact match: near-miss Origins are foreign', async () => {
    const url = await startUrl(new MethodRegistry());
    for (const nearMiss of [
      'https://localhost:14174', // scheme differs
      'http://localhost:5175', // port differs
      'http://localhost:14174.evil.example', // allowlist prefix, not a match
      'http://LOCALHOST:14174', // case differs
    ]) {
      await expect(rejectionStatus(url, nearMiss)).resolves.toBe(403);
    }
  });

  it('never invokes registry handlers for rejected Origins', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const url = await startUrl(untypedRegistryForTest().call('origin.echo', handler));

    await expect(rejectionStatus(url, 'http://evil.example')).resolves.toBe(403);
    await expect(rejectionStatus(url, 'null')).resolves.toBe(403);
    expect(handler).not.toHaveBeenCalled();

    // The same method is reachable over an allowlisted connection, proving the
    // spy is live and only the rejected requests were stopped.
    const socket = await connect(url, 'http://localhost:14174');
    const response = nextMessage(socket);
    request(socket, 'allowed-after-rejects', 'origin.echo');

    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 'allowed-after-rejects',
      ok: true,
      result: { ok: true },
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});
