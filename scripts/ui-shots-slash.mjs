#!/usr/bin/env node
/**
 * Screenshot the composer's `/` palette (T2.4b): open in a pi tab (FO's own
 * commands, templates and skills), filtered, the rename ask, and open in a
 * Claude Code tab (its live or last-known list, or the line saying it has none
 * yet).
 *
 *   node scripts/ui-shots-slash.mjs --out <dir> [--base http://localhost:5199]
 *
 * Same constraints as ui-shots.mjs: needs a Vite serving FunkyOctopus; the
 * browser is picked by `scripts/lib/ui-browser.mjs`; never starts or stops
 * servers. It opens a pi and a Claude Code tab through the "＋ ▾" menu (a
 * sidecar side effect; listing a pi tab's commands builds its session) and
 * closes them again at the end. Nothing is sent, compacted or renamed.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-shots/slash';
const base = args.base ?? 'http://localhost:14174';
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
  const click = async (xpath) => {
    const [el] = await page.$$(`xpath/${xpath}`);
    if (!el) throw new Error(`nothing at ${xpath}`);
    await el.click();
    await pause(900);
  };
  const composer = async () => {
    await click(".//textarea[@aria-label='Message']");
  };
  const clearComposer = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await pause(200);
  };

  // A pi tab: FO's compact and rename, then pi's templates and skills.
  await click(".//button[@aria-label='New tab']");
  await click(".//button[@role='menuitem'][contains(., 'pi tab')]");
  await pause(2500);
  await composer();
  await page.keyboard.type('/');
  await pause(1500);
  await shot('slash-pi-open');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await pause(200);
  await shot('slash-pi-walked');
  await page.keyboard.type('sk');
  await pause(300);
  await shot('slash-pi-filtered');
  await page.keyboard.type('zzz');
  await pause(300);
  await shot('slash-pi-no-match');
  await clearComposer();
  await page.keyboard.type('/ren');
  await pause(300);
  await page.keyboard.press('Enter');
  await pause(500);
  await shot('slash-rename-ask');
  await page.keyboard.press('Escape');
  await pause(300);

  // A Claude Code tab: no process yet, so its last-known list, or none.
  await click(".//button[@aria-label='New tab']");
  await click(".//button[@role='menuitem'][contains(., 'Claude tab')]");
  await pause(1500);
  await composer();
  await page.keyboard.type('/');
  await pause(1200);
  await shot('slash-claude-open');
  await clearComposer();

  // Close the tabs this run opened.
  for (let i = 0; i < 2; i += 1) {
    const [close] = await page.$$("xpath/.//button[starts-with(@aria-label, 'Close ')]");
    if (!close) break;
    await close.click();
    await pause(700);
  }
} finally {
  await browser.close();
}
