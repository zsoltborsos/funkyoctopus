#!/usr/bin/env node
/** Scout grid evidence (project x lens cells, request, cancel, progress): actual UI, fake transport only. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : [],
));
const out = args.out ?? 'tmp/scout-button';
await mkdir(out, { recursive: true });
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});
const A = '/fixture/alpha';
const B = '/fixture/repo two';
const paused = '/fixture/paused';
const emptyScouts = () => ({ focus_projects: [A, B, paused], paused_projects: [paused], pending: [], running: [], recent: [] });
let scouts = emptyScouts();
const lenses = ['state', 'docs', 'tests', 'guardrails'];
/** One `helmraiser stats --json` scouts row: a never-scouted focus lens unless overridden (shape of the real ledger). */
const statsRow = (project, lens, overrides = {}) => ({
  project, lens, in_focus: true, auto: false, cooldown_hours: 24,
  scouts: 0, succeeded: 0, failed: 0, running: 0, drafts_written: 0, cost_usd: 0,
  pending: 0, queued: 0, landed: 0, dropped: 0, dropped_by_class: { wrong: 0, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 0 },
  failed_drafts: 0, queued_unchanged: 0, queued_changed: 0, queued_unknown: 0,
  last_scout_ended_at: null, last_scout_ok: null, last_scout_error: null, last_scout_drafts: null,
  next_eligible_at: null, scheduling_error: null, ...overrides,
});
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
// Projects the stats list as focus rows, and per-(project, lens) overrides; scenarios below change both.
let statsProjects = [A, B, paused];
let statsOverrides = {
  [`${A}::state`]: { last_scout_ended_at: minutesAgo(35), last_scout_ok: true, last_scout_drafts: 2, next_eligible_at: new Date(Date.now() + 5 * 3_600_000).toISOString(), landed: 2, dropped: 1, dropped_by_class: { wrong: 0, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 1 } },
  [`${A}::guardrails`]: { last_scout_ended_at: minutesAgo(90), last_scout_ok: false, last_scout_error: 'candidate verify_hints must contain non-empty strings', last_scout_drafts: 0, auto: true },
};
const stats = () => ({
  window: { since: 'all', since_seconds: null, generated_at: new Date().toISOString(), project: null },
  runs: { overall: { landed: 0, failed: 0, aborted: 0, awaiting_approval: 0, active: 0 }, by_project: [] },
  quality: { first_time_right: { count: 0, rate: null }, rework_rate: null, scope_request_rate: null, retried_tasks: 0, review_verdicts: { pass: 0, concerns: 0, uncertain: 0, none: 0 } },
  failures: {},
  cost: { total_usd: 0, plan_usd: 0, implement_usd: 0, other_usd: 0, per_landed_usd: null },
  latency: { active_minutes: { median: null, p90: null }, approval_wait_minutes: { plan: { median: null, p90: null }, scope: { median: null, p90: null }, merge: { median: null, p90: null } } },
  // A non-focus project comes first, as in the real ledger: it must not become a row.
  scouts: [...lenses.map((lens) => statsRow('/fixture/other-project', lens, { in_focus: false })),
    ...statsProjects.flatMap((project) => lenses.map((lens) => statsRow(project, lens, statsOverrides[`${project}::${lens}`] ?? {})))],
  weekly: [],
});
const settings = { lenses: Object.fromEntries(lenses.map((lens) => [lens, { auto: false, cooldown_hours: 24, source: { auto: 'ledger', cooldown_hours: 'config' } }])) };
let settingsRefusal = false;
let statusLenses = false;
let manualDrafts = ['queue', 'drop', 'boundary'].map((id) => ({ project: A, id, task_id: `alpha:${id}`, title: `Manual ${id}`, kind: 'manual', size: 'S', age: id === 'boundary' ? 600 : 601, intake_status: 'draft', path: `${A}/.helmraiser/tasks/${id}.md` }));
let requestMode = 'mixed';
let cancelMode = 'refusal';
const status = () => ({
  updated_at: new Date(0).toISOString(), queued_count: 0, queue_next: [], running: [],
  awaiting_count: 0, failed_24h_count: 0, spend: {}, usage: {}, caps_enforced: false,
  paused: null, held_providers: {}, worker: { state: 'stopped' },
  queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
  awaiting: [], failed: [], status_path: '/fixture/status.json',
  ...(scouts ? { scouts: { ...scouts, ...(statusLenses ? { lenses: settings.lenses } : {}) } } : {}),
});
const staticReplies = {
  'system.health': { ok: true, service: 'funkyoctopus-sidecar', version: 'fixture', uptimeMs: 1000, backends: { pi: 'up', helmraiser: 'up' } },
  'system.upkeep': { disabled: true, status: 'idle', lastRunAt: null, lastResult: null, globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown', embedded: { installedVersion: null, latestVersion: null, verifiedVersion: null, verificationLevel: 'unknown', status: 'unknown', lastCheckAt: null, lastPromotionAttemptAt: null, lastPromotionResult: null, lastRecoveryAttemptAt: null, lastRecoveryResult: null } },
  'projects.discover': { globalRoot: '/fixture', known: [{ id: A, name: 'alpha', path: A, envTier: 'normal' }], folders: [] },
  'models.list': [], 'chat.transcript': [], 'chat.current': null, 'chat.list': [], 'chat.setRoot': [],
  'helmraiser.drafts': [undefined, 'state', 'docs', 'tests'].map((lens, index) => ({
    project: A, id: `lens-${index}`, task_id: `alpha:lens-${index}`, title: `Lens draft ${index}`,
    lens, kind: 'scout', size: 'S', source: 'scout', age: 60, intake_status: 'ready', intake_error: null,
    proposal: null, preflight: null, path: `${A}/.helmraiser/tasks/lens-${index}.md`,
  })),
};
const requests = [];
const assertions = {};
const assert = (name, condition) => {
  assertions[name] = Boolean(condition);
  if (!condition) throw new Error(`browser assertion failed: ${name}`);
};
const scope = 'section[aria-label="Scout controls"]';
let wss;
let vite;
let browser;
const sockets = new Set();

async function openHelmraiser(page) {
  await page.waitForSelector('button');
  const nav = await page.$$('xpath/.//button[contains(., "Helmraiser")]');
  await nav[0].click();
  await page.waitForSelector(scope);
}

async function runEvidence(page, base) {
  const text = () => page.$eval(scope, (node) => node.innerText);
  const waitText = (needle) => page.waitForFunction((selector, value) =>
    document.querySelector(selector)?.innerText.includes(value), {}, scope, needle);
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
  const cellSelector = (path, lens = 'state') => `${scope} td[aria-label="${lens} cell for ${path}"]`;
  const scoutSelector = (path, lens = 'state') => `${scope} button[aria-label="Scout ${lens} for ${path}"]`;
  const cancelSelector = (path, lens = 'state') => `${scope} button[aria-label="Cancel ${lens} scout for ${path}"]`;
  // A click on a button that is still disabled (a request or cancel in flight) would do nothing, so wait for it.
  const clickEnabled = async (selector) => {
    await page.waitForFunction((target) => { const node = document.querySelector(target); return node && !node.disabled; }, {}, selector);
    await page.click(selector);
  };
  const clickScout = (path, lens = 'state') => clickEnabled(scoutSelector(path, lens));
  const clickCancel = (path, lens = 'state') => clickEnabled(cancelSelector(path, lens));
  const cellText = (path, lens = 'state') => page.$eval(cellSelector(path, lens), (node) => node.innerText.replace(/\s+/g, ' ').trim());
  const mutations = () => requests.filter((r) => ['helmraiser.requestScouts', 'helmraiser.cancelScouts'].includes(r.method)).length;
  const load = async () => {
    const mutationsBefore = mutations();
    await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    await openHelmraiser(page);
    if (!scouts) await waitText('Update Helmraiser');
    else if (statsProjects.length === 0) await waitText('No focus projects available');
    else await page.waitForSelector(`${scope} table`);
    assert(`no automatic scout mutation on load ${Object.keys(assertions).length}`, mutationsBefore === mutations());
  };

  await load();
  await page.waitForSelector('article[aria-label="Scouted draft: Lens draft 3"]');
  for (const [index, lens] of ['state', 'state', 'docs', 'tests'].entries()) {
    assert(`draft ${index} shows lens and original project`, await page.$eval(`article[aria-label="Scouted draft: Lens draft ${index}"]`,
      (node, lens, project) => node.innerText.includes(lens) && node.innerText.includes(project), lens, A));
  }
  await shot('scouted-draft-lenses');
  assert('grid columns are the stats lenses in data order, guardrails included', await page.$$eval(`${scope} thead th`,
    (nodes) => nodes.slice(1).map((node) => node.textContent).join(',') === 'state,docs,tests,guardrails'));
  const grid = await page.$eval(scope, (node) => ({
    rows: [...node.querySelectorAll('tbody th[scope="row"]')].map((row) => ({ text: row.textContent.trim(), title: row.title })),
    cells: node.querySelectorAll('tbody td[aria-label]').length,
    scoutButtons: [...node.querySelectorAll('tbody button[aria-label^="Scout "]')].map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })),
    progress: Boolean(node.querySelector('section[aria-label="Scout progress"]')),
    checkboxes: node.querySelectorAll('fieldset input[aria-label^="Scout project"]').length,
    scrolls: node.querySelector('table')?.parentElement?.classList.contains('overflow-x-auto'),
    legend: node.innerText.includes('per lens: last scout · drafts it wrote; below: all-time drafts landed / queued / pending / dropped / failed'),
  }));
  assert('basenames visible with exact full-path hover, in focus order, non-focus project absent', JSON.stringify(grid.rows) === JSON.stringify([
    { text: 'alpha', title: A }, { text: 'repo two', title: B }, { text: 'paused', title: paused },
  ]));
  assert('every project x lens cell has an accessible name and a Scout button', grid.cells === 12 && grid.scoutButtons.length === 12
    && grid.scoutButtons.every((button) => button.label.startsWith('Scout ')));
  assert('paused project is shown with its Scout buttons disabled, the others enabled', grid.scoutButtons.every((button) =>
    button.disabled === button.label.endsWith(`for ${paused}`)));
  assert('no old picker or progress list, the grid scrolls sideways and has its legend', grid.checkboxes === 0 && !grid.progress && grid.scrolls && grid.legend);
  assert('cells show never scouted, a last scout with age, drafts and outcomes, and a failed scout in its cell', await (async () => {
    const [fresh, ok, failed] = [await cellText(B), await cellText(A), await cellText(A, 'guardrails')];
    return fresh.includes('never scouted') && !fresh.includes('ready')
      && /^35m ago · 2 drafts next in (4|5)h 2 landed 1 dropped Scout$/.test(ok)
      && failed.includes('1h ago') && failed.includes('candidate verify_hints must contain non-empty strings') && failed.includes('ready (auto)');
  })());
  assert('stats are read for the whole ledger', requests.some((r) => r.method === 'helmraiser.stats')
    && requests.filter((r) => r.method === 'helmraiser.stats').every((r) => r.params.since === 'all' && r.params.project === undefined));
  await shot('scout-grid');
  await clickScout(A);
  await waitText('already pending:');
  const requested = requests.filter((r) => r.method === 'helmraiser.requestScouts');
  assert('Scout sends exactly the one cell\'s full path once', requested.length === 1 && JSON.stringify(requested[0].params.projects) === JSON.stringify([A]));
  assert('the state cell requests state', requested[0].params.lens === 'state');
  assert('mixed requested and already pending results render', (await text()).includes('requested: alpha') && (await text()).includes('already pending: repo two'));
  await shot('scout-results');

  for (const [index, lens] of ['docs', 'tests', 'guardrails'].entries()) {
    await clickScout(A, lens);
    while (requests.filter((r) => r.method === 'helmraiser.requestScouts').length < index + 2) await new Promise((resolve) => setTimeout(resolve, 50));
    assert(`request sends ${lens}`, requests.filter((r) => r.method === 'helmraiser.requestScouts').at(-1).params.lens === lens);
    assert(`request for ${lens} sends only that cell's project`, JSON.stringify(requests.filter((r) => r.method === 'helmraiser.requestScouts').at(-1).params.projects) === JSON.stringify([A]));
  }

  requestMode = 'refusal';
  await load();
  await clickScout(A);
  await waitText('project is paused: /fixture/alpha');
  assert('request refusal inline in its cell with retry available', await page.$eval(cellSelector(A), (node) =>
    node.querySelector('[role="alert"]').textContent.includes('project is paused') && !node.querySelector('button').disabled));
  assert('refusal is only in the cell that was asked', await page.$$eval(`${scope} [role="alert"]`, (nodes) => nodes.length === 1));
  await shot('scout-refusal');

  statsProjects = [];
  scouts = { ...emptyScouts(), focus_projects: [] };
  await load();
  assert('no focus projects hides the grid and its Scout buttons', await page.$eval(scope, (node) => node.innerText.includes('No focus projects available')
    && !node.querySelector('table') && !node.querySelector('button[aria-label^="Scout "]') && !node.querySelector('section[aria-label="Scout progress"]')));
  await shot('scout-empty');

  const statsReadsBefore = requests.filter((r) => r.method === 'helmraiser.stats').length;
  scouts = undefined;
  await load();
  assert('older Helmraiser has the update hint, no grid, no Scout buttons and reads no stats', await page.$eval(scope, (node) =>
    node.innerText.includes('Update Helmraiser to enable scouting') && !node.querySelector('table') && !node.querySelector('button[aria-label^="Scout "]'))
    && requests.filter((r) => r.method === 'helmraiser.stats').length === statsReadsBefore);
  await shot('scout-compatibility');

  const reasons = ['queue paused', 'project busy', 'draft cap', 'no headroom', 'slots busy', null];
  const pendingPaths = reasons.map((_, index) => `/fixture/pending-${index}`);
  // Finished scouts now come from the stats, so these projects carry their last scout there.
  const recentFixtures = [
    { project: '/fixture/zero', lens: 'state', ok: true, drafts: 0 },
    { project: '/fixture/one', lens: 'tests', ok: true, drafts: 1 },
    { project: '/fixture/several', lens: 'state', ok: true, drafts: 3 },
    { project: '/fixture/failed', lens: 'state', ok: false, drafts: 0, error: 'fixture scout error' },
  ];
  statsProjects = [A, B, ...pendingPaths, ...recentFixtures.map((fixture) => fixture.project)];
  statsOverrides = Object.fromEntries(recentFixtures.map((fixture) => [`${fixture.project}::${fixture.lens}`, {
    last_scout_ended_at: minutesAgo(5), last_scout_ok: fixture.ok, last_scout_drafts: fixture.drafts, last_scout_error: fixture.error ?? null,
  }]));
  scouts = { ...emptyScouts(), focus_projects: statsProjects, paused_projects: [],
    pending: [...reasons.map((wait_reason, index) => ({ project: pendingPaths[index], requested_at: new Date().toISOString(), wait_reason })),
      { project: pendingPaths[0], lens: 'docs', requested_at: new Date().toISOString(), wait_reason: null }],
    running: [A, B].map((project, index) => ({
      project, lens: index === 0 ? 'docs' : 'tests', scout_id: `running-${index}`, started_at: new Date(Date.now() - 125_000).toISOString(),
    })),
    recent: recentFixtures.map((fixture, index) => ({ project: fixture.project, scout_id: `recent-${index}`, ok: fixture.ok, drafts: fixture.drafts,
      error: fixture.error ?? null, ended_at: new Date().toISOString(), report: null })),
  };
  await load();
  const progress = await text();
  assert('all pending wait reasons are plain words', reasons.slice(0, -1).every((reason) => progress.includes(`waiting: ${reason}`)) && progress.includes('pending-5') && progress.includes('state'));
  assert('running elapsed renders in its own cells', /^running · elapsed 2m \d+s$/.test(await cellText(A, 'docs')) && /^running · elapsed 2m \d+s$/.test(await cellText(B, 'tests')));
  assert('finished scouts show zero/singular/plural drafts and their error in their cells', await (async () => {
    const [zero, one, several, failed] = await Promise.all([cellText('/fixture/zero'), cellText('/fixture/one', 'tests'), cellText('/fixture/several'), cellText('/fixture/failed')]);
    return zero.startsWith('5m ago · 0 drafts') && one.startsWith('5m ago · 1 draft ') && several.startsWith('5m ago · 3 drafts') && failed.startsWith('5m ago fixture scout error');
  })());
  assert('only waiting cells have Cancel, running cells have no button, and nothing is selected', await page.$$eval(`${scope} button[aria-label^="Cancel "]`, (nodes) => nodes.length === 7)
    && await page.$$eval(`${scope} td[aria-label$="for ${A}"]`, (nodes) => nodes.find((node) => node.getAttribute('aria-label').startsWith('docs'))?.querySelector('button') === null));
  assert('same project pending lenses have distinct readable cells', await page.$eval(scope, (node, path) =>
    ['state', 'docs'].every((lens) => {
      const cell = node.querySelector(`td[aria-label="${lens} cell for ${path}"]`);
      return cell?.innerText.includes('waiting') && cell.querySelector(`button[aria-label="Cancel ${lens} scout for ${path}"]`);
    }), pendingPaths[0]));
  assert('running and pending project rows keep basename with full-path hover', await page.$eval(scope, (node, [path, name]) =>
    [...node.querySelectorAll('tbody th[scope="row"]')].some((row) => row.title === path && row.textContent.trim() === name), [A, 'alpha']));
  await shot('scout-progress');
  await clickCancel(pendingPaths[0], 'docs');
  await waitText('fixture cancellation refused');
  assert('cancellation refusal stays in the affected pending cell', await page.$eval(cellSelector(pendingPaths[0], 'docs'), (node) => node.querySelector('[role="alert"]').textContent.includes('fixture cancellation refused')));
  assert('sibling lens does not inherit cancellation refusal', await page.$eval(cellSelector(pendingPaths[0]),
    (node) => !node.querySelector('[role="alert"]')));
  await shot('scout-cancel-refusal');
  cancelMode = 'cancelled';
  await clickCancel(pendingPaths[0], 'docs');
  await waitText('cancelled: pending-0');
  await page.waitForFunction((selector) => !document.querySelector(selector), {}, cancelSelector(pendingPaths[0], 'docs'));
  assert('cancellation sends only the chosen pending path and lens', requests.filter((r) => r.method === 'helmraiser.cancelScouts').every((r) => JSON.stringify(r.params.projects) === JSON.stringify([pendingPaths[0]]) && r.params.lens === 'docs'));
  assert('successful cancellation refresh frees its cell but retains feedback', (await text()).includes('cancelled: pending-0') && scouts.pending.some((row) => row.project === pendingPaths[0] && !row.lens) && !scouts.pending.some((row) => row.project === pendingPaths[0] && row.lens === 'docs')
    && await page.$eval(cellSelector(pendingPaths[0], 'docs'), (node) => !node.querySelector('[role="alert"]') && Boolean(node.querySelector('button[aria-label^="Scout "]'))));
  assert('state sibling survives docs cancellation', await page.$eval(cellSelector(pendingPaths[0]),
    (node) => !node.querySelector('[role="alert"]') && Boolean(node.querySelector('button[aria-label^="Cancel "]'))));
  cancelMode = 'not_pending';
  await clickCancel(pendingPaths[1]);
  await waitText('not pending: pending-1');
  await page.waitForFunction((selector) => !document.querySelector(selector), {}, cancelSelector(pendingPaths[1]));
  const cancelRequests = requests.filter((r) => r.method === 'helmraiser.cancelScouts');
  assert('not-pending response is inline and exact cancellation path recorded', JSON.stringify(cancelRequests.at(-1).params.projects) === JSON.stringify([pendingPaths[1]]) && (await text()).includes('not pending: pending-1'));
  await shot('scout-cancel-results');
  assert('Scout section does not horizontally clip', await page.$eval(scope, (node) => node.scrollWidth <= node.clientWidth));
  await settingsEvidence(page, shot, waitText);
  const allowed = new Set(['helmraiser.allDrafts', 'helmraiser.scoutSettings', 'helmraiser.setScoutSettings', 'helmraiser.resetScoutSettings', 'helmraiser.queue', 'helmraiser.dropDraft', 'helmraiser.status', 'helmraiser.stats', 'helmraiser.report', 'helmraiser.drafts', 'helmraiser.observe', 'helmraiser.requestScouts', 'helmraiser.cancelScouts']);
  assert('only observation and deliberate scout actions reached Helmraiser', requests.filter((r) => r.method.startsWith('helmraiser.')).every((r) => allowed.has(r.method)));
  assert('no chat.send or model turn', !requests.some((r) => r.method === 'chat.send'));
}

async function settingsEvidence(page, shot, waitText) {
  const automation = 'section[aria-label="Scout automation settings"]';
  assert('fallback settings read exercised', requests.some((r) => r.method === 'helmraiser.scoutSettings'));
  statusLenses = true;
  await page.reload({ waitUntil: 'networkidle2' });
  await openHelmraiser(page);
  await page.waitForSelector(`${automation} input`);
  assert('status lenses avoid fallback reads after reload', requests.slice(requests.findLastIndex((r) => r.method === 'chat.slotsObserve')).every((r) => r.method !== 'helmraiser.scoutSettings'));
  const row = `${automation} fieldset:first-of-type`;
  const idle = () => page.waitForFunction((s) => !document.querySelector(`${s} fieldset`).disabled, {}, automation);
  assert('sources and note rendered', await page.$eval(automation, (node) => ['ledger', 'config', 'queue pause stops all scouting'].every((text) => node.innerText.includes(text))));
  assert('no automatic settings writes', !requests.some((r) => r.method === 'helmraiser.setScoutSettings'));
  await shot('scout-settings');
  await page.click(`${row} input[type="checkbox"]`);
  await idle();
  assert('toggle exact lens payload', JSON.stringify(requests.filter((r) => r.method === 'helmraiser.setScoutSettings').at(-1).params) === JSON.stringify({ lens: 'state', auto: true }));
  await page.focus(`${row} input[type="number"]`);
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type('1.5');
  await page.click(`${row} button`);
  await idle();
  assert('cooldown exact payload', JSON.stringify(requests.filter((r) => r.method === 'helmraiser.setScoutSettings').at(-1).params) === JSON.stringify({ lens: 'state', cooldownHours: 1.5 }));
  const reset = await page.$$('xpath/.//section[@aria-label="Scout automation settings"]//button[contains(., "Reset to default")]');
  await reset[0].click(); await idle();
  assert('reset exact lens', requests.filter((r) => r.method === 'helmraiser.resetScoutSettings').at(-1).params.lens === 'state');
  settingsRefusal = true;
  await page.click(`${row} input[type="checkbox"]`);
  await waitText('fixture settings refused');
  await shot('scout-settings-refusal');
  const unqueued = 'details[aria-label="Unqueued drafts"]';
  assert('unqueued collapsed', await page.$eval(unqueued, (node) => !node.open));
  await page.$eval(unqueued, (node) => node.scrollIntoView({ block: 'center' }));
  await shot('unqueued-collapsed');
  await page.click(`${unqueued} summary`);
  assert('only eligible manual drafts', await page.$$eval(`${unqueued} article`, (nodes) => nodes.length === 2 && nodes.every((node) => !node.innerText.includes('boundary'))));
  const manualRow = `${unqueued} article[aria-label="Unqueued draft: Manual queue"]`;
  await page.$eval(manualRow, async (node) => {
    node.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Geometry updates before the compositor paints the scrolled content. Let both
    // layout and paint settle rather than capturing immediately after a DOM check.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await page.waitForFunction((selector) => {
    const row = document.querySelector(selector);
    if (!row) return false;
    return [...row.querySelectorAll('button')].every((button) => {
      const bounds = button.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > innerHeight) return false;
      for (let parent = button.parentElement; parent; parent = parent.parentElement) {
        if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) {
          const clip = parent.getBoundingClientRect();
          if (bounds.top < clip.top || bounds.bottom > clip.bottom) return false;
        }
      }
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return bounds.height > 0 && hit !== null && button.contains(hit);
    });
  }, {}, manualRow);
  const captureBounds = await page.$eval(manualRow, (node) => node.getBoundingClientRect().toJSON());
  await shot('unqueued-expanded');
  assert('manual draft stayed in place through expanded screenshot capture', await page.$eval(manualRow,
    (node, before) => JSON.stringify(node.getBoundingClientRect().toJSON()) === JSON.stringify(before), captureBounds));
  assert('manual draft Queue and Drop visible in expanded evidence', await page.$eval(manualRow,
    (node) => ['QUEUE', 'DROP'].every((label) => [...node.querySelectorAll('button')].some((button) => button.textContent === label))));
  await page.click(`${unqueued} article[aria-label="Unqueued draft: Manual queue"] button`);
  const queue = await page.$$('xpath/.//details//button[contains(., "CONFIRM QUEUE")]');
  await queue[0].click();
  await page.waitForFunction((s) => document.querySelectorAll(`${s} article`).length === 1, {}, unqueued);
  assert('queue manual exact path', requests.filter((r) => r.method === 'helmraiser.queue').at(-1).params.path === `${A}/.helmraiser/tasks/queue.md`);
  const drop = await page.$$('xpath/.//details//button[text()="DROP"]');
  await drop[0].click();
  assert('unqueued Drop asks "Why drop it?" with four classes', await page.$eval(unqueued, (node) =>
    node.querySelector('[role="radiogroup"] legend')?.textContent === 'Why drop it?' && node.querySelectorAll('input[type="radio"]').length === 4));
  await page.type(`${unqueued} input:not([type="radio"])`, 'not needed');
  const confirm = await page.$$('xpath/.//details//button[contains(., "CONFIRM DROP")]');
  assert('unqueued Drop cannot submit without a class', await confirm[0].evaluate((node) => node.disabled));
  await page.click(`${unqueued} input[type="radio"][value="unwanted"]`);
  assert('unqueued Drop submits once a class is chosen', !(await confirm[0].evaluate((node) => node.disabled)));
  await confirm[0].click();
  await page.waitForFunction((s) => document.querySelectorAll(`${s} article`).length === 0, {}, unqueued);
  assert('drop manual exact payload', JSON.stringify(requests.filter((r) => r.method === 'helmraiser.dropDraft').at(-1).params) === JSON.stringify({ taskId: 'alpha:drop', reason: 'not needed', class: 'unwanted' }));
}

try {
  const [wsPort, vitePort] = await Promise.all([freePort(), freePort()]);
  wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request') return;
      requests.push({ method: request.method, params: request.params });
      if (['chat.observe', 'helmraiser.observe'].includes(request.method)) return;
      let result = Object.hasOwn(staticReplies, request.method) ? staticReplies[request.method] : null;
      let error;
      if (request.method === 'helmraiser.status') result = status();
      if (request.method === 'helmraiser.stats') result = stats();
      if (request.method === 'helmraiser.report') result = { since: request.params.since, generated_at: new Date().toISOString(), landed_count: 0, awaiting_count: 0, failed: [], cost: { total_usd: 0, by_model: {} }, models: [] };
      if (request.method === 'helmraiser.allDrafts') result = [...manualDrafts, ...staticReplies['helmraiser.drafts']];
      if (request.method === 'helmraiser.scoutSettings') result = settings;
      if (request.method === 'helmraiser.setScoutSettings') {
        if (settingsRefusal) error = { code: 'helmraiser_cli_error', message: 'fixture settings refused' };
        else {
          const { lens, auto, cooldownHours } = request.params;
          if (auto !== undefined) settings.lenses[lens].auto = auto;
          if (cooldownHours !== undefined) settings.lenses[lens].cooldown_hours = cooldownHours;
          result = settings;
        }
      }
      if (request.method === 'helmraiser.resetScoutSettings') {
        settings.lenses[request.params.lens] = { auto: false, cooldown_hours: 24, source: { auto: 'default', cooldown_hours: 'config' } };
        result = settings;
      }
      if (request.method === 'helmraiser.queue') { manualDrafts = manualDrafts.filter((draft) => draft.path !== request.params.path); result = { status: 'queued' }; }
      if (request.method === 'helmraiser.dropDraft') { manualDrafts = manualDrafts.filter((draft) => draft.task_id !== request.params.taskId); result = { status: 'dropped' }; }
      if (request.method === 'helmraiser.requestScouts') {
        if (requestMode === 'refusal') error = { code: 'helmraiser_cli_error', message: 'project is paused: /fixture/alpha' };
        else result = { requested: [A], already_pending: [B] };
      }
      if (request.method === 'helmraiser.cancelScouts') {
        if (cancelMode === 'refusal') error = { code: 'helmraiser_cli_error', message: 'fixture cancellation refused' };
        else {
          const projects = request.params.projects;
          scouts.pending = scouts.pending.filter((row) => !projects.includes(row.project) ||
            (request.params.lens !== undefined && (row.lens ?? 'state') !== request.params.lens));
          result = cancelMode === 'cancelled' ? { cancelled: projects, not_pending: [] } : { cancelled: [], not_pending: projects };
        }
      }
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: !error, ...(error ? { error } : { result }) }));
    });
  });
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
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
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`[page] ${error.stack ?? error}`));
  page.on('console', (message) => { if (message.type() === 'error') console.error(`[console] ${message.text()}`); });
  await page.setViewport({ width: 1500, height: 1200, deviceScaleFactor: 1 });
  await runEvidence(page, base);
  const report = { assertions, requests };
  await writeFile(`${out}/scout-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  try { await browser?.close(); } finally {
    vite?.kill('SIGTERM');
    for (const socket of sockets) socket.terminate();
    if (wss) await new Promise((resolve) => wss.close(resolve));
  }
}
