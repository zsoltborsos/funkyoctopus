#!/usr/bin/env node
/** Rendered fake-transport evidence for REWORK on rows awaiting merge: the buttons, the confirm form, the rounds history, a refusal and a success. */
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/rework';
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
// Real shapes: `awaiting[]` as `_awaiting_rows` writes it (monitor.py), `reworks[]` as `build_status` does
// (loop/status.py) with request payloads from `Ledger.hand_back`, and the `reworked` payload `rework`
// builds (commands.py): `reworked`, `rebase` when asked, then `_hand_back`'s run_id/task_id/project/status/stage/worker.
const awaitingRow = (n, id, title, projectPath, pending) => ({
  run_id: `${n}0000000-aaaa-4bbb-8ccc-dddddddddddd`, task: `-fixture-${id}:${id}`, project: projectPath, id, title, pending,
  verdict: 'pass', cost_usd: 1.2345, worktree: `${projectPath}/.helmraiser/worktrees/${id}`, branch: `feature/${id}`,
  base_commit: 'abc1234', origin: null,
});
const tidy = awaitingRow(1, 'tidy-settings', 'Tidy the settings panel', other, 'merge');
const rename = awaitingRow(2, 'rename-export', 'Rename the export', project, 'merge');
const plan = awaitingRow(3, 'new-importer', 'A new importer', project, 'plan');
let awaiting = [tidy, rename, plan];
let resuming = [];
const rounds = [
  { approval_id: 3, round: 1, note: 'The empty case is not covered.\nAdd a test for a settings panel with no sections, and keep the 30 s limit.', findings: [], iteration_allowance: 2, extra_cost_usd: 1.3333, extra_minutes: 20, iterations_before: 1 },
  { approval_id: 5, round: 2, rebase: true, note: Array.from({ length: 24 }, (_, line) => `Rebased note, line ${line + 1}: a long set of feedback that would wall the row if it were shown in full.`).join('\n'), findings: [], iteration_allowance: 2, extra_cost_usd: 1.3333, extra_minutes: 20, iterations_before: 3 },
];
let reworks = [{ run_id: tidy.run_id, task: tidy.task, status: 'awaiting_approval', rework_rounds: rounds.length, reworks: rounds }];
// A running worker that serves only the helmraiser project: funkyoctopus rows get the hint, helmraiser rows do not.
const worker = { state: 'running', pid: 4242, projects: [other], exclude_projects: [] };
const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], held: [], never_startable: [], running: [],
  resuming, reworks, awaiting_count: awaiting.length, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: true, paused: null,
  held_providers: {}, worker, queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: awaiting.length },
  awaiting, failed: [], status_path: '/fixture/status.json',
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
    if (request.method === 'helmraiser.rework') {
      const row = awaiting.find((candidate) => candidate.run_id === request.params?.runId);
      if (row === rename) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: {
          code: 'helmraiser_cli_error',
          message: `helmraiser rework failed: run ${row.run_id} already contains main; nothing to rebase`,
        } }));
        return;
      }
      const rebase = request.params?.rebase === true;
      awaiting = awaiting.filter((candidate) => candidate !== row);
      resuming = [{ run_id: row.run_id, task: row.task, project: row.project, id: row.id, title: row.title, stage: 'implement', origin: null }];
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: {
        reworked: 'merge', ...(rebase ? { rebase: true } : {}), run_id: row.run_id, task_id: row.task, project: row.project,
        status: 'resuming', stage: 'implement', worker: 'running', worker_serves_project: row.project === other,
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
  await page.setViewport({ width: 1300, height: 1300, deviceScaleFactor: 1 });
  // Awaiting rows are plain divs; find one by its title.
  const rowXpath = (title) => `xpath/.//strong[normalize-space(.)="${title}"]/ancestor::div[contains(@class,"rounded")][1]`;
  const inRow = async (title, path) => (await page.$$(`${rowXpath(title)}//${path}`))[0];
  const rowButton = (title, name) => inRow(title, `button[normalize-space(.)="${name}"]`);
  const rowText = async (title) => page.evaluate((node) => node?.innerText ?? '', (await page.$$(rowXpath(title)))[0]);
  const reworkCalls = () => requests.filter((request) => request.method === 'helmraiser.rework');
  const bodyText = () => page.evaluate(() => document.body.innerText);

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await (await page.$$(`xpath/.//button[contains(., "Helmraiser")]`))[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('AWAITING'));

  assert('merge rows carry REWORK', Boolean(await rowButton('Tidy the settings panel', 'REWORK')) && Boolean(await rowButton('Rename the export', 'REWORK')));
  assert('a plan approval offers no REWORK', !(await rowButton('A new importer', 'REWORK')));
  assert('REWORK sits beside APPROVE and REJECT', await page.evaluate((node) => {
    const names = [...node.querySelectorAll('button')].map((button) => button.textContent);
    return names.slice(-3).join() === 'APPROVE,REJECT,REWORK';
  }, (await page.$$(rowXpath('Rename the export')))[0]));
  assert('nothing is sent until a confirm', reworkCalls().length === 0);
  await page.screenshot({ path: `${out}/rework-rows.png` });

  assert('a reworked run shows its history toggle, collapsed', Boolean(await rowButton('Tidy the settings panel', 'REWORK HISTORY (2)'))
    && !(await rowText('Tidy the settings panel')).includes('The empty case is not covered'));
  assert('a never-reworked run has no history toggle', !(await inRow('Rename the export', 'button[starts-with(normalize-space(.),"REWORK HISTORY")]')));
  await (await rowButton('Tidy the settings panel', 'REWORK HISTORY (2)')).click();
  const roundsText = await rowText('Tidy the settings panel');
  assert('the rounds show the round, the rebase marker and the note', roundsText.includes('Round 1') && roundsText.includes('Round 2 · rebase')
    && roundsText.includes('The empty case is not covered.'));
  assert('a long note is its own bounded scroll area, not a wall', await page.evaluate((node) => {
    const pre = [...node.querySelectorAll('li pre')][1];
    return pre.scrollHeight > pre.clientHeight && pre.clientHeight <= 170;
  }, (await page.$$(rowXpath('Tidy the settings panel')))[0]));
  await page.screenshot({ path: `${out}/rework-rounds.png` });
  await (await rowButton('Tidy the settings panel', 'REWORK HISTORY (2)')).click();

  await (await rowButton('Rename the export', 'REWORK')).click();
  const confirmText = await rowText('Rename the export');
  assert('REWORK says what it does, in the help\'s words', confirmText.includes('Hands the run back for feedback, a rebase, or both.')
    && !confirmText.includes('as retry does'));
  assert('an empty form blocks the confirm and says why', await (await rowButton('Rename the export', 'CONFIRM REWORK')).evaluate((node) => node.disabled)
    && confirmText.includes('Needs a note, or a rebase on its own'));
  assert('no worker serving the project is said before the confirm', confirmText.includes('no worker serves this project — the running worker is scoped to other projects'));
  assert('APPROVE and REJECT step aside while the form is open', !(await rowButton('Rename the export', 'APPROVE')) && !(await rowButton('Rename the export', 'REJECT')));
  await page.screenshot({ path: `${out}/rework-confirm.png` });

  await (await inRow('Rename the export', 'textarea')).type('Rename it to publishSettings, "quoted" and -dashed.');
  await (await inRow('Rename the export', 'input[@type="checkbox"]')).click();
  assert('a note or a rebase enables the confirm', await (await rowButton('Rename the export', 'CONFIRM REWORK')).evaluate((node) => !node.disabled));
  await page.screenshot({ path: `${out}/rework-filled.png` });
  await (await rowButton('Rename the export', 'CONFIRM REWORK')).click();
  await page.waitForFunction(() => document.body.innerText.includes('Not reworked'));
  const refusedText = await rowText('Rename the export');
  assert('the CLI refusal shows on its own row, with the command prefix stripped',
    refusedText.includes('Not reworked — run 20000000-aaaa-4bbb-8ccc-dddddddddddd already contains main; nothing to rebase')
    && !refusedText.includes('helmraiser rework failed')
    && !(await rowText('Tidy the settings panel')).includes('Not reworked'));
  assert('the refused form keeps the note and the rebase flag', await page.evaluate((node) => (
    node.querySelector('textarea').value === 'Rename it to publishSettings, "quoted" and -dashed.' && node.querySelector('input[type=checkbox]').checked
  ), (await page.$$(rowXpath('Rename the export')))[0]));
  assert('the refused request carried the exact note and the rebase flag', reworkCalls().some((call) => call.params?.runId === rename.run_id
    && call.params?.note === 'Rename it to publishSettings, "quoted" and -dashed.' && call.params?.rebase === true));
  await page.screenshot({ path: `${out}/rework-refused.png` });
  await (await rowButton('Rename the export', 'CANCEL')).click();

  await (await rowButton('Tidy the settings panel', 'REWORK')).click();
  assert('a row whose project the worker serves has no worker hint', !(await rowText('Tidy the settings panel')).includes('no worker serves'));
  await (await inRow('Tidy the settings panel', 'textarea')).type('Cover the empty case in the settings panel.');
  await (await rowButton('Tidy the settings panel', 'CONFIRM REWORK')).click();
  await page.waitForFunction(() => document.body.innerText.includes('run sent back for rework'));
  assert('success sends the full run id and the note, without a rebase flag', reworkCalls().some((call) => call.params?.runId === tidy.run_id
    && call.params?.note === 'Cover the empty case in the settings panel.' && !('rebase' in call.params)));
  assert('the run leaves AWAITING and shows as resuming at implement',
    (await bodyText()).includes('AWAITING YOUR APPROVAL (2)') && (await bodyText()).includes('resuming at implement')
    && !(await page.$$(rowXpath('Tidy the settings panel') + '//button[normalize-space(.)="REWORK"]')).length);
  assert('the panel says the worker resumes it, beside the worker controls',
    await page.evaluate(() => [...document.querySelectorAll('[role=status]')].some((node) =>
      node.textContent === 'run sent back for rework — the worker resumes it'
      && node.className.includes('text-ok')
      && node.parentElement?.innerText.includes('WORKER RUNNING'))));
  await page.screenshot({ path: `${out}/rework-done.png` });
  console.log(JSON.stringify({ ok: true, assertions, out }, null, 2));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
