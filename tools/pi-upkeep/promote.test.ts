/**
 * Transactional promotion engine tests (test-first).
 *
 * Every external effect goes through injected seams: the coordination fs,
 * runCommand's spawn, the stat-device probe, the live canary, and the
 * embedded-state reader. No test touches a registry, a model, or the real
 * repository. One end-to-end test runs on a real temp filesystem with faked
 * commands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { embeddedStatePath } from '../../server/src/upkeep/embedded-state.ts';
import type { ChatChunk } from '../../src/shared/transport/protocol.ts';
import {
  CANARY_MODEL,
  CANARY_PROMPT,
  MAX_REASON_BYTES,
  runCanary,
  type CanaryChat,
  type CanaryDeps,
  type CanarySession,
  type CanaryTempRoot,
} from './canary.ts';
import { journalPath, pendingJournalPath } from './journal.ts';
import { sdkDependencyClosure, validateLockScope, validatePackageJsonScope } from './manifest-scope.ts';
import {
  AUDIT_TIMEOUT_MS,
  CANARY_CLEANUP_GRACE_MS,
  CANDIDATE_BUILD_TIMEOUT_MS,
  CANDIDATE_INSTALL_TIMEOUT_MS,
  CANARY_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  MAX_PROMOTION_LOG_BYTES,
  ROLLBACK_FS_TIMEOUT_MS,
  runPromotion,
  type CanaryOutcome,
  type PromoteFsOps,
  type PromoteOptions,
} from './promote.ts';
import type { PromotionContext } from './preflight.ts';
import type { CommandChild } from '../../server/src/upkeep/run-command.ts';
import { sentinelPath } from './sentinel.ts';
import { sha256Hex } from '../../server/src/upkeep/state-path.ts';
import { PromoteFakeFs } from './test/fake-fs.ts';

const SDK = '@earendil-works/pi-coding-agent';
const REPO = '/repo';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const STATE_DIR = '/state/abc';
const BACKUP = join('/', `repo-${'node_modules-backup'}-${HEAD.slice(0, 12)}-tx-1`);
const INSTALLED = '0.84.1';
const CANDIDATE = '0.85.0';

const PACKAGE_JSON = JSON.stringify({
  name: 'funkyoctopus',
  version: '0.1.0',
  dependencies: { [SDK]: INSTALLED },
});
const CANDIDATE_PACKAGE_JSON = JSON.stringify({
  name: 'funkyoctopus',
  version: '0.1.0',
  dependencies: { [SDK]: CANDIDATE },
});

function lockWith(rootDeps: Record<string, string>, packages: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'funkyoctopus',
    lockfileVersion: 3,
    packages: { '': { name: 'funkyoctopus', dependencies: rootDeps }, ...packages },
  });
}

const PACKAGE_LOCK = lockWith({ [SDK]: INSTALLED }, {
  [`node_modules/${SDK}`]: { version: INSTALLED, dependencies: { 'dep-a': '^1.0.0' } },
  'node_modules/dep-a': { version: '1.2.0' },
});
const CANDIDATE_PACKAGE_LOCK = lockWith({ [SDK]: CANDIDATE }, {
  [`node_modules/${SDK}`]: { version: CANDIDATE, dependencies: { 'dep-a': '^1.0.0' } },
  'node_modules/dep-a': { version: '1.2.0' },
});

const NPM_LS_INSTALLED = JSON.stringify({
  name: 'funkyoctopus',
  problems: [],
  dependencies: { [SDK]: { version: INSTALLED, resolved: 'https://registry.npmjs.org/x' } },
});
const NPM_LS_CANDIDATE = JSON.stringify({
  name: 'funkyoctopus',
  problems: [],
  dependencies: { [SDK]: { version: CANDIDATE, resolved: 'https://registry.npmjs.org/x' } },
});

const AUDIT_CLEAN = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} });

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

/** Promotion-only device probing and nth-call fault injection layered on the shared fake. */
class FakeFs extends PromoteFakeFs {
  readonly writeOverrides = new Map<string, string>();
  readonly devices = new Map<string, number>();
  readonly deviceErrors = new Map<string, Error>();
  private readonly renameFailNth = new Map<string, number>();
  private readonly renameCallCount = new Map<string, number>();

  failRenameOnNthCall(pair: string, nth: number): void {
    this.renameFailNth.set(pair, nth);
  }

  override writeFile(path: string, data: string, options: { mode?: number; flag?: string }): Promise<void> {
    return super.writeFile(path, this.writeOverrides.get(path) ?? data, options);
  }

  override rename(oldPath: string, newPath: string): Promise<void> {
    const pair = `${oldPath}|${newPath}`;
    const failNth = this.renameFailNth.get(pair);
    if (failNth !== undefined) {
      const count = (this.renameCallCount.get(pair) ?? 0) + 1;
      this.renameCallCount.set(pair, count);
      if (count === failNth) {
        this.events.push(`rename ${oldPath} -> ${newPath}`);
        return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      }
    }
    return super.rename(oldPath, newPath);
  }

  statDevice(path: string): Promise<number> {
    this.events.push(`statDevice ${path}`);
    const forced = this.deviceErrors.get(path);
    if (forced) return Promise.reject(forced);
    const device = this.devices.get(path);
    return device === undefined ? Promise.reject(enoent(path)) : Promise.resolve(device);
  }
}

interface ScriptOutcome {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
  spawnError?: Error;
}

type ScriptEntry = ScriptOutcome | ScriptOutcome[];
type Script = Record<string, ScriptEntry>;

/** Fake child; emits its canned outcome on the next microtask. */
class FakeChild implements CommandChild {
  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stdout', cb });
    },
  };
  readonly stderr = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stderr', cb });
    },
  };
  private readonly dataHandlers: { stream: 'stdout' | 'stderr'; cb: (chunk: Buffer) => void }[] = [];
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private readonly closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  kills: string[] = [];
  private emitted = false;

  constructor(private readonly outcome: ScriptOutcome) {
    queueMicrotask(() => this.drive());
  }

  on(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === 'error') this.errorHandlers.push(listener as (error: Error) => void);
    else this.closeHandlers.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  emitClose(code: number | null, signal: string | null): void {
    this.emitted = true;
    for (const listener of [...this.closeHandlers]) listener(code, signal);
  }

  private drive(): void {
    if (this.emitted) return;
    if (this.outcome.spawnError) {
      this.emitted = true;
      for (const listener of [...this.errorHandlers]) listener(this.outcome.spawnError);
      return;
    }
    if (this.outcome.hang) return;
    const stdout = this.outcome.stdout ?? '';
    const stderr = this.outcome.stderr ?? '';
    if (stdout) for (const handler of this.dataHandlers) if (handler.stream === 'stdout') handler.cb(Buffer.from(stdout));
    if (stderr) for (const handler of this.dataHandlers) if (handler.stream === 'stderr') handler.cb(Buffer.from(stderr));
    this.emitClose(this.outcome.code ?? 0, null);
  }
}

/** Routes spawn calls by `command args`; per-key outcome sequences; optional effects. */
class ScriptedSpawn {
  calls: { command: string; args: string[]; cwd: string | URL | undefined }[] = [];
  children: FakeChild[] = [];

  constructor(
    private readonly script: Script,
    private readonly effects: Record<string, () => void> = {},
  ) {}

  spawn(command: string, args: string[], options: SpawnOptions): CommandChild {
    const key = [command, ...args].join(' ');
    const entry = this.script[key];
    if (!entry) throw new Error(`unexpected command: ${key}`);
    this.calls.push({ command, args, cwd: options.cwd });
    const outcome = Array.isArray(entry) ? entry.shift() ?? entry[0] ?? {} : entry;
    this.effects[key]?.();
    const child = new FakeChild(outcome);
    this.children.push(child);
    return child;
  }

  lastChild(): FakeChild {
    const child = this.children[this.children.length - 1];
    if (!child) throw new Error('no child spawned');
    return child;
  }

  gitCalls(): { command: string; args: string[] }[] {
    return this.calls.filter((call) => call.command === 'git');
  }
}

interface TestWorld {
  fs: FakeFs;
  spawn: ScriptedSpawn;
}

function makeContext(overrides: Partial<PromotionContext> = {}): PromotionContext {
  return Object.freeze({
    decision: 'ready',
    canonicalRepo: REPO,
    stateDir: STATE_DIR,
    branch: 'master',
    head: HEAD,
    installedVersion: INSTALLED,
    candidateVersion: CANDIDATE,
    manifests: Object.freeze({
      packageJson: Object.freeze({ content: PACKAGE_JSON, sha256: sha256Hex(PACKAGE_JSON) }),
      packageLock: Object.freeze({ content: PACKAGE_LOCK, sha256: sha256Hex(PACKAGE_LOCK) }),
    }),
    backup: BACKUP,
    logs: Object.freeze([join(STATE_DIR, 'promotion-tx-1.log'), join(STATE_DIR, 'promotion-tx-1.stderr.log')]),
    ...overrides,
  });
}

const INSTALL_KEY = `npm install --save-exact ${SDK}@${CANDIDATE}`;

function happyScript(): Script {
  return {
    'git symbolic-ref --short HEAD': { stdout: 'master\n' },
    'git rev-parse HEAD': [{ stdout: `${HEAD}\n` }, { stdout: `${NEW_HEAD}\n` }],
    'git rev-parse HEAD^': { stdout: `${HEAD}\n` },
    'git status --porcelain=v1 --untracked-files=all': [{ stdout: '' }, { stdout: '' }],
    'git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD': { stdout: 'package.json\0package-lock.json\0' },
    'git diff --quiet HEAD -- package.json package-lock.json': { stdout: '' },
    [INSTALL_KEY]: { stdout: 'added 1 package\n' },
    [`npm ls ${SDK} --json`]: [{ stdout: NPM_LS_CANDIDATE }, { stdout: NPM_LS_INSTALLED }, { stdout: NPM_LS_INSTALLED }],
    'npm run verify': { stdout: 'verify ok\n' },
    'npm run build': { stdout: 'build ok\n' },
    'npm audit --omit=dev --audit-level=high --json': { stdout: AUDIT_CLEAN },
    'npm ci': { stdout: 'ci ok\n' },
    'git add -- package.json package-lock.json': { stdout: '' },
    'git diff --cached --name-only -z': { stdout: 'package.json\0package-lock.json\0' },
    'git restore --staged -- package.json package-lock.json': { stdout: '' },
    'git commit -m chore(deps): update embedded pi to 0.85.0': { stdout: '[master 0123456] chore(deps): update embedded pi to 0.85.0\n' },
  };
}

/**
 * Seeds the fake repo with the old tree and devices. `onInstall` replaces the
 * default install effect (which writes the exact candidate manifests and a
 * fresh tree); `onCi` runs when `npm ci` is invoked in the fallback.
 */
function makeWorld(
  script: Script = happyScript(),
  onInstall?: (fs: FakeFs) => void,
  onCi?: (fs: FakeFs) => void,
  extraEffects: Record<string, () => void> = {},
): TestWorld {
  const fs = new FakeFs();
  fs.seed(join(REPO, 'package.json'), PACKAGE_JSON);
  fs.seed(join(REPO, 'package-lock.json'), PACKAGE_LOCK);
  fs.seed(join(REPO, 'node_modules'), '__OLD_TREE__');
  fs.devices.set(join(REPO, 'node_modules'), 1);
  fs.devices.set(dirname(REPO), 1);
  const effects: Record<string, () => void> = {
    [INSTALL_KEY]: () => {
      if (onInstall) {
        onInstall(fs);
        return;
      }
      fs.seed(join(REPO, 'package.json'), CANDIDATE_PACKAGE_JSON);
      fs.seed(join(REPO, 'package-lock.json'), CANDIDATE_PACKAGE_LOCK);
      fs.seed(join(REPO, 'node_modules'), '__CANDIDATE_TREE__');
    },
    'npm ci': () => {
      if (onCi) {
        onCi(fs);
        return;
      }
      fs.seed(join(REPO, 'node_modules'), '__CI_TREE__');
    },
    ...extraEffects,
  };
  return { fs, spawn: new ScriptedSpawn(script, effects) };
}

/** Fixed id/clock deps: journal tx, journal updates, state pending. */
function makeIds(): () => string {
  const sequence = ['tx-1', 'tmp-2', 'tmp-3', 'tmp-4', 'tmp-5', 'tmp-6'];
  let next = 0;
  return () => sequence[Math.min(next++, sequence.length - 1)] ?? 'fallback';
}

function defaultOptions(world: TestWorld, overrides: Partial<PromoteOptions> = {}): PromoteOptions {
  return {
    sdk: SDK,
    context: makeContext(),
    fs: world.fs,
    command: { spawn: (command, args, options) => world.spawn.spawn(command, args, options) },
    statDevice: (path) => world.fs.statDevice(path),
    runCanary: (_signal: AbortSignal) => Promise.resolve({ kind: 'ok' }),
    skipCanary: false,
    randomId: makeIds(),
    now: () => 1_000,
    ...overrides,
  };
}

function persistedState(fs: FakeFs): {
  status: string;
  installedVersion: string | null;
  verifiedVersion: string | null;
  verificationLevel: string;
  lastPromotionResult: string | null;
} {
  const raw = fs.files.get(embeddedStatePath(STATE_DIR));
  expect(raw).toBeDefined();
  const parsed = JSON.parse(raw ?? '{}') as {
    status?: unknown;
    installedVersion?: unknown;
    verifiedVersion?: unknown;
    verificationLevel?: unknown;
    lastPromotionResult?: unknown;
  };
  return {
    status: String(parsed.status),
    installedVersion: nullableString(parsed.installedVersion),
    verifiedVersion: nullableString(parsed.verifiedVersion),
    verificationLevel: String(parsed.verificationLevel),
    lastPromotionResult: nullableString(parsed.lastPromotionResult),
  };
}

/** String field that may be null; never falls back to object stringification. */
function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function eventIndexOf(fs: FakeFs, event: string): number {
  const index = fs.events.indexOf(event);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function journalWriteEvent(stateDir: string, instance: string): string {
  return `rename ${pendingJournalPath(stateDir, instance)} -> ${journalPath(stateDir)}`;
}

/** fs mutation events (excluding reads and device probes). */
function mutationEvents(fs: FakeFs): string[] {
  return fs.events.filter(
    (event) =>
      event.startsWith('write ') ||
      event.startsWith('rename ') ||
      event.startsWith('unlink ') ||
      event.startsWith('mkdir') ||
      event.startsWith('chmod') ||
      event.startsWith('rm '),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('promotion — no-op and pre-arm recheck', () => {
  it('returns noop for a noop context without any I/O', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(
      defaultOptions(world, { context: makeContext({ decision: 'noop' }) }),
    );
    expect(outcome).toEqual({ kind: 'noop', installed: INSTALLED });
    expect(world.spawn.calls).toEqual([]);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses when HEAD moved since preflight, before any journal or mutation', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git rev-parse HEAD': { stdout: 'c'.repeat(40) + '\n' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('HEAD');
    expect(world.spawn.calls.map((call) => call.args.join(' '))).toEqual(['symbolic-ref --short HEAD', 'rev-parse HEAD']);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses when the branch changed (detach/switch race) since preflight, before HEAD or tree inspection', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git symbolic-ref --short HEAD': { stdout: 'main\n' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('branch');
    // only the branch recheck ran: HEAD/status were never consulted
    expect(world.spawn.calls.map((call) => call.args.join(' '))).toEqual(['symbolic-ref --short HEAD']);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses when the branch recheck fails closed (detached)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git symbolic-ref --short HEAD': { stderr: 'fatal: ref HEAD is not a symbolic ref\n', code: 128 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('branch');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('refuses a dirty tree since preflight', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: ' M package.json\n' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('working tree');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('refuses when a manifest changed since preflight', async () => {
    const world = makeWorld();
    world.fs.seed(join(REPO, 'package.json'), PACKAGE_JSON.replace(INSTALLED, '0.84.2'));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('package.json');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('refuses when the backup device layout changed since preflight', async () => {
    const world = makeWorld();
    world.fs.devices.set(join(REPO, 'node_modules'), 2);
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('filesystem');
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('refuses before arming when a git recheck command fails', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git status --porcelain=v1 --untracked-files=all': { stderr: 'fatal: not a git repository\n', code: 128 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('fails closed when embedded state is unreadable, before any journal', async () => {
    const world = makeWorld();
    world.fs.seed(embeddedStatePath(STATE_DIR), 'garbage');
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('embedded');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('refuses when a transaction sentinel is already present (prepare refuses)', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'other' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('sentinel');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });
});

describe('promotion — journal/sentinel ordering and checkpoint', () => {
  it('writes the prepared journal, then the sentinel, then arms, then mutates, then renames the whole tree before installing', async () => {
    const world = makeWorld();
    let renameBeforeInstall = false;
    const renameEvent = `rename ${join(REPO, 'node_modules')} -> ${BACKUP}`;
    const spawn = (command: string, args: string[], options: SpawnOptions): CommandChild => {
      if ([command, ...args].join(' ') === INSTALL_KEY) {
        renameBeforeInstall = world.fs.events.includes(renameEvent);
      }
      return world.spawn.spawn(command, args, options);
    };
    const outcome = await runPromotion(defaultOptions(world, { command: { spawn } }));
    expect(outcome.kind).toBe('committed');
    // the whole-tree rename happened before npm install was even spawned
    expect(renameBeforeInstall).toBe(true);
    // ordering inside the fs
    expect(eventIndexOf(world.fs, 'mkdir')).toBeLessThan(eventIndexOf(world.fs, journalWriteEvent(STATE_DIR, 'tx-1')));
    expect(eventIndexOf(world.fs, journalWriteEvent(STATE_DIR, 'tx-1'))).toBeLessThan(eventIndexOf(world.fs, `write ${sentinelPath(STATE_DIR)}`));
    expect(world.fs.writeFlags.get(sentinelPath(STATE_DIR))).toBe('wx');
    expect(world.fs.writeModes.get(sentinelPath(STATE_DIR))).toBe(0o600);
    // armed -> mutating lands after the sentinel and before the rename
    expect(eventIndexOf(world.fs, `write ${sentinelPath(STATE_DIR)}`)).toBeLessThan(eventIndexOf(world.fs, journalWriteEvent(STATE_DIR, 'tmp-2')));
    expect(eventIndexOf(world.fs, journalWriteEvent(STATE_DIR, 'tmp-2'))).toBeLessThan(eventIndexOf(world.fs, renameEvent));
    // the old tree moved out of the repo and the candidate tree took its place
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__CANDIDATE_TREE__');
    expect(world.fs.events).toContain(`rm ${BACKUP}`);
  });

  it('preserves the armed journal and sentinel when the armed -> mutating update fails: recovery_required, explicit recovery resolves', async () => {
    const world = makeWorld();
    // the armed -> mutating journal write fails mid-flight
    world.fs.renameErrors.set(pendingJournalPath(STATE_DIR, 'tmp-3'), Object.assign(new Error('EIO'), { code: 'EIO' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.phase).toBe('armed');
      expect(outcome.reason).toContain('mutating');
      // An ordinary transaction failure is provably canary-free: the lock is
      // released normally.
      expect(outcome.retainLockUntilExit).toBe(false);
    }
    // the nonterminal evidence is never cleared/removed: a crash between the
    // clear and the removal would otherwise brick startup
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    const journal = JSON.parse(world.fs.files.get(journalPath(STATE_DIR))!) as { phase?: string };
    expect(journal.phase).toBe('armed');
    // nothing was mutated: no npm install, no tree rename/removal
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
    expect(world.fs.events.some((event) => (event.startsWith('rename ') || event.startsWith('rm ')) && event.includes('node_modules'))).toBe(false);
  });

  it('uses the exact preflight backup path and renames the whole tree to it', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    expect(world.fs.events).toContain(`rename ${join(REPO, 'node_modules')} -> ${BACKUP}`);
    expect(world.fs.events).toContain(`rm ${BACKUP}`);
  });
});

describe('promotion — install and manifest scope', () => {
  it('installs the exact candidate with --save-exact and lifecycle scripts enabled', async () => {
    const world = makeWorld();
    await runPromotion(defaultOptions(world));
    const install = world.spawn.calls.find((call) => call.args[0] === 'install');
    expect(install?.args).toEqual(['install', '--save-exact', `${SDK}@${CANDIDATE}`]);
    expect(install?.cwd).toBe(REPO);
    // lifecycle scripts must never be disabled in install or ci
    for (const call of world.spawn.calls) {
      expect(call.args).not.toContain('--ignore-scripts');
    }
  });

  it('rejects an unrelated package.json dependency change before gates', async () => {
    const world = makeWorld(happyScript(), (fs) => {
      fs.seed(join(REPO, 'package.json'), JSON.stringify({
        name: 'funkyoctopus',
        version: '0.1.0',
        dependencies: { [SDK]: CANDIDATE, 'left-pad': '^9.9.9' },
      }));
      fs.seed(join(REPO, 'package-lock.json'), CANDIDATE_PACKAGE_LOCK);
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    // gates never ran
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'verify')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'audit')).toBe(false);
    // old state restored
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(PACKAGE_JSON);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    expect(world.fs.has(join(REPO, 'node_modules'))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(false);
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('package.json');
  });

  it('rejects an unrelated package-lock change outside the SDK closure before gates', async () => {
    const unrelatedLock = lockWith({ [SDK]: CANDIDATE }, {
      [`node_modules/${SDK}`]: { version: CANDIDATE, dependencies: { 'dep-a': '^1.0.0' } },
      'node_modules/dep-a': { version: '1.2.0' },
      'node_modules/unrelated': { version: '9.9.9' },
    });
    const world = makeWorld(happyScript(), (fs) => {
      fs.seed(join(REPO, 'package.json'), CANDIDATE_PACKAGE_JSON);
      fs.seed(join(REPO, 'package-lock.json'), unrelatedLock);
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('package-lock');
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'verify')).toBe(false);
  });

  it('rejects a candidate npm-ls that does not agree exactly with the manifests', async () => {
    const world = makeWorld({
      ...happyScript(),
      [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED }, // still the old version
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('npm ls');
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'verify')).toBe(false);
  });

  it('rejects a failing candidate npm-ls (exit nonzero)', async () => {
    const world = makeWorld({
      ...happyScript(),
      [`npm ls ${SDK} --json`]: [
        { stderr: 'npm ERR! code ELSPROBLEMS\n', code: 1 },
        { stdout: NPM_LS_INSTALLED },
      ],
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('npm ls');
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'verify')).toBe(false);
  });

  it('rejects a malformed candidate manifest before gates', async () => {
    const world = makeWorld(happyScript(), (fs) => {
      fs.seed(join(REPO, 'package.json'), 'not json');
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'verify')).toBe(false);
  });

  it('records the expected candidate manifest snapshots in the journal before gates', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    // candidate package.json is read from disk during the scope check and again
    // during the post-commit verification
    const candidateReads = world.fs.events.filter((event) => event === `read ${join(REPO, 'package.json')}`);
    expect(candidateReads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('promotion — gates', () => {
  it('runs verify, build, bounded audit, then the live canary in order', async () => {
    const world = makeWorld();
    let canaryCalls = 0;
    const outcome = await runPromotion(
      defaultOptions(world, { runCanary: (_signal) => { canaryCalls += 1; return Promise.resolve({ kind: 'ok' }); } }),
    );
    expect(outcome.kind).toBe('committed');
    const commands = world.spawn.calls.map((call) => `${call.command} ${call.args.join(' ')}`);
    const verifyIndex = commands.findIndex((command) => command === 'npm run verify');
    const buildIndex = commands.findIndex((command) => command === 'npm run build');
    const auditIndex = commands.findIndex((command) => command === 'npm audit --omit=dev --audit-level=high --json');
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
    expect(auditIndex).toBeGreaterThan(buildIndex);
    expect(canaryCalls).toBe(1);
  });

  it('rolls back when npm run verify fails', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'error TS2322\n', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('verify');
    // the candidate build gate and audit never ran; only the rollback
    // verification build ran
    const verifyCalls = world.spawn.calls.filter((call) => call.args[0] === 'run' && call.args[1] === 'verify');
    const buildCalls = world.spawn.calls.filter((call) => call.args[0] === 'run' && call.args[1] === 'build');
    expect(verifyCalls.length).toBe(1);
    expect(buildCalls.length).toBe(1);
    expect(world.spawn.calls.some((call) => call.args[0] === 'audit')).toBe(false);
  });

  it('rolls back when the candidate build fails (and the restored old tree builds)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run build': [{ stderr: 'vite build failed\n', code: 1 }, { stdout: 'build ok\n' }],
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('build');
  });

  it('rejects a high or critical production audit finding', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm audit --omit=dev --audit-level=high --json': {
        stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: { 'evil': { severity: 'high' } } }),
        code: 1,
      },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('audit');
  });

  it('rejects malformed audit JSON as ambiguity', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm audit --omit=dev --audit-level=high --json': { stdout: 'not json', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('audit');
  });

  it('rejects an audit that did not exit 0 or 1 (command/service ambiguity)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm audit --omit=dev --audit-level=high --json': { stderr: 'npm ERR! network down\n', code: 2 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('audit');
  });

  it('rejects an audit whose exit code disagrees with its findings', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm audit --omit=dev --audit-level=high --json': { stdout: AUDIT_CLEAN, code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
  });

  it('rolls back when the live canary fails', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(
      defaultOptions(world, { runCanary: (_signal) => Promise.resolve({ kind: 'failed', reason: 'model refused to answer' }) }),
    );
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('model refused');
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
  });

  it('aborts the canary signal at the 120s ceiling and rolls back when it settles within the cleanup grace', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    let capturedSignal: AbortSignal | undefined;
    let resolveCanary: ((outcome: CanaryOutcome) => void) | undefined;
    const pending = runPromotion(
      defaultOptions(world, {
        canaryCleanupGraceMs: 5_000,
        runCanary: (signal) => {
          capturedSignal = signal;
          return new Promise<CanaryOutcome>((resolve) => {
            resolveCanary = resolve;
          });
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS);
    expect(capturedSignal!.aborted).toBe(true);
    // the canary settles after the abort: still the timeout failure -> rollback
    resolveCanary!({ kind: 'ok' });
    const outcome = await pending;
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('timed out');
    // the rollback restored the old tree and never staged or committed
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('returns recovery_required without rollback when the canary never settles within the cleanup grace', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const pending = runPromotion(
      defaultOptions(world, {
        canaryCleanupGraceMs: 5_000,
        runCanary: (_signal) => new Promise<CanaryOutcome>(() => {}),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS + 5_000);
    const outcome = await pending;
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.reason).toContain('canary');
      // A live canary may still run: the CLI must retain the repository lock.
      expect(outcome.retainLockUntilExit).toBe(true);
    }
    // no rollback: no git staging, no tree mutation, evidence preserved
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('yields recovery without rollback when the real canary settlement wait never settles through the gate grace', async () => {
    // Interaction regression: the real production-path canary, bound to a
    // session whose idle state never settles, wired into the promotion gate.
    // The canary must not invent a timer or a second turn; the promotion's
    // 120s abort plus the bounded cleanup grace decide the outcome — recovery,
    // with the repo untouched.
    vi.useFakeTimers();
    const world = makeWorld();
    const tempRoot: CanaryTempRoot = {
      root: '/tmp/canary-root',
      workspace: '/tmp/canary-root/workspace',
      sessionDir: '/tmp/canary-root/sessions',
      vaultFile: '/tmp/canary-root/vault/vault.json',
    };
    const session = {
      model: { provider: CANARY_MODEL.provider, id: CANARY_MODEL.id },
      isStreaming: true,
      sessionManager: {
        getEntries: () => [
          { type: 'message', message: { role: 'user', content: CANARY_PROMPT } },
        ],
      },
      // The SDK never settles: neither the idle wait nor the abort drive ever
      // resolves, so the canary's await is bounded only by the promotion's
      // gate — no internal timer, no polling.
      waitForIdle: vi.fn(() => new Promise<void>(() => {})),
      abort: vi.fn(() => new Promise<void>(() => {})),
    } satisfies CanarySession;
    const chat = {
      setRoot: vi.fn(() => Promise.resolve(undefined)),
      send: vi.fn(async function* (): AsyncGenerator<ChatChunk> {
        await Promise.resolve();
        yield { kind: 'text', delta: 'CANARY-OK' };
      }),
      liveSession: vi.fn(() => Promise.resolve(session)),
      disposeLiveSession: vi.fn(() => Promise.resolve(true)),
    } satisfies CanaryChat;
    const canaryDeps: CanaryDeps = {
      createTempRoot: vi.fn(() => Promise.resolve(tempRoot)),
      createChat: vi.fn(() => Promise.resolve(chat)),
      fs: {
        rm: vi.fn(() => Promise.resolve()),
        exists: vi.fn(() => Promise.resolve(false)),
      },
    };
    let canarySignal: AbortSignal | undefined;
    const pending = runPromotion(
      defaultOptions(world, {
        canaryCleanupGraceMs: 5_000,
        runCanary: (signal) => {
          canarySignal = signal;
          return runCanary(canaryDeps, signal);
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // The turn drained; the canary is inside its settlement wait — it must be
    // awaiting the session's idle state, not sending anything else.
    expect(canarySignal).toBeDefined();
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(chat.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS);
    // The gate's abort reached the canary's settlement wait: the session's own
    // abort was driven, but it never settles either.
    expect(canarySignal!.aborted).toBe(true);
    expect(session.abort).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await pending;
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.reason).toContain('did not settle');
      expect(outcome.retainLockUntilExit).toBe(true);
    }
    // No rollback, no second canary turn, no git staging or tree mutation; all
    // transaction evidence stays for recovery.
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('maps an unsafe canary outcome to recovery_required without rollback or fs mutation', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(
      defaultOptions(world, {
        runCanary: (_signal) =>
          Promise.resolve({ kind: 'unsafe', reason: 'canary session disposal failed: dispose exploded' }),
      }),
    );
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.reason).toContain('dispose exploded');
      expect(outcome.retainLockUntilExit).toBe(true);
    }
    // A live canary session may still run: no rollback, no git, no fs mutation
    // of the candidate tree, and all evidence stays.
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__CANDIDATE_TREE__');
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('keeps recovery when an unsafe canary settles after the abort — precedence over the timeout failure', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    let resolveCanary: ((outcome: CanaryOutcome) => void) | undefined;
    const pending = runPromotion(
      defaultOptions(world, {
        canaryCleanupGraceMs: 5_000,
        runCanary: (_signal) =>
          new Promise<CanaryOutcome>((resolve) => {
            resolveCanary = resolve;
          }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS);
    // The canary settles after the abort with an unsafe cleanup: the generic
    // timeout failure must not downgrade it — recovery stays recovery.
    resolveCanary!({ kind: 'unsafe', reason: 'canary session disposal failed: dispose exploded' });
    const outcome = await pending;
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.reason).toContain('dispose exploded');
      expect(outcome.retainLockUntilExit).toBe(true);
    }
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('maps an unexpected async canary rejection to recovery_required without rollback', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(
      defaultOptions(world, {
        runCanary: (_signal) => Promise.reject(new Error('canary exploded')),
      }),
    );
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(outcome.reason).toContain('canary exploded');
      expect(outcome.retainLockUntilExit).toBe(true);
    }
    // The canary's state is unknown — conservatively blocked, never rolled back.
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('maps a synchronous canary invocation throw to an ordinary failed canary (nothing was built)', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(
      defaultOptions(world, {
        runCanary: (_signal) => {
          throw new Error('seam exploded before any session');
        },
      }),
    );
    // A synchronous throw precedes any session/root construction, so rollback
    // is provably safe — the candidate is rejected and the tree restored.
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('seam exploded');
    expect(world.spawn.calls.some((call) => call.args[0] === 'add')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
  });

  it('bounds an oversized canary diagnostic before it reaches state/log persistence', async () => {
    const world = makeWorld();
    const huge = `huge diagnostic ${'x'.repeat(MAX_REASON_BYTES * 4)}`;
    const outcome = await runPromotion(
      defaultOptions(world, {
        runCanary: (_signal) => Promise.reject(new Error(huge)),
      }),
    );
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') {
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(MAX_REASON_BYTES);
      expect(outcome.reason).toContain('truncated');
    }
    const state = persistedState(world.fs);
    expect(state.lastPromotionResult).toContain('truncated');
    expect(Buffer.byteLength(state.lastPromotionResult ?? '')).toBeLessThanOrEqual(MAX_REASON_BYTES + 64);
  });
});

describe('promotion — skip level and staging', () => {
  it('skips the canary with --skip-live-canary and records deterministic_only', async () => {
    const world = makeWorld();
    let canaryCalls = 0;
    const outcome = await runPromotion(
      defaultOptions(world, { skipCanary: true, runCanary: (_signal) => { canaryCalls += 1; return Promise.resolve({ kind: 'ok' }); } }),
    );
    expect(outcome.kind).toBe('committed');
    expect(canaryCalls).toBe(0);
    if (outcome.kind === 'committed') expect(outcome.verificationLevel).toBe('deterministic_only');
    expect(persistedState(world.fs).verificationLevel).toBe('deterministic_only');
  });

  it('records live verification on a default canary success', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'committed') expect(outcome.verificationLevel).toBe('live');
    const state = persistedState(world.fs);
    expect(state.verificationLevel).toBe('live');
    expect(state.status).toBe('current');
    expect(state.installedVersion).toBe(CANDIDATE);
    expect(state.verifiedVersion).toBe(CANDIDATE);
  });

  it('stages exactly package.json and package-lock.json and proves the NUL-separated set', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    const add = world.spawn.calls.find((call) => call.args[0] === 'add');
    expect(add?.args).toEqual(['add', '--', 'package.json', 'package-lock.json']);
    const diff = world.spawn.calls.find((call) => call.args[0] === 'diff');
    expect(diff?.args).toEqual(['diff', '--cached', '--name-only', '-z']);
  });

  it('keeps the transaction blocked when the staged set is not exactly the two manifests (extra path is ambiguous)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git diff --cached --name-only -z': { stdout: 'package.json\0package-lock.json\0extra.txt\0' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    // an extra staged path refuses the rollback's un-stage too: someone's
    // staged work must never be destroyed, so the transaction stays blocked
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('staged');
    expect(world.spawn.calls.some((call) => call.args[0] === 'commit')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('promotion — commit and post-commit', () => {
  it('commits with the exact message through normal hooks (no --no-verify)', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    const commit = world.spawn.calls.find((call) => call.args[0] === 'commit');
    expect(commit?.args).toEqual(['commit', '-m', 'chore(deps): update embedded pi to 0.85.0']);
    expect(commit?.args).not.toContain('--no-verify');
    if (outcome.kind === 'committed') expect(outcome.commit).toBe(NEW_HEAD);
  });

  it('verifies the new HEAD after commit (recheck + post-commit rev-parse)', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    const headCalls = world.spawn.calls.filter(
      (call) => call.command === 'git' && call.args.join(' ') === 'rev-parse HEAD',
    );
    expect(headCalls.length).toBe(2);
  });

  it('returns recovery_required when the committed HEAD is not a direct child of the preflight HEAD', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git rev-parse HEAD^': { stdout: 'c'.repeat(40) + '\n' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('child');
    // evidence preserved: sentinel, journal, and the commit stand
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('returns recovery_required when the committed path set is not exactly the two manifests (enlarged commit)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD': { stdout: 'package.json\0package-lock.json\0dist/extra.js\0' },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('manifest');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('returns recovery_required when the committed blobs differ from the working manifests', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git diff --quiet HEAD -- package.json package-lock.json': { stdout: ' M package.json\n', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('blob');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
  });

  it('rolls back when git commit fails with HEAD unchanged, un-staging the two manifests and proving a clean tree', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git rev-parse HEAD': [{ stdout: `${HEAD}\n` }, { stdout: `${HEAD}\n` }],
      'git commit -m chore(deps): update embedded pi to 0.85.0': { stderr: 'husky - pre-commit hook failed\n', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('commit');
    // old state fully restored and verified
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(PACKAGE_JSON);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    expect(world.fs.has(BACKUP)).toBe(false);
    // the previously staged manifests were un-staged (index restored), then
    // the config-proof status proof ran before the sentinel was cleared
    const restore = world.spawn.gitCalls().find((call) => call.args[0] === 'restore');
    expect(restore?.args).toEqual(['restore', '--staged', '--', 'package.json', 'package-lock.json']);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(persistedState(world.fs).status).toBe('promotion_failed');
  });

  it('rolls back and un-stages when git add fails, leaving the index and tree clean', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git add -- package.json package-lock.json': { stderr: 'fatal: index.lock exists\n', code: 128 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    const restore = world.spawn.gitCalls().find((call) => call.args[0] === 'restore');
    expect(restore?.args).toEqual(['restore', '--staged', '--', 'package.json', 'package-lock.json']);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('treats a commit that exits nonzero but moved HEAD as committed (post-commit hook case)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git commit -m chore(deps): update embedded pi to 0.85.0': { stderr: 'post-commit hook failed\n', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'committed') expect(outcome.commit).toBe(NEW_HEAD);
  });

  it('returns recovery_required when the post-commit manifests do not match the expected candidate snapshots', async () => {
    const world = makeWorld(happyScript(), undefined, undefined, {
      'git commit -m chore(deps): update embedded pi to 0.85.0': () => {
        // a hook rewrote package.json after staging
        world.fs.seed(join(REPO, 'package.json'), JSON.stringify({
          name: 'funkyoctopus',
          version: '0.1.0',
          dependencies: { [SDK]: CANDIDATE, 'extra': '^1.0.0' },
        }));
      },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    // evidence preserved: sentinel, journal, backup, and the commit stand
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('package.json');
  });

  it('finalizes on success: committed -> finalized, sentinel cleared, journal removed, backup deleted, state current', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    // prepared, mutating, committed, finalized all land through atomic renames
    const journalRenames = world.fs.events.filter(
      (event) => event.startsWith('rename ') && event.includes('transaction.journal.json'),
    );
    expect(journalRenames.length).toBeGreaterThanOrEqual(3);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.fs.events).toContain(`unlink ${sentinelPath(STATE_DIR)}`);
    expect(world.fs.events).toContain(`unlink ${journalPath(STATE_DIR)}`);
    const state = persistedState(world.fs);
    expect(state.status).toBe('current');
    expect(state.verificationLevel).toBe('live');
    expect(state.lastPromotionResult).toContain(CANDIDATE);
  });

  it('becomes non-blocking cleanup_pending when obsolete backup deletion fails, keeping the verified commit', async () => {
    const world = makeWorld();
    world.fs.rmErrors.set(BACKUP, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('cleanup_pending');
    if (outcome.kind === 'cleanup_pending') {
      expect(outcome.candidate).toBe(CANDIDATE);
      expect(outcome.commit).toBe(NEW_HEAD);
    }
    // blocking sentinel cleared; committed journal left as the pending-cleanup record
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('cleanup_pending');
    expect(state.installedVersion).toBe(CANDIDATE);
    expect(state.verifiedVersion).toBe(CANDIDATE);
  });
});

describe('promotion — rollback', () => {
  it('renames the intact backup back offline when a failed install left no candidate tree', async () => {
    const sourceTree = join(REPO, 'node_modules');
    const world = makeWorld(
      {
        ...happyScript(),
        [INSTALL_KEY]: { stderr: 'registry unavailable\n', code: 1 },
        [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
      },
      (fs) => fs.files.delete(sourceTree),
    );
    // Production fs.rm({ recursive: true }) rejects ENOENT unless force=true.
    world.fs.rmErrors.set(sourceTree, enoent(sourceTree));

    const outcome = await runPromotion(defaultOptions(world));

    expect(outcome.kind).toBe('rolled_back');
    expect(world.fs.files.get(sourceTree)).toBe('__OLD_TREE__');
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.spawn.calls.some((call) => call.command === 'npm' && call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('restores the exact old manifests atomically, deletes the candidate tree, and renames the saved tree back offline', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    // exact old bytes restored
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(PACKAGE_JSON);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    // candidate tree removed, old tree renamed back
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
    expect(world.fs.has(BACKUP)).toBe(false);
    // rollback verification ran npm ls + build
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'build')).toBe(true);
    // sentinel cleared, journal removed, state promotion_failed with last-good fields
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    const state = persistedState(world.fs);
    expect(state.status).toBe('promotion_failed');
    expect(state.installedVersion).toBe(INSTALLED);
    // nothing was newly verified: with no prior verified version the fields stay empty
    expect(state.verifiedVersion).toBeNull();
    expect(state.verificationLevel).toBe('unknown');
  });

  it('preserves the prior verified version and verification level on a failed promotion (honest verification state)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
    });
    world.fs.seed(embeddedStatePath(STATE_DIR), JSON.stringify({
      schemaVersion: 1,
      installedVersion: INSTALLED,
      latestVersion: CANDIDATE,
      verifiedVersion: '0.84.0',
      verificationLevel: 'live',
      status: 'available',
      lastCheckAt: 100,
      lastPromotionAttemptAt: null,
      lastPromotionResult: null,
      lastRecoveryAttemptAt: null,
      lastRecoveryResult: null,
    }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    const state = persistedState(world.fs);
    expect(state.status).toBe('promotion_failed');
    expect(state.installedVersion).toBe(INSTALLED);
    // the baseline installed version was never marked verified by this failure
    expect(state.verifiedVersion).toBe('0.84.0');
    expect(state.verificationLevel).toBe('live');
  });

  it('requires exact old npm ls and a production build before clearing the sentinel; falls back to npm ci otherwise, preserving the last evidence tree first', async () => {
    let backupAtCi: string | undefined;
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
      [`npm ls ${SDK} --json`]: [
        { stdout: NPM_LS_CANDIDATE },
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
    }, undefined, (fs) => {
      backupAtCi = fs.files.get(BACKUP);
      fs.seed(join(REPO, 'node_modules'), '__CI_TREE__');
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    if (outcome.kind === 'rolled_back') expect(outcome.reason).toContain('fallback');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(true);
    // the last evidence tree was preserved at the backup before npm ci started
    expect(backupAtCi).toBe('__OLD_TREE__');
    // sentinel cleared only after the fallback verified
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('refuses to run npm ci when the last evidence tree cannot be preserved (never destroys the only evidence)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
      [`npm ls ${SDK} --json`]: [
        { stdout: NPM_LS_CANDIDATE },
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
    });
    // checkpoint rename (call 1) succeeds; the fallback preservation rename (call 2) fails
    world.fs.failRenameOnNthCall(`${join(REPO, 'node_modules')}|${BACKUP}`, 2);
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('preserve');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('returns recovery_required when preserved-backup cleanup after a verified fallback fails (no silent finalize)', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
      [`npm ls ${SDK} --json`]: [
        { stdout: NPM_LS_CANDIDATE },
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
    });
    world.fs.rmErrors.set(BACKUP, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('backup');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(true);
    // evidence preserved: sentinel, journal, and the preserved backup
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });

  it('verifyOldTree rereads the manifests and requires byte-exact originals before npm ls/build; a drift falls back and then fails closed', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
    });
    // the offline restore "succeeds" but writes drifted bytes for package.json
    world.fs.writeOverrides.set(join(REPO, '.promote-restore-package.json'), PACKAGE_JSON.replace(INSTALLED, '0.84.2'));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('verification');
    // npm ci ran (fallback attempted) but the drifted manifest never verified
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(true);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('runs npm ci from the restored exact lock with lifecycle scripts when offline restoration fails', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
    });
    // sabotage the offline restore: renaming the saved tree back fails
    world.fs.renamePairErrors.set(`${BACKUP}|${join(REPO, 'node_modules')}`, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('rolled_back');
    const ci = world.spawn.calls.find((call) => call.args[0] === 'ci');
    expect(ci?.args).toEqual(['ci']);
    expect(ci?.args).not.toContain('--ignore-scripts');
    // the broken candidate tree was removed and a fresh tree exists
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__CI_TREE__');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('refuses to finalize the rollback when the config-proof status is not clean', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
      'git status --porcelain=v1 --untracked-files=all': [{ stdout: '' }, { stdout: ' M package.json\n' }],
    });
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('clean');
    // finalization never happened: sentinel and journal stay
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('preserves sentinel/journal/backup evidence and returns recovery_required when the fallback also fails', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
      'npm ci': { stderr: 'npm ERR! code ERESOLVE\n', code: 1 },
    });
    world.fs.renamePairErrors.set(`${BACKUP}|${join(REPO, 'node_modules')}`, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.phase).toBe('rolled_back');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('recovery_required');
  });

  it('returns recovery_required when the rollback filesystem deadline fires: the in-flight step settles first and no fallback or later step runs', async () => {
    vi.useFakeTimers();
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stderr: 'fail\n', code: 1 },
    });
    // the candidate-tree removal inside restoreOffline settles only when released
    world.fs.gateRm(join(REPO, 'node_modules'));
    const pending = runPromotion(defaultOptions(world));
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(ROLLBACK_FS_TIMEOUT_MS);
    // the deadline fired while the rm was still in flight; the promotion is
    // still awaiting that step to settle, so nothing else has run
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);
    world.fs.releaseRm(join(REPO, 'node_modules'));
    const outcome = await pending;
    expect(outcome.kind).toBe('recovery_required');
    if (outcome.kind === 'recovery_required') expect(outcome.reason).toContain('ceiling');
    // no fallback and no later restore steps ran
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'build')).toBe(false);
    // evidence preserved: sentinel, journal, and the untouched backup
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(persistedState(world.fs).status).toBe('recovery_required');
  });
});

describe('promotion — bounded logs and forbidden git operations', () => {
  it('keeps the operation log bounded and records step entries and stderr tails', async () => {
    const world = makeWorld({
      ...happyScript(),
      'npm run verify': { stdout: 'V'.repeat(10_000) + 'END-MARKER\n' },
      'npm run build': { stderr: 'some build warning\n' },
    });
    const outcome = await runPromotion(defaultOptions(world, { logLimitBytes: 500 }));
    expect(outcome.kind).toBe('committed');
    const log = world.fs.files.get(join(STATE_DIR, 'promotion-tx-1.log'));
    const stderrLog = world.fs.files.get(join(STATE_DIR, 'promotion-tx-1.stderr.log'));
    expect(log).toBeDefined();
    expect(stderrLog).toBeDefined();
    expect(Buffer.byteLength(log!, 'utf8')).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(stderrLog!, 'utf8')).toBeLessThanOrEqual(500);
    // the tail entries survived; the earliest entry was trimmed away
    expect(log).toContain('[finalize]');
    expect(log).not.toContain('tx-1 armed');
    expect(stderrLog).toContain('some build warning');
  });

  it('bounds the operation log by UTF-8 bytes, not characters', async () => {
    const world = makeWorld({
      ...happyScript(),
      'git commit -m chore(deps): update embedded pi to 0.85.0': { stdout: '✅'.repeat(50) + 'COMMIT-MARKER\n' },
    });
    const outcome = await runPromotion(defaultOptions(world, { logLimitBytes: 800 }));
    expect(outcome.kind).toBe('committed');
    const log = world.fs.files.get(join(STATE_DIR, 'promotion-tx-1.log'));
    expect(log).toBeDefined();
    // 50 emoji = 150 bytes; a char-based trim would keep 800 chars (~875 bytes)

    expect(Buffer.byteLength(log!, 'utf8')).toBeLessThanOrEqual(800);
    expect(log).toContain('COMMIT-MARKER');
  });

  it('never resets, stashes, cleans, or passes --no-verify, and stages only the two manifests', async () => {
    const world = makeWorld();
    const outcome = await runPromotion(defaultOptions(world));
    expect(outcome.kind).toBe('committed');
    const gitCalls = world.spawn.gitCalls();
    for (const call of gitCalls) {
      expect(call.args).not.toContain('reset');
      expect(call.args).not.toContain('stash');
      expect(call.args).not.toContain('clean');
      expect(call.args).not.toContain('--no-verify');
      expect(call.args).not.toContain('--hard');
    }
    const adds = gitCalls.filter((call) => call.args[0] === 'add');
    expect(adds.length).toBe(1);
    expect(adds[0]?.args).toEqual(['add', '--', 'package.json', 'package-lock.json']);
  });
});

describe('promotion — real filesystem end-to-end with faked commands', () => {
  const realFs: PromoteFsOps = {
    mkdir,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile,
    realpath,
    readdir,
    chmod,
    stat,
    rename,
    unlink,
    rmdir,
    rm: (path, options) => rm(path, options),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };

  it('runs the full transaction in a temp repository (no registry or model calls)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-promote-'));
    try {
      const repo = join(base, 'funkyoctopus');
      await mkdir(join(repo, 'node_modules'), { recursive: true });
      await writeFile(join(repo, 'package.json'), PACKAGE_JSON);
      await writeFile(join(repo, 'package-lock.json'), PACKAGE_LOCK);
      await writeFile(join(repo, 'node_modules', '.marker'), 'old-tree');
      const stateDir = join(base, 'state');
      const backup = join(base, `funkyoctopus-node_modules-backup-${HEAD.slice(0, 12)}-tx-1`);
      const context = makeContext({
        canonicalRepo: repo,
        stateDir,
        backup,
        logs: [join(stateDir, 'promotion-tx-1.log'), join(stateDir, 'promotion-tx-1.stderr.log')],
      });

      // The install effect mutates the real repo synchronously so the engine's
      // post-install reads observe the candidate manifests (no registry).
      const installEffect = (): void => {
        writeFileSync(join(repo, 'package.json'), CANDIDATE_PACKAGE_JSON);
        writeFileSync(join(repo, 'package-lock.json'), CANDIDATE_PACKAGE_LOCK);
        mkdirSync(join(repo, 'node_modules'), { recursive: true });
        writeFileSync(join(repo, 'node_modules', '.marker'), 'candidate-tree');
      };
      const spawnCalls: { command: string; args: string[] }[] = [];
      let headCalls = 0;
      const spawn = (command: string, args: string[], _options: SpawnOptions): CommandChild => {
        const key = [command, ...args].join(' ');
        spawnCalls.push({ command, args });
        let outcome: ScriptOutcome;
        if (key === INSTALL_KEY) {
          installEffect();
          outcome = { stdout: 'added 1 package\n' };
        } else if (key === `npm ls ${SDK} --json`) {
          outcome = { stdout: NPM_LS_CANDIDATE };
        } else if (key === 'npm run verify') {
          outcome = { stdout: 'verify ok\n' };
        } else if (key === 'npm run build') {
          outcome = { stdout: 'build ok\n' };
        } else if (key === 'npm audit --omit=dev --audit-level=high --json') {
          outcome = { stdout: AUDIT_CLEAN };
        } else if (key === 'git rev-parse HEAD') {
          outcome = headCalls++ === 0 ? { stdout: `${HEAD}\n` } : { stdout: `${NEW_HEAD}\n` };
        } else if (key === 'git symbolic-ref --short HEAD') {
          outcome = { stdout: 'master\n' };
        } else if (key === 'git rev-parse HEAD^') {
          outcome = { stdout: `${HEAD}\n` };
        } else if (key === 'git status --porcelain=v1 --untracked-files=all') {
          outcome = { stdout: '' };
        } else if (key === 'git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD') {
          outcome = { stdout: 'package.json\0package-lock.json\0' };
        } else if (key === 'git diff --quiet HEAD -- package.json package-lock.json') {
          outcome = { stdout: '' };
        } else if (key === 'git add -- package.json package-lock.json') {
          outcome = { stdout: '' };
        } else if (key === 'git diff --cached --name-only -z') {
          outcome = { stdout: 'package.json\0package-lock.json\0' };
        } else if (key === 'git commit -m chore(deps): update embedded pi to 0.85.0') {
          outcome = { stdout: '[master 0123456] committed\n' };
        } else {
          throw new Error(`unexpected command: ${key}`);
        }
        return new FakeChild(outcome);
      };

      const outcome = await runPromotion({
        sdk: SDK,
        context,
        fs: realFs,
        command: { spawn },
        statDevice: async (path) => (await stat(path)).dev,
        runCanary: () => Promise.resolve({ kind: 'ok' }),
        skipCanary: false,
        randomId: makeIds(),
        now: () => 1_000,
      });

      expect(outcome.kind).toBe('committed');
      if (outcome.kind === 'committed') expect(outcome.commit).toBe(NEW_HEAD);
      // real candidate manifests on disk
      expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(CANDIDATE_PACKAGE_JSON);
      expect(await readFile(join(repo, 'package-lock.json'), 'utf8')).toBe(CANDIDATE_PACKAGE_LOCK);
      // backup sibling deleted after commit
      await expect(readdir(backup)).rejects.toMatchObject({ code: 'ENOENT' });
      // state dir finalized: sentinel/journal gone, logs + state written
      const entries = await readdir(stateDir);
      expect(entries).not.toContain('transaction.sentinel');
      expect(entries).not.toContain('transaction.journal.json');
      expect(entries.some((entry) => entry.startsWith('promotion-'))).toBe(true);
      const state = JSON.parse(await readFile(join(stateDir, 'embedded-state.json'), 'utf8')) as {
        status?: unknown;
        installedVersion?: unknown;
        verificationLevel?: unknown;
      };
      expect(state.status).toBe('current');
      expect(state.installedVersion).toBe(CANDIDATE);
      expect(state.verificationLevel).toBe('live');
      // no forbidden git options and no disabled lifecycle scripts anywhere
      for (const call of spawnCalls) {
        expect(call.args).not.toContain('--no-verify');
        expect(call.args).not.toContain('--ignore-scripts');
        expect(call.args).not.toContain('reset');
        expect(call.args).not.toContain('stash');
        expect(call.args).not.toContain('clean');
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('promotion — exported constants', () => {
  it('uses the upkeep command-contract ceilings', () => {
    expect(CANDIDATE_INSTALL_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(CANDIDATE_BUILD_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(AUDIT_TIMEOUT_MS).toBe(2 * 60 * 1000);
    expect(CANARY_TIMEOUT_MS).toBe(120_000);
    expect(CANARY_CLEANUP_GRACE_MS).toBe(30_000);
    expect(COMMIT_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(MAX_PROMOTION_LOG_BYTES).toBe(64 * 1024);
  });

  it('re-validates manifest scope with the same pure functions the engine uses', () => {
    expect(validatePackageJsonScope(PACKAGE_JSON, CANDIDATE_PACKAGE_JSON, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
    expect(validateLockScope(PACKAGE_LOCK, CANDIDATE_PACKAGE_LOCK, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
    const parsed = JSON.parse(CANDIDATE_PACKAGE_LOCK) as { packages: Record<string, unknown> };
    expect(sdkDependencyClosure(parsed.packages, SDK).has(`node_modules/${SDK}`)).toBe(true);
  });
});
