#!/usr/bin/env node
/**
 * Screenshot the chat surface with the Leeboard panel (T3 L3; it replaced the
 * old rail in the same place) in each of its states: closed, each spine
 * tab open, an entry opened from the first tab that has one, and a spine crop.
 *
 *   node scripts/ui-shots-rail.mjs --out <dir> [--base http://localhost:5199] [--routing <project>]
 *
 * Same constraints as ui-shots.mjs: needs a Vite serving FunkyOctopus; the
 * browser is picked by `scripts/lib/ui-browser.mjs`; never starts or stops
 * servers. Only read-only `lb` calls happen behind it (brief, show, review --peek,
 * list).
 *
 * `--routing <project>` adds the T3 L5 inbox routing: it opens the "open a
 * <project> tab" menu, opens a pi tab there (a sidecar side effect: the tab
 * stays, close it afterwards), then goes back to the first tab and uses "go to
 * <project> tab". Every prompt is left unsent in a composer; nothing is sent.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-shots/leeboard';
const base = args.base ?? 'http://localhost:5199';
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
  const clickLabel = async (label) => {
    const [btn] = await page.$$(`xpath/.//button[@aria-label='${label}']`);
    if (!btn) throw new Error(`no button labelled ${label}`);
    await btn.click();
    await pause(1200);
  };

  await shot('chat-leeboard-closed');
  let read = false;
  for (const tab of ['Inbox', 'Holds', 'Index', 'Digest']) {
    await clickLabel(tab);
    await shot(`leeboard-${tab.toLowerCase()}`);
    // One entry body, from the first tab that lists one (the digest folds its rows).
    if (!read) {
      const [row] = await page.$$("xpath/.//aside[@aria-label='Leeboard detail']//li/button");
      if (row) {
        await row.click();
        await pause(1200);
        await shot(`leeboard-entry-from-${tab.toLowerCase()}`);
        read = true;
      }
    }
    await clickLabel(tab);
  }
  if (args.routing) {
    const project = args.routing;
    const clickText = async (text) => {
      const [btn] = await page.$$(`xpath/.//button[normalize-space(.)='${text}']`);
      if (!btn) throw new Error(`no button reading ${text}`);
      await btn.click();
      await pause(1500);
    };
    await clickLabel('Inbox');
    await clickText(`open a ${project} tab ▾`);
    await shot('routing-open-menu');
    const [pi] = await page.$$("xpath/.//*[@role='menuitem'][contains(., 'pi tab')]");
    if (!pi) throw new Error('no pi tab menu item');
    await pi.click();
    await pause(2000);
    await shot('routing-new-tab-prefilled');
    await clickLabel('Inbox');
    await shot('routing-project-tab-inbox');
    const [first] = await page.$$("xpath/.//button[@role='tab']");
    await first.click();
    await pause(1500);
    await clickLabel('Inbox');
    await shot('routing-first-tab-go-to');
    // A replied request, read through the entry view.
    const [replied] = await page.$$("xpath/.//aside[@aria-label='Leeboard detail']//button[.//span[normalize-space(.)='replied']]");
    if (replied) {
      await replied.click();
      await pause(1200);
      await shot('routing-replied-entry');
      await clickText('← back');
    }
    await clickText(`go to ${project} tab`);
    await pause(1000);
    await shot('routing-go-to-prefilled');
  }

  // The spine alone, cropped, for glyph/label legibility.
  const nav = await page.$("xpath/.//nav[@aria-label='Leeboard']");
  if (nav) {
    await nav.screenshot({ path: `${out}/spine.png` });
    console.log(`${out}/spine.png`);
  }
} finally {
  await browser.close();
}
