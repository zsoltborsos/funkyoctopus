import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import { MethodRegistry } from './transport/registry.ts';
import { attachTransport } from './transport/server.ts';

/**
 * SPA fallback for a sidecar that serves the built UI: any GET that no route
 * (or static file) claimed falls back to `index.html`. `/ws` never reaches the
 * handler — the WebSocket route owns it — and non-GET misses stay ordinary 404s.
 */
function spaFallback(reply: FastifyReply, request: FastifyRequest): void {
  if (request.method === 'GET' || request.method === 'HEAD') {
    void reply.sendFile('index.html');
    return;
  }
  void reply.code(404).send({
    message: `Route ${request.method}:${request.url} not found`,
    error: 'Not Found',
    statusCode: 404,
  });
}

/**
 * The static plugin follows symlinks, so one inside the built UI could serve a
 * file from anywhere. `vite build` never writes symlinks: refuse any.
 */
async function assertNoSymlinks(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const link = entries.find((entry) => entry.isSymbolicLink());
  if (link) {
    throw new Error(`refusing to serve ${dir}: it contains a symlink (${join(link.parentPath, link.name)})`);
  }
}

/**
 * Builds the Fastify host with the WebSocket transport wired to `registry`.
 * With `serveUiDir` set, the built UI is served from that directory (the
 * always-on deployment); unset, the HTTP surface stays WebSocket-only.
 */
export async function createApp(
  registry: MethodRegistry,
  wsAllowedOrigins: readonly string[],
  serveUiDir?: string,
): Promise<FastifyInstance> {
  if (serveUiDir !== undefined) await assertNoSymlinks(serveUiDir);
  const app = Fastify({
    logger: {
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  await app.register(websocket);

  // HTTP liveness for service tooling (systemd deploy health, installers).
  // Registered before the static plugin so the SPA fallback never shadows it.
  app.get('/health', () => ({ ok: true, service: 'funkyoctopus-sidecar' }));

  if (serveUiDir !== undefined) {
    await app.register(fastifyStatic, {
      root: serveUiDir,
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      spaFallback(reply, request);
    });
  }

  attachTransport(app, registry, wsAllowedOrigins);

  return app;
}
