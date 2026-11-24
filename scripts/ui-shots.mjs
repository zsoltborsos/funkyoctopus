#!/usr/bin/env node
/**
 * Screenshot every FunkyOctopus view from a running Vite dev server.
 *
 *   node scripts/ui-shots.mjs --out <dir> [--base http://localhost:5199]
 *                             [--views chat,helmraiser,prompts,settings]
 *                             [--width 1600 --height 1000]
 *                             [--theme brand|matrix] [--scheme light|dark]
 *
 * Auto-detects a Vite that is actually serving FunkyOctopus on 5199 then 14174.
 * Browser: `CHROME_PATH` if set, else the newest chrome-headless-shell under
 * `~/.cache/puppeteer/chrome-headless-shell/` (`npx @puppeteer/browsers
 * install chrome-headless-shell@stable --path ~/.cache/puppeteer`), else
 * `/usr/bin/google-chrome` — see `scripts/lib/ui-browser.mjs`. Never starts or
 * stops servers; if nothing answers it exits 2 with the commands to run.
 * `--theme` stores that theme preference before the page loads (default: the
 * page's own stored or default theme); `--scheme` emulates the system
 * `prefers-color-scheme` (default: the browser's).
 *
 * This script must live inside the repo: `puppeteer-core` (a devDependency)
 * resolves from the script's own tree under ESM.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-shots';
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 1000);
const wanted = (args.views ?? 'chat,helmraiser,prompts,settings').split(',');
const theme = args.theme;
const scheme = args.scheme;
if (scheme && scheme !== 'light' && scheme !== 'dark') {
  console.error(`--scheme must be light or dark, not ${scheme}`);
  process.exit(2);
}
const VIEW_LABEL = { chat: 'Chat', helmraiser: 'Helmraiser', prompts: 'Prompts', settings: 'Settings' };

async function servesFunkyoctopus(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const html = await res.text();
    // Vite dev serves index.html; the app title/root marks it as ours.
    return /funkyoctopus/i.test(html);
  } catch {
    return false;
  }
}

let base = args.base;
if (!base) {
  for (const candidate of ['http://localhost:5199', 'http://localhost:14174']) {
    if (await servesFunkyoctopus(candidate)) {
      base = candidate;
      break;
    }
  }
}
if (!base) {
  console.error(
    'No Vite serving FunkyOctopus on 5199 or 14174.\n' +
      'Start it with: npx vite --port 5199 --strictPort\n' +
      'and the sidecar with: SIDECAR_PORT=14788 FUNKYOCTOPUS_WS_ORIGINS=http://localhost:5199,http://127.0.0.1:5199 npm run server:start',
  );
  process.exit(2);
}

await mkdir(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (scheme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  if (theme) {
    // Merged into the stored preferences, as the Settings control would.
    await page.evaluateOnNewDocument((value) => {
      const key = 'funkyoctopus.preferences';
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { /* start fresh */ }
      localStorage.setItem(key, JSON.stringify({ ...prefs, theme: value }));
    }, theme);
  }
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 2000));

  const summary = [];
  for (const view of wanted) {
    const label = VIEW_LABEL[view];
    if (!label) {
      console.error(`unknown view: ${view}`);
      continue;
    }
    if (view !== 'chat') {
      const [btn] = await page.$$(`xpath/.//nav//button[.//span[contains(text(),'${label}')]]`);
      if (!btn) {
        console.error(`nav button not found: ${label}`);
        continue;
      }
      await btn.click();
      await new Promise((r) => setTimeout(r, 1200));
    }
    const file = `${out}/${view}.png`;
    await page.screenshot({ path: file });
    const text = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    summary.push({ view, file, text });
  }
  const status = await page.evaluate(() => {
    const bar = document.querySelector('footer, [data-status-bar], .status-bar');
    return bar ? bar.textContent?.trim().slice(0, 300) : document.body.innerText.split('\n').slice(-1)[0];
  });
  const applied = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  console.log(JSON.stringify({ base, out, theme: applied, scheme: scheme ?? null, statusBar: status, views: summary }, null, 2));
} finally {
  await browser.close();
}
