import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MethodRegistry } from './transport/registry.ts';
import { createApp } from './app.ts';

const INDEX_HTML = '<!doctype html><title>funkyoctopus</title>';
const ESCAPE_MARKER = '{"escape-marker":true}';

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
const tempDirs: string[] = [];

async function makeDist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-static-'));
  tempDirs.push(root);
  const dist = join(root, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), INDEX_HTML);
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'assets', 'app.css'), 'body{color:red}');
  // A file OUTSIDE dist that escape attempts must never reach.
  await writeFile(join(root, 'package.json'), ESCAPE_MARKER);
  return dist;
}

async function startApp(serveUiDir?: string): Promise<string> {
  const app = await createApp(new MethodRegistry(), [], serveUiDir);
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** Raw-verb GET that does not normalize the path, unlike fetch/undici. */
function rawGet(url: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(url, { path }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body }));
    });
    request.once('error', rejectPromise);
    request.end();
  });
}

function openSocket(base: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`);
  sockets.push(socket);
  return once(socket, 'open').then(() => socket);
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('static UI serving', () => {
  it('serves index.html at / when a UI directory is given', async () => {
    const base = await startApp(await makeDist());
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('serves assets with their content types', async () => {
    const base = await startApp(await makeDist());
    const response = await fetch(`${base}/assets/app.css`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for unknown GET routes (SPA)', async () => {
    const base = await startApp(await makeDist());
    const response = await fetch(`${base}/some/route`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('keeps /health out of the SPA fallback', async () => {
    const base = await startApp(await makeDist());
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'funkyoctopus-sidecar' });
  });

  it.each([
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
    '/assets/../../package.json',
  ])('does not let %r escape the served directory', async (path) => {
    const base = await startApp(await makeDist());
    const response = await rawGet(base, path);
    expect(response.body).not.toContain(ESCAPE_MARKER);
    expect(response.body).not.toContain('"name"');
  });

  it('still upgrades /ws while serving the UI', async () => {
    const base = await startApp(await makeDist());
    const socket = await openSocket(base);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses to serve a UI directory that contains a symlink', async () => {
    const dist = await makeDist();
    await symlink(join(dist, '..', 'package.json'), join(dist, 'assets', 'leak.json'));
    await expect(createApp(new MethodRegistry(), [], dist)).rejects.toThrow(
      /refusing to serve .*: it contains a symlink \(.*leak\.json\)/,
    );
  });

  it('leaves / a 404 when no UI directory is given', async () => {
    const base = await startApp();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(404);
  });

  it('keeps unknown POST misses ordinary 404s while serving', async () => {
    const base = await startApp(await makeDist());
    const response = await fetch(`${base}/nope`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

/**
 * `config.ts` snapshots its env at import, so each configuration case resets
 * the module registry and imports fresh (same pattern as config.test.ts).
 */
async function loadConfig(): Promise<typeof import('./config.ts')> {
  vi.resetModules();
  return import('./config.ts');
}

describe('FUNKYOCTOPUS_SERVE_UI configuration', () => {
  const repoDist = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'dist',
  );

  it('is unset by default and keeps the historical origin defaults', async () => {
    const { config } = await loadConfig();
    expect(config.serveUiDir).toBeUndefined();
    expect(config.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
    ]);
  });

  it('resolves the value 1 to the repository dist directory', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '1');
    const { config } = await loadConfig();
    expect(config.serveUiDir).toBe(repoDist);
  });

  it('resolves an explicit directory (absolute or relative to the CWD)', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '/srv/funkyoctopus/dist');
    const { config } = await loadConfig();
    expect(config.serveUiDir).toBe('/srv/funkyoctopus/dist');

    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', 'out/dist');
    const { config: relative } = await loadConfig();
    expect(relative.serveUiDir).toBe(resolve(process.cwd(), 'out/dist'));
  });

  it('treats a blank value as not serving', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '   ');
    const { config } = await loadConfig();
    expect(config.serveUiDir).toBeUndefined();
  });
});

describe('serving-aware WebSocket origins', () => {
  it('adds the two same-port loopback origins when serving on the default port', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '1');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
      'http://127.0.0.1:14787',
      'http://localhost:14787',
    ]);
  });

  it('uses the configured port for the appended serving origins', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '1');
    vi.stubEnv('SIDECAR_PORT', '8790');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toContain('http://127.0.0.1:8790');
    expect(config.wsAllowedOrigins).toContain('http://localhost:8790');
  });

  it('appends the serving origins even when an override is present, deduplicated', async () => {
    vi.stubEnv('FUNKYOCTOPUS_SERVE_UI', '1');
    vi.stubEnv('FUNKYOCTOPUS_WS_ORIGINS', 'http://dev.example:14174,http://localhost:14787');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://dev.example:14174',
      'http://localhost:14787',
      'http://127.0.0.1:14787',
    ]);
  });

  it('leaves the defaults untouched when not serving', async () => {
    vi.stubEnv('SIDECAR_PORT', '14788');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
    ]);
  });
});
