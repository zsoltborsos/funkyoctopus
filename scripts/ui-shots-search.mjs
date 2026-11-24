#!/usr/bin/env node
/**
 * Screenshot Ctrl+K's stored-chat search (T2.5): searching, results, a stored
 * row highlighted, no match, a narrow window, and the tab a picked result opens.
 *
 *   node scripts/ui-shots-search.mjs --out <dir> [--base http://localhost:5199] [--query "deepseek pin"]
 *
 * Same constraints as ui-shots.mjs: needs a Vite serving FunkyOctopus; the
 * browser is picked by `scripts/lib/ui-browser.mjs`; never starts or stops
 * servers. The sidecar reads the real session stores (read-only). Picking a
 * result opens it in a new tab, which is closed again at the end; nothing is
 * sent to any model.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-shots/search';
const base = args.base ?? 'http://localhost:14174';
const query = args.query ?? 'deepseek pin';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await pause(2500);

  const shot = async (name) => {
    const file = `${out}/${name}.png`;
    await page.screenshot({ path: file });
    console.log(file);
  };
  const ctrlK = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await pause(400);
  };
  const storedRows = () => page.$$("xpath/.//*[@role='option'][contains(@id, 'stored-')]");
  const waitForRows = async () => {
    for (let i = 0; i < 60; i += 1) {
      if ((await storedRows()).length > 0) return;
      await pause(500);
    }
    throw new Error('no stored-chat rows after 30 s');
  };

  await ctrlK();
  await page.keyboard.type(query);
  await pause(600);
  await shot('search-searching');
  await waitForRows();
  await shot('search-results');

  // Walk past the views and tabs onto the first stored row.
  const before = await page.$$("xpath/.//*[@role='option']");
  const firstStored = before.length - (await storedRows()).length;
  for (let i = 0; i < firstStored; i += 1) await page.keyboard.press('ArrowDown');
  await pause(200);
  await shot('search-stored-highlighted');

  await page.setViewport({ width: 820, height: 900, deviceScaleFactor: 1 });
  await pause(400);
  await shot('search-narrow');
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await pause(400);

  await page.keyboard.press('Enter');
  await pause(2500);
  await shot('search-picked');

  await ctrlK();
  await page.keyboard.type('zzqqxxnomatch');
  await pause(1500);
  await shot('search-no-match');
  await page.keyboard.press('Escape');
  await pause(300);

  // Close the tab the pick opened (a pick that switched to an open tab opened none).
  const tabs = await page.$$("xpath/.//button[starts-with(@aria-label, 'Close ')]");
  if (tabs.length > 0) {
    await tabs[tabs.length - 1].click();
    await pause(700);
  }
} finally {
  await browser.close();
}
