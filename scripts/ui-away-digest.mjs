#!/usr/bin/env node
/**
 * Self-contained rendered evidence for the production away digest.
 *
 * Runs its own fixture sidecar (WebSocket) and Vite on free ports, drives the
 * UI with the shared browser launcher (`scripts/lib/ui-browser.mjs`: CHROME_PATH,
 * else the newest chrome-headless-shell under ~/.cache/puppeteer/chrome-headless-shell/
 * — the only browser that works inside Helmraiser's srt sandbox — else system
 * Chrome) and installs a controlled clock on the page, so no real clock,
 * session store or helmraiser is touched.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((value, index, all) =>
    value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
  ),
);
const out = args.out ?? 'tmp/away-digest';
await mkdir(out, { recursive: true });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
const [wsPort, vitePort] = await Promise.all([freePort(), freePort()]);
const streams = new Map();
const sockets = new Set();
const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });

const session = {
  path: '/tmp/away/session.jsonl',
  id: 'away-fixture',
  title: 'Away digest fixture',
  cwd: '/tmp/away',
  created: new Date(0).toISOString(),
  modified: new Date(0).toISOString(),
};
const status = {
  updated_at: new Date(0).toISOString(),
  queued_count: 0, queue_next: [], running: [], awaiting_count: 0, failed_24h_count: 0,
  spend: {}, usage: {}, caps_enforced: false, paused: null, held_providers: {},
  worker: { state: 'stopped' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  awaiting: [], failed: [], landed: [], status_path: '/tmp/status.json',
};
const health = {
  ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000,
  backends: { pi: 'up', helmraiser: 'up' },
};
const replies = {
  'system.health': health,
  'system.upkeep': {
    disabled: true, status: 'idle', lastRunAt: null, lastResult: null,
    globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown',
    embedded: {
      installedVersion: null, latestVersion: null, verifiedVersion: null,
      verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null,
      lastPromotionAttemptAt: null, lastPromotionResult: null,
      lastRecoveryAttemptAt: null, lastRecoveryResult: null,
    },
  },
  'projects.discover': { globalRoot: '/tmp/away', known: [], folders: [] },
  'models.list': [],
  'chat.list': [session],
  'chat.current': session,
  'chat.transcript': [],
  'helmraiser.status': status,
};

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') {
      streams.set(request.method, { socket, id: request.id });
      return;
    }
    if (request.method === 'chat.send') {
      socket.send(JSON.stringify({
        kind: 'stream', id: request.id,
        chunk: { kind: 'text', delta: 'Fixture transcript line. '.repeat(500) },
      }));
      socket.send(JSON.stringify({ kind: 'stream-end', id: request.id }));
      return;
    }
    const result = Object.hasOwn(replies, request.method) ? replies[request.method] : null;
    socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
  });
});

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: process.cwd(),
  env: { ...process.env, VITE_SIDECAR_URL: `ws://127.0.0.1:${wsPort}/ws` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const base = `http://127.0.0.1:${vitePort}`;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(base);
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (attempt === 99) throw new Error(`Vite did not start:\n${viteLog}`);
}

let browser;
try {
  browser = await launchBrowser();
} catch (error) {
  vite.kill('SIGTERM');
  await new Promise((resolve) => wss.close(resolve));
  throw error;
}
const assertions = {};
const fixtureInputs = [];
const sendStream = (method, chunk) => {
  const stream = streams.get(method);
  if (!stream) throw new Error(`${method} stream was not opened`);
  fixtureInputs.push({ method, chunk });
  stream.socket.send(JSON.stringify({ kind: 'stream', id: stream.id, chunk }));
};
const assert = (name, condition) => {
  assertions[name] = Boolean(condition);
  if (!condition) throw new Error(`browser assertion failed: ${name}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  // The digest captures Date.now when it is constructed, so the fake clock must
  // be installed before the app loads: an offset on the real clock.
  await page.evaluateOnNewDocument(() => {
    const real = Date.now.bind(Date);
    window.__awayOffset = 0;
    Date.now = () => real() + window.__awayOffset;
  });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await page.waitForSelector('textarea[aria-label="Message"]');
  await page.waitForFunction(() => document.body.innerText.includes('Away digest fixture'));
  await page.waitForFunction(() => document.querySelector('button[type="submit"]'));
  // Make a real, overflowing production transcript before collecting the digest.
  await page.type('textarea[aria-label="Message"]', 'seed the fixture transcript');
  await page.keyboard.press('Enter');
  await page.waitForSelector('button[type="submit"]');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__awayVisibility });
    window.__awayVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  sendStream('chat.observe', { kind: 'turn-ended', origin: 'cli-fixture' });
  sendStream('chat.observe', {
    kind: 'custom-message', id: 'crew-1', customType: 'crew-result', display: true,
    content: 'review complete',
    details: { agentId: 'reviewer-1', agentName: 'Reviewer', status: 'completed' },
    timestamp: Date.now() - 120_000,
  });
  sendStream('helmraiser.observe', {
    kind: 'helmraiser-event', event: 'awaiting', runId: 'run-1', task: 'release.md', title: 'Approve the release',
  });
  // Let the WebSocket frames reach the page before it becomes visible again.
  await new Promise((resolve) => setTimeout(resolve, 750));
  await page.evaluate(() => {
    window.__awayOffset += 180_000;
    window.__awayVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('aside[aria-label="While you were away"]');
  const firstText = await page.$eval('aside[aria-label="While you were away"]', (el) => el.innerText);
  assert('representative entries render', /A turn finished/.test(firstText) && /Reviewer completed/.test(firstText) && /Helmraiser needs approval/.test(firstText));
  assert('relative times render', /ago/.test(firstText));
  await page.screenshot({ path: `${out}/away-digest.png` });

  const contrast = await page.$eval('aside[aria-label="While you were away"] span.text-muted', (el) => {
    const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const fg = parse(getComputedStyle(el).color);
    const bg = parse(getComputedStyle(document.body).backgroundColor);
    const luminance = (rgb) => {
      const channels = rgb.map((part) => {
        const value = part / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  });
  assert('secondary contrast is AA', contrast >= 4.5);

  await page.$eval('div[aria-label="Transcript"]', (el) => { el.scrollTop = 0; });
  const turnLine = await page.$$('xpath/.//button[contains(., "A turn finished")]');
  await turnLine[0].click();
  const tailGap = await page.$eval('div[aria-label="Transcript"]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert('chat entry scrolls to latest message', tailGap <= 1);

  const helmraiserLine = await page.$$('xpath/.//button[contains(., "Helmraiser needs approval")]');
  await helmraiserLine[0].click();
  await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser'));
  assert('Helmraiser entry opens Jobs', true);
  const chatNav = await page.$$('xpath/.//button[contains(., "Chat")]');
  await chatNav[0].click();
  await page.waitForSelector('textarea[aria-label="Message"]');

  // A fresh period replaces the first card and demonstrates overflow.
  await page.evaluate(() => {
    window.__awayVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let index = 1; index <= 12; index += 1) {
    await page.evaluate(() => { window.__awayOffset += 60_000; });
    sendStream('helmraiser.observe', {
      kind: 'helmraiser-event', event: 'landed', runId: `landed-${index}`, task: 'task.md', title: `Landed run ${index}`,
    });
  }
  await page.evaluate(() => {
    window.__awayOffset += 60_000;
    window.__awayVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="While you were away"] li').length === 10);
  const overflowText = await page.$eval('aside[aria-label="While you were away"]', (el) => el.innerText);
  assert('overflow shows ten newest', /Landed run 12/.test(overflowText) && !/Landed run 2\b/.test(overflowText));
  assert('overflow count is accurate', /and 2 more/.test(overflowText));
  await page.screenshot({ path: `${out}/away-digest-overflow.png` });

  await page.click('button[aria-label="Dismiss while you were away"]');
  assert('dismissal clears card', !(await page.$('aside[aria-label="While you were away"]')));
  await page.reload({ waitUntil: 'networkidle2' });
  assert('reload starts empty', !(await page.$('aside[aria-label="While you were away"]')));

  const report = { fixtureInputs, assertions, secondaryTextContrast: contrast };
  await writeFile(`${out}/away-digest-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
