/**
 * Transactional promotion engine (test-first).
 *
 * Runs one explicit embedded-SDK promotion from an immutable `PromotionContext`
 * returned by the preflight (`preflight.ts`). The orchestrator holds the
 * repository lock before calling in; this engine re-checks the context/tree
 * invariants immediately before arming to close preflight-to-mutation races.
 *
 * Transaction order:
 *   1. prepared journal + exclusive blocking sentinel, then armed;
 *   2. advance armed -> mutating BEFORE the first repo mutation;
 *   3. atomically rename the whole `node_modules` tree to the preflight
 *      same-filesystem sibling backup;
 *   4. `npm install --save-exact <sdk>@<candidate>` into the fresh tree with
 *      lifecycle scripts enabled;
 *   5. validate package.json/package-lock.json scope and the candidate's
 *      exact `npm ls`, and record the candidate manifest snapshots;
 *   6. gates: `npm run verify`, `npm run build`, bounded production audit,
 *      then the injected live canary (aborted through its AbortSignal at the
 *      120s ceiling, with a bounded cleanup grace) unless one-shot skip;
 *   7. stage only package.json/package-lock.json and prove the NUL-separated
 *      staged set is exactly those two;
 *   8. a normal `git commit -m chore(deps): update embedded pi to <version>`
 *      through the repository hooks (never `--no-verify`);
 *   9. verify the new HEAD is a direct child of the preflight HEAD, the
 *      committed path set is exactly the two manifests, and the committed
 *      blobs equal the working files; journal committed; delete the obsolete
 *      backup;
 *  10. finalize: clear the sentinel, remove the journal, persist the verified
 *      state.
 *
 * Every external effect goes through injected seams: the coordination fs
 * (plus recursive `rm`), runCommand's spawn, the stat-device probe, the live
 * canary, and the embedded-state reader. The production binding
 * (`productionPromote`) wires node fs/spawn but is never invoked by default
 * tests. Rollback restores the exact old manifest bytes atomically, deletes
 * the candidate tree, renames the saved old tree back offline, requires the
 * recorded version, clean `npm ls`, and a production build, then un-stages
 * the two manifests and proves a config-proof clean tree before clearing the
 * sentinel. A fallback preserves the last evidence tree (determined by actual
 * fs presence, never the checkpoint flag) before `npm ci`; its cleanup
 * failure refuses finalization. A filesystem deadline cancels the restore,
 * awaits the in-flight step to settle, and never starts a fallback. A failed
 * or ambiguous rollback preserves the sentinel, journal, backup, and logs
 * and returns `recovery_required`.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_REASON_BYTES, boundedReason } from './bounded-reason.ts';
import { validateBaseline } from './baseline.ts';
import { EMBEDDED_SDK_PACKAGE } from '../../server/src/upkeep/detect.ts';
import {
  defaultEmbeddedState,
  loadEmbeddedState,
  saveEmbeddedState,
  type EmbeddedStateFs,
  type EmbeddedStateLoad,
  type PersistedEmbeddedState,
} from '../../server/src/upkeep/embedded-state.ts';
import {
  prepareTransaction,
  removeJournal,
  updateJournal,
  type JournalPhase,
  type NewJournalData,
  type TransactionJournal,
} from './journal.ts';
import { clearSentinel } from './sentinel.ts';
import { validateLockScope, validatePackageJsonScope } from './manifest-scope.ts';
import { GIT_READ_TIMEOUT_MS, NPM_LS_TIMEOUT_MS, type PromotionContext } from './preflight.ts';
import {
  CANDIDATE_BUILD_TIMEOUT_MS,
  EXPECTED_COMMIT_PATHS,
  FALLBACK_CI_TIMEOUT_MS,
  ROLLBACK_FS_TIMEOUT_MS,
  boundedTail,
  byteTail,
  fallbackRestore,
  isEnoent,
  messageOf,
  parseJson,
  parseNulList,
  proveCleanTree,
  readHead,
  readManifestOrNull,
  restoreOffline,
  runGit,
  unstageStagedManifests,
  verifyOldTree,
  type RollbackSeams,
} from './rollback.ts';
// The shared ceilings are defined once in the rollback helpers and re-exported
// here so callers keep importing the transaction ceilings from promote.ts.
export { CANDIDATE_BUILD_TIMEOUT_MS, FALLBACK_CI_TIMEOUT_MS, ROLLBACK_FS_TIMEOUT_MS };
import { nodeSpawn, runCommand, type CommandOutcome, type RunCommandDeps } from '../../server/src/upkeep/run-command.ts';
import { ensureStateDir, sha256Hex, type CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';
import { recordOf } from './records.ts';

/** Ceilings from the upkeep command contract (tests inject shorter ones). */
export const CANARY_CLEANUP_GRACE_MS = 30_000;
export const CANDIDATE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DETERMINISTIC_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
export const AUDIT_TIMEOUT_MS = 2 * 60 * 1000;
export const CANARY_TIMEOUT_MS = 120_000;
export const COMMIT_TIMEOUT_MS = 15 * 60 * 1000;
/** Per-file ceiling of the bounded operation logs written under the state dir. */
export const MAX_PROMOTION_LOG_BYTES = 64 * 1024;
/** Per-command output tail appended to the operation log. */
const MAX_COMMAND_LOG_TAIL = 4 * 1024;

const AUDIT_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;

/**
 * Live-canary seam outcome; Phase 5 binds the real production path.
 *
 * `unsafe` is a cleanup ambiguity — the canary could not prove its session is
 * gone (disposal rejected). The gate maps it to recovery_required: the repo
 * must never be rolled back or mutated while a live canary session may still
 * run. `failed` remains the ordinary rejected-canary outcome (disposal
 * succeeded, rollback safe).
 */
export type CanaryOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unsafe'; reason: string };

/** The canary-gate verdict after the timeout/grace handling; `unsafe` is folded into `recovery`. */
type CanaryGateVerdict =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'recovery'; reason: string };

/** Coordination fs plus recursive directory removal and presence probing. */
export interface PromoteFsOps extends CoordinationFsOps {
  /** Recursively removes a directory tree (node fs `rm({ recursive: true })`). */
  rm(path: string, options: { recursive: boolean }): Promise<void>;
  /**
   * True only when the path exists. Any error other than a definite ENOENT
   * propagates so an ambiguous backup/tree state fails closed. Production
   * binds a stat probe; tests bind the fake fs's map.
   */
  exists(path: string): Promise<boolean>;
}

export interface PromoteOptions {
  /** Embedded SDK package name, e.g. `@earendil-works/pi-coding-agent`. */
  sdk: string;
  /** Immutable ready context from the preflight (decision must be `ready`). */
  context: PromotionContext;
  /** Coordination fs; production binds node:fs/promises (plus `rm`). */
  fs: PromoteFsOps;
  /** runCommand's spawn seam; tests inject a fake, production binds nodeSpawn. */
  command: RunCommandDeps;
  /** Device probe for backup same-filesystem safety (same seam as preflight). */
  statDevice: (path: string) => Promise<number>;
  /**
   * The live canary; aborted via its AbortSignal at the 120s ceiling. A
   * settlement after the abort still counts as the timeout failure; a
   * canary that does not settle within the bounded cleanup grace forces
   * `recovery_required` without rollback (repo mutation must never race a
   * live canary). Skipped entirely when `skipCanary` is true.
   */
  runCanary: (signal: AbortSignal) => Promise<CanaryOutcome>;
  /** One-run deterministic-only promotion: no canary, `deterministic_only` level. */
  skipCanary: boolean;
  /** Cleanup grace after the canary abort; defaults to CANARY_CLEANUP_GRACE_MS. */
  canaryCleanupGraceMs?: number;
  /** Embedded-state reader; defaults to embedded-state's loadEmbeddedState. */
  readEmbeddedState?: (stateDir: string, fs: Pick<EmbeddedStateFs, 'readFile'>) => Promise<EmbeddedStateLoad>;
  now?: () => number;
  randomId?: () => string;
  /** Operation-log byte ceiling; defaults to MAX_PROMOTION_LOG_BYTES. */
  logLimitBytes?: number;
}

export type PromotionOutcome =
  | { kind: 'noop'; installed: string }
  | {
      kind: 'committed';
      transactionId: string;
      candidate: string;
      verificationLevel: 'live' | 'deterministic_only';
      commit: string;
    }
  | { kind: 'rolled_back'; transactionId: string; installed: string; reason: string }
  | {
      kind: 'cleanup_pending';
      transactionId: string;
      candidate: string;
      commit: string;
      reason: string;
    }
  | {
      kind: 'recovery_required';
      transactionId: string;
      phase: JournalPhase;
      reason: string;
      /**
       * Lock disposition for the CLI orchestrator: true only when a live
       * canary session may still be running (unsafe settlement, no settle
       * within the cleanup grace, or an unexpected async rejection), so the
       * repository lock must NOT be released until this process exits — a
       * concurrent promotion or recovery must never race a possibly-live
       * canary. Ordinary transaction recovery_required (journal, commit, or
       * rollback failures, which provably happened after the canary settled
       * or was skipped) sets false and the orchestrator releases the lock it
       * owns on exit.
       */
      retainLockUntilExit: boolean;
    }
  | { kind: 'error'; message: string };

/** Bounded private operation log: keeps only the tail under the byte ceiling. */
export class BoundedLogFile {
  constructor(
    private readonly fs: Pick<PromoteFsOps, 'readFile' | 'writeFile'>,
    private readonly path: string,
    private readonly limit: number,
  ) {}

  /** Best-effort append; log failures never fail the transaction. */
  async append(entry: string): Promise<void> {
    try {
      let existing = '';
      try {
        existing = await this.fs.readFile(this.path);
      } catch {
        // First write; the file does not exist yet.
      }
      const merged = existing.length > 0 ? `${existing}\n${entry}` : entry;
      await this.fs.writeFile(this.path, byteTail(merged, this.limit), { mode: 0o600 });
    } catch {
      // Bounded logs are evidence aids, never a safety boundary.
    }
  }
}

export async function runPromotion(options: PromoteOptions): Promise<PromotionOutcome> {
  const context = options.context;
  if (context.decision !== 'ready') {
    return { kind: 'noop', installed: context.installedVersion };
  }
  const sdk = options.sdk;
  const repo = context.canonicalRepo;
  const candidate = context.candidateVersion;

  // 1. Pre-arm recheck of the preflight invariants (read-only). This closes
  //    the preflight-to-mutation race: HEAD, tree cleanliness, byte-exact
  //    manifests, and the backup same-filesystem layout must still hold.
  const recheck = await recheckPreflight(options, context, repo);
  if (recheck !== null) {
    return { kind: 'error', message: `promotion refused before arming: ${recheck}` };
  }

  // 2. State dir and embedded state; unreadable state fails closed.
  try {
    await ensureStateDir(context.stateDir, options.fs);
  } catch (error) {
    return { kind: 'error', message: `could not create the state directory: ${messageOf(error)}` };
  }
  const readEmbeddedState = options.readEmbeddedState ?? loadEmbeddedState;
  const loaded = await readEmbeddedState(context.stateDir, options.fs);
  if (loaded.kind === 'invalid') {
    return { kind: 'error', message: `embedded upkeep state is unreadable: ${loaded.reason}` };
  }
  const prior = loaded.kind === 'loaded' ? loaded.state : defaultEmbeddedState();

  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => Date.now());
  const journalDeps = { randomId, now };
  const logLimit = options.logLimitBytes ?? MAX_PROMOTION_LOG_BYTES;
  const log = context.logs[0] !== undefined ? new BoundedLogFile(options.fs, context.logs[0], logLimit) : null;
  const errLog = context.logs[1] !== undefined ? new BoundedLogFile(options.fs, context.logs[1], logLimit) : null;
  const record = (entry: string): Promise<void> => (log ? log.append(entry) : Promise.resolve());
  const recordStderr = (key: string, outcome: CommandOutcome): Promise<void> =>
    outcome.facts.stderr.length > 0 && errLog ? errLog.append(`[${key}] ${outcome.facts.stderr}`) : Promise.resolve();
  const recordCommand = (key: string, outcome: CommandOutcome): Promise<void> =>
    recordCommandTail(record, recordStderr, key, outcome);

  // 3. Journal + blocking sentinel, then armed. The verification intent (the
  //    required live canary vs the explicit one-run skip) is recorded before
  //    any mutation, so recovery can finalize a candidate with exactly the
  //    level this attempt earned — never a stronger claim.
  const verificationLevel: 'live' | 'deterministic_only' = options.skipCanary ? 'deterministic_only' : 'live';
  const prepared = await prepareTransaction(context.stateDir, options.fs, journalDeps, journalDataOf(context, verificationLevel));
  if (prepared.kind !== 'armed') {
    const detail = prepared.kind === 'refuse' ? prepared.reason : prepared.message;
    return { kind: 'error', message: `could not arm transaction: ${detail}` };
  }
  let journal = prepared.journal;
  const txId = journal.transactionId;
  await record(`[prepare] transaction ${txId} armed`);

  // 4. Advance armed -> mutating BEFORE the first repo mutation.
  const mutating = await updateJournal(context.stateDir, options.fs, { randomId }, txId, 'armed', {
    kind: 'phase',
    to: 'mutating',
  });
  if (mutating.kind !== 'updated') {
    // Nothing was mutated, but the armed journal and its sentinel are the
    // only evidence of this transaction. Clearing/removing them could destroy
    // the record of an update that did land (a write applied but not read
    // back), leaving the tree unaccounted for. Keep the nonterminal evidence
    // and let explicit recovery resolve it.
    return recoveryRequired(options, journal, `could not advance the journal to mutating: ${mutating.kind === 'refuse' ? mutating.reason : mutating.message}`, record, prior, now);
  }
  journal = mutating.journal;
  await record('[phase] armed -> mutating');

  // 5. Whole-tree checkpoint: atomic same-filesystem sibling rename. A failed
  //    rename mutates nothing, so the rollback below is a no-op restore.
  try {
    await options.fs.rename(join(repo, 'node_modules'), context.backup);
  } catch (error) {
    return rollback(options, context, journal, `checkpoint rename failed: ${messageOf(error)}`, record, recordCommand, prior, now);
  }
  await record(`[checkpoint] node_modules -> ${context.backup}`);

  // 6. Exact candidate install into the fresh tree; lifecycle scripts enabled
  //    (no --ignore-scripts — isolation and rollback are the safety boundary).
  const installOutcome = await runCommand(options.command, {
    command: 'npm',
    args: ['install', '--save-exact', `${sdk}@${candidate}`],
    timeoutMs: CANDIDATE_INSTALL_TIMEOUT_MS,
    cwd: repo,
  });
  await recordCommand(`npm install --save-exact ${sdk}@${candidate}`, installOutcome);
  if (installOutcome.kind !== 'exit' || installOutcome.code !== 0) {
    return rollback(options, context, journal, `npm install failed: ${boundedTail(installOutcome)}`, record, recordCommand, prior, now);
  }

  // 7. Candidate manifests: exact scope checks (rejected before any gate).
  const candidatePkgJson = await readManifestOrNull(options.fs, join(repo, 'package.json'));
  const candidatePkgLock = await readManifestOrNull(options.fs, join(repo, 'package-lock.json'));
  if (candidatePkgJson === null || candidatePkgLock === null) {
    return rollback(options, context, journal, 'candidate manifests are unreadable after install', record, recordCommand, prior, now);
  }
  const pkgScope = validatePackageJsonScope(context.manifests.packageJson.content, candidatePkgJson, sdk, candidate);
  if (pkgScope.kind === 'reject') {
    return rollback(options, context, journal, `package.json changed beyond the SDK dependency (${scopeDetail(pkgScope.issues)})`, record, recordCommand, prior, now);
  }
  const lockScope = validateLockScope(context.manifests.packageLock.content, candidatePkgLock, sdk, candidate);
  if (lockScope.kind === 'reject') {
    return rollback(options, context, journal, `package-lock.json contains unrelated changes (${scopeDetail(lockScope.issues)})`, record, recordCommand, prior, now);
  }
  await record('[scope] package.json and package-lock.json scopes verified');

  // 8. Candidate exact npm-ls agreement.
  const lsOutcome = await runCommand(options.command, {
    command: 'npm',
    args: ['ls', sdk, '--json'],
    timeoutMs: NPM_LS_TIMEOUT_MS,
    cwd: repo,
  });
  await recordCommand(`npm ls ${sdk} --json`, lsOutcome);
  if (lsOutcome.kind !== 'exit' || lsOutcome.code !== 0) {
    return rollback(options, context, journal, `npm ls ${sdk} failed for the candidate: ${boundedTail(lsOutcome)}`, record, recordCommand, prior, now);
  }
  const baseline = validateBaseline({
    sdk,
    packageJson: parseJson(candidatePkgJson),
    packageLock: parseJson(candidatePkgLock),
    npmLs: parseJson(lsOutcome.facts.stdout),
  });
  if (baseline.kind !== 'ok' || baseline.version !== candidate) {
    return rollback(options, context, journal, `candidate manifests and npm ls do not agree exactly on ${candidate}`, record, recordCommand, prior, now);
  }
  await record(`[npm-ls] candidate ${candidate} exact`);

  // 9. Record the expected candidate manifest snapshots for recovery.
  const recorded = await updateJournal(context.stateDir, options.fs, { randomId }, txId, 'mutating', {
    kind: 'candidate_manifests',
    packageJson: { content: candidatePkgJson, sha256: sha256Hex(candidatePkgJson) },
    packageLock: { content: candidatePkgLock, sha256: sha256Hex(candidatePkgLock) },
  });
  if (recorded.kind !== 'updated') {
    return rollback(options, context, journal, 'could not record candidate manifest snapshots', record, recordCommand, prior, now);
  }
  journal = recorded.journal;
  await record('[journal] candidate manifests recorded');

  // 10. Deterministic gates, then audit, then the live canary.
  const verifyOutcome = await runCommand(options.command, {
    command: 'npm',
    args: ['run', 'verify'],
    timeoutMs: DETERMINISTIC_VERIFY_TIMEOUT_MS,
    cwd: repo,
  });
  await recordCommand('npm run verify', verifyOutcome);
  if (verifyOutcome.kind !== 'exit' || verifyOutcome.code !== 0) {
    return rollback(options, context, journal, `npm run verify failed: ${boundedTail(verifyOutcome)}`, record, recordCommand, prior, now);
  }
  await record('[gate] npm run verify ok');

  const buildOutcome = await runCommand(options.command, {
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: CANDIDATE_BUILD_TIMEOUT_MS,
    cwd: repo,
  });
  await recordCommand('npm run build', buildOutcome);
  if (buildOutcome.kind !== 'exit' || buildOutcome.code !== 0) {
    return rollback(options, context, journal, `npm run build failed: ${boundedTail(buildOutcome)}`, record, recordCommand, prior, now);
  }
  await record('[gate] npm run build ok');

  const auditVerdict = await runAuditGate(options, context, record, recordStderr);
  if (auditVerdict !== 'ok') {
    return rollback(options, context, journal, `production audit rejected: ${auditVerdict.reason}`, record, recordCommand, prior, now);
  }
  await record('[gate] npm audit ok');

  const canaryVerdict = await runCanaryGate(options, record);
  if (canaryVerdict.kind === 'recovery') {
    // The canary is still live or its session state is ambiguous: repo
    // mutation must never race it, so the transaction stays blocked without a
    // rollback. The possible live session also forces the orchestrator to
    // retain the repository lock until this process exits.
    return recoveryRequired(options, journal, canaryVerdict.reason, record, prior, now, true);
  }
  if (canaryVerdict.kind !== 'ok') {
    return rollback(options, context, journal, boundedReason(`live canary rejected: ${canaryVerdict.reason}`, MAX_REASON_BYTES), record, recordCommand, prior, now);
  }
  const level = journal.verificationLevel;

  // 11. Stage exactly the two npm manifests and prove the NUL-separated set.
  const addOutcome = await runGit(options.command, repo, ['add', '--', 'package.json', 'package-lock.json'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git add -- package.json package-lock.json', addOutcome);
  if (addOutcome.kind !== 'exit' || addOutcome.code !== 0) {
    return rollback(options, context, journal, `git add failed: ${boundedTail(addOutcome)}`, record, recordCommand, prior, now);
  }
  const stagedOutcome = await runGit(options.command, repo, ['diff', '--cached', '--name-only', '-z'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git diff --cached --name-only -z', stagedOutcome);
  if (stagedOutcome.kind !== 'exit' || stagedOutcome.code !== 0) {
    return rollback(options, context, journal, `could not inspect the staged set: ${boundedTail(stagedOutcome)}`, record, recordCommand, prior, now);
  }
  const staged = parseNulList(stagedOutcome.facts.stdout);
  if (staged.length !== 2 || !staged.every((path) => EXPECTED_COMMIT_PATHS.has(path))) {
    return rollback(options, context, journal, `staged set is not exactly the two npm manifests: ${staged.join(', ')}`, record, recordCommand, prior, now);
  }
  await record(`[staging] staged set {${staged.join(', ')}} proven`);

  // 12. Normal git commit through the repository hooks (never --no-verify).
  const commitMessage = `chore(deps): update embedded pi to ${candidate}`;
  const commitOutcome = await runCommand(options.command, {
    command: 'git',
    args: ['commit', '-m', commitMessage],
    timeoutMs: COMMIT_TIMEOUT_MS,
    cwd: repo,
  });
  await recordCommand(`git commit -m ${commitMessage}`, commitOutcome);
  const commitFailed = commitOutcome.kind !== 'exit' || commitOutcome.code !== 0;

  // 13. Verify the new HEAD regardless of the commit exit code: a failing
  //     post-commit hook still creates the commit, which must be finalized
  //     rather than rolled back.
  const newHead = await readHead(options.command, repo);
  if (newHead === null) {
    return recoveryRequired(options, journal, 'cannot read the post-commit HEAD', record, prior, now);
  }
  if (newHead === context.head) {
    if (commitFailed) {
      return rollback(options, context, journal, `git commit failed: ${boundedTail(commitOutcome)}`, record, recordCommand, prior, now);
    }
    return recoveryRequired(options, journal, 'commit reported success but HEAD did not move', record, prior, now);
  }
  await record(`[commit] HEAD ${context.head.slice(0, 12)} -> ${newHead.slice(0, 12)}`);

  // 14. Exact commit verification: the new HEAD must be a direct child of the
  //     preflight HEAD, the committed path set exactly the two manifests, the
  //     working manifest bytes the recorded candidate, and the committed
  //     blobs identical to the working files. Anything else is
  //     recovery_required — a wrong-parent or enlarged commit is never
  //     finalized.
  const parent = await runGit(options.command, repo, ['rev-parse', 'HEAD^'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git rev-parse HEAD^', parent);
  if (parent.kind !== 'exit' || parent.code !== 0 || parent.facts.stdout.trim() !== context.head) {
    return recoveryRequired(options, journal, `committed HEAD is not a direct child of the preflight HEAD (${context.head.slice(0, 12)})`, record, prior, now);
  }
  const commitPathsOutcome = await runGit(options.command, repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD^', 'HEAD'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD', commitPathsOutcome);
  if (commitPathsOutcome.kind !== 'exit' || commitPathsOutcome.code !== 0) {
    return recoveryRequired(options, journal, 'could not inspect the committed path set', record, prior, now);
  }
  const committedPaths = parseNulList(commitPathsOutcome.facts.stdout);
  if (committedPaths.length !== 2 || !committedPaths.every((path) => EXPECTED_COMMIT_PATHS.has(path))) {
    return recoveryRequired(options, journal, `committed path set is not exactly the two npm manifests: ${committedPaths.join(', ')}`, record, prior, now);
  }
  const manifestVerify = await verifyCandidateManifests(options, context, journal);
  if (!manifestVerify.ok) {
    return recoveryRequired(options, journal, manifestVerify.reason, record, prior, now);
  }
  const blobAgreement = await runGit(options.command, repo, ['diff', '--quiet', 'HEAD', '--', 'package.json', 'package-lock.json'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git diff --quiet HEAD -- package.json package-lock.json', blobAgreement);
  if (blobAgreement.kind !== 'exit' || blobAgreement.code !== 0) {
    return recoveryRequired(options, journal, 'the committed manifest blobs differ from the working files', record, prior, now);
  }
  await record(`[verify] new HEAD ${newHead}; candidate manifests committed exactly`);

  // 15. Record the commit before deleting the old-tree backup.
  const committed = await updateJournal(context.stateDir, options.fs, { randomId }, txId, 'mutating', {
    kind: 'phase',
    to: 'committed',
  });
  if (committed.kind !== 'updated') {
    return recoveryRequired(options, journal, 'could not record the committed phase', record, prior, now);
  }
  journal = committed.journal;
  await record(`[journal] committed (${newHead})`);

  // 16. Delete the obsolete backup. A failure keeps the verified commit,
  //     clears the blocking sentinel, leaves the committed journal, and
  //     persists non-blocking cleanup_pending.
  try {
    await options.fs.rm(context.backup, { recursive: true });
  } catch (error) {
    const reason = `obsolete backup could not be removed: ${messageOf(error)}`;
    await record(`[cleanup] ${reason}`);
    try {
      await clearSentinel(context.stateDir, options.fs);
    } catch (sentinelError) {
      return recoveryRequired(options, journal, `cleanup pending but the sentinel could not be cleared: ${messageOf(sentinelError)}`, record, prior, now);
    }
    await persistState(options, {
      ...prior,
      installedVersion: candidate,
      latestVersion: candidate,
      verifiedVersion: candidate,
      verificationLevel: level,
      status: 'cleanup_pending',
      lastPromotionAttemptAt: now(),
      lastPromotionResult: `committed ${candidate} but backup cleanup is pending: ${reason}`,
    }, record);
    return { kind: 'cleanup_pending', transactionId: txId, candidate, commit: newHead, reason };
  }
  await record('[cleanup] backup removed');

  // 17. Finalize: committed -> finalized, clear sentinel, remove journal.
  const finalized = await updateJournal(context.stateDir, options.fs, { randomId }, txId, 'committed', {
    kind: 'phase',
    to: 'finalized',
  });
  if (finalized.kind !== 'updated') {
    return recoveryRequired(options, journal, 'could not finalize the journal', record, prior, now);
  }
  journal = finalized.journal;
  try {
    await clearSentinel(context.stateDir, options.fs);
  } catch (error) {
    return recoveryRequired(options, journal, `could not clear the sentinel: ${messageOf(error)}`, record, prior, now);
  }
  const removed = await removeJournal(context.stateDir, options.fs, txId);
  if (removed !== 'removed' && removed !== 'absent') {
    return recoveryRequired(options, journal, `could not remove the journal (${removed})`, record, prior, now);
  }
  await record('[finalize] sentinel cleared; journal removed');
  await persistState(options, {
    ...prior,
    installedVersion: candidate,
    latestVersion: candidate,
    verifiedVersion: candidate,
    verificationLevel: level,
    status: 'current',
    lastPromotionAttemptAt: now(),
    lastPromotionResult: `promoted to ${candidate} (${level})`,
  }, record);
  await record('[state] persisted current verified state');
  return { kind: 'committed', transactionId: txId, candidate, verificationLevel: level, commit: newHead };
}

/**
 * Pre-commit rollback: restore the exact old manifest bytes atomically,
 * remove the candidate tree, rename the saved old tree back offline, require
 * the recorded version, clean npm ls, and a production build, then un-stage
 * the two manifests and prove a config-proof clean tree before clearing the
 * sentinel. If offline restoration cannot be completed or verified, fall
 * back to `npm ci` from the restored exact lock while preserving the last
 * evidence tree (fs presence decides, never the checkpoint flag). A failed
 * or ambiguous rollback preserves the sentinel, journal, backup, and logs
 * and returns `recovery_required`.
 */
async function rollback(
  options: PromoteOptions,
  context: PromotionContext,
  journal: TransactionJournal,
  reason: string,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
  prior: PersistedEmbeddedState,
  now: () => number,
): Promise<PromotionOutcome> {
  const txId = journal.transactionId;
  await record(`[rollback] ${reason}`);

  // Record the rolled_back phase first so a crash mid-restore is recognizable.
  const rolled = await updateJournal(context.stateDir, options.fs, randomIdDeps(options), txId, 'mutating', {
    kind: 'phase',
    to: 'rolled_back',
  });
  if (rolled.kind !== 'updated') {
    return recoveryRequired(options, journal, `could not record the rollback phase: ${rolled.kind === 'refuse' ? rolled.reason : rolled.message}`, record, prior, now);
  }
  const rolledJournal = rolled.journal;
  const seams = seamsOf(options);

  // Offline restore under the bounded filesystem ceiling. On the deadline the
  // in-flight step is awaited to settle and no later step runs: a hung fs
  // syscall must never race a fallback or a concurrent mutation.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ROLLBACK_FS_TIMEOUT_MS);
  const restore = await restoreOffline(seams, context, record, controller.signal);
  clearTimeout(deadline);
  if (restore.kind === 'cancelled') {
    return recoveryRequired(options, rolledJournal, `rollback filesystem work exceeded its ${ROLLBACK_FS_TIMEOUT_MS}ms ceiling; recovery required`, record, prior, now);
  }

  let restoredOk = restore.kind === 'ok';
  if (restoredOk) {
    restoredOk = await verifyOldTree(seams, context, record, recordCommand);
  }
  let usedFallback = false;
  if (!restoredOk) {
    usedFallback = true;
    const fallback = await fallbackRestore(seams, context, record, recordCommand);
    if (fallback.kind !== 'verified') {
      // Sentinel, journal, backup, and logs remain — the next promotion refuses until recovery.
      return recoveryRequired(options, rolledJournal, `rollback could not be restored or verified: ${fallback.reason}`, record, prior, now);
    }
  }

  // The old tree is verified; the git index and working tree must still be
  // provably clean before the sentinel is cleared. Only the two manifests
  // may be un-staged — any extra staged path is ambiguous and stays blocked.
  const stagedIssue = await unstageStagedManifests(options.command, context.canonicalRepo, recordCommand);
  if (stagedIssue !== null) {
    return recoveryRequired(options, rolledJournal, stagedIssue, record, prior, now);
  }
  const treeClean = await proveCleanTree(options.command, context.canonicalRepo, recordCommand);
  if (!treeClean) {
    return recoveryRequired(options, rolledJournal, 'the working tree is not clean after rollback; recovery required', record, prior, now);
  }

  const finalized = await updateJournal(context.stateDir, options.fs, randomIdDeps(options), txId, 'rolled_back', {
    kind: 'phase',
    to: 'finalized',
  });
  if (finalized.kind !== 'updated') {
    return recoveryRequired(options, rolledJournal, `could not finalize the rollback: ${finalized.kind === 'refuse' ? finalized.reason : finalized.message}`, record, prior, now);
  }
  try {
    await clearSentinel(context.stateDir, options.fs);
  } catch (error) {
    return recoveryRequired(options, rolledJournal, `could not clear the sentinel: ${messageOf(error)}`, record, prior, now);
  }
  const removed = await removeJournal(context.stateDir, options.fs, txId);
  if (removed !== 'removed' && removed !== 'absent') {
    return recoveryRequired(options, rolledJournal, `could not remove the journal (${removed})`, record, prior, now);
  }
  await record('[finalize] rolled back; sentinel cleared; journal removed');
  const outcomeReason = usedFallback ? `${reason} (restored via npm ci fallback)` : reason;
  // A failed promotion never claims the baseline is newly verified: the prior
  // verifiedVersion/verificationLevel are preserved as they were.
  await persistState(options, {
    ...prior,
    installedVersion: context.installedVersion,
    latestVersion: context.candidateVersion,
    status: 'promotion_failed',
    lastPromotionAttemptAt: now(),
    lastPromotionResult: `promotion to ${context.candidateVersion} failed: ${outcomeReason}`,
  }, record);
  await record('[state] persisted promotion_failed');
  return { kind: 'rolled_back', transactionId: txId, installed: context.installedVersion, reason: outcomeReason };
}

/** Post-commit verification: disk manifests must equal the recorded candidate bytes. */
async function verifyCandidateManifests(
  options: PromoteOptions,
  context: PromotionContext,
  journal: TransactionJournal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedJson = journal.manifests.candidatePackageJson;
  const expectedLock = journal.manifests.candidatePackageLock;
  if (!expectedJson || !expectedLock) {
    return { ok: false, reason: 'no expected candidate manifest snapshots recorded' };
  }
  const diskJson = await readManifestOrNull(options.fs, join(context.canonicalRepo, 'package.json'));
  const diskLock = await readManifestOrNull(options.fs, join(context.canonicalRepo, 'package-lock.json'));
  if (diskJson !== expectedJson.content) {
    return { ok: false, reason: 'post-commit package.json does not match the expected candidate snapshot' };
  }
  if (diskLock !== expectedLock.content) {
    return { ok: false, reason: 'post-commit package-lock.json does not match the expected candidate snapshot' };
  }
  return { ok: true };
}

/**
 * Bounded production audit: `npm audit --omit=dev --audit-level=high --json`.
 * Rejects high/critical findings and any command/service/JSON ambiguity: a
 * non-0/1 exit, malformed JSON, a missing vulnerabilities record, an
 * unknown severity, or an exit code that disagrees with the findings.
 */
async function runAuditGate(
  options: PromoteOptions,
  context: PromotionContext,
  record: (entry: string) => Promise<void>,
  recordStderr: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<'ok' | { reason: string }> {
  const audit = await runCommand(options.command, {
    command: 'npm',
    args: ['audit', '--omit=dev', '--audit-level=high', '--json'],
    timeoutMs: AUDIT_TIMEOUT_MS,
    cwd: context.canonicalRepo,
  });
  await recordCommandTail(record, recordStderr, 'npm audit --omit=dev --audit-level=high --json', audit);
  if (audit.kind !== 'exit') {
    return { reason: `npm audit did not exit cleanly (${audit.kind})` };
  }
  if (audit.code !== 0 && audit.code !== 1) {
    return { reason: `npm audit exited ${audit.code}` };
  }
  const root = recordOf(parseJson(audit.facts.stdout));
  if (root === null) {
    return { reason: 'npm audit produced no valid JSON' };
  }
  const vulnerabilities = recordOf(root['vulnerabilities']);
  if (vulnerabilities === null) {
    return { reason: 'npm audit JSON has no vulnerabilities record' };
  }
  let highCritical = 0;
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const entryRecord = recordOf(entry);
    const severity = entryRecord === null ? null : entryRecord['severity'];
    if (typeof severity !== 'string' || !(AUDIT_SEVERITIES as readonly string[]).includes(severity)) {
      return { reason: `npm audit entry ${name} has an ambiguous severity` };
    }
    if (severity === 'high' || severity === 'critical') highCritical += 1;
  }
  if (highCritical > 0) {
    return { reason: `npm audit found ${highCritical} high/critical production finding(s)` };
  }
  if (audit.code === 1) {
    return { reason: 'npm audit exit code disagrees with the reported findings' };
  }
  return 'ok';
}

/**
 * The live canary with the 120s bounded ceiling and a bounded cleanup grace
 * after the abort. A settlement after the abort still counts as the timeout
 * failure — unless the settlement is `unsafe`, which stays recovery: the repo
 * must never be mutated or rolled back while a canary session may still be
 * live. A canary that does not settle within the grace returns `recovery` for
 * the same reason. An unexpected async rejection is conservatively recovery
 * (the canary's state is unknown); only a synchronous invocation throw —
 * which happens before any session/root could exist — is an ordinary failure.
 * Every diagnostic is bounded before it reaches the log or persisted state.
 */
async function runCanaryGate(
  options: PromoteOptions,
  record: (entry: string) => Promise<void>,
): Promise<CanaryGateVerdict> {
  if (options.skipCanary) {
    await record('[canary] skipped -> deterministic_only');
    return { kind: 'ok' };
  }
  const controller = new AbortController();
  const graceMs = options.canaryCleanupGraceMs ?? CANARY_CLEANUP_GRACE_MS;
  let promise: Promise<CanaryOutcome>;
  try {
    promise = options.runCanary(controller.signal);
  } catch (error) {
    // A synchronous throw happens before the canary built anything — no
    // session or root can exist yet — so it is a proven-safe pre-session
    // failure: an ordinary failed canary, rollback is safe.
    const reason = boundedReason(`live canary failed: ${messageOf(error)}`, MAX_REASON_BYTES);
    await record(`[canary] failed: ${reason}`);
    return { kind: 'failed', reason };
  }
  const verdict = await new Promise<CanaryGateVerdict>((resolve) => {
    let finished = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (gateVerdict: CanaryGateVerdict): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(gateVerdict);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      graceTimer = setTimeout(() => {
        finish({
          kind: 'recovery',
          reason: boundedReason(
            `live canary did not settle within the ${graceMs}ms cleanup grace after the ${CANARY_TIMEOUT_MS}ms abort; recovery required`,
            MAX_REASON_BYTES,
          ),
        });
      }, graceMs);
    }, CANARY_TIMEOUT_MS);
    promise.then(
      (outcome) => {
        if (outcome.kind === 'unsafe') {
          // The canary could not prove its session is gone: the repo must
          // never be rolled back or mutated while it may still be live. This
          // takes precedence over the timeout failure — an unsafe settlement
          // after the abort stays recovery.
          finish({ kind: 'recovery', reason: boundedReason(outcome.reason, MAX_REASON_BYTES) });
        } else if (timedOut) {
          // A settlement after the abort cannot rescue the run: the timeout
          // already decided failure.
          finish({
            kind: 'failed',
            reason: boundedReason(`live canary timed out after ${CANARY_TIMEOUT_MS}ms`, MAX_REASON_BYTES),
          });
        } else {
          finish(
            outcome.kind === 'ok'
              ? { kind: 'ok' }
              : { kind: 'failed', reason: boundedReason(outcome.reason, MAX_REASON_BYTES) },
          );
        }
      },
      (error: unknown) => {
        // An unexpected rejection leaves the canary's state unknown — a live
        // session or temp root may remain. Conservatively recovery.
        finish({
          kind: 'recovery',
          reason: boundedReason(`live canary failed unexpectedly: ${messageOf(error)}`, MAX_REASON_BYTES),
        });
      },
    );
  });
  if (verdict.kind === 'ok') await record('[canary] live ok');
  else await record(`[canary] ${verdict.kind === 'recovery' ? 'recovery_required' : 'failed'}: ${verdict.reason}`);
  return verdict;
}

/** Unambiguous-failure terminal state: evidence stays; the next promotion refuses until recovery. */
async function recoveryRequired(
  options: PromoteOptions,
  journal: TransactionJournal,
  reason: string,
  record: (entry: string) => Promise<void>,
  prior: PersistedEmbeddedState,
  now: () => number,
  retainLockUntilExit = false,
): Promise<PromotionOutcome> {
  await record(`[recovery_required] ${reason}`);
  await persistState(options, {
    ...prior,
    status: 'recovery_required',
    lastPromotionAttemptAt: now(),
    lastPromotionResult: `recovery required: ${reason}`,
  }, record);
  return {
    kind: 'recovery_required',
    transactionId: journal.transactionId,
    phase: journal.phase,
    reason,
    retainLockUntilExit,
  };
}

/** Persist the merged embedded state; best-effort (the journal/sentinel are authoritative). */
async function persistState(
  options: PromoteOptions,
  state: PersistedEmbeddedState,
  record: (entry: string) => Promise<void>,
): Promise<void> {
  try {
    await saveEmbeddedState(options.context.stateDir, options.fs, state, {
      randomId: options.randomId ?? (() => randomUUID()),
    });
    await record(`[state] persisted status=${state.status}`);
  } catch (error) {
    await record(`[state] could not persist embedded state: ${messageOf(error)}`);
  }
}

/**
 * Re-checks the preflight invariants immediately before arming: HEAD, a
 * completely clean tree, byte-exact manifests, and the backup same-filesystem
 * layout. Returns a refusal reason or null when everything still holds.
 */
async function recheckPreflight(
  options: PromoteOptions,
  context: PromotionContext,
  repo: string,
): Promise<string | null> {
  // Branch identity first: a detach/switch since preflight must refuse before
  // HEAD, tree, manifests, or devices are even consulted.
  const branch = await runGit(options.command, repo, ['symbolic-ref', '--short', 'HEAD'], GIT_READ_TIMEOUT_MS);
  if (branch.kind !== 'exit' || branch.code !== 0 || branch.facts.stdout.trim() !== context.branch) {
    return 'the repository branch changed since preflight';
  }
  const head = await runGit(options.command, repo, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS);
  if (head.kind !== 'exit' || head.code !== 0 || head.facts.stdout.trim() !== context.head) {
    return 'the repository HEAD moved since preflight';
  }
  const status = await runGit(options.command, repo, ['status', '--porcelain=v1', '--untracked-files=all'], GIT_READ_TIMEOUT_MS);
  if (status.kind !== 'exit' || status.code !== 0 || status.facts.stdout.trim() !== '') {
    return 'the working tree changed since preflight';
  }
  const pkgJson = await readManifestOrNull(options.fs, join(repo, 'package.json'));
  const pkgLock = await readManifestOrNull(options.fs, join(repo, 'package-lock.json'));
  if (pkgJson !== context.manifests.packageJson.content) return 'package.json changed since preflight';
  if (pkgLock !== context.manifests.packageLock.content) return 'package-lock.json changed since preflight';
  let sourceDevice: number;
  let backupDevice: number;
  try {
    [sourceDevice, backupDevice] = await Promise.all([
      options.statDevice(join(repo, 'node_modules')),
      options.statDevice(dirname(repo)),
    ]);
  } catch (error) {
    return `the backup filesystem layout changed since preflight: ${messageOf(error)}`;
  }
  if (sourceDevice !== backupDevice) return 'the backup filesystem layout changed since preflight';
  return null;
}

/** Appends a bounded step entry and stderr tail for one command outcome. */
export async function recordCommandTail(
  record: (entry: string) => Promise<void>,
  recordStderr: (key: string, outcome: CommandOutcome) => Promise<void>,
  key: string,
  outcome: CommandOutcome,
): Promise<void> {
  if (outcome.kind === 'exit') {
    await record(`[cmd] ${key} exit ${outcome.code}${outcome.signal !== null ? ` (${outcome.signal})` : ''}`);
  } else if (outcome.kind === 'terminated') {
    await record(`[cmd] ${key} terminated (${outcome.reason})`);
  } else {
    await record(`[cmd] ${key} error: ${outcome.message}`);
  }
  if (outcome.facts.log.length > 0) {
    await record(`[output] ${byteTail(outcome.facts.log, MAX_COMMAND_LOG_TAIL)}`);
  }
  await recordStderr(key, outcome);
}

function scopeDetail(issues: readonly { code: string; entry?: string }[]): string {
  const first = issues[0];
  return first === undefined ? 'unknown' : first.code === 'lock_change_outside_closure' ? `entry ${String(first.entry)} outside the SDK closure` : first.code;
}

/** Optional-dep deps object for journal updates under exactOptionalPropertyTypes. */
function randomIdDeps(options: PromoteOptions): { randomId?: () => string } {
  return options.randomId !== undefined ? { randomId: options.randomId } : {};
}

function journalDataOf(
  context: PromotionContext,
  verificationLevel: 'live' | 'deterministic_only',
): NewJournalData {
  return {
    repo: { canonicalPath: context.canonicalRepo, head: context.head, branch: context.branch },
    versions: { installed: context.installedVersion, candidate: context.candidateVersion },
    verificationLevel,
    manifests: {
      packageJson: { content: context.manifests.packageJson.content, sha256: context.manifests.packageJson.sha256 },
      packageLock: { content: context.manifests.packageLock.content, sha256: context.manifests.packageLock.sha256 },
    },
    paths: { backup: context.backup, logs: [...context.logs] },
  };
}

/** The rollback seams over one promotion's injected external effects. */
function seamsOf(options: PromoteOptions): RollbackSeams {
  return { fs: options.fs, command: options.command, sdk: options.sdk };
}

/**
 * Production binding: real node fs/spawn, the bounded stable-latest seams,
 * and the injected canary (Phase 5 wires the real production path). Never
 * invoked by default tests.
 */
/** Real node fs/promises bound to the transaction fs surface (shared by the
 * production promotion and recovery bindings). */
export function productionTransactionFs(): PromoteFsOps {
  return {
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
      } catch (error) {
        if (isEnoent(error)) return false;
        throw error;
      }
    },
  };
}

export function productionPromote(deps: {
  runCanary: (signal: AbortSignal) => Promise<CanaryOutcome>;
  skipCanary: boolean;
}): (context: PromotionContext) => Promise<PromotionOutcome> {
  const fs = productionTransactionFs();
  return (context) =>
    runPromotion({
      sdk: EMBEDDED_SDK_PACKAGE,
      context,
      fs,
      command: { spawn: nodeSpawn },
      statDevice: (path) => stat(path).then((stats) => stats.dev),
      runCanary: deps.runCanary,
      skipCanary: deps.skipCanary,
    });
}
