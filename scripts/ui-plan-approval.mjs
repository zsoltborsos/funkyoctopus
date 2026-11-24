#!/usr/bin/env node
/** Rendered fake-transport evidence for Helmraiser plan approval and resuming rows. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/plan-approval';
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

const runId = '865c36b8-a39d-433a-bc6c-87b1715d14e2';
const project = '/fixture/funkyoctopus';
const planText = `# Implementation plan

1. Add the guarded read-only plan seam.
2. Send the owner's optional approval note.
3. Let the existing Helmraiser worker resume the governed run.

Verification:
- exercise path guards
- render the pending plan
- never start the worker automatically`;
const awaiting = {
  run_id: runId, task: 'fixture:plan-approval', pending: 'plan', verdict: 'pass', cost_usd: 1.42,
  project, id: 'plan-approval', title: 'Approve a governed implementation plan',
};
const baseStatus = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [],
  awaiting_count: 1, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'running' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 1 },
  awaiting: [awaiting], failed: [], landed: [], status_path: '/fixture/status.json',
});
let status = baseStatus();
let approvalWorkerServes = true;
const session = {
  path: '/fixture/chat.jsonl', id: 'fixture-chat', title: 'Plan approval fixture', cwd: project,
  created: new Date(0).toISOString(), modified: new Date(0).toISOString(),
};
const replies = {
  'system.health': {
    ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000,
    backends: { pi: 'up', helmraiser: 'up' },
  },
  'system.upkeep': {
    disabled: true, status: 'idle', lastRunAt: null, lastResult: null,
    globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown',
    embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null,
      verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null,
      lastPromotionAttemptAt: null, lastPromotionResult: null,
      lastRecoveryAttemptAt: null, lastRecoveryResult: null },
  },
  'projects.discover': {
    globalRoot: '/fixture', known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }], folders: [],
  },
  'models.list': [], 'chat.list': [session], 'chat.current': session, 'chat.transcript': [],
};

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') return;
    let result = Object.hasOwn(replies, request.method) ? replies[request.method] : null;
    if (request.method === 'helmraiser.status') result = status;
    if (request.method === 'helmraiser.plan') result = { text: planText };
    if (request.method === 'helmraiser.approve') {
      result = { approved: 'plan', run_id: runId, status: 'resuming', stage: 'implement', worker_serves_project: approvalWorkerServes };
    }
    if (request.method === 'helmraiser.reject') result = { rejected: 'plan', run_id: runId };
    socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
  });
});

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, VITE_SIDECAR_URL: `ws://127.0.0.1:${wsPort}/ws` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const base = `http://127.0.0.1:${vitePort}`;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { if ((await fetch(base)).ok) break; } catch { /* Vite is starting. */ }
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
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const openHelmraiser = async (reload = false) => {
    if (reload) await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 });
    else await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    const nav = await page.$$('xpath/.//button[contains(., "Helmraiser")]');
    await nav[0].click();
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser'));
  };
  const button = async (name) => (await page.$$(`xpath/.//button[normalize-space(.)="${name}"]`))[0];

  await openHelmraiser();
  await (await button('PLAN')).click();
  await page.waitForFunction((text) => document.body.innerText.includes(text), {}, 'Add the guarded read-only plan seam.');
  await page.type('input[placeholder="optional"]', 'Keep the migration reversible.');
  const renderedPlan = await page.$eval('pre', (element) => ({
    text: element.textContent, overflowY: getComputedStyle(element).overflowY,
  }));
  assert('PLAN fetches selected run text', requests.some((row) => row.method === 'helmraiser.plan' && row.params?.runId === runId) && renderedPlan.text === planText);
  assert('plan view is scrollable preformatted text', renderedPlan.overflowY === 'auto');
  assert('plan actions rendered', Boolean(await button('APPROVE PLAN')) && Boolean(await button('REJECT')));
  await page.screenshot({ path: `${out}/plan-expanded.png` });

  const rejectsBefore = requests.filter((row) => row.method === 'helmraiser.reject').length;
  await (await button('REJECT')).click();
  assert('reject waits for confirmation', requests.filter((row) => row.method === 'helmraiser.reject').length === rejectsBefore);
  await page.type('input[placeholder="why (optional)"]', 'Clarify the rollback step.');
  await (await button('CONFIRM REJECT')).click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rejectRequest = requests.filter((row) => row.method === 'helmraiser.reject').at(-1);
  assert('confirmed reject sends optional note', rejectRequest?.params?.runId === runId && rejectRequest?.params?.note === 'Clarify the rollback step.');

  status = baseStatus();
  approvalWorkerServes = true;
  await openHelmraiser(true);
  await page.type('input[placeholder="optional"]', 'Keep the migration reversible.');
  await (await button('APPROVE PLAN')).click();
  await page.waitForFunction(() => document.body.innerText.includes('plan approved — the worker resumes it'));
  const serveApprove = requests.filter((row) => row.method === 'helmraiser.approve').at(-1);
  assert('APPROVE PLAN sends run and note', serveApprove?.params?.runId === runId && serveApprove?.params?.note === 'Keep the migration reversible.');
  const startsAfterServing = requests.filter((row) => row.method === 'helmraiser.workerStart').length;
  assert('serving worker is not started automatically', startsAfterServing === 0);
  await page.screenshot({ path: `${out}/approval-worker-serves.png` });

  status = { ...baseStatus(), worker: { state: 'stopped' } };
  approvalWorkerServes = false;
  await openHelmraiser(true);
  await (await button('APPROVE PLAN')).click();
  await page.waitForFunction(() => document.body.innerText.includes('plan approved — start the worker to resume it'));
  assert('worker-needed outcome is beside START', Boolean(await button('START')));
  assert('stopped worker is not started automatically', requests.filter((row) => row.method === 'helmraiser.workerStart').length === startsAfterServing);
  await page.screenshot({ path: `${out}/approval-worker-needed.png` });

  status = {
    ...baseStatus(), awaiting_count: 0, awaiting: [], worker: { state: 'running' },
    queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
    resuming: [{ run_id: runId, task: 'fixture:plan-approval', project, id: 'plan-approval',
      title: 'Approve a governed implementation plan', stage: 'implement' }],
  };
  await openHelmraiser(true);
  await page.waitForFunction(() => document.body.innerText.includes('resuming at implement'));
  const body = await page.evaluate(() => document.body.innerText);
  assert('resuming row shows title project and stage', body.includes('Approve a governed implementation plan') && body.includes('funkyoctopus') && body.includes('resuming at implement'));
  assert('resuming status is active work', !body.includes('queue empty'));
  await page.screenshot({ path: `${out}/resuming.png` });

  status = {
    ...baseStatus(), awaiting_count: 0, awaiting: [], worker: { state: 'stopped' },
    queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  };
  delete status.resuming;
  await openHelmraiser(true);
  await page.waitForFunction(() => document.body.innerText.includes('queue empty'));
  assert('older status without resuming renders', !(await page.evaluate(() => document.body.innerText)).includes('RESUMING'));

  const report = {
    requests,
    displayedOutcomes: {
      workerServes: 'plan approved — the worker resumes it',
      workerNeeded: 'plan approved — start the worker to resume it',
      resuming: 'resuming at implement',
    },
    automaticWorkerStartRequests: requests.filter((row) => row.method === 'helmraiser.workerStart'),
    assertions,
  };
  await writeFile(`${out}/plan-approval-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
