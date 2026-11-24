#!/usr/bin/env node
/** Rendered, fake-transport-only evidence for FROM CHAT → Helmraiser intake. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/chat-to-helmraiser';
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
const taskPath = `${project}/.helmraiser/tasks/generated-from-chat.md`;
const generatedBody = '## Goal\n\nTurn the current conversation into a governed task.\n\n## Change\n\nAdd the focused implementation described in chat.';
const generatedReply = `\`\`\`helmraiser-task\ntitle: Generated from the current chat\n${generatedBody}\n\`\`\``;
const session = {
  path: '/fixture/chat.jsonl', id: 'fixture-chat', title: 'Chat to Helmraiser fixture', cwd: project,
  created: new Date(0).toISOString(), modified: new Date(0).toISOString(),
};
const status = {
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [],
  awaiting_count: 0, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'stopped' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  awaiting: [], failed: [], landed: [], status_path: '/fixture/status.json',
};
const proposal = {
  task_id: 'fixture:generated', id: 'generated-from-chat', status: 'draft', path: taskPath,
  proposal: { verify: [] },
  notes: ['Attention: proposed verification inspects source structure; confirm it tests behaviour.'],
  task: `---\ntitle: Generated from the current chat\n---\n\n${generatedBody}`,
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
    globalRoot: '/fixture',
    known: [{ id: project, name: 'funkyoctopus', path: project, envTier: 'normal' }],
    folders: [],
  },
  'models.list': [{ provider: 'fixture-provider', id: 'fixture-model', name: 'Fixture model', input: ['text'], thinkingLevels: ['high'] }],
  'chat.list': [session],
  'chat.current': session,
  'chat.transcript': [],
  'helmraiser.status': status,
  'helmraiser.drafts': [],
  'helmraiser.draft': { task_id: 'fixture:generated', id: 'generated-from-chat', status: 'draft', path: taskPath },
  'helmraiser.propose': proposal,
  'helmraiser.queue': { ...proposal, status: 'queued' },
};

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.kind !== 'request') return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === 'chat.observe' || request.method === 'helmraiser.observe') return;
    if (request.method === 'chat.send') {
      socket.send(JSON.stringify({ kind: 'stream', id: request.id, chunk: { kind: 'text', delta: generatedReply } }));
      socket.send(JSON.stringify({ kind: 'stream-end', id: request.id }));
      return;
    }
    const result = Object.hasOwn(replies, request.method) ? replies[request.method] : null;
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
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('funkyoctopus.preferences', JSON.stringify({
      chatModel: { provider: 'fixture-provider', id: 'fixture-model' }, chatEffort: 'high',
      activeProject: null,
    }));
  });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  const helmraiserNav = await page.$$('xpath/.//button[contains(., "Helmraiser")]');
  await helmraiserNav[0].click();
  await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.textContent?.includes('Helmraiser'));
  const newTask = await page.$$('xpath/.//button[normalize-space(.)="NEW TASK"]');
  await newTask[0].click();
  await page.waitForSelector('textarea');

  const callsBeforeDraft = requests.filter((row) => row.method.startsWith('helmraiser.') && !['helmraiser.status', 'helmraiser.observe', 'helmraiser.drafts'].includes(row.method));
  const fromChat = await page.$$('xpath/.//button[normalize-space(.)="FROM CHAT"]');
  await fromChat[0].click();
  await page.waitForFunction(() => document.querySelector('input')?.value === 'Generated from the current chat');
  const fieldValues = await page.evaluate(() => ({
    project: document.querySelector('select')?.value,
    title: document.querySelector('input')?.value,
    goal: document.querySelector('textarea')?.value,
  }));
  const chatRequests = requests.filter((row) => row.method === 'chat.send');
  const callsAfterDraft = requests.filter((row) => row.method.startsWith('helmraiser.') && !['helmraiser.status', 'helmraiser.observe', 'helmraiser.drafts'].includes(row.method));
  assert('one drafting turn', chatRequests.length === 1);
  assert('selected model used', chatRequests[0]?.params?.provider === 'fixture-provider' && chatRequests[0]?.params?.model === 'fixture-model');
  assert('fixed instruction visible', String(chatRequests[0]?.params?.text).startsWith('Draft a Helmraiser task from this conversation.'));
  assert('known chat project selected', fieldValues.project === project);
  assert('generated fields prefilled', fieldValues.title === 'Generated from the current chat' && fieldValues.goal === generatedBody);
  assert('drafting does not invoke workflow', callsBeforeDraft.length === 0 && callsAfterDraft.length === 0);
  await page.screenshot({ path: `${out}/chat-to-task-prefilled.png` });

  const contrast = await page.$eval('label.text-muted', (el) => {
    const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (parts) => parts.map((part) => {
      const value = part / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const fg = luminance(rgb(getComputedStyle(el).color));
    const bg = luminance(rgb(getComputedStyle(document.body).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  assert('secondary text contrast is AA', contrast >= 4.5);

  const propose = await page.$$('xpath/.//button[normalize-space(.)="PROPOSE"]');
  await propose[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('Attention: proposed verification'));
  const order = await page.evaluate(() => {
    const note = [...document.querySelectorAll('p')].find((el) => el.textContent?.includes('Attention: proposed verification'));
    const preview = document.querySelector('pre');
    return note && preview ? Boolean(note.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  });
  assert('intake note precedes task preview', order);
  assert('queue remains explicit', Boolean((await page.$$('xpath/.//button[normalize-space(.)="QUEUE"]'))[0]));
  assert('discard remains explicit', Boolean((await page.$$('xpath/.//button[normalize-space(.)="DISCARD"]'))[0]));
  assert('nothing queued automatically', !requests.some((row) => row.method === 'helmraiser.queue'));
  await page.screenshot({ path: `${out}/chat-to-task-proposal.png` });

  const report = {
    requests,
    selectedModel: chatRequests[0] ? { provider: chatRequests[0].params.provider, model: chatRequests[0].params.model } : null,
    completedReply: generatedReply,
    fieldValues,
    ownerWorkflowCalls: requests.filter((row) => ['helmraiser.draft', 'helmraiser.propose', 'helmraiser.queue'].includes(row.method)),
    secondaryTextContrast: contrast,
    assertions,
  };
  await writeFile(`${out}/chat-to-task-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => wss.close(resolve));
}
