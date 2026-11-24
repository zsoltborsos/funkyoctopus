/**
 * Phase-aware recovery engine tests (test-first).
 *
 * Hermetic crash-state coverage: every external effect goes through injected
 * seams (coordination fs, runCommand's spawn, the embedded-state reader).
 * No test touches a registry, a model, or the real repository. Journal and
 * sentinel states are seeded directly to simulate interruption at every
 * phase: before the checkpoint, after checkpoint/install/snapshots/staging,
 * after the exact commit before the phase record, committed cleanup-pending,
 * rolled_back mid-restore, orphan prepared, moved/wrong HEAD, wrong
 * parent/path/blob, invalid/mismatched evidence, backup/source presence
 * combinations, fallback success/failure, cleanup failure, disabled mode,
 * and idempotent re-runs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedStatePath } from '../../server/src/upkeep/embedded-state.ts';
import { journalPath, readJournal, readTransaction } from './journal.ts';
import { ROLLBACK_FS_TIMEOUT_MS } from './rollback.ts';
import { runRecovery, type RecoveryOptions } from './recover.ts';
import type { CommandChild } from '../../server/src/upkeep/run-command.ts';
import { sentinelPath } from './sentinel.ts';
import { sha256Hex } from '../../server/src/upkeep/state-path.ts';
import type { PromoteFsOps } from './promote.ts';
import { PromoteFakeFs as FakeFs } from './test/fake-fs.ts';

const SDK = '@earendil-works/pi-coding-agent';
const REPO = '/repo';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
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
    return new FakeChild(outcome);
  }
}

interface TestWorld {
  fs: FakeFs;
  spawn: ScriptedSpawn;
}

type JournalPhase = 'prepared' | 'armed' | 'mutating' | 'committed' | 'rolled_back' | 'finalized';

interface JournalSeed {
  transactionId?: string;
  phase?: JournalPhase;
  head?: string;
  canonicalPath?: string;
  verificationLevel?: 'live' | 'deterministic_only';
  installed?: string;
  candidate?: string;
  candidateManifests?: boolean;
  backup?: string;
  logs?: string[];
}

function makeJournal(overrides: JournalSeed = {}): Record<string, unknown> {
  const candidateManifests = overrides.candidateManifests ?? true;
  return {
    schemaVersion: 1,
    transactionId: overrides.transactionId ?? 'tx-1',
    phase: overrides.phase ?? 'mutating',
    createdAt: 1_000,
    repo: { canonicalPath: overrides.canonicalPath ?? REPO, head: overrides.head ?? HEAD, branch: 'master' },
    versions: { installed: overrides.installed ?? INSTALLED, candidate: overrides.candidate ?? CANDIDATE },
    verificationLevel: overrides.verificationLevel ?? 'live',
    manifests: {
      packageJson: { content: PACKAGE_JSON, sha256: sha256Hex(PACKAGE_JSON) },
      packageLock: { content: PACKAGE_LOCK, sha256: sha256Hex(PACKAGE_LOCK) },
      ...(candidateManifests
        ? {
            candidatePackageJson: { content: CANDIDATE_PACKAGE_JSON, sha256: sha256Hex(CANDIDATE_PACKAGE_JSON) },
            candidatePackageLock: { content: CANDIDATE_PACKAGE_LOCK, sha256: sha256Hex(CANDIDATE_PACKAGE_LOCK) },
          }
        : {}),
    },
    paths: {
      backup: overrides.backup ?? BACKUP,
      logs: overrides.logs ?? [join(STATE_DIR, 'promotion-tx-1.log'), join(STATE_DIR, 'promotion-tx-1.stderr.log')],
    },
  };
}

/** Seeds the journal (and optionally the sentinel) into the state dir. */
function seedTransaction(fs: FakeFs, journal: Record<string, unknown>, sentinel: boolean): void {
  fs.seed(journalPath(STATE_DIR), JSON.stringify(journal));
  if (sentinel) {
    fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: String(journal['transactionId']) }));
  }
}

/** Seeds the repo in its original state (byte-exact original manifests + old tree). */
function seedOldRepo(fs: FakeFs): void {
  fs.seed(join(REPO, 'package.json'), PACKAGE_JSON);
  fs.seed(join(REPO, 'package-lock.json'), PACKAGE_LOCK);
  fs.seed(join(REPO, 'node_modules'), '__OLD_TREE__');
}

/** Seeds the repo in the post-install candidate state (candidate manifests + candidate tree). */
function seedCandidateRepo(fs: FakeFs): void {
  fs.seed(join(REPO, 'package.json'), CANDIDATE_PACKAGE_JSON);
  fs.seed(join(REPO, 'package-lock.json'), CANDIDATE_PACKAGE_LOCK);
  fs.seed(join(REPO, 'node_modules'), '__CANDIDATE_TREE__');
}

/** Seeds embedded state with prior verification fields (honesty tests). */
function seedPriorState(fs: FakeFs, overrides: Record<string, unknown> = {}): void {
  fs.seed(embeddedStatePath(STATE_DIR), JSON.stringify({
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
    ...overrides,
  }));
}

function makeWorld(script: Script = {}, effects: Record<string, () => void> = {}): TestWorld {
  return { fs: new FakeFs(), spawn: new ScriptedSpawn(script, effects) };
}

/** Fixed id/clock deps: journal updates and the embedded-state pending file. */
function makeIds(): () => string {
  const sequence = ['tmp-2', 'tmp-3', 'tmp-4', 'tmp-5', 'tmp-6'];
  let next = 0;
  return () => sequence[Math.min(next++, sequence.length - 1)] ?? 'fallback';
}

function defaultOptions(world: TestWorld, overrides: Partial<RecoveryOptions> = {}): RecoveryOptions {
  return {
    sdk: SDK,
    repo: REPO,
    stateDir: STATE_DIR,
    disabled: false,
    fs: world.fs,
    command: { spawn: (command, args, options) => world.spawn.spawn(command, args, options) },
    randomId: makeIds(),
    now: () => 1_000,
    ...overrides,
  };
}

/** The happy exact-candidate script: verified commit at NEW_HEAD. */
function candidateScript(): Script {
  return {
    'git rev-parse HEAD': { stdout: `${NEW_HEAD}\n` },
    'git rev-parse HEAD^': { stdout: `${HEAD}\n` },
    'git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD': { stdout: 'package.json\0package-lock.json\0' },
    'git diff --quiet HEAD -- package.json package-lock.json': { stdout: '' },
    [`npm ls ${SDK} --json`]: { stdout: NPM_LS_CANDIDATE },
    'npm run build': { stdout: 'build ok\n' },
  };
}

/** The happy old-state script: original HEAD, verified old tree, clean index/tree. */
function oldScript(): Script {
  return {
    'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
    'npm run build': { stdout: 'build ok\n' },
    'git diff --cached --name-only -z': { stdout: '' },
    'git status --porcelain=v1 --untracked-files=all': { stdout: '' },
  };
}

function persistedState(fs: FakeFs): {
  status: string;
  installedVersion: string | null;
  verifiedVersion: string | null;
  verificationLevel: string;
  lastRecoveryResult: string | null;
} {
  const raw = fs.files.get(embeddedStatePath(STATE_DIR));
  expect(raw).toBeDefined();
  const parsed = JSON.parse(raw ?? '{}') as {
    status?: unknown;
    installedVersion?: unknown;
    verifiedVersion?: unknown;
    verificationLevel?: unknown;
    lastRecoveryResult?: unknown;
  };
  const nullableString = (value: unknown): string | null =>
    value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  return {
    status: String(parsed.status),
    installedVersion: nullableString(parsed.installedVersion),
    verifiedVersion: nullableString(parsed.verifiedVersion),
    verificationLevel: String(parsed.verificationLevel),
    lastRecoveryResult: nullableString(parsed.lastRecoveryResult),
  };
}

/** fs mutation events (excluding reads and existence probes). */
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

describe('recovery — no transaction and disabled mode', () => {
  it('reports none when no transaction evidence exists, without any I/O', async () => {
    const world = makeWorld();
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome).toEqual({ kind: 'none', reason: 'no transaction evidence exists; nothing to recover' });
    expect(world.spawn.calls).toEqual([]);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses disabled upkeep before any I/O, even with transaction evidence present', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal(), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world, { disabled: true }));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('disabled');
    expect(world.fs.events).toEqual([]);
    expect(world.spawn.calls).toEqual([]);
  });
});

describe('recovery — failed-closed and mismatched evidence', () => {
  it('stays blocked when the sentinel exists without a readable journal', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-1' }));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('failed closed');
    // evidence preserved, nothing mutated
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.spawn.calls).toEqual([]);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('stays blocked when the sentinel and journal transaction ids do not match', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ transactionId: 'tx-1' }), false);
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'someone-else' }));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('does not match');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.spawn.calls).toEqual([]);
  });

  it('stays blocked when the journal is invalid without a sentinel (failed closed)', async () => {
    const world = makeWorld();
    world.fs.seed(journalPath(STATE_DIR), 'garbage-not-a-journal');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('unreadable');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.spawn.calls).toEqual([]);
  });

  it('stays blocked when the journal belongs to a different repository (canonical path mismatch)', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ canonicalPath: '/other/repo' }), true);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('repository');
    // no git or npm command ran and nothing was mutated
    expect(world.spawn.calls).toEqual([]);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('stays blocked when embedded state is unreadable, preserving prior verification', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal(), true);
    world.fs.seed(embeddedStatePath(STATE_DIR), 'garbage');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('embedded');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.spawn.calls).toEqual([]);
  });
});

describe('recovery — orphan prepared journal', () => {
  it('removes an orphan prepared journal only after exact original-state verification (npm ls, build, clean index and tree)', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    seedPriorState(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') expect(outcome.reason).toContain('orphan');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    // the orphan now demands the full exact proof, not mere tree existence
    expect(world.spawn.calls.some((call) => call.command === 'npm' && call.args[0] === 'ls')).toBe(true);
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'build')).toBe(true);
    expect(world.spawn.calls.some((call) => call.args.join(' ').includes('status --porcelain'))).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('available');
    expect(state.lastRecoveryResult).toContain('orphan');
  });

  it('blocks an orphan when HEAD moved', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${OTHER_HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when the manifests drifted from the journal originals', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    world.fs.seed(join(REPO, 'package.json'), PACKAGE_JSON.replace(INSTALLED, '0.84.2'));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('manifests');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when the node_modules tree is missing', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    world.fs.files.delete(join(REPO, 'node_modules'));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('tree');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when a backup exists (a non-mutating journal must never have one)', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('backup');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('recovery — old-state restore', () => {
  it('proves and cleans up an armed journal with the original HEAD (no mutation began)', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'armed' }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    // manifests byte-exact, tree untouched, transaction cleared
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(PACKAGE_JSON);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    // the old tree was verified: npm ls + build ran
    expect(world.spawn.calls.some((call) => call.args[0] === 'ls')).toBe(true);
    expect(world.spawn.calls.some((call) => call.args[0] === 'run' && call.args[1] === 'build')).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('promotion_failed');
    expect(state.lastRecoveryResult).toContain('nothing was mutated');
  });

  it('completes a mutating rollback: restores exact manifests, renames the saved tree back offline, and clears the transaction', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    // the journal advanced mutating -> rolled_back -> finalized through atomic renames
    const journalRenames = world.fs.events.filter(
      (event) => event.startsWith('rename ') && event.includes('transaction.journal.json'),
    );
    expect(journalRenames.length).toBeGreaterThanOrEqual(2);
    // exact old state restored
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(PACKAGE_JSON);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(world.spawn.calls.some((call) => call.command === 'npm' && call.args[0] === 'ci')).toBe(false);
  });

  it('completes an interrupted rolled_back restore when the backup still exists and the tree is gone', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'rolled_back' }), true);
    seedOldRepo(world.fs);
    // crash mid-restore: the tree was removed but the saved tree was not renamed back
    world.fs.files.delete(join(REPO, 'node_modules'));
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    expect(world.fs.files.get(join(REPO, 'node_modules'))).toBe('__OLD_TREE__');
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('finishes a rollback-finalized journal with the original HEAD (complete old-state cleanup)', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'finalized' }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('un-stages only the two manifests and proves a config-proof clean tree before finalizing', async () => {
    const world = makeWorld({
      ...oldScript(),
      'git diff --cached --name-only -z': { stdout: 'package.json\0package-lock.json\0' },
      'git restore --staged -- package.json package-lock.json': { stdout: '' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    const restoreCall = world.spawn.calls.find(
      (call) => call.command === 'git' && call.args[0] === 'restore',
    );
    expect(restoreCall?.args).toEqual(['restore', '--staged', '--', 'package.json', 'package-lock.json']);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('stays blocked when the staged set after rollback contains an unexpected path', async () => {
    const world = makeWorld({
      ...oldScript(),
      'git diff --cached --name-only -z': { stdout: 'package.json\0package-lock.json\0someone.txt\0' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('staged');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('stays blocked when the working tree is not clean after rollback', async () => {
    const world = makeWorld({
      ...oldScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: ' M package.json\n' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('clean');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('preserves prior verification fields on an old-state restore (never claims new verification)', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    seedPriorState(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    const state = persistedState(world.fs);
    expect(state.status).toBe('promotion_failed');
    expect(state.installedVersion).toBe(INSTALLED);
    expect(state.verifiedVersion).toBe('0.84.0');
    expect(state.verificationLevel).toBe('live');
    expect(state.lastRecoveryResult).toContain(CANDIDATE);
  });

  it('falls back to npm ci when offline restoration cannot be verified, then finalizes', async () => {
    const world = makeWorld({
      ...oldScript(),
      [`npm ls ${SDK} --json`]: [
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
      'npm ci': { stdout: 'ci ok\n' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    // the offline restore "succeeds" but the verification shows a wrong version
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') expect(outcome.reason).toContain('fallback');
    const ci = world.spawn.calls.find((call) => call.args[0] === 'ci');
    expect(ci?.args).toEqual(['ci']);
    expect(ci?.args).not.toContain('--ignore-scripts');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('preserves the last evidence tree before npm ci and refuses the fallback when it cannot be preserved', async () => {
    const world = makeWorld({
      ...oldScript(),
      [`npm ls ${SDK} --json`]: [
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
    });
    seedTransaction(world.fs, makeJournal({ phase: 'rolled_back' }), true);
    seedOldRepo(world.fs);
    // crash mid-restore: the tree was removed but the saved tree was not renamed back
    world.fs.files.delete(join(REPO, 'node_modules'));
    world.fs.seed(BACKUP, '__OLD_TREE__');
    // the offline restore completes (backup renamed back), then verification
    // fails; preserving the only evidence tree back to the backup fails
    world.fs.renamePairErrors.set(`${join(REPO, 'node_modules')}|${BACKUP}`, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('preserve');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('stays blocked when the npm ci fallback fails, preserving all evidence', async () => {
    const world = makeWorld({
      ...oldScript(),
      [`npm ls ${SDK} --json`]: [
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: NPM_LS_INSTALLED },
      ],
      'npm ci': { stderr: 'npm ERR! code ERESOLVE\n', code: 1 },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('npm ci');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('recovery_required');
  });

  it('stays blocked when the fallback verification fails after npm ci', async () => {
    const world = makeWorld({
      ...oldScript(),
      [`npm ls ${SDK} --json`]: [
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
        { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
      ],
      'npm ci': { stdout: 'ci ok\n' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(true);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('stays blocked when the restore filesystem deadline fires (the in-flight step settles first, no fallback runs)', async () => {
    vi.useFakeTimers();
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    world.fs.gateRm(join(REPO, 'node_modules'));
    const pending = runRecovery(defaultOptions(world));
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(ROLLBACK_FS_TIMEOUT_MS);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);
    world.fs.releaseRm(join(REPO, 'node_modules'));
    const outcome = await pending;
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('ceiling');
    expect(world.spawn.calls.some((call) => call.args[0] === 'ci')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('recovery — candidate finalization', () => {
  it('finalizes the exact committed candidate for a committed journal', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('finalized');
    if (outcome.kind === 'finalized') {
      expect(outcome.commit).toBe(NEW_HEAD);
      expect(outcome.candidate).toBe(CANDIDATE);
      expect(outcome.verificationLevel).toBe('live');
    }
    // backup removed, sentinel cleared, journal removed
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    const state = persistedState(world.fs);
    expect(state.status).toBe('current');
    expect(state.installedVersion).toBe(CANDIDATE);
    expect(state.verifiedVersion).toBe(CANDIDATE);
    expect(state.verificationLevel).toBe('live');
  });

  it('finalizes a completed cleanup_pending journal (committed without sentinel) and removes the backup', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), false);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('finalized');
    expect(world.fs.has(BACKUP)).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('finalizes a mutating journal whose HEAD is the exact candidate commit (crash after commit, before the phase record)', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('finalized');
    if (outcome.kind === 'finalized') expect(outcome.commit).toBe(NEW_HEAD);
    // mutating -> committed -> finalized
    const journalRenames = world.fs.events.filter(
      (event) => event.startsWith('rename ') && event.includes('transaction.journal.json'),
    );
    expect(journalRenames.length).toBeGreaterThanOrEqual(2);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('records the journaled deterministic_only level on finalization', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed', verificationLevel: 'deterministic_only' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('finalized');
    if (outcome.kind === 'finalized') expect(outcome.verificationLevel).toBe('deterministic_only');
    const state = persistedState(world.fs);
    expect(state.verificationLevel).toBe('deterministic_only');
  });

  it('blocks when the committed journal has no candidate snapshot pair', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed', candidateManifests: false }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('snapshots');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the candidate HEAD is not a direct child of the original (wrong parent)', async () => {
    const world = makeWorld({
      ...candidateScript(),
      'git rev-parse HEAD^': { stdout: `${OTHER_HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('child');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(false);
  });

  it('blocks when the committed path set is not exactly the two manifests (enlarged commit)', async () => {
    const world = makeWorld({
      ...candidateScript(),
      'git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD': { stdout: 'package.json\0package-lock.json\0dist/extra.js\0' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('manifest');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the committed blobs differ from the working files', async () => {
    const world = makeWorld({
      ...candidateScript(),
      'git diff --quiet HEAD -- package.json package-lock.json': { stdout: ' M package.json\n', code: 1 },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('blob');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the disk manifests differ from the expected candidate snapshots', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(join(REPO, 'package.json'), JSON.stringify({
      name: 'funkyoctopus',
      version: '0.1.0',
      dependencies: { [SDK]: CANDIDATE, 'extra': '^1.0.0' },
    }));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('package.json');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
  });

  it('blocks when npm ls does not agree exactly on the candidate', async () => {
    const world = makeWorld({
      ...candidateScript(),
      [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('npm ls');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the production build fails for the candidate', async () => {
    const world = makeWorld({
      ...candidateScript(),
      'npm run build': { stderr: 'vite build failed\n', code: 1 },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('build');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('finalizes even when the obsolete backup is already gone (definite ENOENT is success)', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'finalized' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('finalized');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
  });

  it('becomes non-blocking cleanup_pending when obsolete backup removal fails, keeping the verified commit', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    world.fs.rmErrors.set(BACKUP, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('cleanup_pending');
    if (outcome.kind === 'cleanup_pending') {
      expect(outcome.candidate).toBe(CANDIDATE);
      expect(outcome.commit).toBe(NEW_HEAD);
    }
    // blocking sentinel cleared; the committed journal is retained as the record
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(BACKUP)).toBe(true);
    const state = persistedState(world.fs);
    expect(state.status).toBe('cleanup_pending');
    expect(state.verifiedVersion).toBe(CANDIDATE);
    expect(state.verificationLevel).toBe('live');
  });
});

describe('recovery — moved HEAD and idempotence', () => {
  it('blocks a moved HEAD for armed journals (no blind rollback)', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${OTHER_HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'armed' }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('moved HEAD');
    // no npm command ran: nothing was rolled back
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks a moved HEAD during mutating when the expected candidate commit cannot be verified exactly', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${OTHER_HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('candidate commit');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('is idempotent: a re-run after old-state restore reports none', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'mutating' }), true);
    seedCandidateRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const first = await runRecovery(defaultOptions(world));
    expect(first.kind).toBe('restored');
    const second = await runRecovery(defaultOptions(world));
    expect(second.kind).toBe('none');
  });

  it('is idempotent: a re-run after candidate finalization reports none', async () => {
    const world = makeWorld(candidateScript());
    seedTransaction(world.fs, makeJournal({ phase: 'committed' }), true);
    seedCandidateRepo(world.fs);
    const first = await runRecovery(defaultOptions(world));
    expect(first.kind).toBe('finalized');
    const second = await runRecovery(defaultOptions(world));
    expect(second.kind).toBe('none');
  });

  it('is idempotent: a blocked recovery re-runs and stays blocked with the evidence intact', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${OTHER_HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'armed' }), true);
    seedOldRepo(world.fs);
    const first = await runRecovery(defaultOptions(world));
    expect(first.kind).toBe('blocked');
    const second = await runRecovery(defaultOptions(world));
    expect(second.kind).toBe('blocked');
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('recovery — non-mutating completion (prepared/armed/finalized-original)', () => {
  it('terminalizes an armed journal before clearing the sentinel: a crash after the clear leaves a rerunnable completed journal, never failed_closed', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'armed' }), true);
    seedOldRepo(world.fs);
    // crash after the sentinel was cleared but before the journal removal
    world.fs.unlinkErrors.set(journalPath(STATE_DIR), Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const first = await runRecovery(defaultOptions(world));
    expect(first.kind).toBe('blocked');
    if (first.kind === 'blocked') expect(first.reason).toContain('journal');
    // the journal was terminalized before the sentinel clear, so the crash
    // state is a completed cleanup — never an armed-without-sentinel brick
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(false);
    const journal = await readJournal(STATE_DIR, world.fs);
    expect(journal.kind).toBe('present');
    if (journal.kind === 'present') expect(journal.journal.phase).toBe('finalized');
    const state = await readTransaction(STATE_DIR, world.fs);
    expect(state.kind).toBe('completed');
    // rerunnable: remove the injected fault and the same recovery completes
    world.fs.unlinkErrors.delete(journalPath(STATE_DIR));
    const second = await runRecovery(defaultOptions(world));
    expect(second.kind).toBe('restored');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(false);
  });

  it('terminalizes a prepared journal before clearing the sentinel: a crash after the clear stays rerunnable', async () => {
    const world = makeWorld(oldScript());
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), true);
    seedOldRepo(world.fs);
    world.fs.unlinkErrors.set(journalPath(STATE_DIR), Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const first = await runRecovery(defaultOptions(world));
    expect(first.kind).toBe('blocked');
    const journal = await readJournal(STATE_DIR, world.fs);
    expect(journal.kind).toBe('present');
    if (journal.kind === 'present') expect(journal.journal.phase).toBe('finalized');
    expect((await readTransaction(STATE_DIR, world.fs)).kind).toBe('completed');
  });

  it('blocks on manifest divergence for an armed journal and leaves the drifted bytes byte-untouched', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'armed' }), true);
    seedOldRepo(world.fs);
    const drifted = PACKAGE_JSON.replace(INSTALLED, '0.84.2');
    world.fs.seed(join(REPO, 'package.json'), drifted);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('manifests');
    // the drifted user bytes were never overwritten
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(drifted);
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(PACKAGE_LOCK);
    expect(world.fs.events.some((event) => event.startsWith('write ') && event.includes('/repo/package'))).toBe(false);
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks on manifest divergence for a prepared journal and leaves the drifted bytes byte-untouched', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), true);
    seedOldRepo(world.fs);
    const drifted = PACKAGE_LOCK.replace(INSTALLED, '0.84.2');
    world.fs.seed(join(REPO, 'package-lock.json'), drifted);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('manifests');
    expect(world.fs.files.get(join(REPO, 'package-lock.json'))).toBe(drifted);
    expect(world.fs.events.some((event) => event.startsWith('write ') && event.includes('/repo/package'))).toBe(false);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks a finalized-original rerun on divergence instead of overwriting (non-mutating verification/completion)', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'finalized' }), true);
    seedOldRepo(world.fs);
    const drifted = PACKAGE_JSON.replace(INSTALLED, '0.84.2');
    world.fs.seed(join(REPO, 'package.json'), drifted);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('manifests');
    expect(world.fs.files.get(join(REPO, 'package.json'))).toBe(drifted);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks a finalized-original rerun when a backup exists (a terminal journal never mutates)', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'finalized' }), true);
    seedOldRepo(world.fs);
    world.fs.seed(BACKUP, '__OLD_TREE__');
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('backup');
    expect(world.fs.has(BACKUP)).toBe(true);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('recovery — orphan prepared journal exact proof', () => {
  it('blocks an orphan when npm ls does not agree exactly on the installed version', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
      [`npm ls ${SDK} --json`]: { stdout: JSON.stringify({ name: 'funkyoctopus', problems: [], dependencies: { [SDK]: { version: '0.84.2' } } }) },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('npm ls');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when the production build fails', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
      [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
      'npm run build': { stderr: 'vite build failed\n', code: 1 },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('build');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when the git index is not clean', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
      [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
      'npm run build': { stdout: 'build ok\n' },
      'git diff --cached --name-only -z': { stdout: 'package.json\0' },
      'git status --porcelain=v1 --untracked-files=all': { stdout: '' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('index');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks an orphan when the working tree is not clean', async () => {
    const world = makeWorld({
      'git rev-parse HEAD': { stdout: `${HEAD}\n` },
      [`npm ls ${SDK} --json`]: { stdout: NPM_LS_INSTALLED },
      'npm run build': { stdout: 'build ok\n' },
      'git diff --cached --name-only -z': { stdout: '' },
      'git status --porcelain=v1 --untracked-files=all': { stdout: ' M package.json\n' },
    });
    seedTransaction(world.fs, makeJournal({ phase: 'prepared' }), false);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('clean');
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });
});

describe('recovery — journal path trust boundary', () => {
  it('blocks hostile backup/log paths with zero read/write/rm/rename against them', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ backup: '/tmp/victim', logs: ['/tmp/victim.log', '/etc/passwd'] }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    // not one event touched the hostile paths
    for (const event of world.fs.events) {
      expect(event).not.toContain('/tmp/victim');
      expect(event).not.toContain('/etc/passwd');
    }
    expect(world.spawn.calls).toEqual([]);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the backup unique does not match the log unique', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ logs: [join(STATE_DIR, 'promotion-tx-2.log'), join(STATE_DIR, 'promotion-tx-2.stderr.log')] }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
    expect(world.fs.has(sentinelPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the journal records a wrong number of log paths', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ logs: [join(STATE_DIR, 'promotion-tx-1.log')] }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when a log path is nested below the state dir', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ logs: [join(STATE_DIR, 'promotion-tx-1.log/nested'), join(STATE_DIR, 'promotion-tx-1.stderr.log')] }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
    expect(world.fs.has(journalPath(STATE_DIR))).toBe(true);
  });

  it('blocks when the backup is not a direct sibling of the repo', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ backup: join('/repo/sub', `repo-${'node_modules-backup'}-${HEAD.slice(0, 12)}-tx-1`) }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
  });

  it('blocks when the backup unique is not a safe single path component', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ backup: join('/', `repo-${'node_modules-backup'}-${HEAD.slice(0, 12)}-..%2Fetc`) }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
  });

  it('blocks when the backup basename does not match the transaction naming scheme', async () => {
    const world = makeWorld();
    seedTransaction(world.fs, makeJournal({ backup: join('/', 'repo-something-else-tx-1') }), true);
    seedOldRepo(world.fs);
    const outcome = await runRecovery(defaultOptions(world));
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('paths');
    expect(world.spawn.calls).toEqual([]);
  });
});

describe('recovery — real filesystem end-to-end with faked commands', () => {
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

  it('completes a crashed mutating rollback in a temp repository (no registry or model calls)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-recover-'));
    try {
      const repo = join(base, 'funkyoctopus');
      const stateDir = join(base, 'state');
      const backup = join(base, `funkyoctopus-node_modules-backup-${HEAD.slice(0, 12)}-tx-1`);
      await mkdir(join(repo, 'node_modules'), { recursive: true });
      await mkdir(backup, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      // crashed mutating state: candidate manifests installed, old tree saved
      await writeFile(join(repo, 'package.json'), CANDIDATE_PACKAGE_JSON);
      await writeFile(join(repo, 'package-lock.json'), CANDIDATE_PACKAGE_LOCK);
      await writeFile(join(repo, 'node_modules', '.marker'), 'candidate-tree');
      await writeFile(join(backup, '.marker'), 'old-tree');
      const journal = makeJournal({ phase: 'mutating', canonicalPath: repo });
      const paths = journal['paths'] as Record<string, unknown>;
      const logs = [join(stateDir, 'promotion-tx-1.log'), join(stateDir, 'promotion-tx-1.stderr.log')];
      await writeFile(journalPath(stateDir), JSON.stringify({ ...journal, paths: { ...paths, backup, logs } }));
      await writeFile(sentinelPath(stateDir), JSON.stringify({ transactionId: 'tx-1' }));

      const spawnCalls: { command: string; args: string[] }[] = [];
      const spawn = (command: string, args: string[], _options: SpawnOptions): CommandChild => {
        const key = [command, ...args].join(' ');
        spawnCalls.push({ command, args });
        let outcome: ScriptOutcome;
        if (key === 'git rev-parse HEAD') {
          outcome = { stdout: `${HEAD}\n` };
        } else if (key === `npm ls ${SDK} --json`) {
          outcome = { stdout: NPM_LS_INSTALLED };
        } else if (key === 'npm run build') {
          outcome = { stdout: 'build ok\n' };
        } else if (key === 'git diff --cached --name-only -z') {
          outcome = { stdout: '' };
        } else if (key === 'git status --porcelain=v1 --untracked-files=all') {
          outcome = { stdout: '' };
        } else {
          throw new Error(`unexpected command: ${key}`);
        }
        return new FakeChild(outcome);
      };

      const outcome = await runRecovery({
        sdk: SDK,
        repo,
        stateDir,
        disabled: false,
        fs: realFs,
        command: { spawn },
        randomId: () => 'tmp-2',
        now: () => 1_000,
      });

      expect(outcome.kind).toBe('restored');
      // exact old bytes restored on the real fs
      expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
      expect(await readFile(join(repo, 'package-lock.json'), 'utf8')).toBe(PACKAGE_LOCK);
      // the saved old tree is back in the repo and the backup sibling is gone
      expect(await readFile(join(repo, 'node_modules', '.marker'), 'utf8')).toBe('old-tree');
      await expect(readdir(backup)).rejects.toMatchObject({ code: 'ENOENT' });
      // transaction cleared
      const entries = await readdir(stateDir);
      expect(entries).not.toContain('transaction.sentinel');
      expect(entries).not.toContain('transaction.journal.json');
      const state = JSON.parse(await readFile(join(stateDir, 'embedded-state.json'), 'utf8')) as {
        status?: unknown;
        installedVersion?: unknown;
        lastRecoveryResult?: unknown;
      };
      expect(state.status).toBe('promotion_failed');
      expect(state.installedVersion).toBe(INSTALLED);
      expect(String(state.lastRecoveryResult)).toContain(CANDIDATE);
      // no forbidden operations
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
