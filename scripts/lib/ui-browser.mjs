/**
 * Shared browser launcher for the UI evidence scripts.
 *
 * Picks the browser in this order:
 *   1. `CHROME_PATH` if set;
 *   2. the newest `chrome-headless-shell` under
 *      `~/.cache/puppeteer/chrome-headless-shell/` (installs with
 *      `npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer`);
 *   3. `/usr/bin/google-chrome`.
 *
 * chrome-headless-shell is launched with `headless: 'shell'`, `--no-sandbox`
 * and a temporary `userDataDir` that is removed when the browser closes —
 * it has no ProcessSingleton Unix socket, so it is the only browser that
 * works inside Helmraiser's srt sandbox, where full Chrome aborts. The shell
 * settings follow the *binary*, not the source: `CHROME_PATH` pointing at a
 * chrome-headless-shell binary gets them too. Any other binary keeps the
 * plain headless launch. Logs the chosen binary to stderr; if no browser can
 * be found it fails with the install command above.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// The test suite points HOME at a temp dir to grow fixture trees.
const headlessShellDir = () => join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');

const newestHeadlessShell = () => {
  const HEADLESS_SHELL_DIR = headlessShellDir();
  if (!existsSync(HEADLESS_SHELL_DIR)) return undefined;
  let entries;
  try {
    entries = readdirSync(HEADLESS_SHELL_DIR);
  } catch {
    return undefined;
  }
  // `linux-<version>` directories; newest version wins.
  const versions = entries
    .filter((name) => /^linux-\d/.test(name))
    .sort((a, b) => {
      const parts = (entry) => entry.replace(/^linux-/, '').split('.').map(Number);
      const [aParts, bParts] = [parts(a), parts(b)];
      const length = Math.max(aParts.length, bParts.length);
      for (let i = 0; i < length; i += 1) {
        const [aPart, bPart] = [aParts[i] ?? 0, bParts[i] ?? 0];
        if (aPart !== bPart) return aPart - bPart;
      }
      return 0;
    });
  for (const version of versions.reverse()) {
    const binary = join(
      HEADLESS_SHELL_DIR,
      version,
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    );
    if (existsSync(binary)) return binary;
  }
  return undefined;
};

/** Shell settings follow the binary: recognised by its base name. */
const isHeadlessShellBinary = (path) => {
  const base = path.split('/').pop() ?? '';
  return base === 'chrome-headless-shell' || base.startsWith('chrome-headless-shell-');
};

export const pickBrowser = () => {
  if (process.env.CHROME_PATH) {
    const path = process.env.CHROME_PATH;
    return {
      path,
      kind: isHeadlessShellBinary(path) ? 'chrome-headless-shell' : 'chrome',
      source: 'CHROME_PATH',
    };
  }
  const shell = newestHeadlessShell();
  if (shell) {
    return { path: shell, kind: 'chrome-headless-shell', source: 'chrome-headless-shell' };
  }
  const chrome = '/usr/bin/google-chrome';
  if (existsSync(chrome)) {
    return { path: chrome, kind: 'chrome', source: 'system chrome' };
  }
  return undefined;
};

/**
 * Launch the picked browser. `options` are passed through to
 * `puppeteer.launch` (minus `executablePath`, which is decided here).
 * When chrome-headless-shell is used the handle's `close()` also removes the
 * temporary `userDataDir`, and a rejected launch never leaves the profile
 * behind. `launch` is a test seam defaulting to the real puppeteer launcher.
 */
export const launchBrowser = async (options = {}, { launch = puppeteer.launch } = {}) => {
  const browser = pickBrowser();
  if (!browser) {
    throw new Error(
      'No browser found. Install Chrome for Testing headless shell with:\n' +
        '  npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer\n' +
        'or point CHROME_PATH at a Chrome binary.',
    );
  }
  console.error(`[browser] using ${browser.source}: ${browser.path}`);
  if (browser.kind !== 'chrome-headless-shell') {
    return launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
      ...options,
      executablePath: browser.path,
    });
  }
  const userDataDir = await mkdtemp(join(tmpdir(), 'fo-ui-evidence-chrome-'));
  let handle;
  try {
    handle = await launch({
      headless: 'shell',
      args: ['--no-sandbox', '--disable-gpu'],
      ...options,
      executablePath: browser.path,
      userDataDir,
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
  const originalClose = handle.close.bind(handle);
  handle.close = async () => {
    try {
      await originalClose();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  };
  return handle;
};
