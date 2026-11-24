/**
 * Launcher regression tests for the shared UI browser chooser.
 *
 * Pure selection tests only: they never launch a browser, so `verify` stays
 * hermetic. `pickBrowser` reads `HOME` and `CHROME_PATH` from `process.env`,
 * so each case gets a fake home via the exported `withFakeEnv` hook.
 */
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, pickBrowser } from './ui-browser.mjs';

const REAL_CHROME_PATH = process.env.CHROME_PATH;
const REAL_HOME = process.env.HOME;
const HOMES = [];
const tempHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'fo-pickbrowser-'));
  HOMES.push(home);
  return home;
};
const shellBinary = (home, version) =>
  join(
    home,
    '.cache/puppeteer/chrome-headless-shell',
    `linux-${version}`,
    'chrome-headless-shell-linux64',
    'chrome-headless-shell',
  );
const shellDir = (home, version) => shellBinary(home, version).replace(/\/chrome-headless-shell$/, '');

beforeEach(() => {
  delete process.env.CHROME_PATH;
});
afterAll(async () => {
  if (REAL_CHROME_PATH === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = REAL_CHROME_PATH;
  process.env.HOME = REAL_HOME;
  await Promise.all(HOMES.map((home) => rm(home, { recursive: true, force: true })));
});

describe('pickBrowser', () => {
  it('CHROME_PATH wins even when a shell is installed, and passes unknown paths through', async () => {
    const home = await tempHome();
    process.env.HOME = home;
    process.env.CHROME_PATH = '/definitely/not/a/browser';
    await mkdir(shellDir(home, '154.0.8037.92'), { recursive: true });
    await writeFile(join(shellDir(home, '154.0.8037.92'), 'chrome-headless-shell'), '#!/bin/sh\n');
    await chmod(join(shellDir(home, '154.0.8037.92'), 'chrome-headless-shell'), 0o755);
    expect(pickBrowser()).toEqual({
      path: '/definitely/not/a/browser',
      kind: 'chrome',
      source: 'CHROME_PATH',
    });
  });

  it('without CHROME_PATH it takes the newest chrome-headless-shell, by version not string order', async () => {
    const home = await tempHome();
    process.env.HOME = home;
    const dirs = ['9.0.115.0', '100.0.4896.12', '154.0.8037.92'];
    for (const version of dirs) {
      await mkdir(shellDir(home, version), { recursive: true });
      await writeFile(join(shellDir(home, version), 'chrome-headless-shell'), '#!/bin/sh\n');
      await chmod(join(shellDir(home, version), 'chrome-headless-shell'), 0o755);
    }
    const pick = pickBrowser();
    expect(pick?.source).toBe('chrome-headless-shell');
    expect(pick?.kind).toBe('chrome-headless-shell');
    expect(pick?.path).toBe(shellBinary(home, '154.0.8037.92'));
  });

  it('a shell directory without a usable binary is skipped', async () => {
    const home = await tempHome();
    process.env.HOME = home;
    await mkdir(shellDir(home, '9.0.115.0'), { recursive: true });
    await writeFile(join(shellDir(home, '9.0.115.0'), 'chrome-headless-shell'), '#!/bin/sh\n');
    await chmod(join(shellDir(home, '9.0.115.0'), 'chrome-headless-shell'), 0o755);
    await mkdir(shellDir(home, '100.0.4896.12'), { recursive: true }); // no binary inside
    const pick = pickBrowser();
    expect(pick?.source).toBe('chrome-headless-shell');
    expect(pick?.kind).toBe('chrome-headless-shell');
    expect(pick?.path).toBe(shellBinary(home, '9.0.115.0'));
  });

  it('with no cache and no CHROME_PATH it falls back to the system chrome path', async () => {
    const home = await tempHome();
    process.env.HOME = home;
    const pick = pickBrowser();
    if (!pick) return; // /usr/bin/google-chrome not present in this environment
    expect(pick).toEqual({ path: '/usr/bin/google-chrome', kind: 'chrome', source: 'system chrome' });
  });

  it('with no source at all it returns undefined so scripts can fail with the install command', async () => {
    if (existsSync('/usr/bin/google-chrome')) return; // can only test the empty case without it
    const home = await tempHome();
    process.env.HOME = home;
    await mkdir(join(home, '.cache/puppeteer/chrome-headless-shell'), { recursive: true });
    expect(pickBrowser()).toBeUndefined();
  });

  it('CHROME_PATH pointing at a chrome-headless-shell binary is recognised as shell by name', () => {
    process.env.CHROME_PATH = '/some/where/chrome-headless-shell';
    expect(pickBrowser()).toEqual({
      path: '/some/where/chrome-headless-shell',
      kind: 'chrome-headless-shell',
      source: 'CHROME_PATH',
    });
  });
});

describe('launchBrowser (injected launch, never a real browser)', () => {
  beforeEach(() => {
    delete process.env.CHROME_PATH;
  });

  it('regression: CHROME_PATH at a shell binary gets headless shell, a temp profile and profile cleanup on close', async () => {
    process.env.CHROME_PATH = '/some/where/chrome-headless-shell';
    const launch = vi.fn(async (opts) => ({
      ...opts,
      close: vi.fn(async () => {}),
    }));
    const browser = await launchBrowser({}, { launch });
    expect(launch).toHaveBeenCalledTimes(1);
    const passed = launch.mock.calls[0][0];
    expect(passed.headless).toBe('shell');
    expect(passed.args).toContain('--no-sandbox');
    expect(passed.userDataDir).toMatch(/fo-ui-evidence-chrome-/);
    expect(existsSync(passed.userDataDir)).toBe(true);
    await browser.close();
    expect(existsSync(passed.userDataDir)).toBe(false);
  });

  it('regression: a rejected shell launch leaves no temporary profile behind', async () => {
    process.env.CHROME_PATH = '/some/where/chrome-headless-shell';
    const launch = vi.fn(async () => {
      throw new Error('launch boom');
    });
    await expect(launchBrowser({}, { launch })).rejects.toThrow('launch boom');
    const passed = launch.mock.calls[0][0];
    expect(passed.userDataDir).toMatch(/fo-ui-evidence-chrome-/);
    expect(existsSync(passed.userDataDir)).toBe(false);
  });

  it('a real Chrome binary keeps the plain headless launch without a temp profile', async () => {
    process.env.CHROME_PATH = '/some/where/google-chrome';
    const launch = vi.fn(async (opts) => ({
      ...opts,
      close: vi.fn(async () => {}),
    }));
    const browser = await launchBrowser({}, { launch });
    const passed = launch.mock.calls[0][0];
    expect(passed.headless).toBe(true);
    expect(passed.userDataDir).toBeUndefined();
    await browser.close();
  });
});
