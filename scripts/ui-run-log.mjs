#!/usr/bin/env node
/** Rendered fake-transport evidence for the LOG toggle on failed and running Helmraiser rows, and a running log following new events. */
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/run-log';
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

// Historical run 142d660e log events adapted to Helmraiser, as the sidecar sends them (no run_id / session_id).
const events = (await readFile(new URL('../server/src/helmraiser/fixtures/log-failed-run.jsonl', import.meta.url), 'utf8'))
  .split('\n').filter(Boolean).map((line) => {
    const { id, ts, source, stage, type, payload } = JSON.parse(line);
    return { id, ts, source, stage, type, payload };
  });

const project = '/fixture/acme';
const failedRun = '142d660e-8ed6-4338-9413-5ad16510baaa';
const runningRun = 'e1fba81e-9ac9-4421-af2c-9a28dc79da8e';
// The running run's log grows: the first read is the first 26 events, each later read the next five.
const RUNNING_FIRST = 26;
const STEP = 5;
let runningShown = RUNNING_FIRST;

const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], held: [], never_startable: [],
  running: [{
    run_id: runningRun, task: '-fixture-acme:app-sign-in', stage: 'implement', iteration: 1, cost_usd: 0.64, minutes: 6,
    project, id: 'app-sign-in', title: 'App: Meet Acme background on sign-in', origin: null,
  }],
  awaiting_count: 0, failed_24h_count: 1, spend: {}, usage: {}, caps_enforced: true, paused: null, held_providers: {},
  worker: { state: 'running' }, queue: { failed: 1, landed: 0, queued: 0, running: 1, awaiting_approval: 0 }, awaiting: [],
  failed: [{
    run_id: failedRun, task: '-fixture-acme:app-sign-in-tagline-mansalva',
    reason: 'blocked: `acme-app/assets/fonts/Mansalva-OFL.txt:21` contains supplied trailing whitespace. Keeping it unchanged, as required, makes `diff-check` fail.',
    ended_at: '2026-10-19T16:46:28.875610+00:00', project, id: 'app-sign-in-tagline-mansalva',
    title: 'App: brand logo and Mansalva tagline on sign-in',
  }],
  status_path: '/fixture/status.json',
});
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: project, name: 'acme', path: project, envTier: 'normal' }], folders: [] },
  'models.list': [], 'chat.transcript': [], 'chat.list': [], 'helmraiser.drafts': [],
};

/** `helmraiser.log` as the sidecar answers it: the failed run's whole fixture (marked truncated), the running one's growing prefix. */
function logReply({ runId, sinceId }) {
  if (runId === failedRun) return { events, truncated: true };
  if (runId !== runningRun) return null;
  if (sinceId === undefined) return { events: events.slice(0, runningShown), truncated: false };
  const from = events.findIndex((event) => event.id > sinceId);
  if (from === -1 || from >= runningShown) runningShown = Math.min(events.length, runningShown + STEP);
  return { events: events.slice(0, runningShown).filter((event) => event.id > sinceId), truncated: false };
}

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') return;
    let result = Object.hasOwn(staticReplies, request.method) ? staticReplies[request.method] : null;
    if (request.method === 'helmraiser.status') result = status();
    if (request.method === 'helmraiser.log') {
      const reply = logReply(request.params ?? {});
      if (reply === null) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: { code: 'helmraiser_cli_error', message: `helmraiser log failed: unknown run: ${request.params?.runId}` } }));
        return;
      }
      result = reply;
    }
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
  // The two rows are told apart by their (distinct) titles.
  const RUNNING = 'Meet Acme background';
  const FAILED = 'brand logo and Mansalva';
  const rowFor = (title) => `(//div[contains(@class,"rounded") and .//strong[contains(.,"${title}")]])[last()]`;
  const logButton = async (title) => (await page.$$(`xpath/${rowFor(title)}//button[normalize-space(.)="LOG"]`))[0];
  const inRow = (title, op) => page.evaluate((needle, what) => {
    const row = [...document.querySelectorAll('div.rounded')].filter((node) => node.querySelector('strong')?.textContent?.includes(needle)).at(-1);
    if (!row) return null;
    if (what === 'reveal') row.scrollIntoView({ block: 'start' });
    return what === 'text' ? row.innerText : row.querySelectorAll('ol[aria-label="Run log"] > li').length;
  }, title, op);
  const rowText = (title) => inRow(title, 'text');
  const logRows = (title) => inRow(title, 'count');
  const logCalls = (runId) => requests.filter((request) => request.method === 'helmraiser.log' && request.params?.runId === runId);
  // Scroll the row to the top of the panel and let any smooth scrolling settle before the shot.
  const reveal = async (title) => {
    await inRow(title, 'reveal');
    await new Promise((resolve) => setTimeout(resolve, 800));
  };

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await (await page.$$(`xpath/.//button[contains(., "Helmraiser")]`))[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('FAILED'));

  assert('both rows start collapsed with a LOG toggle', Boolean(await logButton(RUNNING)) && Boolean(await logButton(FAILED)) && await logRows(RUNNING) === 0);
  assert('nothing is read before LOG is opened', requests.every((request) => request.method !== 'helmraiser.log'));

  // Failed row: the whole story, ending in the failing check and the reason.
  await (await logButton(FAILED)).click();
  await page.waitForFunction(() => document.body.innerText.includes('run_end'));
  const failed = await rowText(FAILED);
  assert('failed log lists the timeline', await logRows(FAILED) === 39 && failed.includes('stage_start') && failed.includes('verify_result'));
  assert('verify checks show pass or fail', failed.includes('PASS lint') && failed.includes('FAIL diff-check · exit 2'));
  assert('the failed check shows its output', failed.includes('Mansalva-OFL.txt:21: trailing whitespace.'));
  assert('a passing check shows no output', !failed.includes('Test Suites'));
  assert('run_end shows the status and the reason', failed.includes('run_end') && failed.includes('makes `diff-check` fail.'));
  assert('truncation is stated', failed.includes('39 most recent events · earlier ones not shown'));
  await reveal(FAILED);
  await page.screenshot({ path: `${out}/failed-log.png` });

  // Running row: opens, then follows.
  await (await logButton(RUNNING)).click();
  await page.waitForFunction((needle) => [...document.querySelectorAll('div.rounded')].some((node) => node.querySelector('strong')?.textContent?.includes(needle)
    && node.querySelectorAll('ol[aria-label="Run log"] > li').length > 0), {}, RUNNING);
  assert('running log opens with the first events', await logRows(RUNNING) === RUNNING_FIRST);
  await page.waitForFunction((needle, first) => [...document.querySelectorAll('div.rounded')].some((node) => node.querySelector('strong')?.textContent?.includes(needle)
    && node.querySelectorAll('ol[aria-label="Run log"] > li').length > first), { timeout: 15_000 }, RUNNING, RUNNING_FIRST);
  const lastSeen = events[RUNNING_FIRST - 1].id;
  assert('it follows with the last seen event id', logCalls(runningRun).some((request) => request.params?.sinceId === lastSeen));
  assert('the log grew by the new events', await logRows(RUNNING) > RUNNING_FIRST);
  await reveal(RUNNING);
  await page.screenshot({ path: `${out}/running-log.png` });

  // Collapsing stops the reads.
  await (await logButton(RUNNING)).click();
  const callsAtCollapse = { running: logCalls(runningRun).length, failed: logCalls(failedRun).length };
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  assert('collapsing stops following', logCalls(runningRun).length === callsAtCollapse.running);
  // Vite's dev StrictMode mounts effects twice, so the failed row's first read may appear twice; it is never repeated or followed.
  assert('the failed row is never followed', logCalls(failedRun).length === callsAtCollapse.failed && logCalls(failedRun).every((request) => request.params.sinceId === undefined));
  console.log(JSON.stringify({ ok: true, assertions, out }, null, 2));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
