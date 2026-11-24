#!/usr/bin/env node
/** Rendered fake-transport evidence for RETRY and RETRY (IMPLEMENT) on failed rows: the confirm, the worker hint, a refusal and a success. */
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/retry';
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
const other = '/fixture/helmraiser';
// Real shapes: `failed[]` as `helmraiser status --json` writes it (monitor.py `status`), and the
// `retried` payload `_hand_back` builds (commands.py): stage, worker, worker_serves_project.
const failedRow = (n, id, title, projectPath, reason) => ({
  run_id: `${n}0000000-aaaa-4bbb-8ccc-dddddddddddd`, task: `-fixture-${id}:${id}`, project: projectPath, id, title,
  origin: null, reason, hints: [], ended_at: '2026-10-19T19:07:16.029352+00:00',
});
const blocked = failedRow(1, 'tagline', 'Brand the sign-in tagline', project, 'blocked: the diff-check fails on trailing whitespace in a supplied file.');
const goneWorktree = failedRow(2, 'rewrite-loop', 'Rewrite the loop', other, 'verify_exhausted');
const rejected = failedRow(3, 'old-experiment', 'Old experiment', project, 'rejected');
let failed = [blocked, goneWorktree, rejected];
let resuming = [];
// A running worker that serves only the helmraiser project: funkyoctopus rows get the hint, helmraiser rows do not.
const worker = { state: 'running', pid: 4242, projects: [other], exclude_projects: [] };
const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], held: [], never_startable: [], running: [],
  resuming, awaiting_count: 0, failed_24h_count: failed.length, spend: {}, usage: {}, caps_enforced: true, paused: null,
  held_providers: {}, worker, queue: { failed: failed.length, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  awaiting: [], failed, status_path: '/fixture/status.json',
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
    if (request.method === 'helmraiser.retry') {
      const row = failed.find((candidate) => candidate.run_id === request.params?.runId);
      if (row === goneWorktree) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: {
          code: 'helmraiser_cli_error',
          message: `helmraiser retry failed: run ${row.run_id} cannot be retried: its worktree /fixture/helmraiser/.helmraiser/worktrees/rewrite-loop or branch feature/rewrite-loop is gone`,
        } }));
        return;
      }
      if (row === rejected) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: {
          code: 'helmraiser_cli_error',
          message: `helmraiser retry failed: run ${row.run_id} failed with rejected; retry is only for a run that was blocked or failed verify`,
        } }));
        return;
      }
      failed = failed.filter((candidate) => candidate !== row);
      const implement = request.params?.implement === true;
      resuming = [{ run_id: row.run_id, task: row.task, project: row.project, id: row.id, title: row.title, stage: implement ? 'implement' : 'verify', origin: null }];
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: {
        retried: row.reason, run_id: row.run_id, task_id: row.task, project: row.project, status: 'resuming',
        stage: implement ? 'implement' : 'verify', worker: 'running', worker_serves_project: row.project === other,
      } }));
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
  // Failed rows are plain divs; find one by its title.
  const rowXpath = (title) => `xpath/.//strong[normalize-space(.)="${title}"]/ancestor::div[contains(@class,"rounded")][1]`;
  const rowButton = async (title, name) => (await page.$$(`${rowXpath(title)}//button[normalize-space(.)="${name}"]`))[0];
  const rowText = async (title) => page.evaluate((node) => node?.innerText ?? '', (await page.$$(rowXpath(title)))[0]);
  const retryCalls = () => requests.filter((request) => request.method === 'helmraiser.retry');

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await (await page.$$(`xpath/.//button[contains(., "Helmraiser")]`))[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('FAILED'));

  assert('failed rows carry RETRY and RETRY (IMPLEMENT)', Boolean(await rowButton('Brand the sign-in tagline', 'RETRY')) && Boolean(await rowButton('Brand the sign-in tagline', 'RETRY (IMPLEMENT)')));
  assert('a run the owner rejected offers no retry', !(await rowButton('Old experiment', 'RETRY')));
  assert('nothing is sent until a confirm', retryCalls().length === 0);
  await page.screenshot({ path: `${out}/retry-rows.png` });

  await (await rowButton('Brand the sign-in tagline', 'RETRY')).click();
  const resumeText = await rowText('Brand the sign-in tagline');
  assert('RETRY says what it does, in the help\'s words', resumeText.includes('resumes at verify → evidence → review'));
  assert('no worker serving the project is said before the confirm', resumeText.includes('no worker serves this project — the running worker is scoped to other projects'));
  assert('RETRY asks first and sends nothing', retryCalls().length === 0 && Boolean(await rowButton('Brand the sign-in tagline', 'CONFIRM RETRY')));
  await page.screenshot({ path: `${out}/retry-confirm.png` });

  await (await rowButton('Brand the sign-in tagline', 'CANCEL')).click();
  await (await rowButton('Brand the sign-in tagline', 'RETRY (IMPLEMENT)')).click();
  assert('RETRY (IMPLEMENT) says what it does, in the help\'s words', (await rowText('Brand the sign-in tagline')).includes('goes back to implement with the last verify failure'));
  await page.screenshot({ path: `${out}/retry-implement-confirm.png` });
  await (await rowButton('Brand the sign-in tagline', 'CANCEL')).click();

  await (await rowButton('Rewrite the loop', 'RETRY')).click();
  assert('a row whose project the worker serves has no worker hint', !(await rowText('Rewrite the loop')).includes('no worker serves'));
  await (await rowButton('Rewrite the loop', 'CONFIRM RETRY')).click();
  await page.waitForFunction(() => document.body.innerText.includes('Not retried'));
  assert('the CLI refusal shows on its own row, with the command prefix stripped',
    (await rowText('Rewrite the loop')).includes('Not retried — run 20000000-aaaa-4bbb-8ccc-dddddddddddd cannot be retried: its worktree')
    && !(await rowText('Rewrite the loop')).includes('helmraiser retry failed')
    && !(await rowText('Brand the sign-in tagline')).includes('Not retried'));
  assert('the refused row is still there and retryable again', Boolean(await rowButton('Rewrite the loop', 'RETRY')));
  await page.screenshot({ path: `${out}/retry-refused.png` });

  await (await rowButton('Brand the sign-in tagline', 'RETRY (IMPLEMENT)')).click();
  await (await rowButton('Brand the sign-in tagline', 'CONFIRM RETRY (IMPLEMENT)')).click();
  await page.waitForFunction(() => document.body.innerText.includes('run retried — no worker serves its project'));
  assert('success sends the full run id with implement', retryCalls().some((call) => call.params?.runId === blocked.run_id && call.params?.implement === true));
  assert('the run leaves FAILED and shows as resuming at implement',
    !(await page.evaluate(() => document.body.innerText)).includes('FAILED · 24H (3)')
    && (await page.evaluate(() => document.body.innerText)).includes('resuming at implement'));
  assert('the panel says the running worker does not serve the project, beside the worker controls',
    await page.evaluate(() => [...document.querySelectorAll('[role=status]')].some((node) =>
      node.textContent === 'run retried — no worker serves its project'
      && node.parentElement?.innerText.includes('WORKER RUNNING'))));
  await page.screenshot({ path: `${out}/retry-done.png` });
  console.log(JSON.stringify({ ok: true, assertions, out }, null, 2));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
