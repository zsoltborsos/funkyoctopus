#!/usr/bin/env node
/**
 * Screenshot the Ctrl+K switcher (T2.4a): open over the chat view with a pi
 * and a Claude Code tab beside `main`, filtered, and open over Settings.
 *
 *   node scripts/ui-shots-switcher.mjs --out <dir> [--base http://localhost:5199]
 *
 * Same constraints as ui-shots.mjs: needs a Vite serving FunkyOctopus; the
 * browser is picked by `scripts/lib/ui-browser.mjs`; never starts or stops
 * servers. It opens two tabs through the "＋ ▾" menu (a sidecar side effect)
 * and closes them again at the end; nothing is sent to any model.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-shots/switcher';
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
  const ctrlK = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await pause(400);
  };

  // A pi tab and a Claude Code tab, so both engine glyphs show.
  await click(".//button[@aria-label='New tab']");
  await click(".//button[@role='menuitem'][contains(., 'pi tab')]");
  await click(".//button[@aria-label='New tab']");
  await click(".//button[@role='menuitem'][contains(., 'Claude tab')]");

  await ctrlK();
  await shot('switcher-chat');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await shot('switcher-chat-second-tab-highlighted');
  await page.keyboard.type('claude');
  await pause(200);
  await shot('switcher-filtered');
  await page.keyboard.press('Escape');
  await pause(300);

  await click(".//nav//button[.//span[contains(text(),'Settings')]]");
  await ctrlK();
  await shot('switcher-settings');
  // Jump to the first tab from Settings: chat comes back with that tab shown.
  await page.keyboard.press('Escape');
  await ctrlK();
  await page.keyboard.type('untitled');
  await page.keyboard.press('Enter');
  await pause(900);
  await shot('after-jump');

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
