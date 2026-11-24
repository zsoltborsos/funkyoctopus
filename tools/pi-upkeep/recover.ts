/**
 * Phase-aware recovery engine (test-first).
 *
 * Resolves a crashed promotion transaction from the durable journal and
 * sentinel (journal.ts readTransaction). Recovery is explicit and phase-aware:
 *
 * - no transaction evidence -> noop, nothing touched;
 * - failed-closed or mismatched evidence -> blocked, evidence preserved;
 * - orphan prepared journal (no sentinel) -> exact non-mutating
 *   verification (original HEAD, byte-exact manifests, no backup, tree
 *   present, exact npm ls, production build, clean index and tree), then
 *   the journal is terminalized and removed;
 * - prepared/armed with the original HEAD -> the same non-mutating
 *   completion: those phases provably never mutated the repo, so any
 *   divergence blocks without a single byte written;
 * - mutating with the original HEAD -> roll back (the checkpoint happened);
 * - rolled_back -> complete the interrupted old-state restore;
 * - committed/finalized (or mutating whose HEAD is the exact expected
 *   candidate commit) -> verify and finalize the candidate exactly;
 * - any other HEAD -> blocked; a moved HEAD is never blindly rolled back.
 *
 * Old-state finalization restores the exact recorded manifest bytes
 * atomically, restores the saved tree offline by actual existence, requires
 * byte-exact manifests, the exact installed version through npm ls, and a
 * production build, un-stages only the two npm manifests, proves a
 * config-proof clean tree, and only then clears the sentinel and journal. A
 * verified `npm ci` fallback (with the last evidence tree preserved) applies
 * when offline restoration cannot be proven. Candidate finalization requires
 * the recorded candidate snapshot pair, a HEAD that is a direct child of the
 * original with exactly the two manifest paths committed, disk bytes equal to
 * the expected candidate snapshots, working files equal to HEAD, exact
 * candidate npm ls, and a production build; the obsolete backup is then
 * removed. A backup removal failure keeps the verified commit and becomes
 * non-blocking `cleanup_pending`. Every persisted claim reuses the journal's
 * recorded verification level, and recovery fields are persisted on every
 * attempt; prior verification fields are preserved on an old-state rollback.
 * The journal's backup/log paths are trusted only when they are exactly the
 * transaction's own preflight-derived paths (see validateJournalPaths); any
 * mismatch blocks before a single byte of journal-directed I/O.
 *
 * Disabled upkeep refuses before any I/O. The caller holds the repository
 * lock and injects the canonical repo + state dir; the journal's canonical
 * path must match the injected repo. No registry or model calls occur except
 * the `npm ci` fallback's registry when offline restoration fails.
 */

import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
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
  readTransaction,
  removeJournal,
  updateJournal,
  type JournalFs,
  type TransactionJournal,
  type TransactionState,
} from './journal.ts';
import { BACKUP_NAME_PREFIX, GIT_READ_TIMEOUT_MS, logPathsFor, NPM_LS_TIMEOUT_MS } from './preflight.ts';
import {
  BoundedLogFile,
  MAX_PROMOTION_LOG_BYTES,
  productionTransactionFs,
  recordCommandTail,
  type PromoteFsOps,
} from './promote.ts';
import { nodeSpawn, runCommand, type CommandOutcome, type RunCommandDeps } from '../../server/src/upkeep/run-command.ts';
import {
  CANDIDATE_BUILD_TIMEOUT_MS,
  EXPECTED_COMMIT_PATHS,
  ROLLBACK_FS_TIMEOUT_MS,
  boundedTail,
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
  type RollbackTarget,
} from './rollback.ts';
import { clearSentinel } from './sentinel.ts';

export type RecoveryOutcome =
  | { kind: 'none'; reason: string }
  | {
      kind: 'finalized';
      transactionId: string;
      candidate: string;
      verificationLevel: 'live' | 'deterministic_only';
      commit: string;
    }
  | { kind: 'restored'; transactionId: string; installed: string; reason: string }
  | {
      kind: 'cleanup_pending';
      transactionId: string;
      candidate: string;
      commit: string;
      reason: string;
    }
  | { kind: 'blocked'; transactionId: string | null; phase: string | null; reason: string }
  | { kind: 'error'; message: string };

export interface RecoveryOptions {
  /** Embedded SDK package name, e.g. `@earendil-works/pi-coding-agent`. */
  sdk: string;
  /** Canonical repository root; the caller holds the repository lock. */
  repo: string;
  /** Repository-scoped state dir holding journal/sentinel/logs. */
  stateDir: string;
  /** `FUNKYOCTOPUS_UPKEEP_DISABLED=1` — the first refusal, before any I/O. */
  disabled: boolean;
  /** Coordination fs (plus recursive rm and existence probing); tests inject a fake. */
  fs: PromoteFsOps;
  /** runCommand's spawn seam; tests inject a fake, production binds nodeSpawn. */
  command: RunCommandDeps;
  /** Transaction sentinel/journal reader; defaults to journal's readTransaction. */
  readTransactionState?: (stateDir: string, fs: JournalFs) => Promise<TransactionState>;
  /** Embedded-state reader; defaults to embedded-state's loadEmbeddedState. */
  readEmbeddedState?: (stateDir: string, fs: Pick<EmbeddedStateFs, 'readFile'>) => Promise<EmbeddedStateLoad>;
  now?: () => number;
  randomId?: () => string;
  /** Operation-log byte ceiling; defaults to MAX_PROMOTION_LOG_BYTES. */
  logLimitBytes?: number;
}

export async function runRecovery(options: RecoveryOptions): Promise<RecoveryOutcome> {
  // 1. Disabled upkeep is the first refusal, before any fs or command I/O.
  if (options.disabled) {
    return {
      kind: 'error',
      message:
        'recovery refused: upkeep is disabled (FUNKYOCTOPUS_UPKEEP_DISABLED=1); recovery refuses before any inspection',
    };
  }
  const now = options.now ?? (() => Date.now());

  // 2. Coherent sentinel + journal inspection; unreadable or mismatched
  //    evidence fails closed and stays blocked with everything preserved.
  const readTransactionState = options.readTransactionState ?? readTransaction;
  const transaction = await readTransactionState(options.stateDir, options.fs);
  if (transaction.kind === 'none') {
    return { kind: 'none', reason: 'no transaction evidence exists; nothing to recover' };
  }
  if (transaction.kind === 'failed_closed') {
    return {
      kind: 'blocked',
      transactionId: null,
      phase: null,
      reason: `transaction evidence is ambiguous or failed closed: ${transaction.reason}`,
    };
  }
  const journal = transaction.journal;
  const txId = journal.transactionId;

  // 3. The journal must belong to the injected canonical repository.
  if (journal.repo.canonicalPath !== options.repo) {
    return {
      kind: 'blocked',
      transactionId: txId,
      phase: journal.phase,
      reason: `the transaction journal belongs to repository ${JSON.stringify(journal.repo.canonicalPath)}, not ${JSON.stringify(options.repo)}; recovery refuses`,
    };
  }

  // 4. Prior embedded state: unreadable fails closed so prior verification
  //    fields can never be silently overwritten.
  const readEmbeddedState = options.readEmbeddedState ?? loadEmbeddedState;
  const loaded = await readEmbeddedState(options.stateDir, options.fs);
  if (loaded.kind === 'invalid') {
    return {
      kind: 'blocked',
      transactionId: txId,
      phase: journal.phase,
      reason: `embedded upkeep state is unreadable, so prior verification cannot be preserved: ${loaded.reason}`,
    };
  }
  const prior = loaded.kind === 'loaded' ? loaded.state : defaultEmbeddedState();

  // 4b. Journal paths are trusted only when they are exactly the
  //    transaction's own preflight-derived paths: the backup is a direct
  //    sibling of the repo named from the same head + unique, and the logs
  //    are exactly the two direct children of the state dir derived from
  //    that same unique. Any mismatch blocks before the operation logs are
  //    opened or the backup is read, renamed, or removed. The blocked
  //    status is persisted only to the caller-derived state dir (never to
  //    the untrusted journal paths).
  const pathIssue = validateJournalPaths(options.repo, options.stateDir, journal);
  if (pathIssue !== null) {
    return blocked(options, journal, prior, now, noOpRecord, `journal paths are not the transaction's own: ${pathIssue}`);
  }

  // 5. Bounded operation logs appended to the journal's own recorded paths.
  const logLimit = options.logLimitBytes ?? MAX_PROMOTION_LOG_BYTES;
  const log = journal.paths.logs[0] !== undefined ? new BoundedLogFile(options.fs, journal.paths.logs[0], logLimit) : null;
  const errLog = journal.paths.logs[1] !== undefined ? new BoundedLogFile(options.fs, journal.paths.logs[1], logLimit) : null;
  const record = (entry: string): Promise<void> => (log ? log.append(entry) : Promise.resolve());
  const recordStderr = (key: string, outcome: CommandOutcome): Promise<void> =>
    outcome.facts.stderr.length > 0 && errLog ? errLog.append(`[${key}] ${outcome.facts.stderr}`) : Promise.resolve();
  const recordCommand = (key: string, outcome: CommandOutcome): Promise<void> =>
    recordCommandTail(record, recordStderr, key, outcome);
  await record(`[recovery] transaction ${txId} at phase ${journal.phase}`);

  // 6. An orphan prepared journal has no sentinel and never mutated anything:
  //    it completes only through the exact non-mutating verification flow.
  if (transaction.kind === 'orphan_prepared') {
    const head = await readHead(options.command, options.repo);
    if (head === null) {
      return blocked(options, journal, prior, now, record, 'cannot read the repository HEAD');
    }
    return finalizeNonMutating(options, journal, head, prior, now, record, recordCommand, 'orphan_prepared');
  }

  const phase = journal.phase;
  const head = await readHead(options.command, options.repo);
  if (head === null) {
    return blocked(options, journal, prior, now, record, 'cannot read the repository HEAD');
  }
  await record(`[head] ${head.slice(0, 12)}`);

  // 7. A committed journal records a candidate commit: only exact candidate
  //    finalization applies, never a rollback. A finalized journal is
  //    ambiguous — a verified rollback leaves the original HEAD, a finalized
  //    candidate leaves the candidate commit — so the HEAD decides.
  if (phase === 'committed') {
    return finalizeCandidateFlow(options, journal, head, prior, now, record, recordCommand);
  }
  if (phase === 'finalized' && head === journal.repo.head) {
    // A rollback reaches finalized only after exact verification, so the old
    // state is already in place: complete non-mutating and never overwrite
    // manifests or the tree (a crash after the terminal phase is rerunnable).
    return finalizeNonMutating(options, journal, head, prior, now, record, recordCommand, 'finalized_original');
  }
  if (phase === 'finalized') {
    return finalizeCandidateFlow(options, journal, head, prior, now, record, recordCommand);
  }

  // 8. Prepared/armed journals provably never mutated: verify the exact
  //    original state non-mutating, block on any divergence, then terminalize
  //    before clearing the sentinel. Mutating/rolled_back restore the old
  //    state: prove first, restore conservatively when unproven.
  if (head === journal.repo.head) {
    if (phase === 'prepared' || phase === 'armed') {
      return finalizeNonMutating(options, journal, head, prior, now, record, recordCommand, phase);
    }
    return restoreOldState(options, journal, prior, now, record, recordCommand);
  }

  // 9. A moved HEAD: only the exact expected candidate commit may be
  //    finalized (the crash happened after the commit but before the phase
  //    record); anything else stays blocked.
  if (phase === 'mutating') {
    const verified = await verifyCandidate(options, journal, record, recordCommand);
    if (verified.ok) {
      return finalizeCandidateFlow(options, journal, head, prior, now, record, recordCommand);
    }
    return blocked(
      options,
      journal,
      prior,
      now,
      record,
      `HEAD moved while the journal is at mutating but the expected candidate commit cannot be verified exactly: ${verified.reason}`,
    );
  }
  return blocked(
    options,
    journal,
    prior,
    now,
    record,
    `HEAD moved while the journal is at phase ${phase}; recovery refuses to roll back a moved HEAD`,
  );
}

/**
 * Non-mutating completion shared by orphan-prepared, prepared, armed, and
 * finalized-original journals. These transactions provably never mutated the
 * repo, so the exact original state is required before any cleanup: the
 * original HEAD, byte-exact original manifests, no backup, the tree present,
 * exact installed npm ls, a production build, a clean index, and a
 * config-proof clean tree. Any divergence blocks without a single byte
 * written. Only then is the journal terminalized to `finalized` (legal for
 * prepared/armed), the sentinel cleared if any, and the journal removed — so
 * a crash between the sentinel clear and the journal removal always leaves a
 * rerunnable `completed` state, never a failed-closed brick.
 */
async function finalizeNonMutating(
  options: RecoveryOptions,
  journal: TransactionJournal,
  head: string,
  prior: PersistedEmbeddedState,
  now: () => number,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
  kind: 'orphan_prepared' | 'prepared' | 'armed' | 'finalized_original',
): Promise<RecoveryOutcome> {
  const txId = journal.transactionId;
  if (head !== journal.repo.head) {
    return blocked(options, journal, prior, now, record, `HEAD moved while the journal is a non-mutating ${kind}; recovery refuses`);
  }
  const diskJson = await readManifestOrNull(options.fs, join(options.repo, 'package.json'));
  const diskLock = await readManifestOrNull(options.fs, join(options.repo, 'package-lock.json'));
  if (diskJson !== journal.manifests.packageJson.content || diskLock !== journal.manifests.packageLock.content) {
    return blocked(options, journal, prior, now, record, 'the manifests do not match the journal originals; the non-mutating transaction cannot complete without writing');
  }
  let backupExists: boolean;
  let treeExists: boolean;
  try {
    [backupExists, treeExists] = await Promise.all([
      options.fs.exists(journal.paths.backup),
      options.fs.exists(join(options.repo, 'node_modules')),
    ]);
  } catch (error) {
    return blocked(options, journal, prior, now, record, `could not inspect the tree/backup state: ${messageOf(error)}`);
  }
  if (backupExists) {
    return blocked(options, journal, prior, now, record, 'a backup exists for a non-mutating journal; recovery refuses');
  }
  if (!treeExists) {
    return blocked(options, journal, prior, now, record, 'the node_modules tree is missing; the non-mutating transaction cannot complete');
  }
  await record(`[verify] non-mutating ${kind}: original HEAD, manifests, and tree verified`);
  const ls = await runCommand(options.command, {
    command: 'npm',
    args: ['ls', options.sdk, '--json'],
    timeoutMs: NPM_LS_TIMEOUT_MS,
    cwd: options.repo,
  });
  await recordCommand(`npm ls ${options.sdk} --json`, ls);
  if (ls.kind !== 'exit' || ls.code !== 0) {
    return blocked(options, journal, prior, now, record, `npm ls ${options.sdk} failed for the original state: ${boundedTail(ls)}`);
  }
  const baseline = validateBaseline({
    sdk: options.sdk,
    packageJson: parseJson(diskJson),
    packageLock: parseJson(diskLock),
    npmLs: parseJson(ls.facts.stdout),
  });
  if (baseline.kind !== 'ok' || baseline.version !== journal.versions.installed) {
    return blocked(options, journal, prior, now, record, 'npm ls does not agree exactly on the original installed version');
  }
  const build = await runCommand(options.command, {
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: CANDIDATE_BUILD_TIMEOUT_MS,
    cwd: options.repo,
  });
  await recordCommand('npm run build', build);
  if (build.kind !== 'exit' || build.code !== 0) {
    return blocked(options, journal, prior, now, record, `the production build failed for the original state: ${boundedTail(build)}`);
  }
  await record('[verify] exact original npm ls + production build verified');
  // The index must be empty too: a non-mutating transaction never staged
  // anything, so any staged path is user work and stays untouched/blocked.
  const stagedOutcome = await runGit(options.command, options.repo, ['diff', '--cached', '--name-only', '-z'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git diff --cached --name-only -z', stagedOutcome);
  if (stagedOutcome.kind !== 'exit' || stagedOutcome.code !== 0 || stagedOutcome.facts.stdout.trim() !== '') {
    return blocked(options, journal, prior, now, record, 'the git index is not clean; the non-mutating transaction cannot complete without touching user work');
  }
  const treeClean = await proveCleanTree(options.command, options.repo, recordCommand);
  if (!treeClean) {
    return blocked(options, journal, prior, now, record, 'the working tree is not clean; the non-mutating transaction cannot complete');
  }

  // Terminalize before the sentinel is cleared so a crash between the clear
  // and the journal removal can never leave a nonterminal journal without
  // its sentinel (failed_closed).
  let current = journal;
  if (current.phase !== 'finalized') {
    const finalized = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, current.phase, {
      kind: 'phase',
      to: 'finalized',
    });
    if (finalized.kind !== 'updated') {
      return blocked(options, current, prior, now, record, `could not finalize the journal: ${finalized.kind === 'refuse' ? finalized.reason : finalized.message}`);
    }
    current = finalized.journal;
    await record('[phase] -> finalized');
  }
  try {
    await clearSentinel(options.stateDir, options.fs);
  } catch (error) {
    return blocked(options, current, prior, now, record, `could not clear the sentinel: ${messageOf(error)}`);
  }
  const removed = await removeJournal(options.stateDir, options.fs, txId);
  if (removed !== 'removed' && removed !== 'absent') {
    return blocked(options, current, prior, now, record, `could not remove the journal (${removed})`);
  }
  await record('[finalize] non-mutating transaction cleared; nothing was mutated');
  if (kind === 'orphan_prepared') {
    // The transaction never armed: prior state stays as it was.
    await persistState(options, {
      ...prior,
      lastRecoveryAttemptAt: now(),
      lastRecoveryResult: 'removed an orphan prepared journal; nothing was mutated',
    }, record);
    return {
      kind: 'restored',
      transactionId: txId,
      installed: journal.versions.installed,
      reason: 'orphan prepared journal removed; nothing was mutated',
    };
  }
  // A failed promotion never claims the baseline is newly verified: the prior
  // verifiedVersion/verificationLevel are preserved exactly as they were.
  await persistState(options, {
    ...prior,
    installedVersion: journal.versions.installed,
    latestVersion: journal.versions.candidate,
    status: 'promotion_failed',
    lastRecoveryAttemptAt: now(),
    lastRecoveryResult: `recovery completed the interrupted transaction; the original state was verified, nothing was mutated (failed promotion to ${journal.versions.candidate})`,
  }, record);
  await record('[state] persisted promotion_failed');
  return {
    kind: 'restored',
    transactionId: txId,
    installed: journal.versions.installed,
    reason: 'original state verified; nothing was mutated',
  };
}

/**
 * Journal-path trust boundary: the backup and the two logs are accepted only
 * when they are exactly the transaction's own preflight-derived paths — the
 * backup a direct sibling of the repo named
 * `${basename(repo)}-node_modules-backup-${head.slice(0, 12)}-${unique}` with a
 * safe nonempty single-component unique, and the logs exactly the two direct
 * children of the state dir named from that same unique. Returns a refusal
 * reason or null when the paths are the transaction's own.
 */
export function validateJournalPaths(repo: string, stateDir: string, journal: TransactionJournal): string | null {
  const head12 = journal.repo.head.slice(0, 12);
  const backupDir = dirname(journal.paths.backup);
  const backupName = basename(journal.paths.backup);
  if (backupDir !== dirname(repo)) {
    return `backup ${JSON.stringify(journal.paths.backup)} is not a direct sibling of the repository`;
  }
  const prefix = `${basename(repo)}-${BACKUP_NAME_PREFIX}-${head12}-`;
  if (!backupName.startsWith(prefix)) {
    return `backup ${JSON.stringify(journal.paths.backup)} does not match the transaction backup naming`;
  }
  const unique = backupName.slice(prefix.length);
  if (!SAFE_UNIQUE.test(unique)) {
    return `backup unique ${JSON.stringify(unique)} is not a safe single path component`;
  }
  const expectedLogs = logPathsFor(stateDir, unique);
  if (journal.paths.logs.length !== expectedLogs.length) {
    return `journal records ${journal.paths.logs.length} log paths; expected exactly ${expectedLogs.length}`;
  }
  for (let i = 0; i < expectedLogs.length; i++) {
    if (journal.paths.logs[i] !== expectedLogs[i]) {
      return `journal log path ${JSON.stringify(journal.paths.logs[i])} does not match the transaction log naming`;
    }
  }
  return null;
}

/** A unique must be a safe nonempty single path component. */
const SAFE_UNIQUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Old-state finalization (mutating/rolled_back with the original HEAD):
 * record the rollback phase when the checkpoint happened, restore the exact
 * manifests and the saved tree offline
 * by actual existence, verify byte-exact manifests + exact npm ls + a
 * production build (with a verified `npm ci` fallback that preserves the last
 * evidence tree), un-stage only the two manifests, prove a config-proof clean
 * tree, remove any now-redundant backup, and only then clear the sentinel and
 * journal. Any ambiguity stays blocked with the evidence preserved.
 */
async function restoreOldState(
  options: RecoveryOptions,
  journal: TransactionJournal,
  prior: PersistedEmbeddedState,
  now: () => number,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<RecoveryOutcome> {
  const txId = journal.transactionId;
  let current = journal;
  if (current.phase === 'mutating') {
    const rolled = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, 'mutating', {
      kind: 'phase',
      to: 'rolled_back',
    });
    if (rolled.kind !== 'updated') {
      return blocked(options, current, prior, now, record, `could not record the rollback phase: ${rolled.kind === 'refuse' ? rolled.reason : rolled.message}`);
    }
    current = rolled.journal;
    await record('[phase] mutating -> rolled_back');
  }
  const seams = seamsOf(options);
  const target = targetOf(current);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ROLLBACK_FS_TIMEOUT_MS);
  const restore = await restoreOffline(seams, target, record, controller.signal);
  clearTimeout(deadline);
  if (restore.kind === 'cancelled') {
    return blocked(options, current, prior, now, record, `rollback filesystem work exceeded its ${ROLLBACK_FS_TIMEOUT_MS}ms ceiling; recovery required`);
  }
  let restoredOk = restore.kind === 'ok';
  let usedFallback = false;
  if (restoredOk) {
    restoredOk = await verifyOldTree(seams, target, record, recordCommand);
  }
  if (!restoredOk) {
    usedFallback = true;
    const fallback = await fallbackRestore(seams, target, record, recordCommand);
    if (fallback.kind !== 'verified') {
      return blocked(options, current, prior, now, record, `rollback could not be restored or verified: ${fallback.reason}`);
    }
  }

  // The old tree is verified; the git index and working tree must still be
  // provably clean before the sentinel is cleared. Only the two manifests may
  // be un-staged — any extra staged path is ambiguous and stays blocked.
  const stagedIssue = await unstageStagedManifests(options.command, options.repo, recordCommand);
  if (stagedIssue !== null) {
    return blocked(options, current, prior, now, record, stagedIssue);
  }
  const treeClean = await proveCleanTree(options.command, options.repo, recordCommand);
  if (!treeClean) {
    return blocked(options, current, prior, now, record, 'the working tree is not clean after rollback; recovery required');
  }

  // A verified old tree makes any remaining backup redundant; remove it when
  // safe. A removal failure keeps the transaction blocked.
  let backupExists: boolean;
  try {
    backupExists = await options.fs.exists(journal.paths.backup);
  } catch (error) {
    return blocked(options, current, prior, now, record, `could not inspect the backup state: ${messageOf(error)}`);
  }
  if (backupExists) {
    try {
      await options.fs.rm(journal.paths.backup, { recursive: true });
    } catch (error) {
      return blocked(options, current, prior, now, record, `could not remove the redundant backup: ${messageOf(error)}`);
    }
    await record('[cleanup] redundant backup removed');
  }

  if (current.phase === 'rolled_back') {
    const finalized = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, 'rolled_back', {
      kind: 'phase',
      to: 'finalized',
    });
    if (finalized.kind !== 'updated') {
      return blocked(options, current, prior, now, record, `could not finalize the rollback: ${finalized.kind === 'refuse' ? finalized.reason : finalized.message}`);
    }
    current = finalized.journal;
    await record('[phase] rolled_back -> finalized');
  }
  try {
    await clearSentinel(options.stateDir, options.fs);
  } catch (error) {
    return blocked(options, current, prior, now, record, `could not clear the sentinel: ${messageOf(error)}`);
  }
  const removed = await removeJournal(options.stateDir, options.fs, txId);
  if (removed !== 'removed' && removed !== 'absent') {
    return blocked(options, current, prior, now, record, `could not remove the journal (${removed})`);
  }
  await record('[finalize] original state restored; sentinel cleared; journal removed');
  // A failed promotion never claims the baseline is newly verified: the prior
  // verifiedVersion/verificationLevel are preserved exactly as they were.
  await persistState(options, {
    ...prior,
    installedVersion: journal.versions.installed,
    latestVersion: journal.versions.candidate,
    status: 'promotion_failed',
    lastRecoveryAttemptAt: now(),
    lastRecoveryResult: `recovery restored the previous state after a failed promotion to ${journal.versions.candidate}`,
  }, record);
  await record('[state] persisted promotion_failed');
  return {
    kind: 'restored',
    transactionId: txId,
    installed: journal.versions.installed,
    reason: usedFallback ? 'original state restored and verified via npm ci fallback' : 'original state restored and verified',
  };
}

/**
 * Candidate finalization: the caller has already verified the expected
 * candidate commit exactly. The obsolete backup is removed (a definite ENOENT
 * is success); a removal failure keeps the verified commit and becomes
 * non-blocking `cleanup_pending` (committed journal retained, sentinel
 * cleared). On success the journal advances through the legal phase machine,
 * the sentinel is cleared, the journal is removed, and the candidate is
 * persisted with the journal's recorded verification level.
 */
async function finalizeCandidateFlow(
  options: RecoveryOptions,
  journal: TransactionJournal,
  commit: string,
  prior: PersistedEmbeddedState,
  now: () => number,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<RecoveryOutcome> {
  const verified = await verifyCandidate(options, journal, record, recordCommand);
  if (!verified.ok) {
    return blocked(options, journal, prior, now, record, `the expected candidate commit cannot be verified exactly: ${verified.reason}`);
  }
  const txId = journal.transactionId;
  const candidate = journal.versions.candidate;
  const level = journal.verificationLevel;
  try {
    await options.fs.rm(journal.paths.backup, { recursive: true });
  } catch (error) {
    if (isEnoent(error)) {
      await record('[cleanup] backup already absent');
    } else {
      const reason = `obsolete backup could not be removed: ${messageOf(error)}`;
      await record(`[cleanup] ${reason}`);
      let current = journal;
      if (current.phase === 'mutating') {
        const committed = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, 'mutating', {
          kind: 'phase',
          to: 'committed',
        });
        if (committed.kind !== 'updated') {
          return blocked(options, current, prior, now, record, `could not record the committed phase: ${committed.kind === 'refuse' ? committed.reason : committed.message}`);
        }
        current = committed.journal;
      }
      try {
        await clearSentinel(options.stateDir, options.fs);
      } catch (sentinelError) {
        return blocked(options, current, prior, now, record, `cleanup pending but the sentinel could not be cleared: ${messageOf(sentinelError)}`);
      }
      await persistState(options, {
        ...prior,
        installedVersion: candidate,
        latestVersion: candidate,
        verifiedVersion: candidate,
        verificationLevel: level,
        status: 'cleanup_pending',
        lastRecoveryAttemptAt: now(),
        lastRecoveryResult: `recovery finalized candidate ${candidate} but backup cleanup is pending: ${reason}`,
      }, record);
      return { kind: 'cleanup_pending', transactionId: txId, candidate, commit, reason };
    }
  }
  await record('[cleanup] backup removed');

  let current = journal;
  if (current.phase === 'mutating') {
    const committed = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, 'mutating', {
      kind: 'phase',
      to: 'committed',
    });
    if (committed.kind !== 'updated') {
      return blocked(options, current, prior, now, record, `could not record the committed phase: ${committed.kind === 'refuse' ? committed.reason : committed.message}`);
    }
    current = committed.journal;
    await record('[phase] mutating -> committed');
  }
  if (current.phase === 'committed') {
    const finalized = await updateJournal(options.stateDir, options.fs, randomIdDeps(options), txId, 'committed', {
      kind: 'phase',
      to: 'finalized',
    });
    if (finalized.kind !== 'updated') {
      return blocked(options, current, prior, now, record, `could not finalize the journal: ${finalized.kind === 'refuse' ? finalized.reason : finalized.message}`);
    }
    current = finalized.journal;
    await record('[phase] committed -> finalized');
  }
  try {
    await clearSentinel(options.stateDir, options.fs);
  } catch (error) {
    return blocked(options, current, prior, now, record, `could not clear the sentinel: ${messageOf(error)}`);
  }
  const removed = await removeJournal(options.stateDir, options.fs, txId);
  if (removed !== 'removed' && removed !== 'absent') {
    return blocked(options, current, prior, now, record, `could not remove the journal (${removed})`);
  }
  await record('[finalize] candidate finalized; sentinel cleared; journal removed');
  await persistState(options, {
    ...prior,
    installedVersion: candidate,
    latestVersion: candidate,
    verifiedVersion: candidate,
    verificationLevel: level,
    status: 'current',
    lastRecoveryAttemptAt: now(),
    lastRecoveryResult: `recovery finalized candidate ${candidate} (${level})`,
  }, record);
  await record('[state] persisted current verified state');
  return { kind: 'finalized', transactionId: txId, candidate, verificationLevel: level, commit };
}

/**
 * Exact candidate-commit verification: the recorded candidate snapshot pair
 * must exist; HEAD must be a direct child of the original; the committed path
 * set must be exactly the two npm manifests; the disk bytes must equal the
 * expected candidate snapshots; the working files must equal HEAD; npm ls
 * must agree exactly on the candidate; and the production build must pass.
 */
async function verifyCandidate(
  options: RecoveryOptions,
  journal: TransactionJournal,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedJson = journal.manifests.candidatePackageJson;
  const expectedLock = journal.manifests.candidatePackageLock;
  if (!expectedJson || !expectedLock) {
    return { ok: false, reason: 'no expected candidate manifest snapshots are recorded' };
  }
  const parent = await runGit(options.command, options.repo, ['rev-parse', 'HEAD^'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git rev-parse HEAD^', parent);
  if (parent.kind !== 'exit' || parent.code !== 0 || parent.facts.stdout.trim() !== journal.repo.head) {
    return { ok: false, reason: 'HEAD is not a direct child of the original HEAD' };
  }
  const pathsOutcome = await runGit(
    options.command,
    options.repo,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD^', 'HEAD'],
    GIT_READ_TIMEOUT_MS,
  );
  await recordCommand('git diff-tree --no-commit-id --name-only -r -z HEAD^ HEAD', pathsOutcome);
  if (pathsOutcome.kind !== 'exit' || pathsOutcome.code !== 0) {
    return { ok: false, reason: 'could not inspect the committed path set' };
  }
  const committedPaths = parseNulList(pathsOutcome.facts.stdout);
  if (committedPaths.length !== 2 || !committedPaths.every((path) => EXPECTED_COMMIT_PATHS.has(path))) {
    return { ok: false, reason: `the committed path set is not exactly the two npm manifests: ${committedPaths.join(', ')}` };
  }
  const diskJson = await readManifestOrNull(options.fs, join(options.repo, 'package.json'));
  const diskLock = await readManifestOrNull(options.fs, join(options.repo, 'package-lock.json'));
  if (diskJson === null || diskJson !== expectedJson.content) {
    return { ok: false, reason: 'package.json on disk does not match the expected candidate snapshot' };
  }
  if (diskLock === null || diskLock !== expectedLock.content) {
    return { ok: false, reason: 'package-lock.json on disk does not match the expected candidate snapshot' };
  }
  const blobAgreement = await runGit(
    options.command,
    options.repo,
    ['diff', '--quiet', 'HEAD', '--', 'package.json', 'package-lock.json'],
    GIT_READ_TIMEOUT_MS,
  );
  await recordCommand('git diff --quiet HEAD -- package.json package-lock.json', blobAgreement);
  if (blobAgreement.kind !== 'exit' || blobAgreement.code !== 0) {
    return { ok: false, reason: 'the working manifests differ from the committed blobs' };
  }
  const ls = await runCommand(options.command, {
    command: 'npm',
    args: ['ls', options.sdk, '--json'],
    timeoutMs: NPM_LS_TIMEOUT_MS,
    cwd: options.repo,
  });
  await recordCommand(`npm ls ${options.sdk} --json`, ls);
  if (ls.kind !== 'exit' || ls.code !== 0) {
    return { ok: false, reason: `npm ls ${options.sdk} failed for the candidate: ${boundedTail(ls)}` };
  }
  const baseline = validateBaseline({
    sdk: options.sdk,
    packageJson: parseJson(diskJson),
    packageLock: parseJson(diskLock),
    npmLs: parseJson(ls.facts.stdout),
  });
  if (baseline.kind !== 'ok' || baseline.version !== journal.versions.candidate) {
    return { ok: false, reason: `candidate manifests and npm ls do not agree exactly on the candidate ${journal.versions.candidate}` };
  }
  const build = await runCommand(options.command, {
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: CANDIDATE_BUILD_TIMEOUT_MS,
    cwd: options.repo,
  });
  await recordCommand('npm run build', build);
  if (build.kind !== 'exit' || build.code !== 0) {
    return { ok: false, reason: `the production build failed for the candidate: ${boundedTail(build)}` };
  }
  await record('[verify] exact candidate commit verified');
  return { ok: true };
}

/** Unambiguous-failure terminal state: evidence stays; the next promotion refuses until recovery. */
async function blocked(
  options: RecoveryOptions,
  journal: TransactionJournal,
  prior: PersistedEmbeddedState,
  now: () => number,
  record: (entry: string) => Promise<void>,
  reason: string,
): Promise<RecoveryOutcome> {
  await record(`[blocked] ${reason}`);
  await persistState(options, {
    ...prior,
    status: 'recovery_required',
    lastRecoveryAttemptAt: now(),
    lastRecoveryResult: `recovery blocked: ${reason}`,
  }, record);
  return { kind: 'blocked', transactionId: journal.transactionId, phase: journal.phase, reason };
}

/**
 * No-op logger for blocks whose journal paths are untrusted (path-validation
 * failures): the blocked status is persisted only to the caller-derived state
 * dir, never to a journal-directed path.
 */
const noOpRecord = (): Promise<void> => Promise.resolve();

/** Persist the merged embedded state; best-effort (the journal/sentinel are authoritative). */
async function persistState(
  options: RecoveryOptions,
  state: PersistedEmbeddedState,
  record: (entry: string) => Promise<void>,
): Promise<void> {
  try {
    await saveEmbeddedState(options.stateDir, options.fs, state, {
      randomId: options.randomId ?? (() => randomUUID()),
    });
    await record(`[state] persisted status=${state.status}`);
  } catch (error) {
    await record(`[state] could not persist embedded state: ${messageOf(error)}`);
  }
}

/** The rollback seams over one recovery's injected external effects. */
function seamsOf(options: RecoveryOptions): RollbackSeams {
  return { fs: options.fs, command: options.command, sdk: options.sdk };
}

/** The transaction facts the shared rollback helpers need. */
function targetOf(journal: TransactionJournal): RollbackTarget {
  return {
    canonicalRepo: journal.repo.canonicalPath,
    backup: journal.paths.backup,
    manifests: { packageJson: journal.manifests.packageJson, packageLock: journal.manifests.packageLock },
    installedVersion: journal.versions.installed,
  };
}

/** Optional-dep deps object for journal updates under exactOptionalPropertyTypes. */
function randomIdDeps(options: RecoveryOptions): { randomId?: () => string } {
  return options.randomId !== undefined ? { randomId: options.randomId } : {};
}

/**
 * Production binding: real node fs/spawn. The caller (Phase 5 orchestration)
 * holds the repository lock and supplies the canonical repo + state dir.
 * Never invoked by default tests.
 */
export function productionRecover(deps: {
  repo: string;
  stateDir: string;
  disabled: boolean;
}): () => Promise<RecoveryOutcome> {
  return () =>
    runRecovery({
      sdk: EMBEDDED_SDK_PACKAGE,
      repo: deps.repo,
      stateDir: deps.stateDir,
      disabled: deps.disabled,
      fs: productionTransactionFs(),
      command: { spawn: nodeSpawn },
    });
}
