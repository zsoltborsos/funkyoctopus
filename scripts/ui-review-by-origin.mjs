#!/usr/bin/env node
/** Rendered origin-review evidence. Fake transport only: no sidecar, CLI or model. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/review-by-origin';
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
const events = [];
const assertions = {};
const observed = [];
const sockets = new Set();
const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
const runId = '865c36b8-a39d-433a-bc6c-87b1715d14e2';
const project = '/fixture/funkyoctopus';
const worktree = `${project}/.helmraiser/worktrees/review`;
const taskPath = `/custom/helmraiser/runs/${runId}/task.md`;
const planPath = `/custom/helmraiser/runs/${runId}/plan.md`;
const info = (path, id, cwd, title) => ({ path, id, cwd, title, created: new Date(0).toISOString(), modified: new Date(1).toISOString() });
const prior = info('/fixture/sessions/prior.jsonl', 'prior', project, 'Current owner conversation');
let origin = info('/fixture/sessions/origin.jsonl', 'original', project, 'Conversation that queued this run');
const originalText = 'Original conversation: queue this governed task after checking the constraints.';
const transcript = [{ id: 'queued-here', role: 'user', createdAt: 1, steps: [{ kind: 'text', text: originalText }] }];
let current = prior;
let exists = true;
let failOpen = false;
let pendingOpen = null;
let scenario = '';
let sequence = 0;
let row;
let extraRow = null;
const secondOrigin = info('/fixture/sessions/other-origin.jsonl', 'other-original', '/fixture/other-project', 'Other originating conversation');
const makeRow = (pending, variant = 'fo', hasWorktree = true) => ({
  run_id: runId, task: 'fixture:review', title: `Review the waiting ${pending} run`, pending,
  project, verdict: 'pass', cost_usd: 1.84, branch: 'feature/review', base_commit: 'abc123',
  ...(hasWorktree ? { worktree } : {}),
  ...(variant === 'fo' || variant === 'gone' ? { origin: { kind: 'fo', session: origin.path } } : {}),
  ...(variant === 'claude-code' ? { origin: { kind: 'claude-code', session: 'claude-uuid' } } : {}),
  ...(variant === 'null' ? { origin: null } : {}),
  future_field: 'unknown fields are tolerated',
});
const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [], resuming: [],
  awaiting_count: extraRow ? 2 : 1, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'running' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: extraRow ? 2 : 1 },
  awaiting: extraRow ? [row, extraRow] : [row], failed: [], landed: [], status_path: '/fixture/status.json',
});
const review = {
  taskPath, summary: '## Verify\n- Fixture tests pass\n\n## Evidence\n- Inspect the origin review controls',
  review: '### Review\nVerdict: pass\n- Owner still makes the approval decision.',
  diffStat: { files: [{ path: 'src/review.ts', additions: 8, deletions: 2, binary: false }], filesChanged: 1, additions: 8, deletions: 2 },
  diffTruncated: false,
};
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }, { id: '/fixture/other-project', name: 'other-project', path: '/fixture/other-project', envTier: 'normal' }], folders: [] },
  'models.list': [], 'helmraiser.drafts': [],
};
const respond = (socket, request, result) => socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ scenario, method: request.method, params: request.params });
    if (['chat.observe', 'helmraiser.observe'].includes(request.method)) return;
    if (request.method === 'chat.open') {
      if (failOpen) {
        socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: { message: 'fixture open failed' } }));
      } else {
        pendingOpen = () => {
          current = request.params.path === origin.path ? origin : secondOrigin;
          events.push({ scenario, event: 'open completed', path: current.path, cwd: current.cwd });
          respond(socket, request, transcript);
          pendingOpen = null;
        };
      }
      return;
    }
    let result = staticReplies[request.method] ?? null;
    if (request.method === 'helmraiser.status') result = status();
    if (request.method === 'helmraiser.runReview') result = review;
    if (request.method === 'helmraiser.plan') result = { text: '# Implementation plan\n\nCheck constraints, then implement with tests.\nOwner decides whether to approve.', path: planPath };
    if (request.method === 'chat.exists') result = { exists: exists && (request.params.path === origin.path || (extraRow !== null && request.params.path === secondOrigin.path)) };
    if (request.method === 'chat.current') result = current;
    // Origin is not in recent history until it is opened; status's path is sufficient.
    if (request.method === 'chat.list') result = current === prior ? [prior] : [current];
    if (request.method === 'chat.transcript') result = current === prior ? [] : transcript;
    respond(socket, request, result);
  });
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, VITE_SIDECAR_URL: `ws://127.0.0.1:${wsPort}/ws` }, stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const base = `http://127.0.0.1:${vitePort}`;
let browser;
const assert = (name, condition) => {
  assertions[name] = Boolean(condition);
  if (!condition) throw new Error(`browser assertion failed: ${name}`);
};
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (attempt === 99) throw new Error(`Vite did not start:\n${viteLog}`);
  }
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const button = async (name) => (await page.$$(`xpath/.//button[normalize-space(.)="${name}"]`))[0];
  const nav = async (name) => (await page.$$(`xpath/.//button[contains(., "${name}")]`))[0].click();
  const visible = () => page.evaluate(() => document.body.innerText);
  const screenshot = (name) => page.screenshot({ path: `${out}/${name}.png` });
  const calls = (method) => requests.filter((r) => r.scenario === scenario && r.method === method);
  const load = async (pending, variant = 'fo', hasWorktree = true, cwd = project, twoRows = false) => {
    scenario = `${++sequence}-${pending}-${variant}-${hasWorktree ? 'worktree' : 'no-worktree'}-${cwd === project ? 'same' : 'cross'}`;
    origin = info('/fixture/sessions/origin.jsonl', 'original', cwd, 'Conversation that queued this run');
    current = prior; exists = variant !== 'gone'; failOpen = false; pendingOpen = null;
    row = makeRow(pending, variant, hasWorktree);
    extraRow = twoRows ? { ...makeRow('plan'), run_id: '9c766bfd-052a-4ce2-bb4e-128694fa620f', title: 'Review the other waiting plan run', origin: { kind: 'fo', session: secondOrigin.path } } : null;
    await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    await page.waitForSelector('textarea[aria-label="Message"]');
    await page.$eval('textarea[aria-label="Message"]', (node) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(node, 'owner untouched draft');
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await nav('Helmraiser');
    await page.waitForFunction(() => document.body.innerText.includes('Review the waiting'));
    if (variant === 'fo') await page.waitForFunction(() => document.body.innerText.includes('REVIEW IN ITS CHAT'));
    if (pending === 'merge') {
      await (await button('REVIEW')).click();
      await page.waitForFunction(() => document.body.innerText.includes('SUMMARY · VERIFY · EVIDENCE'));
    } else {
      await (await button('PLAN')).click();
      await page.waitForFunction(() => document.body.innerText.includes('# Implementation plan'));
    }
  };
  for (const pending of ['merge', 'plan']) {
    for (const variant of ['fo', 'claude-code', 'absent', 'null', 'gone']) {
      await load(pending, variant);
      const text = await visible();
      assert(`${scenario}: primary only for existing FO`, Boolean(await button('REVIEW IN ITS CHAT')) === (variant === 'fo'));
      assert(`${scenario}: Claude label`, text.includes('queued from Claude Code') === (variant === 'claude-code'));
      assert(`${scenario}: unchanged fresh fallback`, Boolean(await button('OPEN IN CHAT')) === (pending === 'merge' || variant === 'fo'));
      assert(`${scenario}: owner decisions remain available`, Boolean(await button(pending === 'plan' ? 'APPROVE PLAN' : 'APPROVE')) && Boolean(await button('REJECT')));
      assert(`${scenario}: only FO probes`, variant === 'fo' || variant === 'gone' ? calls('chat.exists').length > 0 && calls('chat.exists').every((r) => r.params.path === origin.path) : calls('chat.exists').length === 0);
      if (variant === 'fo') {
        const styles = await (await button('OPEN IN CHAT')).evaluate((node) => node.className);
        assert(`${scenario}: fresh action is secondary`, styles.includes('text-muted'));
      }
      await screenshot(`${pending}-${variant}-controls`);
      if (pending === 'plan' && variant === 'fo') {
        await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
        assert(`${scenario}: review controls wrap without clipping`, await (await button('REVIEW IN ITS CHAT')).evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth));
        await screenshot('plan-fo-controls-narrow');
        await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
      }
    }
  }

  for (const [pending, hasWorktree, cwd] of [['merge', true, project], ['plan', true, '/fixture/other-project'], ['merge', false, '/fixture/other-project'], ['plan', false, project]]) {
    await load(pending, 'fo', hasWorktree, cwd);
    if (!hasWorktree) assert(`${scenario}: origin independent of worktree`, !(await button('OPEN IN CHAT')));
    const probesBeforeClick = calls('chat.exists').length;
    await (await button('REVIEW IN ITS CHAT')).click();
    await page.waitForFunction(() => document.body.innerText.includes('OPENING ORIGIN…'));
    for (let attempt = 0; !pendingOpen && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(`${scenario}: exact confirmed path requested`, calls('chat.open').length === 1 && calls('chat.open')[0].params.path === origin.path && calls('chat.exists').length === probesBeforeClick + 1);
    assert(`${scenario}: opening stays in Helmraiser with no composer replacement`, await page.evaluate(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser') && !document.querySelector('textarea[aria-label="Message"]')));
    assert(`${scenario}: decisions disabled during open`, await (await button(pending === 'plan' ? 'APPROVE PLAN' : 'APPROVE')).evaluate((node) => node.disabled));
    await screenshot(`${pending}-${hasWorktree ? 'with' : 'without'}-worktree-opening`);
    assert(`${scenario}: response explicitly delayed`, Boolean(pendingOpen));
    pendingOpen();
    const draft = pending === 'plan'
      ? `Review this Helmraiser run's plan before the owner approves it: run ${runId}, plan at ${planPath}, task at ${taskPath}. Check the plan against the task and recommend approve or changes.`
      : `Review this Helmraiser run's diff against its task: run ${runId}, branch feature/review, base abc123. The task is in ${taskPath}.`;
    await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="Message"]')?.value === expected, {}, draft);
    events.push({ scenario, event: 'compose visible', draft });
    const mounted = await page.$eval('[aria-label="Session title"]', (node) => ({ title: node.textContent, detail: node.parentElement?.getAttribute('title') }));
    assert(`${scenario}: open completed before exact composition`, events.findIndex((e) => e.scenario === scenario && e.event === 'open completed') < events.findIndex((e) => e.scenario === scenario && e.event === 'compose visible'));
    assert(`${scenario}: original transcript and effective cwd retained`, (await visible()).includes(originalText) && mounted.title === origin.title && mounted.detail?.includes(cwd) && current.path === origin.path && current.id === origin.id);
    assert(`${scenario}: history rooted at confirmed conversation cwd`, calls('chat.list').some((r) => r.params.root === cwd));
    assert(`${scenario}: no fresh conversation or worktree reroot`, calls('chat.new').length === 0 && calls('chat.setRoot').length === 0);
    observed.push({ scenario, origin: { ...origin }, mounted, composer: draft });
    await screenshot(`${pending}-${hasWorktree ? 'with' : 'without'}-worktree-reopened-chat`);
  }

  for (const pending of ['merge', 'plan']) {
    await load(pending, 'fo', true, project, true);
    scenario += '-two-rows';
    await page.waitForFunction(() => [...document.querySelectorAll('button')].filter((node) => node.textContent === 'REVIEW IN ITS CHAT').length === 2);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((node) => node.textContent === 'REVIEW IN ITS CHAT');
      buttons[0].click();
      buttons[1].click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('OPENING ORIGIN…'));
    for (let attempt = 0; !pendingOpen && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(`${scenario}: all other review actions disabled`, await page.evaluate(() => [...document.querySelectorAll('button')].filter((node) => ['REVIEW IN ITS CHAT', 'OPEN IN CHAT'].includes(node.textContent)).every((node) => node.disabled)));
    assert(`${scenario}: only first row can issue a delayed open`, calls('chat.open').length === 1 && calls('chat.open')[0].params.path === origin.path);
    await screenshot(`${pending}-two-rows-opening`);
    assert(`${scenario}: first response remains delayed`, Boolean(pendingOpen));
    pendingOpen();
    const draft = pending === 'plan'
      ? `Review this Helmraiser run's plan before the owner approves it: run ${runId}, plan at ${planPath}, task at ${taskPath}. Check the plan against the task and recommend approve or changes.`
      : `Review this Helmraiser run's diff against its task: run ${runId}, branch feature/review, base abc123. The task is in ${taskPath}.`;
    await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="Message"]')?.value === expected, {}, draft);
    assert(`${scenario}: first prompt stays paired after Helmraiser unmounts`, current.path === origin.path && calls('chat.open').length === 1 && calls('chat.new').length === 0 && calls('chat.setRoot').length === 0);
    await screenshot(`${pending}-two-rows-reopened-chat`);
  }

  for (const pending of ['merge', 'plan']) {
    await load(pending);
    scenario += '-failed-open';
    failOpen = true;
    await (await button('REVIEW IN ITS CHAT')).click();
    await page.waitForFunction(() => document.body.innerText.includes('fixture open failed'));
    assert(`${scenario}: failed open stays in Helmraiser and is retryable`, Boolean(await button('REVIEW IN ITS CHAT')) && await page.evaluate(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser')));
    await screenshot(`${pending}-failed-open`);
    await nav('Chat');
    await page.waitForSelector('textarea[aria-label="Message"]');
    assert(`${scenario}: failed open never composes into current chat`, await page.$eval('textarea[aria-label="Message"]', (node) => node.value) === 'owner untouched draft' && current === prior);

    await load(pending);
    scenario += '-deleted';
    exists = false;
    await (await button('REVIEW IN ITS CHAT')).click();
    await page.waitForFunction(() => !document.body.innerText.includes('REVIEW IN ITS CHAT') && !document.body.innerText.includes('OPENING ORIGIN…'));
    assert(`${scenario}: deletion never opens or creates a conversation`, calls('chat.open').length === 0 && calls('chat.new').length === 0);
    assert(`${scenario}: deletion retains previous fallback`, Boolean(await button('OPEN IN CHAT')) === (pending === 'merge'));
    await nav('Chat');
    await page.waitForSelector('textarea[aria-label="Message"]');
    assert(`${scenario}: deletion never replaces draft`, await page.$eval('textarea[aria-label="Message"]', (node) => node.value) === 'owner untouched draft');
  }
  assert('all review navigation is unsent and owner-only', requests.every((r) => !['chat.send', 'chat.new', 'chat.setRoot', 'helmraiser.approve', 'helmraiser.reject', 'helmraiser.queue', 'helmraiser.workerStart'].includes(r.method)));
  console.log(JSON.stringify({ assertions: Object.keys(assertions).length, screenshots: 'review-by-origin/*.png', unsent: true }));
} finally {
  try {
    await writeFile(`${out}/review-by-origin-browser.json`, `${JSON.stringify({ requests, events, observed, assertions }, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    vite.kill('SIGTERM');
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
}
