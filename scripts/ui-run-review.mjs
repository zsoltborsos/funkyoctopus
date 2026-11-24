#!/usr/bin/env node
/** Rendered fake-transport evidence for Helmraiser run review and Open in chat. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/run-review';
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
const worktree = '/fixture/funkyoctopus/.helmraiser/worktrees/run-review';
const dataDir = '/var/tmp/fo-helmraiser-fixture';
const branch = 'feature/run-review';
const baseCommit = '7d21bc9';
const taskPath = `${dataDir}/runs/${runId}/task.md`;
const expectedDraft = `Review this Helmraiser run's diff against its task: run ${runId}, branch ${branch}, base ${baseCommit}. The task is in ${taskPath}.`;
const awaiting = {
  run_id: runId, task: 'fixture:run-review', pending: 'merge', verdict: 'pass', cost_usd: 1.84,
  project, id: 'run-review', title: 'Review a finished Helmraiser run inside FO',
  worktree, branch, base_commit: baseCommit,
};
const statusWith = (row) => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [], resuming: [],
  awaiting_count: 1, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'running' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 1 },
  awaiting: [row], failed: [], landed: [], status_path: '/fixture/status.json',
});
let status = statusWith(awaiting);
const reviewResult = {
  summary: '## Verify\n- npm run verify — pass\n\n## Evidence\n- rendered review inspected\n\n### Review\nVerdict: pass',
  review: '### Review\nVerdict: pass\n\n- [high] src/features/jobs/JobsPanel.tsx:612 — await setRoot before new\n- [low] server/src/helmraiser/run-review.ts:44 — keep the file cap visible',
  diffStat: {
    files: [
      { path: 'src/features/jobs/JobsPanel.tsx', additions: 84, deletions: 5, binary: false },
      { path: 'server/src/helmraiser/run-review.ts', additions: 96, deletions: 0, binary: false },
      { path: 'evidence/review.png', additions: 0, deletions: 0, binary: true },
    ],
    filesChanged: 3, additions: 180, deletions: 5,
  },
  diffTruncated: false,
  taskPath,
};
const prior = {
  path: '/fixture/sessions/prior.jsonl', id: 'prior-chat', title: 'Previous owner conversation', cwd: project,
  created: new Date(0).toISOString(), modified: new Date(1).toISOString(),
};
const rooted = {
  path: '/fixture/sessions/rooted.jsonl', id: 'rooted-chat', title: 'Existing worktree chat', cwd: worktree,
  created: new Date(2).toISOString(), modified: new Date(3).toISOString(),
};
const fresh = {
  path: '/fixture/sessions/fresh.jsonl', id: 'fresh-chat', title: 'New conversation', cwd: worktree,
  created: new Date(4).toISOString(), modified: new Date(5).toISOString(),
};
let current = prior;
let sessions = [prior];
let reviewCalls = 0;
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }], folders: [] },
  'models.list': [], 'chat.transcript': [],
};

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') return;
    if (request.method === 'helmraiser.runReview') {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: { message: 'fixture first-load failure' } }));
        return;
      }
    }
    let result = Object.hasOwn(staticReplies, request.method) ? staticReplies[request.method] : null;
    if (request.method === 'helmraiser.status') result = status;
    if (request.method === 'helmraiser.runReview') result = reviewResult;
    if (request.method === 'chat.setRoot') {
      current = rooted;
      sessions = [prior, rooted];
      result = [];
    }
    if (request.method === 'chat.new') {
      current = fresh;
      sessions = [prior, rooted, fresh];
      result = fresh;
    }
    if (request.method === 'chat.list') result = sessions;
    if (request.method === 'chat.current') result = current;
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
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const button = async (name) => (await page.$$(`xpath/.//button[normalize-space(.)="${name}"]`))[0];
  const openHelmraiser = async (reload = false) => {
    if (reload) await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 });
    else await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    await (await page.$$(`xpath/.//button[contains(., "Helmraiser")]`))[0].click();
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser'));
  };

  await openHelmraiser();
  await (await button('REVIEW')).click();
  await page.waitForFunction(() => document.body.innerText.includes('review could not be loaded — reopen REVIEW to retry'));
  assert('failed load is explained', (await page.evaluate(() => document.body.innerText)).includes('reopen REVIEW to retry'));
  await (await button('REVIEW')).click();
  await (await button('REVIEW')).click();
  await page.waitForFunction(() => document.body.innerText.includes('await setRoot before new'));
  const expanded = await page.evaluate(() => document.body.innerText);
  assert('selected run review fetched and retry succeeded', reviewCalls === 2 && requests.filter((r) => r.method === 'helmraiser.runReview').every((r) => r.params?.runId === runId));
  assert('expanded review shows verdict findings verify evidence and diff', ['Verdict: pass', '[high]', 'JobsPanel.tsx:612', 'npm run verify — pass', 'rendered review inspected', 'DIFF STAT', '+180', '−5'].every((text) => expanded.includes(text)));
  assert('merge decisions remain available', Boolean(await button('APPROVE')) && Boolean(await button('REJECT')));
  await page.screenshot({ path: `${out}/run-review-expanded.png` });

  status = statusWith({ ...awaiting });
  delete status.awaiting[0].worktree;
  await openHelmraiser(true);
  await (await button('REVIEW')).click();
  await page.waitForFunction(() => document.body.innerText.includes('await setRoot before new'));
  assert('open button hidden without worktree', !(await button('OPEN IN CHAT')));

  status = statusWith(awaiting);
  await openHelmraiser(true);
  await (await button('REVIEW')).click();
  await page.waitForFunction(() => document.body.innerText.includes('await setRoot before new'));
  await (await button('OPEN IN CHAT')).click();
  await page.waitForFunction((draft) => document.querySelector('textarea[aria-label="Message"]')?.value === draft, {}, expectedDraft);
  const setRootIndex = requests.findIndex((r) => r.method === 'chat.setRoot' && r.params?.path === worktree);
  const newIndex = requests.findIndex((r, index) => index > setRootIndex && r.method === 'chat.new');
  assert('setRoot precedes new', setRootIndex >= 0 && newIndex > setRootIndex);
  assert('new session is distinct and rooted at worktree', current.path === fresh.path && current.path !== prior.path && current.cwd === worktree);
  const mountedSession = await page.$eval('[aria-label="Session title"]', (node) => ({
    title: node.textContent,
    detail: node.parentElement?.getAttribute('title'),
  }));
  assert('worktree retained after Chat mounts', mountedSession.title === 'New conversation' && mountedSession.detail?.includes(worktree));
  assert('composer exact and unsent', await page.$eval('textarea[aria-label="Message"]', (node) => node.value) === expectedDraft && requests.filter((r) => r.method === 'chat.send').length === 0);
  await (await page.$('button[aria-label="Chat history"]')).click();
  await page.waitForFunction(() => document.body.innerText.includes('Previous owner conversation'));
  assert('prior conversation remains available in history', (await page.evaluate(() => document.body.innerText)).includes('Previous owner conversation'));
  await page.screenshot({ path: `${out}/run-review-chat-prefilled.png` });

  const report = {
    requests,
    observed: { runId, worktree, priorSession: prior.path, newSession: fresh.path, composer: expectedDraft, chatSendRequests: requests.filter((r) => r.method === 'chat.send').length },
    assertions,
  };
  await writeFile(`${out}/run-review-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
