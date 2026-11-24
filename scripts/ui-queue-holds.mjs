#!/usr/bin/env node
/** Rendered fake-transport evidence for held and never-startable queued rows, and the confirm-first REMOVE. */
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/queue-holds';
await mkdir(out, { recursive: true });
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});
const [wsPort, vitePort] = await Promise.all([freePort(), freePort()]);
const requests = [];
const sockets = new Set();
const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });

const project = '/fixture/funkyoctopus';
// Real shapes: `queue_next[].held_by` / `held[]` as live on 2026-10-19, and the
// `never_startable` row helmraiser's status.py builds (text from never_startable_text).
const hold = {
  run_id: '0f6b2c1e-8d0a-4b8e-9c55-1f2f3a4b5c6d', status: 'awaiting_approval', pending: 'merge',
  reason: 'paths_overlap', other_task_id: 'access-policy',
};
const boardSync = {
  task_id: '-fixture-demo-api:board-sync', id: 'board-sync', title: 'Sync the board with the access policy',
  project: '/fixture/demo-api', origin: null,
};
const plain = {
  task_id: '-fixture-funkyoctopus:status-row-identity', id: 'status-row-identity', priority: 'high',
  title: 'Status rows name their project, id and title', project, origin: null, held_by: null,
};
const running = {
  task_id: '-fixture-helmraiser:running-one', id: 'running-one', priority: 'low',
  title: 'Mark the running task as untouchable', project: '/fixture/helmraiser', origin: null, held_by: null,
};
const neverStartable = {
  task_id: '-fixture-helmraiser:rewrite-the-loop', id: 'rewrite-the-loop', title: 'Rewrite the loop',
  project: '/fixture/helmraiser', origin: null, reason: 'never_startable:opencode-go:5h',
  model: 'opencode-go/unlisted', projected: 1.6667, stop_at: 0.7, projection_usd: 5,
  text: 'will never start: projected $5 on opencode-go/unlisted is 167% of the opencode-go 5h window, at or over stop_at 70%; lower budget.max_cost_usd or opencode-go projection_usd, raise stop_at, or pick a model with a larger monthly limit',
};
let queueNext = [
  plain,
  { ...boardSync, priority: 'normal', held_by: hold },
  running,
];
const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: queueNext.length + 1, queue_next: queueNext,
  held: queueNext.some((row) => row.task_id === boardSync.task_id) ? [{ ...boardSync, ...hold }] : [],
  never_startable: [neverStartable], running: [], awaiting_count: 0, failed_24h_count: 0, spend: {}, usage: {},
  caps_enforced: true, paused: null, held_providers: {}, worker: { state: 'running' },
  queue: { failed: 0, landed: 0, queued: queueNext.length + 1, running: 0, awaiting_approval: 0 },
  awaiting: [], failed: [], status_path: '/fixture/status.json',
});
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }], folders: [] },
  'models.list': [], 'chat.transcript': [], 'chat.list': [], 'helmraiser.drafts': [],
};

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') return;
    if (request.method === 'helmraiser.queueRemove') {
      const taskId = request.params?.taskId;
      if (taskId === running.task_id) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: {
          code: 'helmraiser_cli_error',
          message: 'helmraiser queue failed: cannot remove task in status running; only queued tasks can be removed',
        } }));
        return;
      }
      queueNext = queueNext.filter((row) => row.task_id !== taskId);
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: { task_id: taskId, status: 'draft' } }));
      return;
    }
    let result = Object.hasOwn(staticReplies, request.method) ? staticReplies[request.method] : null;
    if (request.method === 'helmraiser.status') result = status();
    socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
  });
});

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, VITE_SIDECAR_URL: `ws://127.0.0.1:${wsPort}/ws` }, stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const base = `http://127.0.0.1:${vitePort}`;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (attempt === 99) throw new Error(`Vite did not start:\n${viteLog}`);
}

let browser;
try { browser = await launchBrowser(); } catch (error) {
  vite.kill('SIGTERM');
  await new Promise((resolve) => wss.close(resolve));
  throw error;
}
const assertions = {};
const assert = (name, condition) => {
  assertions[name] = Boolean(condition);
  if (!condition) throw new Error(`browser assertion failed: ${name}`);
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 1000, deviceScaleFactor: 1 });
  const rowButton = async (title, name) => (await page.$$(`xpath/.//article[contains(@aria-label,"${title}")]//button[normalize-space(.)="${name}"]`))[0];
  const rowText = (title) => page.evaluate((needle) =>
    [...document.querySelectorAll('article')].find((node) => node.getAttribute('aria-label')?.includes(needle))?.innerText ?? '', title);

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await (await page.$$(`xpath/.//button[contains(., "Helmraiser")]`))[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('QUEUED NEXT'));

  assert('held row says what it waits for and why', (await rowText('Sync the board')).includes('waits for the merge of access-policy — same files'));
  assert('never-startable row says it cannot start and why', (await rowText('Rewrite the loop')).includes('cannot start — projected $5 on opencode-go/unlisted is 167%'));
  assert('a free row says neither', !/waits for|cannot start/.test(await rowText('Status rows name')));
  await page.screenshot({ path: `${out}/queue-holds.png` });

  const removeCalls = () => requests.filter((request) => request.method === 'helmraiser.queueRemove');
  await (await rowButton('Status rows name', 'REMOVE')).click();
  assert('REMOVE asks first and sends nothing', removeCalls().length === 0 && (await rowText('Status rows name')).includes('Take this task out of the queue?'));
  await page.screenshot({ path: `${out}/queue-remove-confirm.png` });

  await (await rowButton('Mark the running', 'REMOVE')).click();
  await (await rowButton('Mark the running', 'CONFIRM REMOVE')).click();
  await page.waitForFunction(() => document.body.innerText.includes('cannot remove task in status running'));
  assert('the CLI refusal shows on its own row', (await rowText('Mark the running')).includes('only queued tasks can be removed')
    && !(await rowText('Sync the board')).includes('cannot remove'));
  assert('the refused row is still there', (await rowText('Mark the running')).includes('Mark the running task'));
  await page.screenshot({ path: `${out}/queue-remove-refused.png` });

  await (await rowButton('Status rows name', 'CONFIRM REMOVE')).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Status rows name their project'));
  assert('success sends the full task id and the row leaves', removeCalls().some((call) => call.params?.taskId === plain.task_id));
  await page.screenshot({ path: `${out}/queue-remove-done.png` });
  console.log(JSON.stringify({ ok: true, assertions, out }, null, 2));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
