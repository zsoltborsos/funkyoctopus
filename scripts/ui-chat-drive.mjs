#!/usr/bin/env node
/**
 * Drive a real chat turn in the running FunkyOctopus UI and screenshot it.
 *
 *   node scripts/ui-chat-drive.mjs --out <dir> [--base http://localhost:5199]
 *                                  [--prompt "…"] [--no-new-chat]
 *
 * Unlike `ui-shots.mjs` (which captures the views as they are) this sends a
 * prompt through the composer, screenshots the transcript while the answer
 * streams, probes the scroll position (stick-to-bottom, "jump to latest"),
 * and walks the finished answer. It talks to whatever model the composer is on,
 * so it costs a real turn; keep prompts explicit ("answer directly, no tools")
 * unless tool use is what you want to see.
 *
 * Auto-detects Vite on 5199 then 14174 like `ui-shots.mjs`; the browser is
 * picked by `scripts/lib/ui-browser.mjs`. Never starts or stops servers.
 * Prints a JSON summary of the probes on stdout.
 */
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './lib/ui-browser.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const out = args.out ?? 'tmp/ui-chat-drive';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT =
  args.prompt ??
  [
    'Answer directly, no tools. Write a long answer (at least 900 words) titled "Octopus camouflage, for engineers"',
    'in GFM markdown: a ## heading per section, a bulleted list, a numbered list, a 3-column table, one fenced ```ts block,',
    'one fenced ```bash block, inline code, a blockquote. No raw HTML. End with the word DONE.',
  ].join(' ');

async function servesFunkyoctopus(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(1500) });
    return res.ok && /funkyoctopus/i.test(await res.text());
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
      'and the sidecar with: FUNKYOCTOPUS_WS_ORIGINS=http://localhost:5199,http://127.0.0.1:5199 npm run server:start',
  );
  process.exit(2);
}
await mkdir(out, { recursive: true });

const SCROLLER = 'div[aria-label="Transcript"]';
const JUMP = 'button[aria-label="Jump to latest"]';
/** Distance from the end of the transcript, in px (0 = pinned to the tail). */
const gapToEnd = (page) =>
  page.$eval(SCROLLER, (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const turnDone = (page) =>
  page.waitForFunction(() => !!document.querySelector('button[type="submit"]'), { timeout: 240_000 });

const browser = await launchBrowser();
const probes = {};
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console]', m.text().slice(0, 200));
  });
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
  await sleep(1500);
  if (args['no-new-chat'] !== 'true') {
    const [newChat] = await page.$$(`xpath/.//button[contains(., 'new chat')]`);
    if (newChat) {
      await newChat.click();
      await sleep(800);
    }
  }
  const box = await page.$('textarea[aria-label="Message"]');
  await box.click();
  await page.keyboard.type(PROMPT);
  await page.keyboard.press('Enter');

  // Streaming, hands off the scroller: the tail should stay in view.
  await sleep(3000);
  await page.screenshot({ path: `${out}/01-streaming-early.png` });
  await sleep(3000);
  probes.gapWhileStreaming = await gapToEnd(page);
  probes.jumpWhileFollowing = !!(await page.$(JUMP));
  await page.screenshot({ path: `${out}/02-streaming-following.png` });

  // Reader wheels up mid-stream (a real input event, not a scrollTop write —
  // the hook reads intent from the wheel): the view holds, the jump shows.
  const box_ = await page.$eval(SCROLLER, (el) => el.getBoundingClientRect().toJSON());
  await page.mouse.move(box_.x + box_.width / 2, box_.y + box_.height / 2);
  await page.mouse.wheel({ deltaY: -600 });
  await sleep(1500);
  probes.streamingAtScrollUp = !(await page.$('button[type="submit"]'));
  probes.gapAfterScrollUp = await gapToEnd(page);
  probes.jumpAfterScrollUp = !!(await page.$(JUMP));
  await page.screenshot({ path: `${out}/03-scrolled-up-streaming.png` });

  const jump = await page.$(JUMP);
  if (jump) {
    await jump.click();
    await sleep(800);
    probes.gapAfterJump = await gapToEnd(page);
    probes.jumpAfterJump = !!(await page.$(JUMP));
    await page.screenshot({ path: `${out}/04-after-jump.png` });
  }

  await turnDone(page);
  await sleep(800);
  probes.gapAtEnd = await gapToEnd(page);
  await page.screenshot({ path: `${out}/05-done-bottom.png` });
  // Walk the finished answer top to bottom for the reviewer.
  const h = await page.$eval(SCROLLER, (el) => el.scrollHeight);
  for (let y = 0, i = 0; y < h && i < 6; y += 800, i += 1) {
    await page.$eval(SCROLLER, (el, top) => { el.scrollTop = top; }, y);
    await sleep(300);
    await page.screenshot({ path: `${out}/06-done-walk-${i}.png` });
  }
  const text = await page.evaluate(() => document.body.innerText);
  console.log(JSON.stringify({ ...probes, scrollHeight: h, hasDONE: /DONE/.test(text) }));
} finally {
  await browser.close();
}
