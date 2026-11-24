/**
 * `npm run upkeep:embedded` command contract.
 *
 * The injected coordinator (cli.ts) is driven with faked lock/preflight/
 * promote/recover/status seams to prove ordering, no-effects, the outcome-to-
 * exit mapping, lock retention on unsafe-canary recovery, bounded output, and
 * the package script wiring, and the sidecar liveness refusal (the sidecar
 * holds no lock, so a probe of its host:port is the only sidecar↔updater
 * exclusion; tests inject the probe and never touch a real port). A
 * real-filesystem suite coordinates the action against another updater's held
 * lock in a hermetic temp dir. Default tests stay hermetic: no registry, no
 * model, no real promotion or recovery.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile as fsReadFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MAX_REASON_BYTES } from './bounded-reason.ts';
import { runUpkeepCommand, parseUpkeepArgs, USAGE, type RepoResolution, type UpkeepCommandDeps } from './cli.ts';
import { embeddedStatePath } from '../../server/src/upkeep/embedded-state.ts';
import { LOCK_DIR, RepositoryLock, ownerFileName, probeProcess, type LockOwner } from './lock.ts';
import type { PreflightRefusal, PreflightResult, PromotionContext } from './preflight.ts';
import type { CanaryOutcome, PromotionOutcome } from './promote.ts';
import type { RecoveryOutcome } from './recover.ts';
import { sha256Hex, stateDirFor, type CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';
import { CoordinationFakeFs } from './test/fake-fs.ts';

class FakeFs extends CoordinationFakeFs {
  protected override readonly renameNeedsDestinationDir = true;
}

const repoRoot = resolve(import.meta.dirname, '..', '..');
const REPO = '/canonical/repo';
const STATE_ROOT = '/state-root';
const INSTANCE = 'inst-1';
const stateDir = stateDirFor(REPO, STATE_ROOT);
const lockDir = join(stateDir, LOCK_DIR);
const ownerPath = join(lockDir, ownerFileName(INSTANCE));
const HEAD = 'a'.repeat(40);

const PERSISTED_STATE = {
  schemaVersion: 1,
  installedVersion: '0.84.1',
  latestVersion: '0.85.0',
  verifiedVersion: '0.84.1',
  verificationLevel: 'live',
  status: 'available',
  lastCheckAt: 1_000,
  lastPromotionAttemptAt: null,
  lastPromotionResult: null,
  lastRecoveryAttemptAt: null,
  lastRecoveryResult: null,
};

function owner(pid: number, instance: string): LockOwner {
  return { pid, host: 'other-host', startedAt: 1, instance };
}

function eexist(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
}

function context(decision: 'ready' | 'noop'): PromotionContext {
  return Object.freeze({
    decision,
    canonicalRepo: REPO,
    stateDir,
    branch: 'main',
    head: HEAD,
    installedVersion: '0.84.1',
    candidateVersion: '0.85.0',
    manifests: Object.freeze({
      packageJson: Object.freeze({ content: '{}', sha256: sha256Hex('{}') }),
      packageLock: Object.freeze({ content: '{}', sha256: sha256Hex('{}') }),
    }),
    backup: '/sibling/repo-node_modules-backup-aaaaaaaaaaaa-tx-1',
    logs: Object.freeze([join(stateDir, 'promotion-tx-1.log')]),
  });
}

const committedOutcome = (): PromotionOutcome => ({
  kind: 'committed',
  transactionId: 'tx-1',
  candidate: '0.85.0',
  verificationLevel: 'live',
  commit: 'b'.repeat(40),
});

type GitTopLevelFn = (cwd: string) => Promise<RepoResolution>;
type PreflightFn = (repo: string) => Promise<PreflightResult>;
type PromoteFn = (opts: {
  runCanary: (signal: AbortSignal) => Promise<CanaryOutcome>;
  skipCanary: boolean;
}) => (context: PromotionContext) => Promise<PromotionOutcome>;
type CanaryFn = () => (signal: AbortSignal) => Promise<CanaryOutcome>;
type RecoverFn = (opts: { repo: string; stateDir: string; disabled: boolean }) => () => Promise<RecoveryOutcome>;

interface Harness {
  deps: UpkeepCommandDeps;
  fs: FakeFs;
  outLines: string[];
  errLines: string[];
  runGitTopLevel: Mock<GitTopLevelFn>;
  runPreflight: Mock<PreflightFn>;
  runPromote: Mock<PromoteFn>;
  runCanary: Mock<CanaryFn>;
  runRecover: Mock<RecoverFn>;
}

type HarnessOverrides = Partial<Omit<UpkeepCommandDeps, 'stateRoot' | 'fs' | HarnessSeams>> & {
  stateRoot?: string | null;
  fs?: FakeFs;
  runGitTopLevel?: Mock<GitTopLevelFn>;
  runPreflight?: Mock<PreflightFn>;
  runPromote?: Mock<PromoteFn>;
  runCanary?: Mock<CanaryFn>;
  runRecover?: Mock<RecoverFn>;
};

type HarnessSeams = 'runGitTopLevel' | 'runPreflight' | 'runPromote' | 'runCanary' | 'runRecover';

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const fs = overrides.fs ?? new FakeFs();
  const outLines: string[] = [];
  const errLines: string[] = [];
  const runGitTopLevel =
    overrides.runGitTopLevel ??
    vi.fn<GitTopLevelFn>().mockImplementation(() => Promise.resolve({ kind: 'ok', repo: REPO }));
  const runPreflight =
    overrides.runPreflight ??
    vi.fn<PreflightFn>().mockImplementation(() => Promise.resolve({ kind: 'noop', context: context('noop') }));
  const runPromote =
    overrides.runPromote ??
    vi.fn<PromoteFn>().mockImplementation(() => () => Promise.resolve(committedOutcome()));
  const runCanary =
    overrides.runCanary ??
    vi.fn<CanaryFn>().mockImplementation(() => () => Promise.resolve({ kind: 'ok' }));
  const runRecover =
    overrides.runRecover ??
    vi.fn<RecoverFn>().mockImplementation(() => () =>
      Promise.resolve({ kind: 'none', reason: 'no transaction evidence exists; nothing to recover' }),
    );
  const deps: UpkeepCommandDeps = {
    argv: overrides.argv ?? [],
    disabled: overrides.disabled ?? false,
    fs,
    probe: overrides.probe ?? (() => 'dead'),
    sidecar: overrides.sidecar ?? { host: '127.0.0.1', port: 14787, probe: () => Promise.resolve(false) },
    pid: overrides.pid ?? 123,
    host: overrides.host ?? 'test-host',
    cwd: overrides.cwd ?? REPO,
    randomId: overrides.randomId ?? (() => INSTANCE),
    runGitTopLevel,
    runPreflight,
    runPromote,
    runCanary,
    runRecover,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
  if (overrides.stateRoot !== null) deps.stateRoot = overrides.stateRoot ?? STATE_ROOT;
  return { deps, fs, outLines, errLines, runGitTopLevel, runPreflight, runPromote, runCanary, runRecover };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseUpkeepArgs', () => {
  it('parses the no-action form as status', () => {
    expect(parseUpkeepArgs([])).toEqual({ kind: 'ok', action: { kind: 'status' } });
  });

  it('parses --promote with the default live canary', () => {
    expect(parseUpkeepArgs(['--promote'])).toEqual({
      kind: 'ok',
      action: { kind: 'promote', skipCanary: false },
    });
  });

  it('parses --promote --skip-live-canary', () => {
    expect(parseUpkeepArgs(['--promote', '--skip-live-canary'])).toEqual({
      kind: 'ok',
      action: { kind: 'promote', skipCanary: true },
    });
  });

  it('parses --recover', () => {
    expect(parseUpkeepArgs(['--recover'])).toEqual({ kind: 'ok', action: { kind: 'recover' } });
  });

  it('refuses unknown arguments', () => {
    expect(parseUpkeepArgs(['--bogus']).kind).toBe('error');
    expect(parseUpkeepArgs(['--help']).kind).toBe('error');
  });

  it('refuses conflicting action flags in either order', () => {
    expect(parseUpkeepArgs(['--promote', '--recover']).kind).toBe('error');
    expect(parseUpkeepArgs(['--recover', '--promote']).kind).toBe('error');
    expect(parseUpkeepArgs(['--promote', '--promote']).kind).toBe('error');
    expect(parseUpkeepArgs(['--recover', '--recover']).kind).toBe('error');
  });

  it('refuses --skip-live-canary without --promote', () => {
    expect(parseUpkeepArgs(['--skip-live-canary']).kind).toBe('error');
    expect(parseUpkeepArgs(['--recover', '--skip-live-canary']).kind).toBe('error');
    expect(parseUpkeepArgs(['--skip-live-canary', '--skip-live-canary']).kind).toBe('error');
  });
});

describe('status (no action)', () => {
  it('prints cached installed/latest/verified/level/status/transaction and usage with zero effects', async () => {
    const fs = new FakeFs();
    fs.files.set(embeddedStatePath(stateDir), JSON.stringify(PERSISTED_STATE));
    const h = makeHarness({ fs });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    // Read-only: no state chain, no lock, no mutation, no registry.
    for (const event of fs.events) expect(event).toMatch(/^read /);
    expect(h.runPreflight).not.toHaveBeenCalled();
    expect(h.runPromote).not.toHaveBeenCalled();
    expect(h.runCanary).not.toHaveBeenCalled();
    expect(h.runRecover).not.toHaveBeenCalled();
    const joined = [...h.outLines, ...h.errLines].join('\n');
    expect(joined).toContain('embedded pi upkeep');
    expect(joined).toContain('installed: 0.84.1');
    expect(joined).toContain('latest: 0.85.0');
    expect(joined).toContain('verified: 0.84.1');
    expect(joined).toContain('verification: live');
    expect(joined).toContain('status: available');
    expect(joined).toContain('transaction: none');
    expect(joined).toContain(USAGE);
  });

  it('bounds every status line even when a repository identity is oversized', async () => {
    const hugeRepo = `/${'r'.repeat(MAX_REASON_BYTES * 2)}`;
    const runGitTopLevel = vi.fn<GitTopLevelFn>().mockResolvedValue({ kind: 'ok', repo: hugeRepo });
    const h = makeHarness({ runGitTopLevel });

    expect(await runUpkeepCommand(h.deps)).toBe(0);
    for (const line of [...h.outLines, ...h.errLines]) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_REASON_BYTES);
    }
  });

  it('prints unknown fields for an absent cache and exits 0', async () => {
    const h = makeHarness();
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    const joined = [...h.outLines, ...h.errLines].join('\n');
    expect(joined).toContain('installed: unknown');
    expect(joined).toContain('verification: unknown');
    expect(joined).toContain('status: unknown');
    expect(joined).toContain('transaction: none');
    expect(joined).toContain('(no cached embedded upkeep state yet)');
    expect(joined).toContain(USAGE);
  });

  it('reports an unreadable cache boundedly with a nonzero exit', async () => {
    const fs = new FakeFs();
    fs.files.set(embeddedStatePath(stateDir), 'not json at all');
    const h = makeHarness({ fs });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/cached embedded upkeep state is unreadable/);
    expect(h.outLines.join('\n')).toContain(USAGE);
    // Still zero mutation.
    for (const event of fs.events) expect(event).toMatch(/^read /);
  });

  it('classifies transaction evidence from the derived state dir', async () => {
    const fs = new FakeFs();
    fs.files.set(join(stateDir, 'transaction.sentinel'), JSON.stringify({ transactionId: 'tx-9' }));
    const h = makeHarness({ fs });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect([...h.outLines, ...h.errLines].join('\n')).toMatch(/transaction: failed closed \(/);
  });

  it('disabled status still prints the read-only cache', async () => {
    const fs = new FakeFs();
    fs.files.set(embeddedStatePath(stateDir), JSON.stringify(PERSISTED_STATE));
    const h = makeHarness({ fs, disabled: true });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect([...h.outLines, ...h.errLines].join('\n')).toContain('status: available');
    expect(h.runPreflight).not.toHaveBeenCalled();
  });
});

describe('disabled actions refuse before any I/O', () => {
  it('refuses promotion before any I/O', async () => {
    const h = makeHarness({ argv: ['--promote'], disabled: true });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/upkeep is disabled/);
    expect(h.errLines.join('\n')).toContain(USAGE);
    expect(h.runGitTopLevel).not.toHaveBeenCalled();
    expect(h.fs.events).toEqual([]);
    expect(h.runPreflight).not.toHaveBeenCalled();
  });

  it('refuses recovery before any I/O', async () => {
    const h = makeHarness({ argv: ['--recover'], disabled: true });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/upkeep is disabled/);
    expect(h.runGitTopLevel).not.toHaveBeenCalled();
    expect(h.fs.events).toEqual([]);
    expect(h.runRecover).not.toHaveBeenCalled();
  });
});

describe('sidecar liveness refusal', () => {
  const listening = (host = '127.0.0.1', port = 14787) => ({
    host,
    port,
    probe: vi.fn<(host: string, port: number) => Promise<boolean>>().mockResolvedValue(true),
  });

  it('refuses promotion before any I/O while a sidecar answers on the configured port', async () => {
    const sidecar = listening();
    const h = makeHarness({ argv: ['--promote'], sidecar });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toContain('promotion blocked — a sidecar answers on 127.0.0.1:14787');
    expect(err).toContain('stop the sidecar');
    expect(err).toContain(USAGE);
    expect(sidecar.probe).toHaveBeenCalledWith('127.0.0.1', 14787);
    expect(h.runGitTopLevel).not.toHaveBeenCalled();
    expect(h.fs.events).toEqual([]);
    expect(h.runPreflight).not.toHaveBeenCalled();
    expect(h.runPromote).not.toHaveBeenCalled();
  });

  it('refuses recovery the same way — recovery mutates node_modules without a preflight', async () => {
    const sidecar = listening('::1', 9999);
    const h = makeHarness({ argv: ['--recover'], sidecar });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toContain('recovery blocked — a sidecar answers on ::1:9999');
    expect(sidecar.probe).toHaveBeenCalledWith('::1', 9999);
    expect(h.runGitTopLevel).not.toHaveBeenCalled();
    expect(h.fs.events).toEqual([]);
    expect(h.runRecover).not.toHaveBeenCalled();
  });

  it('proceeds when nothing answers: probes before the lock and again after the preflight, before mutating', async () => {
    const probe = vi.fn<(host: string, port: number) => Promise<boolean>>().mockResolvedValue(false);
    const h = makeHarness({ argv: ['--promote'], sidecar: { host: '127.0.0.1', port: 14787, probe } });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(h.runPreflight).toHaveBeenCalledTimes(1);
    expect(h.runPromote).toHaveBeenCalledTimes(1);
  });

  it('a noop preflight never reaches the second probe', async () => {
    const probe = vi.fn<(host: string, port: number) => Promise<boolean>>().mockResolvedValue(false);
    const h = makeHarness({ argv: ['--promote'], sidecar: { host: '127.0.0.1', port: 14787, probe } });
    expect(await runUpkeepCommand(h.deps)).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a sidecar started during the preflight blocks the promotion before any mutation and releases the lock', async () => {
    const probe = vi
      .fn<(host: string, port: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const h = makeHarness({ argv: ['--promote'], sidecar: { host: '127.0.0.1', port: 14787, probe } });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toContain('promotion blocked — a sidecar answers on 127.0.0.1:14787');
    expect(h.runPreflight).toHaveBeenCalledTimes(1);
    expect(h.runPromote).not.toHaveBeenCalled();
    // The lock this run acquired is released in finally.
    expect(h.fs.files.has(ownerPath)).toBe(false);
    expect(h.fs.dirs.has(lockDir)).toBe(false);
  });

  it('never probes for status or when upkeep is disabled', async () => {
    const status = listening();
    await runUpkeepCommand(makeHarness({ argv: [], sidecar: status }).deps);
    expect(status.probe).not.toHaveBeenCalled();
    const disabled = listening();
    const code = await runUpkeepCommand(makeHarness({ argv: ['--promote'], disabled: true, sidecar: disabled }).deps);
    expect(code).toBe(1);
    expect(disabled.probe).not.toHaveBeenCalled();
  });

  it('refuses an invalid sidecar port instead of skipping the probe', async () => {
    const sidecar = { host: '127.0.0.1', port: Number.NaN, probe: vi.fn<(host: string, port: number) => Promise<boolean>>() };
    const h = makeHarness({ argv: ['--promote'], sidecar });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/promotion blocked — invalid sidecar port .*SIDECAR_PORT/);
    expect(sidecar.probe).not.toHaveBeenCalled();
    expect(h.runGitTopLevel).not.toHaveBeenCalled();
  });
});

describe('lock coordination', () => {
  it('acquires the lock before the preflight and releases it on an ordinary outcome', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    let lockHeldDuringPreflight = false;
    h.runPreflight.mockImplementation(() => {
      lockHeldDuringPreflight = h.fs.files.has(ownerPath);
      return Promise.resolve({ kind: 'noop', context: context('noop') });
    });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    // The preflight ran only while this run owned the lock.
    expect(lockHeldDuringPreflight).toBe(true);
    expect(h.runPreflight).toHaveBeenCalledWith(REPO);
    // Released in finally for the ordinary outcome.
    expect(h.fs.files.has(ownerPath)).toBe(false);
    expect(h.fs.dirs.has(lockDir)).toBe(false);
  });

  it('refuses before the preflight when another updater holds the lock', async () => {
    const fs = new FakeFs();
    fs.dirs.add(lockDir);
    fs.files.set(join(lockDir, ownerFileName('other')), JSON.stringify(owner(4242, 'other')));
    fs.mkdirErrors.set(lockDir, eexist(lockDir));
    const h = makeHarness({ fs, argv: ['--promote'], probe: (pid) => (pid === 4242 ? 'alive' : 'dead') });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/promotion blocked —/);
    expect(h.errLines.join('\n')).toMatch(/4242/);
    expect(h.runPreflight).not.toHaveBeenCalled();
    expect(h.runPromote).not.toHaveBeenCalled();
    // The live owner's lock is never touched.
    expect(fs.files.has(join(lockDir, ownerFileName('other')))).toBe(true);
  });

  it('refuses before creating any state when the derived state dir would land inside the repo', async () => {
    const h = makeHarness({ argv: ['--promote'], stateRoot: '/canonical/repo/state-root' });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/would land inside the repository/);
    // The refusal happens after the read-only repo resolution but before any
    // state-dir creation or lock I/O.
    expect(h.runGitTopLevel).toHaveBeenCalledTimes(1);
    expect(h.fs.events.filter((event) => event.startsWith('mkdir '))).toEqual([]);
    expect(h.runPreflight).not.toHaveBeenCalled();
  });
});

describe('promotion under lock', () => {
  it('maps a fresh preflight noop to exit 0 without promoting', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(h.runPreflight).toHaveBeenCalledTimes(1);
    expect(h.runPromote).not.toHaveBeenCalled();
    expect(h.outLines.join('\n')).toContain('already current');
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('refuses a dirty tree with exact guidance and a nonzero exit', async () => {
    const refusal: PreflightRefusal = {
      code: 'dirty_tree',
      reason: 'the working tree has changes',
      tracked: ['package.json'],
      untracked: ['scratch.txt'],
    };
    const h = makeHarness({
      argv: ['--promote'],
      runPreflight: vi.fn<PreflightFn>().mockImplementation(() => Promise.resolve({ kind: 'refused', refusal })),
    });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toContain('promotion refused');
    expect(err).toContain('the working tree must be clean before promotion');
    expect(h.runPromote).not.toHaveBeenCalled();
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it.each([
    ['transaction_state', /an unresolved transaction must be resolved first/],
    ['cleanup_pending', /pending backup cleanup must finish first/],
  ] as const)('gives recovery guidance for a %s refusal', async (codeName, guidance) => {
    const refusal: PreflightRefusal =
      codeName === 'transaction_state'
        ? { code: 'transaction_state', reason: 'active transaction', transactionId: 'tx-1', phase: 'mutating' }
        : { code: 'cleanup_pending', reason: 'cleanup pending' };
    const h = makeHarness({
      argv: ['--promote'],
      runPreflight: vi.fn<PreflightFn>().mockImplementation(() => Promise.resolve({ kind: 'refused', refusal })),
    });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toMatch(guidance);
    expect(err).toContain('run: npm run upkeep:embedded -- --recover');
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('wires the default live canary unless --skip-live-canary is explicit', async () => {
    for (const [argv, skipCanary] of [
      [['--promote'], false],
      [['--promote', '--skip-live-canary'], true],
    ] as const) {
      const h = makeHarness({ argv: [...argv] });
      h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
      const code = await runUpkeepCommand(h.deps);
      expect(code).toBe(0);
      const promoteCall = h.runPromote.mock.calls[0]?.[0];
      expect(promoteCall).toBeDefined();
      expect(promoteCall?.skipCanary).toBe(skipCanary);
      expect(typeof promoteCall?.runCanary).toBe('function');
      // The promotion ran under the held lock with the preflight context.
      expect(h.runPromote).toHaveBeenCalledTimes(1);
      expect(h.fs.files.has(ownerPath)).toBe(false);
    }
  });

  it('maps committed to exit 0', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(h.outLines.join('\n')).toMatch(/embedded pi promoted to 0\.85\.0 and committed/);
  });

  it.each([
    ['rolled_back', (): PromotionOutcome => ({ kind: 'rolled_back', transactionId: 'tx-1', installed: '0.84.1', reason: 'npm install failed' })],
    ['cleanup_pending', (): PromotionOutcome => ({ kind: 'cleanup_pending', transactionId: 'tx-1', candidate: '0.85.0', commit: 'b'.repeat(40), reason: 'backup rm failed' })],
    ['error', (): PromotionOutcome => ({ kind: 'error', message: 'boom' })],
  ] as const)('maps %s to a nonzero exit with guidance', async (_name, makeOutcome) => {
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    h.runPromote.mockImplementation(() => () => Promise.resolve(makeOutcome()));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toMatch(/run: npm run upkeep:embedded -- --recover/);
    // Ordinary outcomes always release the owned lock.
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('maps an ordinary recovery_required to a nonzero exit and releases the lock', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    h.runPromote.mockImplementation(() => () =>
      Promise.resolve({
        kind: 'recovery_required',
        transactionId: 'tx-1',
        phase: 'mutating',
        reason: 'commit verification failed',
        retainLockUntilExit: false,
      }),
    );
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toContain('promotion requires recovery');
    expect(err).toContain('run: npm run upkeep:embedded -- --recover');
    expect(err).not.toContain('retained');
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('retains the lock on an unsafe recovery_required and never releases it', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    h.runPromote.mockImplementation(() => () =>
      Promise.resolve({
        kind: 'recovery_required',
        transactionId: 'tx-1',
        phase: 'armed',
        reason: 'live canary did not settle within the cleanup grace',
        retainLockUntilExit: true,
      }),
    );
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const err = h.errLines.join('\n');
    expect(err).toContain('the repository lock is retained until this process exits');
    expect(err).toContain('terminate it');
    expect(err).toContain('no force bypass');
    // The owner metadata must stay until the process exits / the pid is
    // proven dead — nothing was unlinked or rmdir'd.
    expect(h.fs.files.has(ownerPath)).toBe(true);
    expect(h.fs.dirs.has(lockDir)).toBe(true);
    expect(h.fs.events.filter((event) => event.startsWith('unlink '))).toEqual([]);
  });

  it('releases the lock even when the promotion seam throws', async () => {
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    h.runPromote.mockImplementation(() => () => Promise.reject(new Error('seam exploded')));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toMatch(/unexpected promote failure/);
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('bounds engine reasons and never dumps command logs', async () => {
    const secret = 'TOP-SECRET-COMMAND-OUTPUT-NEVER-LEAK';
    const h = makeHarness({ argv: ['--promote'] });
    h.runPreflight.mockImplementation(() =>
      Promise.resolve({
        kind: 'refused',
        refusal: {
          code: 'git_status_failed',
          reason: 'could not inspect the working tree',
          command: { outcome: 'exit', exitCode: 1, signal: null, diagnostic: secret },
        },
      }),
    );
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    const all = [...h.outLines, ...h.errLines].join('\n');
    expect(all).not.toContain(secret);

    // A huge engine reason is re-bounded at the CLI boundary.
    const h2 = makeHarness({ argv: ['--promote'] });
    h2.runPreflight.mockImplementation(() => Promise.resolve({ kind: 'ready', context: context('ready') }));
    h2.runPromote.mockImplementation(() => () =>
      Promise.resolve({
        kind: 'recovery_required',
        transactionId: 'tx-1',
        phase: 'mutating',
        reason: 'x'.repeat(10_000),
        retainLockUntilExit: false,
      }),
    );
    const code2 = await runUpkeepCommand(h2.deps);
    expect(code2).toBe(1);
    const huge = h2.errLines.find((line) => line.includes('promotion requires recovery'));
    expect(huge).toBeDefined();
    expect(Buffer.byteLength(huge!)).toBeLessThanOrEqual(MAX_REASON_BYTES);
    expect(huge!).toContain('… (truncated)');
  });
});

describe('recovery under lock', () => {
  it('runs recovery only while the lock is held and maps none to exit 0', async () => {
    const h = makeHarness({ argv: ['--recover'] });
    let lockHeldDuringRecovery = false;
    h.runRecover.mockImplementation((opts) => () => {
      lockHeldDuringRecovery = h.fs.files.has(ownerPath);
      expect(opts).toEqual({ repo: REPO, stateDir, disabled: false });
      return Promise.resolve({ kind: 'none', reason: 'no transaction evidence exists; nothing to recover' });
    });
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(lockHeldDuringRecovery).toBe(true);
    expect(h.outLines.join('\n')).toContain('nothing to recover');
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it.each([
    ['restored', (): RecoveryOutcome => ({ kind: 'restored', transactionId: 'tx-1', installed: '0.84.1', reason: 'original state verified' })],
    ['finalized', (): RecoveryOutcome => ({ kind: 'finalized', transactionId: 'tx-1', candidate: '0.85.0', verificationLevel: 'live', commit: 'b'.repeat(40) })],
  ] as const)('maps %s to exit 0', async (_name, makeOutcome) => {
    const h = makeHarness({ argv: ['--recover'] });
    h.runRecover.mockImplementation(() => () => Promise.resolve(makeOutcome()));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it.each([
    ['cleanup_pending', (): RecoveryOutcome => ({ kind: 'cleanup_pending', transactionId: 'tx-1', candidate: '0.85.0', commit: 'b'.repeat(40), reason: 'backup rm failed' })],
    ['blocked', (): RecoveryOutcome => ({ kind: 'blocked', transactionId: 'tx-1', phase: 'mutating', reason: 'HEAD moved while the journal is at mutating' })],
    ['error', (): RecoveryOutcome => ({ kind: 'error', message: 'recovery exploded' })],
  ] as const)('maps %s to a nonzero exit with guidance', async (_name, makeOutcome) => {
    const h = makeHarness({ argv: ['--recover'] });
    h.runRecover.mockImplementation(() => () => Promise.resolve(makeOutcome()));
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.length).toBeGreaterThan(0);
    // Every ordinary recovery outcome releases the owned lock.
    expect(h.fs.files.has(ownerPath)).toBe(false);
  });

  it('blocked recovery preserves-evidence guidance is explicit', async () => {
    const h = makeHarness({ argv: ['--recover'] });
    h.runRecover.mockImplementation(() => () =>
      Promise.resolve({
        kind: 'blocked',
        transactionId: 'tx-1',
        phase: 'mutating',
        reason: 'cannot verify the expected candidate commit',
      }),
    );
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(1);
    expect(h.errLines.join('\n')).toContain('recovery is blocked');
    expect(h.errLines.join('\n')).toContain('evidence');
  });
});

describe('real filesystem lock coordination (hermetic temp dir)', () => {
  const realFs: CoordinationFsOps = {
    mkdir: (path, options) => mkdir(path, options),
    readFile: (path) => fsReadFile(path, 'utf8'),
    writeFile: (path, data, options) => writeFile(path, data, options),
    realpath: (path) => realpath(path),
    readdir: (path) => readdir(path),
    chmod: (path, mode) => chmod(path, mode),
    stat: (path) => stat(path),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: (path) => unlink(path),
    rmdir: (path) => rmdir(path),
  };

  /** Coordinator harness on the real fs, faking only the seams. */
  function realHarness(base: string, repo: string): Harness {
    const runGitTopLevel = vi.fn<GitTopLevelFn>().mockImplementation(() => Promise.resolve({ kind: 'ok', repo }));
    const runPreflight = vi.fn<PreflightFn>().mockImplementation(() =>
      Promise.resolve({ kind: 'noop', context: context('noop') }),
    );
    const runPromote = vi.fn<PromoteFn>().mockImplementation(() => () => Promise.resolve(committedOutcome()));
    const runCanary = vi.fn<CanaryFn>().mockImplementation(() => () => Promise.resolve({ kind: 'ok' }));
    const runRecover = vi.fn<RecoverFn>().mockImplementation(() => () =>
      Promise.resolve({ kind: 'none', reason: 'nothing' }),
    );
    const outLines: string[] = [];
    const errLines: string[] = [];
    const deps: UpkeepCommandDeps = {
      argv: ['--promote'],
      disabled: false,
      fs: realFs,
      probe: probeProcess,
      sidecar: { host: '127.0.0.1', port: 14787, probe: () => Promise.resolve(false) },
      pid: process.pid,
      host: 'test-host',
      cwd: repo,
      stateRoot: base,
      runGitTopLevel,
      runPreflight,
      runPromote,
      runCanary,
      runRecover,
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    };
    return { deps, fs: {} as FakeFs, outLines, errLines, runGitTopLevel, runPreflight, runPromote, runCanary, runRecover };
  }

  it('a lock held by another updater blocks the action before the preflight; release permits it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-cli-real-'));
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    const repoStateDir = stateDirFor(await realpath(repo), base);
    await mkdir(repoStateDir, { recursive: true, mode: 0o700 });
    // Another updater: the same RepositoryLock on the same derived state dir.
    const other = new RepositoryLock(repoStateDir, {
      fs: realFs,
      pid: process.pid,
      host: 'test-host',
      probe: probeProcess,
    });
    const held = await other.acquire();
    expect(held.kind).toBe('acquired');
    try {
      const h = realHarness(base, repo);
      const code = await runUpkeepCommand(h.deps);
      expect(code).toBe(1);
      expect(h.errLines.join('\n')).toMatch(/promotion blocked —/);
      expect(h.runPreflight).not.toHaveBeenCalled();
    } finally {
      if (held.kind === 'acquired') expect(await held.lock.release()).toBe('released');
    }
    // Released lock permits the same action.
    const h2 = realHarness(base, repo);
    const code2 = await runUpkeepCommand(h2.deps);
    expect(code2).toBe(0);
    expect(h2.runPreflight).toHaveBeenCalledTimes(1);
    await rm(base, { recursive: true, force: true });
  });

  it('a stale lock recorded for a positively-dead pid is reclaimed and the action proceeds', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) throw new Error('spawnSync returned no pid');
    expect(probeProcess(child.pid)).toBe('dead');
    const base = await mkdtemp(join(tmpdir(), 'fo-cli-stale-'));
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    const repoStateDir = stateDirFor(await realpath(repo), base);
    const staleLockDir = join(repoStateDir, LOCK_DIR);
    await mkdir(staleLockDir, { recursive: true });
    await writeFile(join(staleLockDir, ownerFileName('stale')), JSON.stringify(owner(child.pid, 'stale')));
    const h = realHarness(base, repo);
    const code = await runUpkeepCommand(h.deps);
    expect(code).toBe(0);
    expect(h.runPreflight).toHaveBeenCalledTimes(1);
    await rm(base, { recursive: true, force: true });
  });
});

describe('package script and CLI entry shape', () => {
  it('wires npm run upkeep:embedded to the CLI entry without touching the lockfile scripts', async () => {
    const pkg = JSON.parse(await fsReadFile(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['upkeep:embedded']).toContain('tools/pi-upkeep/upkeep-cli.ts');
    // The lockfile never carries scripts; adding the npm script must not have
    // changed package-lock.json.
    const lock = JSON.parse(await fsReadFile(join(repoRoot, 'package-lock.json'), 'utf8')) as Record<string, unknown>;
    expect(lock['scripts']).toBeUndefined();
  });

  it('the CLI entry stays SDK-free, never imports the server core, and sets exitCode without process.exit', async () => {
    const source = await fsReadFile(join(repoRoot, 'tools/pi-upkeep/upkeep-cli.ts'), 'utf8');
    expect(source).not.toContain('@earendil-works/pi-coding-agent');
    expect(source).not.toMatch(/import\(/);
    expect(source).toContain('process.exitCode');
    expect(source).not.toContain('process.exit(');
    for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? '';
      expect(specifier.startsWith('node:') || specifier.startsWith('.'), `imports ${specifier}`).toBe(true);
    }
  });

  it('rejects conflicting/unknown arguments through the coordinator with a nonzero exit', async () => {
    for (const argv of [['--promote', '--recover'], ['--nonsense']]) {
      const h = makeHarness({ argv: [...argv] });
      const code = await runUpkeepCommand(h.deps);
      expect(code).toBe(1);
      expect(h.errLines.join('\n')).toContain(USAGE);
      expect(h.fs.events).toEqual([]);
    }
  });
});
