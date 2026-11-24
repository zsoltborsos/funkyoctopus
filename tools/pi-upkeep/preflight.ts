/**
 * Promotion preflight engine.
 *
 * The Phase 4 orchestrator acquires the repository lock and then runs this
 * preflight to establish every pre-mutation fact and refusal BEFORE any
 * journal, sentinel, backup, or dependency change exists. The preflight is
 * strictly read-only — it performs no writes, renames, or cleans, never
 * stashes/resets/cleans the tree, and refuses before mutation when:
 *
 * - upkeep is disabled (first and cheapest refusal, before any I/O);
 * - the repository cannot be canonically identified, or the git top-level
 *   does not match the canonical root;
 * - a transaction sentinel/journal is present, orphaned, or failed closed;
 * - embedded state reports cleanup pending (or is unreadable, so
 *   cleanup-pending cannot be ruled out — fail closed);
 * - the source tree `<repo>/node_modules` and the sibling backup parent
 *   are not on the same filesystem, or their device ids cannot be
 *   established (repos and node_modules may be mountpoints);
 * - HEAD is detached or not a full 40-hex sha;
 * - the tree has tracked or untracked changes;
 * - `package.json`/`package-lock.json` are unreadable or not valid JSON;
 * - `npm ls <sdk> --json` fails or validateBaseline does not agree exactly;
 * - the fresh stable-latest lookup fails or evaluateLatest rejects;
 * - the production baseline build fails (promotable runs only; an
 *   already-current no-op mutates nothing and needs no checkpoint, so it
 *   skips the build — there is no full `npm run verify` baseline).
 *
 * A successful run returns an immutable `PromotionContext` carrying every
 * fact the transaction slice needs — canonical repo, state dir, branch,
 * original HEAD, exact installed/candidate versions, byte-exact manifest
 * snapshots, a deterministic same-filesystem sibling backup path, and
 * bounded log paths — without creating any of them. Already-current state is
 * a no-op result with the same context.
 *
 * Every external effect goes through injected seams: the coordination fs
 * (realpath + byte reads), runCommand's spawn, the transaction and embedded
 * state readers, and the fresh stable-latest reader. The production binding
 * (`productionPreflight`) wires node fs/spawn and is never invoked by
 * default tests.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { chmod, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { validateBaseline, type BaselineIssue } from './baseline.ts';
import { EMBEDDED_SDK_PACKAGE, productionReadStableLatest } from '../../server/src/upkeep/detect.ts';
import { loadEmbeddedState, type EmbeddedStateLoad } from '../../server/src/upkeep/embedded-state.ts';
import { readTransaction, type ManifestSnapshot, type TransactionState } from './journal.ts';
import { nodeSpawn, runCommand, type CommandOutcome, type CommandRunFacts, type RunCommandDeps } from '../../server/src/upkeep/run-command.ts';
import { defaultStateRoot, repositoryStateDir, sha256Hex, type CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';
import { evaluateLatest } from '../../server/src/upkeep/stable-latest.ts';
import { messageOf } from './errors.ts';

/** Ceiling for read-only git calls (identity, branch, HEAD, status). */
export const GIT_READ_TIMEOUT_MS = 30_000;
/** Ceiling for `npm ls <sdk> --json`. */
export const NPM_LS_TIMEOUT_MS = 5 * 60 * 1000;
/** Ceiling for the baseline production build (upkeep command contract). */
export const BASELINE_BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * The registry lookup keeps its own 30s ceiling inside the shared
 * stable-latest reader (detect.ts), so the preflight itself does not re-limit
 * it.
 */
/** Diagnostic embedded in command refusals, after runCommand's tail bound. */
export const MAX_DIAGNOSTIC_CHARS = 2_000;
/** Name prefix of the transaction-safe backup sibling. */
export const BACKUP_NAME_PREFIX = 'node_modules-backup';

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface BoundedCommandFacts {
  outcome: 'exit' | 'terminated' | 'error';
  exitCode: number | null;
  signal: string | null;
  /** Bounded tail of the combined command output. */
  diagnostic: string;
}

export type PreflightRefusal =
  | { code: 'disabled'; reason: string }
  | { code: 'transaction_state'; reason: string; transactionId: string | null; phase: string | null }
  | { code: 'cleanup_pending'; reason: string }
  | { code: 'embedded_state_unreadable'; reason: string }
  | { code: 'path_inside_repo'; reason: string; path: string; repo: string }
  | { code: 'repo_identity'; reason: string; command: BoundedCommandFacts }
  | { code: 'repo_root_mismatch'; reason: string; gitRoot: string; canonical: string }
  | { code: 'detached_head'; reason: string; command: BoundedCommandFacts }
  | { code: 'bad_head'; reason: string; command: BoundedCommandFacts }
  | { code: 'git_status_failed'; reason: string; command: BoundedCommandFacts }
  | { code: 'dirty_tree'; reason: string; tracked: string[]; untracked: string[] }
  | { code: 'manifest_unreadable'; reason: string; path: string }
  | { code: 'manifest_invalid'; reason: string; path: string }
  | { code: 'npm_ls_failed'; reason: string; command: BoundedCommandFacts }
  | { code: 'npm_ls_malformed'; reason: string; diagnostic: string }
  | { code: 'baseline_needs_attention'; reason: string; issues: BaselineIssue[] }
  | { code: 'latest_failed'; reason: string }
  | { code: 'latest_rejected'; reason: string; raw: string | null }
  | { code: 'baseline_build_failed'; reason: string; command: BoundedCommandFacts }
  | { code: 'backup_device_unreadable'; reason: string; path: string }
  | { code: 'backup_device_invalid'; reason: string; path: string; device: number }
  | { code: 'backup_device_mismatch'; reason: string; sourceTree: string; backupParent: string; sourceDevice: number; backupDevice: number };

export type PreflightResult =
  | { kind: 'refused'; refusal: PreflightRefusal }
  | { kind: 'noop'; context: PromotionContext }
  | { kind: 'ready'; context: PromotionContext }
  | { kind: 'error'; message: string };

/** Immutable facts a future transaction slice needs; nothing here is created. */
export interface PromotionContext {
  readonly decision: 'ready' | 'noop';
  /** Canonical repository path (realpath), as hashed for the state dir. */
  readonly canonicalRepo: string;
  /** Repository-scoped state dir holding journal/sentinel/logs. */
  readonly stateDir: string;
  /** Original named branch. */
  readonly branch: string;
  /** Original full 40-hex HEAD commit. */
  readonly head: string;
  /** Exact baseline version agreed by manifests, npm ls, and validateBaseline. */
  readonly installedVersion: string;
  /** Exact candidate version; equals `installedVersion` on a no-op. */
  readonly candidateVersion: string;
  /** Byte-exact original manifest contents and sha256 hashes. */
  readonly manifests: Readonly<{
    packageJson: ManifestSnapshot;
    packageLock: ManifestSnapshot;
  }>;
  /** Deterministic same-filesystem sibling of the repo; never created here. */
  readonly backup: string;
  /** Bounded log paths under the state dir; never created here. */
  readonly logs: readonly string[];
}

export interface PreflightOptions {
  /** Embedded SDK package name, e.g. `@earendil-works/pi-coding-agent`. */
  sdk: string;
  /** Repository root as the orchestrator knows it; canonicalized by realpath. */
  repoPath: string;
  /** `FUNKYOCTOPUS_UPKEEP_DISABLED=1` — the first and cheapest refusal. */
  disabled: boolean;
  /** Shared coordination fs; production binds node:fs/promises (entrypoint.ts). */
  fs: CoordinationFsOps;
  /** runCommand's spawn seam; tests inject a fake, production binds nodeSpawn. */
  command: RunCommandDeps;
  /** Fresh stable-latest reader; production binds `productionReadStableLatest()`. */
  readLatest: () => Promise<string | null>;
  /**
   * Resolves a path's device id (`node:fs` `Stats.dev`) for backup
   * same-filesystem safety. Injected because `CoordinationFsOps.stat` only
   * exposes the lock's `mtimeMs`; production binds node fs. Any stat error,
   * missing or non-finite device, or device mismatch refuses.
   */
  statDevice: (path: string) => Promise<number>;
  /** Transaction sentinel/journal reader; defaults to journal's readTransaction. */
  readTransactionState?: (stateDir: string, fs: CoordinationFsOps) => Promise<TransactionState>;
  /** Embedded-state reader; defaults to embedded-state's loadEmbeddedState. */
  readEmbeddedState?: (stateDir: string, fs: CoordinationFsOps) => Promise<EmbeddedStateLoad>;
  /** State root override for deterministic tests; defaults via XDG_STATE_HOME. */
  stateRoot?: string;
  /** Unique suffix for the backup/log paths; defaults to a fresh UUID. */
  randomId?: () => string;
}

/**
 * Runs the full preflight. Never mutates and never rejects: every external
 * failure becomes a typed refusal or error outcome.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  // 1. Disabled upkeep is the first refusal, before any fs or command I/O.
  if (options.disabled) {
    return refused({
      code: 'disabled',
      reason: 'upkeep is disabled (FUNKYOCTOPUS_UPKEEP_DISABLED=1); promotion refuses before any inspection',
    });
  }

  // 2. Canonical repository identity: the realpath, and the git top-level
  //    must agree with it. A repoPath that points at a subdirectory (or a
  //    different checkout) refuses before any state or tree inspection.
  let canonical: string;
  try {
    canonical = await options.fs.realpath(options.repoPath);
  } catch (error) {
    return { kind: 'error', message: `could not resolve the repository path: ${messageOf(error)}` };
  }
  const topLevelOutcome = await runGit(options.command, canonical, ['rev-parse', '--show-toplevel']);
  if (topLevelOutcome.kind !== 'exit' || topLevelOutcome.code !== 0) {
    return refused({
      code: 'repo_identity',
      reason: 'could not read the git repository root',
      command: commandFactsOf(topLevelOutcome),
    });
  }
  const gitTopRaw = topLevelOutcome.facts.stdout.trim();
  const gitRoot = await resolveSafely(options.fs, gitTopRaw);
  if (gitRoot !== canonical) {
    return refused({
      code: 'repo_root_mismatch',
      reason: `git top-level ${JSON.stringify(gitRoot)} does not match the canonical repository ${JSON.stringify(canonical)}`,
      gitRoot,
      canonical,
    });
  }

  // The state dir derives from the canonical identity. Context paths must
  // never land inside the repo (e.g. a hostile state root), so the derived
  // state dir is containment-checked before anything reads or writes it.
  let stateDir: string;
  try {
    const pathDeps: Parameters<typeof repositoryStateDir>[1] = { fs: options.fs };
    if (options.stateRoot !== undefined) pathDeps.stateRoot = options.stateRoot;
    stateDir = await repositoryStateDir(options.repoPath, pathDeps);
  } catch (error) {
    return { kind: 'error', message: `could not derive the state directory: ${messageOf(error)}` };
  }
  if (isInside(stateDir, canonical)) {
    return refused({
      code: 'path_inside_repo',
      reason: 'the state directory would land inside the repository',
      path: stateDir,
      repo: canonical,
    });
  }

  // 3. Independent transaction sentinel/journal inspection. Only a provably
  //    absent transaction passes; active, orphaned, completed, or failed
  //    closed evidence refuses (recovery owns those states).
  const readTransactionState = options.readTransactionState ?? readTransaction;
  const transaction = await readTransactionState(stateDir, options.fs);
  if (transaction.kind !== 'none') {
    if (transaction.kind === 'active') {
      return refused({
        code: 'transaction_state',
        reason: `an active promotion transaction (${transaction.journal.transactionId}) is at phase ${transaction.journal.phase}; recovery must resolve it first`,
        transactionId: transaction.journal.transactionId,
        phase: transaction.journal.phase,
      });
    }
    if (transaction.kind === 'orphan_prepared') {
      return refused({
        code: 'transaction_state',
        reason: `an orphan prepared journal (${transaction.journal.transactionId}) exists without its sentinel; recovery must resolve it first`,
        transactionId: transaction.journal.transactionId,
        phase: transaction.journal.phase,
      });
    }
    if (transaction.kind === 'completed') {
      return refused({
        code: 'cleanup_pending',
        reason: `transaction ${transaction.journal.transactionId} committed but its backup cleanup is pending; recovery must finish it first`,
      });
    }
    return refused({
      code: 'transaction_state',
      reason: `transaction evidence is ambiguous or failed closed: ${transaction.reason}`,
      transactionId: null,
      phase: null,
    });
  }

  // 4. Embedded upkeep state: cleanup pending refuses; unreadable fails
  //    closed (the sentinel/journal philosophy — inability to prove absence
  //    of a condition blocks promotion, never silently ignores it).
  const readEmbeddedState = options.readEmbeddedState ?? loadEmbeddedState;
  const embedded = await readEmbeddedState(stateDir, options.fs);
  if (embedded.kind === 'invalid') {
    return refused({
      code: 'embedded_state_unreadable',
      reason: `embedded upkeep state is unreadable, so cleanup-pending cannot be ruled out: ${embedded.reason}`,
    });
  }
  if (embedded.kind === 'loaded' && embedded.state.status === 'cleanup_pending') {
    return refused({
      code: 'cleanup_pending',
      reason: 'embedded upkeep state reports pending backup cleanup; recovery must finish it first',
    });
  }

  // 5. Backup same-filesystem safety: the transaction renames the real
  //    source tree `<repo>/node_modules` to a sibling of the repo, which
  //    `rename` requires to be on one filesystem. The repo root or its
  //    node_modules may be mountpoints, so the actual device ids of the two
  //    real targets are compared — never assumed. The probe runs after the
  //    read-only transaction/embedded state inspection, so an active,
  //    orphaned, completed, or failed-closed transaction — or embedded
  //    cleanup-pending — refuses with its own state refusal even when
  //    node_modules is absent or unstatable. Any stat error, missing or
  //    non-finite device, or device mismatch refuses before the branch,
  //    tree, manifests, npm, latest, build, or any mutation. There is no
  //    fallback location in v1.
  const sourceTree = join(canonical, 'node_modules');
  const backupParent = dirname(canonical);
  const sourceDevice = await statDeviceOf(options.statDevice, sourceTree);
  if (sourceDevice.kind === 'refused') return { kind: 'refused', refusal: sourceDevice.refusal };
  const backupDevice = await statDeviceOf(options.statDevice, backupParent);
  if (backupDevice.kind === 'refused') return { kind: 'refused', refusal: backupDevice.refusal };
  if (sourceDevice.device !== backupDevice.device) {
    return refused({
      code: 'backup_device_mismatch',
      reason: `the source tree ${JSON.stringify(sourceTree)} and the backup parent ${JSON.stringify(backupParent)} are not on the same filesystem, so the sibling backup could not be renamed onto it`,
      sourceTree,
      backupParent,
      sourceDevice: sourceDevice.device,
      backupDevice: backupDevice.device,
    });
  }

  // 6. Named branch: `git symbolic-ref --short HEAD` fails when detached.
  const branchOutcome = await runGit(options.command, canonical, ['symbolic-ref', '--short', 'HEAD']);
  if (branchOutcome.kind !== 'exit' || branchOutcome.code !== 0) {
    return refused({
      code: 'detached_head',
      reason: 'HEAD is detached or does not name a branch',
      command: commandFactsOf(branchOutcome),
    });
  }
  const branch = branchOutcome.facts.stdout.trim();
  if (branch === '') {
    return refused({
      code: 'detached_head',
      reason: 'HEAD names no branch',
      command: commandFactsOf(branchOutcome),
    });
  }

  // 7. Full HEAD: exactly one 40-hex commit sha.
  const headOutcome = await runGit(options.command, canonical, ['rev-parse', 'HEAD']);
  if (headOutcome.kind !== 'exit' || headOutcome.code !== 0) {
    return refused({
      code: 'bad_head',
      reason: 'could not read HEAD',
      command: commandFactsOf(headOutcome),
    });
  }
  const head = headOutcome.facts.stdout.trim();
  if (!FULL_SHA.test(head)) {
    return refused({
      code: 'bad_head',
      reason: `HEAD is not a full 40-hex commit sha: ${JSON.stringify(head)}`,
      command: commandFactsOf(headOutcome),
    });
  }

  // 8. Completely clean tree: tracked and untracked, never cleaned/stashed.
  //    Config-proof seam: `--porcelain=v1` pins the report format (config
  //    could otherwise raise the version) and `--untracked-files=all` forces
  //    every untracked file to appear individually (config cannot hide
  //    them).
  const statusOutcome = await runGit(options.command, canonical, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (statusOutcome.kind !== 'exit' || statusOutcome.code !== 0) {
    return refused({
      code: 'git_status_failed',
      reason: 'git status failed',
      command: commandFactsOf(statusOutcome),
    });
  }
  const { tracked, untracked } = parsePorcelain(statusOutcome.facts.stdout);
  if (tracked.length > 0 || untracked.length > 0) {
    return refused({
      code: 'dirty_tree',
      reason: 'the working tree must be completely clean (tracked and untracked) before promotion',
      tracked,
      untracked,
    });
  }

  // 9. Exact byte reads of both npm manifests; invalid JSON refuses.
  const packageJsonRead = await readManifest(canonical, 'package.json', options.fs);
  if (packageJsonRead.kind === 'refused') return { kind: 'refused', refusal: packageJsonRead.refusal };
  const packageLockRead = await readManifest(canonical, 'package-lock.json', options.fs);
  if (packageLockRead.kind === 'refused') return { kind: 'refused', refusal: packageLockRead.refusal };

  // 10. `npm ls <sdk> --json` must succeed and validateBaseline must agree
  //    exactly on one stable version — no repair, no guessing.
  const lsOutcome = await runCommand(options.command, {
    command: 'npm',
    args: ['ls', options.sdk, '--json'],
    timeoutMs: NPM_LS_TIMEOUT_MS,
    cwd: canonical,
  });
  if (lsOutcome.kind !== 'exit' || lsOutcome.code !== 0) {
    return refused({
      code: 'npm_ls_failed',
      reason: `npm ls ${options.sdk} failed`,
      command: commandFactsOf(lsOutcome),
    });
  }
  let npmLs: unknown;
  try {
    npmLs = JSON.parse(lsOutcome.facts.stdout);
  } catch {
    return refused({
      code: 'npm_ls_malformed',
      reason: `npm ls ${options.sdk} printed no valid JSON`,
      diagnostic: boundedDiagnostic(lsOutcome.facts),
    });
  }
  const baseline = validateBaseline({
    sdk: options.sdk,
    packageJson: packageJsonRead.parsed,
    packageLock: packageLockRead.parsed,
    npmLs,
  });
  if (baseline.kind === 'needs_attention') {
    return refused({
      code: 'baseline_needs_attention',
      reason: 'package declaration, lockfile, installed resolution, and npm ls do not agree on one exact version',
      issues: baseline.issues,
    });
  }
  const installed = baseline.version;

  // 11. Fresh stable-latest lookup; evaluateLatest decides no-op vs candidate.
  const latestRaw = await options.readLatest();
  if (latestRaw === null) {
    return refused({
      code: 'latest_failed',
      reason: 'fresh stable-latest lookup failed; no candidate is known',
    });
  }
  const decision = evaluateLatest(latestRaw, installed);
  if (decision.kind === 'reject') {
    return refused({ code: 'latest_rejected', reason: decision.reason, raw: decision.raw });
  }
  const candidate = decision.kind === 'noop' ? decision.latest : decision.candidate;
  const action = decision.kind === 'noop' ? 'noop' : 'ready';

  // 12. The production baseline build is the last gate before a promotable
  //     decision. An already-current no-op mutates nothing and creates no
  //     checkpoint, so it skips the build. There is no full `npm run verify`
  //     baseline.
  if (action === 'ready') {
    const buildOutcome = await runCommand(options.command, {
      command: 'npm',
      args: ['run', 'build'],
      timeoutMs: BASELINE_BUILD_TIMEOUT_MS,
      cwd: canonical,
    });
    if (buildOutcome.kind !== 'exit' || buildOutcome.code !== 0) {
      return refused({
        code: 'baseline_build_failed',
        reason: 'production baseline build failed',
        command: commandFactsOf(buildOutcome),
      });
    }
  }

  // Deterministic same-filesystem sibling backup and bounded log paths,
  // never created by this preflight.
  const unique = options.randomId ? options.randomId() : randomUUID();
  const backup = backupPathFor(canonical, head, unique);
  if (isInside(backup, canonical)) {
    return refused({
      code: 'path_inside_repo',
      reason: 'the backup path would land inside the repository',
      path: backup,
      repo: canonical,
    });
  }
  const logs = Object.freeze(logPathsFor(stateDir, unique));

  const context: PromotionContext = Object.freeze({
    decision: action,
    canonicalRepo: canonical,
    stateDir,
    branch,
    head,
    installedVersion: installed,
    candidateVersion: candidate,
    manifests: Object.freeze({
      packageJson: Object.freeze({ ...packageJsonRead.snapshot }),
      packageLock: Object.freeze({ ...packageLockRead.snapshot }),
    }),
    backup,
    logs,
  });
  return action === 'noop' ? { kind: 'noop', context } : { kind: 'ready', context };
}

/**
 * Production binding: real node fs reads, node's own spawn, the bounded
 * stable-latest reader, and the configured state root. Never invoked by
 * default tests.
 */
export function productionPreflight(repoPath: string): () => Promise<PreflightResult> {
  const fs: CoordinationFsOps = {
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
  };
  return () =>
    runPreflight({
      sdk: EMBEDDED_SDK_PACKAGE,
      repoPath,
      disabled: process.env.FUNKYOCTOPUS_UPKEEP_DISABLED === '1',
      fs,
      command: { spawn: nodeSpawn },
      readLatest: productionReadStableLatest(),
      statDevice: (path) => stat(path).then((stats) => stats.dev),
      stateRoot: defaultStateRoot(process.env.XDG_STATE_HOME, homedir),
    });
}

function runGit(deps: RunCommandDeps, cwd: string, args: string[]): Promise<CommandOutcome> {
  return runCommand(deps, {
    command: 'git',
    args,
    timeoutMs: GIT_READ_TIMEOUT_MS,
    cwd,
  });
}

function commandFactsOf(outcome: CommandOutcome): BoundedCommandFacts {
  if (outcome.kind === 'exit') {
    return {
      outcome: 'exit',
      exitCode: outcome.code,
      signal: outcome.signal,
      diagnostic: boundedDiagnostic(outcome.facts),
    };
  }
  if (outcome.kind === 'terminated') {
    return {
      outcome: 'terminated',
      exitCode: null,
      signal: null,
      diagnostic: boundedDiagnostic(outcome.facts),
    };
  }
  return {
    outcome: 'error',
    exitCode: null,
    signal: null,
    diagnostic: boundedDiagnostic(outcome.facts),
  };
}

function boundedDiagnostic(facts: CommandRunFacts): string {
  const raw = facts.log || facts.stderr || facts.stdout;
  return raw.length > MAX_DIAGNOSTIC_CHARS ? raw.slice(-MAX_DIAGNOSTIC_CHARS) : raw;
}

/** True when `path` equals `ancestor` or lies inside it (path-separator safe). */
export function isInside(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  const rel = relative(ancestor, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Deterministic same-filesystem sibling of the repo: parent dir, repo name,
 * the first 12 sha chars, and a transaction-safe unique suffix. Recovery
 * re-derives this exact form to recognize the journal's own backup path.
 */
export function backupPathFor(canonicalRepo: string, head: string, unique: string): string {
  return join(
    dirname(canonicalRepo),
    `${basename(canonicalRepo)}-${BACKUP_NAME_PREFIX}-${head.slice(0, 12)}-${unique}`,
  );
}

/** Bounded operation-log paths the transaction slice will write. */
export function logPathsFor(stateDir: string, unique: string): string[] {
  return [
    join(stateDir, `promotion-${unique}.log`),
    join(stateDir, `promotion-${unique}.stderr.log`),
  ];
}

/**
 * Parses the pinned `git status --porcelain=v1 --untracked-files=all`
 * contract: single-line v1 entries — `XY PATH` for tracked (v1 keeps a
 * rename on one line), `?? PATH` for each untracked file, never a collapsed
 * directory.
 */
function parsePorcelain(stdout: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const line of stdout.split('\n')) {
    const entry = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (entry === '') continue;
    if (entry.startsWith('??')) untracked.push(entry.slice(2).trim());
    else tracked.push(entry);
  }
  return { tracked, untracked };
}

type ManifestRead =
  | { kind: 'ok'; snapshot: ManifestSnapshot; parsed: unknown }
  | { kind: 'refused'; refusal: PreflightRefusal };

/** Byte-exact read of one manifest; unreadable or non-JSON refuses. */
async function readManifest(
  repo: string,
  name: string,
  fs: CoordinationFsOps,
): Promise<ManifestRead> {
  const path = join(repo, name);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    return {
      kind: 'refused',
      refusal: {
        code: 'manifest_unreadable',
        reason: `${name} is unreadable: ${messageOf(error)}`,
        path,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: 'refused',
      refusal: { code: 'manifest_invalid', reason: `${name} is not valid JSON`, path },
    };
  }
  return { kind: 'ok', snapshot: { content: raw, sha256: sha256Hex(raw) }, parsed };
}

type DeviceRead =
  | { kind: 'ok'; device: number }
  | { kind: 'refused'; refusal: PreflightRefusal };

/**
 * One same-filesystem probe for the sibling backup: a stat error (including
 * a missing path) and a missing or non-finite device id both refuse; the
 * result is only ever a finite device id.
 */
async function statDeviceOf(statDevice: (path: string) => Promise<number>, path: string): Promise<DeviceRead> {
  let device: number;
  try {
    device = await statDevice(path);
  } catch (error) {
    return {
      kind: 'refused',
      refusal: {
        code: 'backup_device_unreadable',
        reason: `cannot stat ${path} for backup same-filesystem safety: ${messageOf(error)}`,
        path,
      },
    };
  }
  if (!Number.isFinite(device)) {
    return {
      kind: 'refused',
      refusal: {
        code: 'backup_device_invalid',
        reason: `the device id of ${path} is not a finite number`,
        path,
        device,
      },
    };
  }
  return { kind: 'ok', device };
}

async function resolveSafely(fs: CoordinationFsOps, path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return path;
  }
}

function refused(refusal: PreflightRefusal): PreflightResult {
  return { kind: 'refused', refusal };
}
