/**
 * Production sidecar liveness probe. Hermetic: a throwaway `net.Server` on a
 * loopback ephemeral port stands in for the sidecar; nothing on 14787 is ever
 * touched, so the suite is indifferent to whether a real sidecar is running.
 */

import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SIDECAR_PROBE_TIMEOUT_MS, probeSidecar, sidecarAddressFromEnv } from './sidecar-probe.ts';

const servers: ReturnType<typeof createServer>[] = [];

function listen(): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        host: '127.0.0.1',
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

describe('probeSidecar', () => {
  it('reports a listening loopback port as answering, and the same port as silent once closed', async () => {
    const server = await listen();
    expect(await probeSidecar(server.host, server.port)).toBe(true);
    await server.close();
    expect(await probeSidecar(server.host, server.port)).toBe(false);
  });

  it('resolves false (never rejects) for a closed loopback port, within the timeout', async () => {
    const server = await listen();
    await server.close();
    await expect(probeSidecar(server.host, server.port, 50)).resolves.toBe(false);
    expect(SIDECAR_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('rejects for an invalid port instead of reading it as "not listening" (the coordinator validates first)', async () => {
    await expect(probeSidecar('127.0.0.1', Number.NaN)).rejects.toBeInstanceOf(Error);
    await expect(probeSidecar('127.0.0.1', 70_000)).rejects.toBeInstanceOf(Error);
  });
});

describe('sidecarAddressFromEnv', () => {
  it('mirrors server/src/config.ts defaults', () => {
    expect(sidecarAddressFromEnv({})).toEqual({ host: '127.0.0.1', port: 14787 });
  });

  it('honours SIDECAR_HOST and SIDECAR_PORT', () => {
    expect(sidecarAddressFromEnv({ SIDECAR_HOST: '::1', SIDECAR_PORT: '9099' })).toEqual({ host: '::1', port: 9099 });
  });

  it('passes a malformed SIDECAR_PORT through as NaN so the coordinator refuses rather than skipping the probe', () => {
    expect(Number.isNaN(sidecarAddressFromEnv({ SIDECAR_PORT: 'eighty' }).port)).toBe(true);
  });
});
