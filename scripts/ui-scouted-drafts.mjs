#!/usr/bin/env node
/** Rendered fake-transport evidence for Scouted draft decisions and FO origins. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/scouted-drafts';
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
const prior = {
  engine: 'pi', path: '/fixture/sessions/2026_current-chat.jsonl', id: 'current-chat', title: 'Owner conversation', cwd: project,
  created: new Date(0).toISOString(), modified: new Date(1).toISOString(),
};
const fresh = {
  engine: 'pi', path: '/fixture/sessions/2026_scouted-chat.jsonl', id: 'scouted-chat', title: 'Scouted discussion', cwd: project,
  created: new Date(2).toISOString(), modified: new Date(3).toISOString(),
};
let sessions = [prior];
const reviewFresh = { ...fresh, path: '/fixture/sessions/2026_review-chat.jsonl', id: 'review-chat', title: 'Fresh run review', cwd: '/fixture/worktree' };
const slots = new Map();
const makeSlot = (chatId, session, root) => ({
  chatId, kind: 'pi', createdAt: slots.size, lastUsedAt: 0, crew: chatId === 'main',
  crewPending: false, busy: false, attention: false, session, root, subagentsLeftRunning: 0,
});
slots.set('main', makeSlot('main', prior, project));
const slotFor = (session) => [...slots.values()].find((slot) => slot.session?.path === session.path);
const subscriptions = new Set();
const chunk = (subscription, event) => subscription.socket.send(JSON.stringify({ kind: 'stream', id: subscription.id, chunk: event }));
const publish = (slot) => {
  for (const subscription of subscriptions) {
    if (subscription.method === 'chat.slotsObserve') chunk(subscription, { kind: 'slot-state', slot });
    if (subscription.method === 'chat.observe' && subscription.chatId === slot.chatId)
      chunk(subscription, { kind: 'session-changed', origin: null, session: slot.session });
  }
};
let delayNext = null;
let pendingNavigation = null;
const navigationObservations = [];
const paths = {
  queue: `${project}/.helmraiser/tasks/cache-status.md`,
  failure: `${project}/.helmraiser/tasks/risky-migration.md`,
  drop: `${project}/.helmraiser/tasks/duplicate-probe.md`,
  discuss: `${project}/.helmraiser/tasks/refine-cockpit.md`,
};
let scouted = [
  {
    project, id: 'cache-status', task_id: 'funkyoctopus:cache-status', title: 'Cache repeated status reads',
    size: 'M', source: 'scout', age: 95, intake_status: 'ready', intake_error: null, proposal: null,
    preflight: { summary: 'All four preflight checks pass', error: null, steps: [] }, path: paths.queue,
    origin: { kind: 'fo', session: prior.path }, extra_future_field: 'ignored',
  },
  {
    project, id: 'risky-migration', task_id: 'funkyoctopus:risky-migration', title: 'Untangle risky migration',
    size: 'L', source: 'scout', age: 7_500, intake_status: 'blocked', intake_error: 'intake needs an owner decision',
    proposal: null, preflight: null, path: paths.failure,
  },
  {
    project, id: 'duplicate-probe', task_id: 'funkyoctopus:duplicate-probe', title: 'Remove duplicate health probe',
    size: 'S', source: 'scout', age: 172_800, intake_status: 'reviewed', intake_error: null, proposal: {},
    preflight: { summary: 'One preflight check failed', error: 'npm test exited 1', steps: [] }, path: paths.drop,
  },
  {
    project, id: 'refine-cockpit', task_id: 'funkyoctopus:refine-cockpit', title: 'Refine the Helmraiser cockpit',
    size: '?', source: 'scout', age: 12, intake_status: 'ready', intake_error: null, proposal: null,
    preflight: { summary: 'Needs owner framing', error: null, steps: [] }, path: paths.discuss,
  },
  {
    project, id: 'legacy-pathless', title: 'Older pathless draft', size: '?', source: 'scout', age: 2,
    intake_status: 'legacy', intake_error: null, proposal: null, preflight: null,
  },
];
const expectedDiscuss = `Help me refine this Helmraiser draft.\n\nProject: ${project}\nTitle: Refine the Helmraiser cockpit\nTask file: ${paths.discuss}\n\nRead the task file, help refine it, and queue it only when I am happy with it.`;
const generatedBody = '## Goal\n\nQueue from chat.\n\n## Change\n\nKeep origin provenance.';
const generatedReply = `\`\`\`helmraiser-task\ntitle: Generated from chat\n${generatedBody}\n\`\`\``;
const oldCompatibleStatus = {
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [],
  awaiting_count: 0, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'running' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  awaiting: [], failed: [], status_path: '/fixture/status.json',
};
const awaitingRun = {
  run_id: 'fixture-run', task: 'fixture:run', title: 'Review waiting cockpit plan', pending: 'plan',
  verdict: 'pass', cost_usd: 0.1, project, worktree: reviewFresh.cwd,
  origin: { kind: 'fo', session: prior.path },
};
const reviewTaskPath = '/fixture/runs/fixture-run/task.md';
const planPath = '/fixture/runs/fixture-run/plan.md';
const expectedReview = `Review this Helmraiser run's plan before the owner approves it: run ${awaitingRun.run_id}, plan at ${planPath}, task at ${reviewTaskPath}. Check the plan against the task and recommend approve or changes.`;
let status = oldCompatibleStatus;
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }], folders: [] },
  'models.list': [], 'chat.transcript': [],
  'chat.exists': { exists: true },
  'helmraiser.plan': { text: '# Plan\n\nRefine the cockpit.', path: planPath },
  'helmraiser.runReview': { taskPath: reviewTaskPath, summary: 'Verify passes', review: 'pass', diffStat: { files: [], filesChanged: 0, additions: 0, deletions: 0 }, diffTruncated: false },
};
let intakeNumber = 0;

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => {
    sockets.delete(socket);
    for (const subscription of subscriptions) if (subscription.socket === socket) subscriptions.delete(subscription);
  });
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind === 'cancel') {
      for (const subscription of subscriptions)
        if (subscription.socket === socket && subscription.id === request.id) subscriptions.delete(subscription);
      return;
    }
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    const respond = () => {
    if (['chat.observe', 'chat.slotsObserve', 'helmraiser.observe'].includes(request.method)) {
      const subscription = { socket, id: request.id, method: request.method, chatId: request.params?.chatId ?? 'main' };
      subscriptions.add(subscription);
      if (request.method === 'chat.slotsObserve') chunk(subscription, { kind: 'slots', slots: [...slots.values()] });
      return;
    }
    if (request.method === 'chat.send') {
      socket.send(JSON.stringify({ kind: 'stream', id: request.id, chunk: { kind: 'text', delta: generatedReply } }));
      socket.send(JSON.stringify({ kind: 'stream-end', id: request.id }));
      return;
    }
    if (request.method === 'helmraiser.queue' && request.params?.path === paths.failure) {
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: { message: 'fixture queue refused this draft' } }));
      return;
    }
    let result = Object.hasOwn(staticReplies, request.method) ? staticReplies[request.method] : null;
    if (request.method === 'helmraiser.status') result = status;
    if (request.method === 'helmraiser.drafts') result = scouted;
    const slot = slots.get(request.params?.chatId ?? 'main');
    if (request.method === 'chat.slots') result = [...slots.values()];
    if (request.method === 'chat.current') result = slot?.session ?? null;
    if (request.method === 'chat.list') result = sessions.filter((session) => !request.params?.root || session.cwd === request.params.root);
    if (request.method === 'chat.create') {
      const session = request.params.root === project ? fresh : reviewFresh;
      const created = makeSlot(`fixture-${slots.size}`, session, request.params.root);
      slots.set(created.chatId, created);
      sessions = [...sessions.filter((stored) => stored.path !== session.path), session];
      result = created;
      for (const subscription of subscriptions)
        if (subscription.method === 'chat.slotsObserve') chunk(subscription, { kind: 'slot-created', slot: created, origin: request.params.clientId ?? null });
      publish(created);
    }
    if (request.method === 'chat.setRoot') { slot.root = request.params.path; result = null; publish(slot); }
    if (request.method === 'chat.new') { slot.session = slot.root === project ? fresh : reviewFresh; result = slot.session; publish(slot); }
    if (request.method === 'chat.open') {
      const session = sessions.find((stored) => stored.path === request.params.path);
      const holder = session && slotFor(session);
      if (holder && holder.chatId !== slot.chatId) result = { heldBy: holder.chatId };
      else { slot.session = session; slot.root = session.cwd; result = { items: [] }; publish(slot); }
    }
    if (request.method === 'helmraiser.queue') {
      scouted = scouted.filter((draft) => draft.path !== request.params?.path);
      result = { task_id: `fixture:${intakeNumber}`, id: `queued-${intakeNumber}`, status: 'queued', path: request.params?.path, proposal: null, notes: [] };
    }
    if (request.method === 'helmraiser.dropDraft') {
      scouted = scouted.filter((draft) => (draft.task_id ?? draft.id) !== request.params?.taskId);
      result = { task_id: request.params?.taskId, status: 'dropped', reason: request.params?.reason, class: request.params?.class ?? null, dropped_at: new Date(4).toISOString() };
    }
    if (request.method === 'helmraiser.draft') {
      intakeNumber += 1;
      result = { task_id: `fixture:intake-${intakeNumber}`, id: `intake-${intakeNumber}`, status: 'draft', path: `${project}/.helmraiser/tasks/intake-${intakeNumber}.md` };
    }
    if (request.method === 'helmraiser.propose') {
      result = { task_id: `fixture:intake-${intakeNumber}`, id: `intake-${intakeNumber}`, status: 'draft', path: request.params?.path, proposal: {}, task: generatedBody, notes: [] };
    }
    socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
    };
    if (delayNext === request.method) {
      delayNext = null;
      pendingNavigation = () => { pendingNavigation = null; respond(); };
    } else respond();
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
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1500, height: 1400, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('funkyoctopus.preferences', JSON.stringify({
      chatModel: { provider: 'fixture-provider', id: 'fixture-model' }, activeProject: null,
    }));
  });
  const button = async (name) => (await page.$$(`xpath/.//button[normalize-space(.)="${name}"]`))[0];
  const rowButton = async (title, name) => (await page.$$(`xpath/.//article[contains(@aria-label,"${title}")]//button[normalize-space(.)="${name}"]`))[0];
  const openHelmraiser = async () => {
    const nav = await page.$$(`xpath/.//button[contains(., "Helmraiser")]`);
    await nav[0].click();
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser'));
  };

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await openHelmraiser();
  await page.waitForFunction(() => document.body.innerText.includes('SCOUTED (5)'));
  const populated = await page.evaluate(() => document.body.innerText);
  assert('metadata and errors render', ['Cache repeated status reads', 'M', '1m ago', 'All four preflight checks pass', 'intake needs an owner decision', 'npm test exited 1'].every((text) => populated.includes(text)));
  const pathlessQueue = await rowButton('Older pathless', 'QUEUE');
  const pathlessDiscuss = await rowButton('Older pathless', 'DISCUSS');
  assert('older pathless draft stays visible with path actions disabled', populated.includes('Older pathless draft') && await pathlessQueue.evaluate((node) => node.disabled) && await pathlessDiscuss.evaluate((node) => node.disabled));
  await page.screenshot({ path: `${out}/scouted-populated.png` });

  const queueCallsBefore = requests.filter((request) => request.method === 'helmraiser.queue').length;
  await (await rowButton('Cache repeated', 'QUEUE')).click();
  assert('Queue waits for confirmation', requests.filter((request) => request.method === 'helmraiser.queue').length === queueCallsBefore);
  await (await rowButton('Cache repeated', 'CANCEL')).click();
  assert('Queue cancellation has no mutation', requests.filter((request) => request.method === 'helmraiser.queue').length === queueCallsBefore);
  await (await rowButton('Cache repeated', 'QUEUE')).click();
  await page.screenshot({ path: `${out}/scouted-confirmations.png` });
  const draftReadsBeforeQueue = requests.filter((request) => request.method === 'helmraiser.drafts').length;
  await (await rowButton('Cache repeated', 'CONFIRM QUEUE')).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Cache repeated status reads'));
  const scoutedQueue = requests.find((request) => request.method === 'helmraiser.queue' && request.params?.path === paths.queue);
  assert('confirmed Queue sends current FO origin', scoutedQueue?.params?.origin === `fo:${prior.path}`);
  assert('successful Queue removes its row', !scouted.some((draft) => draft.path === paths.queue));
  for (let attempt = 0; attempt < 50 && requests.filter((request) => request.method === 'helmraiser.drafts').length <= draftReadsBeforeQueue; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert('panel refresh reloads Scouted drafts', requests.filter((request) => request.method === 'helmraiser.drafts').length > draftReadsBeforeQueue);

  await (await rowButton('Untangle risky', 'QUEUE')).click();
  await (await rowButton('Untangle risky', 'CONFIRM QUEUE')).click();
  await page.waitForFunction(() => document.body.innerText.includes('fixture queue refused this draft'));
  assert('queue failure retains row and local error', (await page.evaluate(() => document.body.innerText)).includes('Untangle risky migration'));

  await (await rowButton('Remove duplicate', 'DROP')).click();
  const dropConfirm = await rowButton('Remove duplicate', 'CONFIRM DROP');
  assert('Drop asks "Why drop it?" with the four classes, none chosen', await page.$eval('article[aria-label*="Remove duplicate"]', (node) => {
    const group = node.querySelector('[role="radiogroup"]');
    const radios = [...(group?.querySelectorAll('input[type="radio"]') ?? [])];
    return group?.querySelector('legend')?.textContent === 'Why drop it?'
      && radios.map((radio) => radio.value).join() === 'wrong,unwanted,duplicate,unusable'
      && radios.every((radio) => !radio.checked);
  }));
  assert('blank Drop reason and no class cannot submit', await dropConfirm.evaluate((node) => node.disabled));
  const dropInput = await page.$('article[aria-label*="Remove duplicate"] input:not([type="radio"])');
  await dropInput.type('  duplicate scout finding  ');
  assert('a reason without a class cannot submit', await dropConfirm.evaluate((node) => node.disabled));
  await (await page.$('article[aria-label*="Remove duplicate"] input[type="radio"][value="duplicate"]')).click();
  assert('a class and a nonblank Drop reason enable submit', !(await dropConfirm.evaluate((node) => node.disabled)));
  await page.screenshot({ path: `${out}/scouted-drop-reason.png` });
  await (await rowButton('Remove duplicate', 'CONFIRM DROP')).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Remove duplicate health probe'));
  const dropRequest = requests.find((request) => request.method === 'helmraiser.dropDraft' && request.params?.taskId === 'funkyoctopus:duplicate-probe');
  assert('Drop sends task id, exact trimmed reason and the chosen class', JSON.stringify(dropRequest?.params) === JSON.stringify({ taskId: 'funkyoctopus:duplicate-probe', reason: 'duplicate scout finding', class: 'duplicate' }));

  // Add an origin-capable awaiting row only for lock evidence; the original
  // status fixture above still proves compatibility with missing optional fields.
  status = { ...oldCompatibleStatus, awaiting: [awaitingRun], awaiting_count: 1,
    queue: { ...oldCompatibleStatus.queue, awaiting_approval: 1 } };
  await (await page.$$(`xpath/.//button[contains(., "Chat")]`))[0].click();
  await openHelmraiser();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'REVIEW IN ITS CHAT'));
  const navigationCalls = () => requests.filter((request) => ['chat.create', 'chat.setRoot', 'chat.new', 'chat.open', 'chat.close'].includes(request.method));
  const waitForDelayedNavigation = async () => {
    for (let attempt = 0; !pendingNavigation && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert('navigation response is explicitly delayed', Boolean(pendingNavigation));
  };
  const competingControlsDisabled = async () => page.evaluate(() => {
    const names = ['DISCUSS', 'REVIEW IN ITS CHAT', 'OPEN IN CHAT'];
    const controls = [...document.querySelectorAll('button')].filter((node) => names.includes(node.textContent?.trim()));
    return controls.length >= 4 && controls.every((node) => node.disabled);
  });
  const attemptCompetingClicks = async () => {
    await (await rowButton('Untangle risky', 'DISCUSS')).click();
    await (await rowButton('Refine the Helmraiser', 'DISCUSS')).click();
    if (await button('REVIEW IN ITS CHAT')) await (await button('REVIEW IN ITS CHAT')).click();
    if (await button('OPEN IN CHAT')) await (await button('OPEN IN CHAT')).click();
  };
  const selectedPair = async (session, prompt) => {
    await page.waitForFunction((title) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes(title), {}, session.title);
    const selectedTab = await page.$eval('[role="tab"][aria-selected="true"]', (node) => node.textContent);
    const slot = slotFor(session);
    assert(`${session.title} selected tab/session/cwd/prompt pairing`, Boolean(slot) && slot.root === session.cwd && slot.session.id === session.id && await page.$eval('textarea[aria-label="Message"]', (node) => node.value) === prompt);
    return { chatId: slot.chatId, selectedTab, session: slot.session.path, cwd: slot.root, prompt };
  };
  const selectTab = async (session) => {
    const tab = (await page.$$(`xpath/.//*[@role="tab"][contains(., "${session.title}")]`))[0];
    await tab.click();
  };
  for (const action of ['fresh', 'origin']) {
    const before = navigationCalls().length;
    await page.waitForFunction((name) => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === name && !node.disabled), {}, action === 'origin' ? 'REVIEW IN ITS CHAT' : 'OPEN IN CHAT');
    const slotsBefore = slots.size;
    const requestStart = requests.length;
    delayNext = action === 'origin' ? 'chat.exists' : 'chat.create';
    await (await button(action === 'origin' ? 'REVIEW IN ITS CHAT' : 'OPEN IN CHAT')).click();
    await waitForDelayedNavigation();
    assert(`${action} review disables all competing discussion/review controls`, await competingControlsDisabled());
    await attemptCompetingClicks();
    assert(`${action} review rejects clicks without competing navigation`, navigationCalls().length === before + (action === 'origin' ? 0 : 1) && slots.size === slotsBefore);
    await page.screenshot({ path: `${out}/scouted-${action}-review-lock.png` });
    pendingNavigation();
    await page.waitForFunction((draft) => document.querySelector('textarea[aria-label="Message"]')?.value === draft, {}, expectedReview);
    const expectedSession = action === 'origin' ? prior : reviewFresh;
    assert(`${action} review keeps its exact unsent prompt paired with its session`, slotFor(expectedSession)?.session.path === expectedSession.path && requests.filter((request) => request.method === 'chat.send').length === 0);
    navigationObservations.push({ winner: `${action} review`, ...await selectedPair(expectedSession, expectedReview), navigation: navigationCalls().slice(before), requests: requests.slice(requestStart) });
    assert(`${action} review creates only the expected slot`, slots.size === slotsBefore + (action === 'origin' ? 0 : 1));
    if (action === 'origin') {
      await selectTab(reviewFresh);
      await selectedPair(reviewFresh, expectedReview);
      await selectTab(prior);
      await selectedPair(prior, expectedReview);
    }
    await openHelmraiser();
    await page.waitForFunction(() => document.body.innerText.includes('SCOUTED (3)'));
    assert(`${action} review did not queue a deferred competing switch`, navigationCalls().length === before + (action === 'origin' ? 0 : 1));
  }

  const beforeDiscussion = navigationCalls().length;
  const queueBeforeDiscussion = requests.filter((request) => request.method === 'helmraiser.queue').length;
  delayNext = 'chat.create';
  await (await rowButton('Refine the Helmraiser', 'DISCUSS')).click();
  await waitForDelayedNavigation();
  assert('discussion creation disables other drafts and both review actions', await competingControlsDisabled());
  await attemptCompetingClicks();
  assert('discussion creation rejects competing navigation', navigationCalls().length === beforeDiscussion + 1);
  await page.screenshot({ path: `${out}/scouted-discussion-create-lock.png` });
  await attemptCompetingClicks();
  assert('discussion create remains locked on repeated competing clicks', navigationCalls().length === beforeDiscussion + 1);
  await page.screenshot({ path: `${out}/scouted-discussion-create-still-locked.png` });
  pendingNavigation();
  await page.waitForFunction((draft) => document.querySelector('textarea[aria-label="Message"]')?.value === draft, {}, expectedDiscuss);
  const discussionCreate = navigationCalls().slice(beforeDiscussion);
  assert('Discuss creates one pi tab at the project root', discussionCreate.length === 1 && discussionCreate[0].method === 'chat.create' && discussionCreate[0].params.kind === 'pi' && discussionCreate[0].params.root === project);
  assert('discussion preserves both existing slot sessions', slots.get('main').session === prior && slotFor(reviewFresh)?.session === reviewFresh);
  assert('Discuss preserves the prior conversation and creates a distinct session', slotFor(fresh)?.session.path === fresh.path && fresh.path !== prior.path && sessions.some((session) => session.path === prior.path));
  const chatSendsAfterDiscuss = requests.filter((request) => request.method === 'chat.send').length;
  assert('Discuss fills exact prompt without send or queue', await page.$eval('textarea[aria-label="Message"]', (node) => node.value) === expectedDiscuss && chatSendsAfterDiscuss === 0);
  assert('winning discussion is project-rooted and invokes no workflow decision', slotFor(fresh)?.root === project && requests.filter((request) => request.method === 'helmraiser.queue').length === queueBeforeDiscussion && !requests.some((request) => ['helmraiser.approve', 'helmraiser.reject'].includes(request.method)));
  navigationObservations.push({ winner: 'discussion', ...await selectedPair(fresh, expectedDiscuss), navigation: navigationCalls().slice(beforeDiscussion) });
  await page.screenshot({ path: `${out}/scouted-discuss-composer.png` });
  await openHelmraiser();
  await page.waitForFunction(() => document.body.innerText.includes('SCOUTED (3)'));
  assert('discussion did not queue a deferred competing switch', navigationCalls().length === beforeDiscussion + 1 && slotFor(fresh)?.session.path === fresh.path);
  assert('explicit discussion succeeds after review releases', slotFor(fresh)?.session.path === fresh.path);
  // Return to the old-status fixture for the unchanged decision/origin flows.
  status = oldCompatibleStatus;

  const decisions = [['Untangle risky', 'risk is too broad', 'unwanted'], ['Refine the Helmraiser', 'discussed elsewhere', 'duplicate'], ['Older pathless', 'legacy row cleanup', 'unusable']];
  for (const [title, reason, dropClass] of decisions) {
    await (await rowButton(title, 'DROP')).click();
    await (await page.$(`article[aria-label*="${title}"] input:not([type="radio"])`)).type(reason);
    await (await page.$(`article[aria-label*="${title}"] input[type="radio"][value="${dropClass}"]`)).click();
    await (await rowButton(title, 'CONFIRM DROP')).click();
    await page.waitForFunction((needle) => !document.body.innerText.includes(needle), {}, title);
  }
  assert('each decision Drop carried its chosen class', decisions.every(([title, reason, dropClass]) =>
    requests.some((request) => request.method === 'helmraiser.dropDraft' && request.params?.reason === reason && request.params?.class === dropClass)));
  await page.waitForFunction(() => document.body.innerText.includes('No drafts — run a scout'));
  assert('successful decisions reach exact empty state', (await page.evaluate(() => document.body.innerText)).includes('No drafts — run a scout'));
  await page.screenshot({ path: `${out}/scouted-empty.png` });

  // Existing manual NEW TASK queueing uses the same authoritative chat.current origin.
  await (await button('NEW TASK')).click();
  await page.type('input', 'Manual origin task');
  await page.type('textarea', 'Prove manual queue provenance.');
  await (await button('PROPOSE')).click();
  // The QUEUE button itself: the page text already says QUEUE in "UNQUEUED DRAFTS", so a text wait would not wait for the proposal.
  await page.waitForSelector('xpath/.//button[normalize-space(.)="QUEUE"]');
  await (await button('QUEUE')).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'NEW TASK' && !node.disabled));

  // FROM CHAT also converges on queueDraft and therefore carries the same origin.
  await (await button('NEW TASK')).click();
  await (await button('FROM CHAT')).click();
  await page.waitForFunction(() => document.querySelector('input')?.value === 'Generated from chat');
  await (await button('PROPOSE')).click();
  await page.waitForFunction(() => Boolean([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'QUEUE')));
  await (await button('QUEUE')).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'NEW TASK' && !node.disabled));

  const originPaths = [`${project}/.helmraiser/tasks/intake-1.md`, `${project}/.helmraiser/tasks/intake-2.md`];
  let queueRequests = requests.filter((request) => request.method === 'helmraiser.queue');
  assert('NEW TASK and FROM CHAT queues carry current FO origin', originPaths.every((path) => queueRequests.some((request) => request.params?.path === path && request.params?.origin === `fo:${fresh.path}`)));

  const discussionSlot = slotFor(fresh);
  discussionSlot.session = null;
  publish(discussionSlot);
  await (await button('NEW TASK')).click();
  await page.type('input', 'No conversation origin');
  await page.type('textarea', 'Queue without provenance when no chat exists.');
  await (await button('PROPOSE')).click();
  await page.waitForFunction(() => Boolean([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'QUEUE')));
  await (await button('QUEUE')).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'NEW TASK' && !node.disabled));
  queueRequests = requests.filter((request) => request.method === 'helmraiser.queue');
  const noOrigin = queueRequests.find((request) => request.params?.path === `${project}/.helmraiser/tasks/intake-3.md`);
  assert('no current conversation omits queue origin', noOrigin !== undefined && !Object.hasOwn(noOrigin.params, 'origin'));

  const sends = requests.filter((request) => request.method === 'chat.send');
  assert('only intentional FROM CHAT generation sends, in discussion slot', sends.length === 1 && sends[0].params.chatId === discussionSlot.chatId);
  const report = {
    requests,
    observed: {
      navigationObservations,
      initialConversation: prior.path,
      discussedConversation: fresh.path,
      discussPrompt: expectedDiscuss,
      queueRequests,
      dropRequests: requests.filter((request) => request.method === 'helmraiser.dropDraft'),
      chatSendRequestsAfterDiscuss: chatSendsAfterDiscuss,
      chatSendRequestsTotal: requests.filter((request) => request.method === 'chat.send').length,
      oldStatusKeys: Object.keys(oldCompatibleStatus),
    },
    assertions,
  };
  await writeFile(`${out}/scouted-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  await writeFile(`${out}/failure.json`, JSON.stringify({ requests, assertions, body: await page.evaluate(() => document.body.innerText) }, null, 2));
  throw error;
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
