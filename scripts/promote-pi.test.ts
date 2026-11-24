/**
 * Hermetic decision-sequence tests for `scripts/promote-pi.ts`: a scripted
 * process seam records every command and answers from a table, so no npm, git
 * or network is ever touched.
 */

import { describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  parseArgs,
  promotePi,
  type CaptureResult,
  type PromoteDeps,
} from './promote-pi.ts';

const SDK = '@earendil-works/pi-coding-agent';
const REPO = '/repo';

interface Scenario {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  pin?: string | null;
  installed?: string | null;
  latest?: string | null;
  dirty?: string;
  sidecarUp?: boolean;
  /** Exit codes for streamed commands, keyed by `command args…`; default 0. */
  streamCodes?: Record<string, number | null>;
  /** Overrides for captured commands, keyed by `command args…`. */
  captures?: Record<string, Partial<CaptureResult>>;
}

function harness(scenario: Scenario = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const pin = scenario.pin === undefined ? '0.84.1' : scenario.pin;
  const installed = scenario.installed === undefined ? '0.84.1' : scenario.installed;
  const files = new Map<string, string>();
  if (pin !== null) files.set(`${REPO}/package.json`, JSON.stringify({ dependencies: { [SDK]: pin } }));
  if (installed !== null) {
    files.set(`${REPO}/node_modules/${SDK}/package.json`, JSON.stringify({ version: installed }));
  }
  const deps: PromoteDeps = {
    argv: scenario.argv ?? [],
    env: scenario.env ?? {},
    cwd: `${REPO}/sub`,
    stream: (command, args) => {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const codes = scenario.streamCodes ?? {};
      return Promise.resolve(key in codes ? (codes[key] as number | null) : 0);
    },
    capture: (command, args) => {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const base: CaptureResult = { code: 0, stdout: '', stderr: '' };
      if (key === 'git rev-parse --show-toplevel') base.stdout = `${REPO}\n`;
      if (key === 'git status --porcelain=v1 --untracked-files=all') base.stdout = scenario.dirty ?? '';
      return Promise.resolve({ ...base, ...scenario.captures?.[key] });
    },
    readFile: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
    },
    readLatest: () => Promise.resolve(scenario.latest === undefined ? '0.84.2' : scenario.latest),
    probeSidecar: () => Promise.resolve(scenario.sidecarUp ?? false),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, out, err };
}

const INSTALL = `npm install --save-exact ${SDK}@0.84.2`;
const VERIFY = 'npm run verify';
const RUNTIME = 'npm run test:runtime';
const ADD = 'git add -- package.json package-lock.json';
const COMMIT = 'git commit --no-verify -m chore(deps): embedded pi 0.84.2';
const RESTORE = 'git checkout -- package.json package-lock.json';
const CI = 'npm ci';

describe('parseArgs', () => {
  it('defaults to the registry latest', () => {
    expect(parseArgs([])).toEqual({ kind: 'run', to: null });
  });

  it('accepts an exact stable --to and normalises it', () => {
    expect(parseArgs(['--to', ' 0.85.0 '])).toEqual({ kind: 'run', to: '0.85.0' });
  });

  it('rejects ranges, tags and missing values for --to', () => {
    expect(parseArgs(['--to', '^0.85.0']).kind).toBe('usage');
    expect(parseArgs(['--to', 'latest']).kind).toBe('usage');
    expect(parseArgs(['--to']).kind).toBe('usage');
  });

  it('rejects unknown arguments and honours --help', () => {
    expect(parseArgs(['--yolo']).kind).toBe('usage');
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });
});

describe('promotePi — refusals (nothing mutated)', () => {
  it('exits 2 with usage on a bad argument and runs nothing', async () => {
    const h = harness({ argv: ['--to', 'next'] });
    expect(await promotePi(h.deps)).toBe(EXIT_USAGE);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('usage:');
  });

  it('refuses outside a git checkout', async () => {
    const h = harness({ captures: { 'git rev-parse --show-toplevel': { code: 128, stdout: '' } } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });

  it('refuses when package.json pin and node_modules disagree (run npm ci first)', async () => {
    const h = harness({ pin: '0.84.1', installed: '0.84.0' });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('npm ci');
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });

  it('refuses when the baseline cannot be read', async () => {
    const h = harness({ installed: null });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });

  it('refuses on a dirty tree (tracked or untracked) with the manual-restore hint', async () => {
    const h = harness({ dirty: '?? scratch.txt\n' });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('git checkout -- package.json package-lock.json && npm ci');
    expect(h.calls).not.toContain(INSTALL);
  });

  it('refuses while a sidecar answers on SIDECAR_HOST:SIDECAR_PORT', async () => {
    let probed: { host: string; port: number } | null = null;
    const h = harness({ sidecarUp: true, env: { SIDECAR_HOST: '::1', SIDECAR_PORT: '9099' } });
    h.deps.probeSidecar = (host, port) => {
      probed = { host, port };
      return Promise.resolve(true);
    };
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(probed).toEqual({ host: '::1', port: 9099 });
    expect(h.err.join('\n')).toContain('stop it before promoting');
    expect(h.calls).not.toContain(INSTALL);
  });

  it('refuses a malformed SIDECAR_PORT rather than skipping the probe', async () => {
    const h = harness({ env: { SIDECAR_PORT: 'eighty' } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).not.toContain(INSTALL);
  });

  it('refuses when the registry gives no stable latest and no --to was passed', async () => {
    const h = harness({ latest: null });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('--to');
    expect(h.calls).not.toContain(INSTALL);
  });
});

describe('promotePi — idempotence', () => {
  it('is a no-op when already at the candidate (the re-run after a success)', async () => {
    const h = harness({ latest: '0.84.1' });
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    expect(h.out.join('\n')).toContain('already at');
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });

  it('is a no-op when installed is ahead of the registry latest', async () => {
    const h = harness({ pin: '0.85.0', installed: '0.85.0', latest: '0.84.2' });
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    expect(h.out.join('\n')).toContain('ahead');
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });

  it('an explicit --to equal to the installed version is the same no-op', async () => {
    const h = harness({ argv: ['--to', '0.84.1'] });
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    expect(h.calls.some((call) => call.startsWith('npm'))).toBe(false);
  });
});

describe('promotePi — the happy path', () => {
  it('installs exactly, runs verify then test:runtime, commits the pin, skips the duplicate hook', async () => {
    const h = harness();
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    const mutating = h.calls.filter((call) => call.startsWith('npm') || call.startsWith('git add') || call.startsWith('git commit'));
    expect(mutating).toEqual([INSTALL, VERIFY, RUNTIME, ADD, COMMIT]);
    expect(h.calls).not.toContain(RESTORE);
    expect(h.calls).not.toContain(CI);
  });

  it('honours --to for an explicit candidate without reading the registry', async () => {
    const h = harness({ argv: ['--to', '0.90.0'] });
    h.deps.readLatest = () => Promise.reject(new Error('registry must not be read'));
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    expect(h.calls).toContain(`npm install --save-exact ${SDK}@0.90.0`);
    expect(h.calls).toContain('git commit --no-verify -m chore(deps): embedded pi 0.90.0');
  });

  it('probes the sidecar and reads git status only after deciding there is work to do', async () => {
    const h = harness({ latest: '0.84.1', sidecarUp: true, dirty: ' M x' });
    expect(await promotePi(h.deps)).toBe(EXIT_OK);
    expect(h.calls.some((call) => call.startsWith('git status'))).toBe(false);
  });
});

describe('promotePi — rollback', () => {
  it.each([
    ['npm install', INSTALL],
    ['npm run verify', VERIFY],
    ['npm run test:runtime', RUNTIME],
  ])('restores the two files and runs npm ci when %s fails, and stops there', async (_label, failing) => {
    const h = harness({ streamCodes: { [failing]: 1 } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    const afterFailure = h.calls.slice(h.calls.indexOf(failing) + 1);
    expect(afterFailure).toEqual([RESTORE, CI]);
    expect(h.calls).not.toContain(COMMIT);
    expect(h.err.join('\n')).toContain('rolled back to 0.84.1');
  });

  it('rolls back when the commit itself fails', async () => {
    const h = harness({ captures: { [COMMIT]: { code: 1, stderr: 'nothing to commit' } } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.slice(h.calls.indexOf(COMMIT) + 1)).toEqual([RESTORE, CI]);
  });

  it('says loudly when the rollback itself is incomplete', async () => {
    const h = harness({ streamCodes: { [VERIFY]: 1, [CI]: 1 } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('ROLLBACK INCOMPLETE');
  });

  it('treats a killed gate (null exit) as a failure', async () => {
    const h = harness({ streamCodes: { [RUNTIME]: null } });
    expect(await promotePi(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.slice(h.calls.indexOf(RUNTIME) + 1)).toEqual([RESTORE, CI]);
  });
});
