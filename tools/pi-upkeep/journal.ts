/**
 * Durable transaction journal and sentinel primitives.
 *
 * The journal is the single source of truth for a promotion/recovery
 * transaction. It is a validated, schema-versioned document — never
 * arbitrary JSON — recording the transaction id and phase, the original HEAD
 * and branch, the original exact installed version, the exact candidate
 * version, byte-exact copies and hashes of both npm manifests, the expected
 * candidate manifest hashes once known, and the backup/log paths recovery
 * needs.
 *
 * Safety ordering: the prepared journal is published atomically first (a
 * private unique staging file renamed into place), then the blocking
 * sentinel is created exclusively, and only then is the phase advanced to
 * `armed` — the point after which mutation may begin. A crash between
 * journal and sentinel leaves a non-mutating orphan (`orphan_prepared`);
 * a sentinel without a readable matching journal fails closed
 * (`failed_closed`). Phase updates are atomic temp-write + rename and reject
 * a wrong transaction id, a stale expected phase, and invalid or backward
 * transitions.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sha256Hex } from '../../server/src/upkeep/state-path.ts';
import type { CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';
import { clearSentinel, createSentinel, sentinelPath, sentinelStatus } from './sentinel.ts';
import { parseExactStableVersion } from '../../server/src/upkeep/versions.ts';
import { messageOf } from './errors.ts';
import { isRecord } from './records.ts';

export const JOURNAL_FILE = 'transaction.journal.json';
export const JOURNAL_SCHEMA_VERSION = 1;
/** Hard ceiling for the durable transaction token and any derived output/path use. */
export const MAX_TRANSACTION_ID_LENGTH = 128;
/** Prefix of the unique staging files used for atomic journal writes. */
const PENDING_JOURNAL_PREFIX = 'pending-journal-';

export const JOURNAL_PHASES = [
  'prepared',
  'armed',
  'mutating',
  'committed',
  'rolled_back',
  'finalized',
] as const;
export type JournalPhase = (typeof JOURNAL_PHASES)[number];

/**
 * The only legal phase moves; everything else is rejected as invalid/backward.
 * `prepared -> finalized` and `armed -> finalized` are the legal terminal
 * transitions for a verified non-mutating completion: those phases provably
 * never mutated the repo, so recovery may finish them directly after exact
 * verification — and must terminalize before it clears the sentinel, so a
 * crash between the clear and the journal removal never leaves a
 * nonterminal journal without its sentinel (which would fail closed).
 */
export const PHASE_TRANSITIONS: Record<JournalPhase, readonly JournalPhase[]> = {
  prepared: ['armed', 'finalized'],
  armed: ['mutating', 'finalized'],
  mutating: ['committed', 'rolled_back'],
  committed: ['finalized'],
  rolled_back: ['finalized'],
  finalized: [],
};

/** Byte-exact manifest copy plus its sha256, so recovery can verify without re-reading. */
export interface ManifestSnapshot {
  /** UTF-8 manifest content, restored verbatim on rollback. */
  content: string;
  /** sha256 hex of `content`. */
  sha256: string;
}

export interface TransactionJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  phase: JournalPhase;
  /** Epoch ms at journal creation (injected clock). */
  createdAt: number;
  repo: {
    /** Canonical repository path (as hashed for the state dir). */
    canonicalPath: string;
    /** Original HEAD commit, full 40-hex sha. */
    head: string;
    /** Original branch name. */
    branch: string;
  };
  versions: {
    /** Original exact installed SDK version. */
    installed: string;
    /** Exact candidate version being promoted. */
    candidate: string;
  };
  /**
   * Verification intent, decided before any mutation: `live` when the live
   * canary was required, `deterministic_only` when the one-run skip was
   * explicit. Recovery finalizes a candidate only with the level this
   * journal records — never a stronger claim.
   */
  verificationLevel: 'live' | 'deterministic_only';
  manifests: {
    /** Exact snapshot of the original package.json. */
    packageJson: ManifestSnapshot;
    /** Exact snapshot of the original package-lock.json. */
    packageLock: ManifestSnapshot;
    /** Expected candidate package.json snapshot, recorded once known. */
    candidatePackageJson?: ManifestSnapshot;
    /** Expected candidate package-lock.json snapshot, recorded once known. */
    candidatePackageLock?: ManifestSnapshot;
  };
  paths: {
    /** Same-filesystem sibling holding the original node_modules tree. */
    backup: string;
    /** Bounded operation-log paths written during the transaction. */
    logs: string[];
  };
}

/** Journal fields the caller supplies; id, phase, timestamps, and schema are owned here. */
export type NewJournalData = Omit<
  TransactionJournal,
  'schemaVersion' | 'transactionId' | 'phase' | 'createdAt'
>;

export type JournalFs = Pick<CoordinationFsOps, 'readFile' | 'writeFile' | 'rename' | 'unlink'>;

const HEX64 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const VERIFICATION_LEVELS = ['live', 'deterministic_only'] as const;

export function journalPath(stateDir: string): string {
  return join(stateDir, JOURNAL_FILE);
}

/** Unique staging path for one journal write; never read as a journal. */
export function pendingJournalPath(stateDir: string, instance: string): string {
  return join(stateDir, `${PENDING_JOURNAL_PREFIX}${instance}.json`);
}

export type ParsedJournal =
  | { ok: true; journal: TransactionJournal }
  | { ok: false; reason: string };

/** Strict validation of the journal schema; arbitrary JSON is rejected. */
export function parseJournal(raw: string): ParsedJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'journal is not valid JSON' };
  }
  if (!isRecord(value)) return { ok: false, reason: 'journal root is not an object' };
  if (value['schemaVersion'] !== JOURNAL_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported journal schema version: ${String(value['schemaVersion'])}` };
  }
  const transactionId = value['transactionId'];
  if (
    typeof transactionId !== 'string' ||
    transactionId.length === 0 ||
    transactionId.length > MAX_TRANSACTION_ID_LENGTH
  ) {
    return { ok: false, reason: 'journal transaction id is missing, invalid, or oversized' };
  }
  const phase = value['phase'] as JournalPhase;
  if (typeof phase !== 'string' || !(JOURNAL_PHASES as readonly string[]).includes(phase)) {
    return { ok: false, reason: `journal phase is invalid: ${String(phase)}` };
  }
  const createdAt = value['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, reason: 'journal createdAt is missing or invalid' };
  }
  const repo = value['repo'];
  if (!isRecord(repo)) return { ok: false, reason: 'journal repo record is missing or invalid' };
  const canonicalPath = repo['canonicalPath'];
  if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) {
    return { ok: false, reason: 'journal canonicalPath is missing or invalid' };
  }
  const head = repo['head'];
  if (typeof head !== 'string' || !FULL_SHA.test(head)) {
    return { ok: false, reason: 'journal head is missing or not a full sha' };
  }
  const branch = repo['branch'];
  if (typeof branch !== 'string' || branch.length === 0) {
    return { ok: false, reason: 'journal branch is missing or invalid' };
  }
  const versions = value['versions'];
  if (!isRecord(versions)) return { ok: false, reason: 'journal versions record is missing or invalid' };
  const installed = versions['installed'];
  const candidate = versions['candidate'];
  if (typeof installed !== 'string' || parseExactStableVersion(installed) === null) {
    return { ok: false, reason: `journal installed version is not exact stable: ${String(installed)}` };
  }
  if (typeof candidate !== 'string' || parseExactStableVersion(candidate) === null) {
    return { ok: false, reason: `journal candidate version is not exact stable: ${String(candidate)}` };
  }
  const verificationLevel = value['verificationLevel'];
  if (
    typeof verificationLevel !== 'string' ||
    !(VERIFICATION_LEVELS as readonly string[]).includes(verificationLevel)
  ) {
    return {
      ok: false,
      reason: `journal verificationLevel is invalid: ${String(verificationLevel)}`,
    };
  }
  const manifests = value['manifests'];
  if (!isRecord(manifests)) return { ok: false, reason: 'journal manifests record is missing or invalid' };
  const packageJson = parseManifestSnapshot(manifests['packageJson']);
  if (packageJson === null) {
    return { ok: false, reason: 'journal package.json snapshot is missing or invalid' };
  }
  const packageLock = parseManifestSnapshot(manifests['packageLock']);
  if (packageLock === null) {
    return { ok: false, reason: 'journal package-lock.json snapshot is missing or invalid' };
  }
  // Candidate snapshots are a pair: both absent is legitimately absent, but
  // any present-but-invalid member, or exactly one present member, fails
  // closed — a half-recorded or corrupted snapshot must never read as absent.
  const candidatePackageJsonRaw = manifests['candidatePackageJson'];
  const candidatePackageLockRaw = manifests['candidatePackageLock'];
  const candidatePackageJson = parseManifestSnapshot(candidatePackageJsonRaw);
  const candidatePackageLock = parseManifestSnapshot(candidatePackageLockRaw);
  const candidateJsonAbsent = candidatePackageJsonRaw === undefined;
  const candidateLockAbsent = candidatePackageLockRaw === undefined;
  if (!candidateJsonAbsent || !candidateLockAbsent) {
    if (candidateJsonAbsent || candidateLockAbsent) {
      return { ok: false, reason: 'journal candidate manifest snapshots must be recorded as a pair or not at all' };
    }
    if (candidatePackageJson === null || candidatePackageLock === null) {
      return { ok: false, reason: 'journal candidate manifest snapshot is present but invalid' };
    }
  }
  const paths = value['paths'];
  if (!isRecord(paths)) return { ok: false, reason: 'journal paths record is missing or invalid' };
  const backup = paths['backup'];
  if (typeof backup !== 'string' || backup.length === 0) {
    return { ok: false, reason: 'journal backup path is missing or invalid' };
  }
  const logs = paths['logs'];
  if (!Array.isArray(logs) || !logs.every((entry) => typeof entry === 'string')) {
    return { ok: false, reason: 'journal log paths are missing or invalid' };
  }
  return {
    ok: true,
    journal: {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId,
      phase,
      createdAt,
      repo: { canonicalPath, head, branch },
      versions: { installed, candidate },
      verificationLevel: verificationLevel as 'live' | 'deterministic_only',
      manifests: {
        packageJson,
        packageLock,
        ...(candidatePackageJson !== null ? { candidatePackageJson } : {}),
        ...(candidatePackageLock !== null ? { candidatePackageLock } : {}),
      },
      paths: { backup, logs },
    },
  };
}

function parseManifestSnapshot(value: unknown): ManifestSnapshot | null {
  if (!isRecord(value)) return null;
  const content = value['content'];
  if (typeof content !== 'string') return null;
  const sha256 = value['sha256'];
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
  // Integrity: the recorded hash must match the recorded content, so a
  // corrupted or hand-edited journal fails validation instead of restoring
  // or comparing against wrong bytes.
  if (sha256 !== sha256Hex(content)) return null;
  return { content, sha256 };
}

export type JournalReadResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'present'; journal: TransactionJournal };

export async function readJournal(stateDir: string, fs: JournalFs): Promise<JournalReadResult> {
  const path = journalPath(stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent' };
    return { kind: 'invalid', reason: `journal is unreadable: ${messageOf(error)}` };
  }
  const parsed = parseJournal(raw);
  return parsed.ok ? { kind: 'present', journal: parsed.journal } : { kind: 'invalid', reason: parsed.reason };
}

export type CreateJournalResult =
  | { kind: 'created'; journal: TransactionJournal }
  | { kind: 'refuse'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Publishes a new prepared journal atomically: a private unique staging file
 * renamed over the journal path. A present or unreadable journal is a
 * refusal — existing evidence is never overwritten.
 */
export async function createJournal(
  stateDir: string,
  fs: JournalFs,
  deps: { randomId?: () => string; now?: () => number },
  data: NewJournalData,
): Promise<CreateJournalResult> {
  const existing = await readJournal(stateDir, fs);
  if (existing.kind !== 'absent') {
    return { kind: 'refuse', reason: 'a transaction journal already exists' };
  }
  const journal: TransactionJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId: deps.randomId ? deps.randomId() : randomUUID(),
    phase: 'prepared',
    createdAt: deps.now ? deps.now() : Date.now(),
    ...data,
  };
  const pending = pendingJournalPath(stateDir, journal.transactionId);
  try {
    await fs.writeFile(pending, JSON.stringify(journal, null, 2), { mode: 0o600 });
  } catch (error) {
    await swallowUnlink(fs, pending);
    return { kind: 'error', message: `could not stage journal: ${messageOf(error)}` };
  }
  try {
    await fs.rename(pending, journalPath(stateDir));
  } catch (error) {
    await swallowUnlink(fs, pending);
    return { kind: 'error', message: `could not publish journal: ${messageOf(error)}` };
  }
  return { kind: 'created', journal };
}

export type JournalUpdate =
  | { kind: 'phase'; to: JournalPhase }
  | { kind: 'candidate_manifests'; packageJson: ManifestSnapshot; packageLock: ManifestSnapshot };

export type JournalUpdateResult =
  | { kind: 'updated'; journal: TransactionJournal }
  | { kind: 'refuse'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Atomically applies a validated journal update. The update must name the
 * transaction, the expected current phase (so a stale or concurrent writer
 * is rejected), and a legal transition. The new journal lands through a
 * private unique staging file renamed over the journal path.
 */
export async function updateJournal(
  stateDir: string,
  fs: JournalFs,
  deps: { randomId?: () => string },
  transactionId: string,
  expectedPhase: JournalPhase,
  update: JournalUpdate,
): Promise<JournalUpdateResult> {
  const existing = await readJournal(stateDir, fs);
  if (existing.kind === 'absent') return { kind: 'refuse', reason: 'no transaction journal exists' };
  if (existing.kind === 'invalid') {
    return { kind: 'refuse', reason: `journal is unreadable: ${existing.reason}` };
  }
  const journal = existing.journal;
  if (journal.transactionId !== transactionId) {
    return { kind: 'refuse', reason: 'journal transaction id does not match the update' };
  }
  if (journal.phase !== expectedPhase) {
    return { kind: 'refuse', reason: `journal phase is ${journal.phase}, expected ${expectedPhase}` };
  }
  if (update.kind === 'phase') {
    if (!PHASE_TRANSITIONS[journal.phase].includes(update.to)) {
      return { kind: 'refuse', reason: `invalid phase transition ${journal.phase} -> ${update.to}` };
    }
  } else if (journal.phase !== 'mutating') {
    return {
      kind: 'refuse',
      reason: 'candidate manifest snapshots are recordable only while mutating',
    };
  }
  const next = applyUpdate(journal, update);
  return writeJournalAtomically(stateDir, fs, deps, next);
}

function applyUpdate(journal: TransactionJournal, update: JournalUpdate): TransactionJournal {
  if (update.kind === 'phase') {
    return { ...journal, phase: update.to };
  }
  return {
    ...journal,
    manifests: {
      ...journal.manifests,
      candidatePackageJson: update.packageJson,
      candidatePackageLock: update.packageLock,
    },
  };
}

async function writeJournalAtomically(
  stateDir: string,
  fs: JournalFs,
  deps: { randomId?: () => string },
  journal: TransactionJournal,
): Promise<JournalUpdateResult> {
  const pending = pendingJournalPath(stateDir, deps.randomId ? deps.randomId() : randomUUID());
  try {
    await fs.writeFile(pending, JSON.stringify(journal, null, 2), { mode: 0o600 });
  } catch (error) {
    await swallowUnlink(fs, pending);
    return { kind: 'error', message: `could not stage journal update: ${messageOf(error)}` };
  }
  try {
    await fs.rename(pending, journalPath(stateDir));
  } catch (error) {
    await swallowUnlink(fs, pending);
    return { kind: 'error', message: `could not publish journal update: ${messageOf(error)}` };
  }
  return { kind: 'updated', journal };
}

export type PrepareResult =
  | { kind: 'armed'; journal: TransactionJournal }
  | { kind: 'refuse'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Arms a transaction in the required order: prepared journal first, then the
 * blocking sentinel created exclusively, then the `armed` phase. Only after
 * all three succeed may mutation begin. Any failure removes exactly what
 * this call created (sentinel first, then journal) so a crash mid-sequence
 * never leaves a blocking sentinel without its own journal.
 */
export async function prepareTransaction(
  stateDir: string,
  fs: JournalFs,
  deps: { randomId?: () => string; now?: () => number },
  data: NewJournalData,
): Promise<PrepareResult> {
  const created = await createJournal(stateDir, fs, deps, data);
  if (created.kind !== 'created') return created;
  const transactionId = created.journal.transactionId;
  const sentinel = await createSentinel(
    stateDir,
    fs,
    JSON.stringify({ transactionId }),
  );
  if (sentinel !== 'created') {
    // The sentinel was not ours to create — remove only the journal this
    // call just wrote; a prepared journal without a sentinel is a
    // non-mutating orphan, safe to discard. A pre-existing sentinel is
    // never touched.
    await removeJournal(stateDir, fs, transactionId);
    return sentinel === 'exists'
      ? { kind: 'refuse', reason: 'a transaction sentinel is already present' }
      : { kind: 'error', message: 'could not create the transaction sentinel' };
  }
  const armed = await updateJournal(stateDir, fs, deps, transactionId, 'prepared', {
    kind: 'phase',
    to: 'armed',
  });
  if (armed.kind !== 'updated') {
    await clearSentinel(stateDir, fs);
    await removeJournal(stateDir, fs, transactionId);
    return armed;
  }
  return { kind: 'armed', journal: armed.journal };
}

export type RemoveJournalResult = 'removed' | 'absent' | 'mismatch' | 'error';

/**
 * Removes the journal only when it belongs to the named transaction. An
 * unreadable journal is never deleted — that would destroy the evidence a
 * failed-closed recovery needs.
 */
export async function removeJournal(
  stateDir: string,
  fs: JournalFs,
  transactionId: string,
): Promise<RemoveJournalResult> {
  const existing = await readJournal(stateDir, fs);
  if (existing.kind === 'absent') return 'absent';
  if (existing.kind === 'invalid') return 'error';
  if (existing.journal.transactionId !== transactionId) return 'mismatch';
  try {
    await fs.unlink(journalPath(stateDir));
  } catch (error) {
    if (isEnoent(error)) return 'absent';
    return 'error';
  }
  return 'removed';
}

/**
 * Coherent view of the sentinel + journal pair, as later phase-aware
 * recovery will consume it. Reads only the canonical journal path — a stale
 * staging file from a crashed write is never mistaken for the journal.
 */
export type TransactionState =
  | { kind: 'none' }
  /** Prepared/armed journal without a sentinel: a crash orphan; nothing was mutated. */
  | { kind: 'orphan_prepared'; journal: TransactionJournal }
  /** Committed/finalized journal without a sentinel: post-commit cleanup_pending. */
  | { kind: 'completed'; journal: TransactionJournal }
  /** Sentinel present and its transaction id matches the readable journal. */
  | { kind: 'active'; journal: TransactionJournal }
  /** Sentinel without a readable matching journal — refuse everything. */
  | { kind: 'failed_closed'; reason: string };

export async function readTransaction(stateDir: string, fs: JournalFs): Promise<TransactionState> {
  const status = await sentinelStatus(stateDir, fs);
  const journal = await readJournal(stateDir, fs);
  if (status === 'absent') {
    if (journal.kind === 'absent') return { kind: 'none' };
    if (journal.kind === 'invalid') {
      return { kind: 'failed_closed', reason: `journal is unreadable without a sentinel: ${journal.reason}` };
    }
    const phase = journal.journal.phase;
    // Repository mutation begins only after armed -> mutating is durable, so
    // a sentinel-less prepared or armed journal is a recoverable non-mutating
    // orphan. This also closes the cleanup window where an applied-but-
    // reported-failed armed write is followed by sentinel removal.
    if (phase === 'prepared' || phase === 'armed') {
      return { kind: 'orphan_prepared', journal: journal.journal };
    }
    if (phase === 'committed' || phase === 'finalized') {
      return { kind: 'completed', journal: journal.journal };
    }
    return {
      kind: 'failed_closed',
      reason: `transaction sentinel is missing while the journal is at phase ${phase}`,
    };
  }
  if (status === 'unreadable') {
    return { kind: 'failed_closed', reason: 'transaction sentinel is unreadable' };
  }
  // Sentinel present: a readable journal with a matching transaction id is
  // required; anything else fails closed.
  if (journal.kind === 'absent') {
    return { kind: 'failed_closed', reason: 'transaction sentinel exists but no journal is readable' };
  }
  if (journal.kind === 'invalid') {
    return { kind: 'failed_closed', reason: `transaction sentinel exists but the journal is unreadable: ${journal.reason}` };
  }
  const sentinelTransactionId = await readSentinelTransactionId(stateDir, fs);
  if (sentinelTransactionId === null) {
    return {
      kind: 'failed_closed',
      reason: 'transaction sentinel content does not record a transaction id',
    };
  }
  if (sentinelTransactionId !== journal.journal.transactionId) {
    return { kind: 'failed_closed', reason: 'transaction sentinel does not match the journal transaction id' };
  }
  return { kind: 'active', journal: journal.journal };
}

async function readSentinelTransactionId(stateDir: string, fs: JournalFs): Promise<string | null> {
  try {
    const raw = await fs.readFile(sentinelPath(stateDir));
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value) && typeof value['transactionId'] === 'string') {
      return value['transactionId'];
    }
    return null;
  } catch {
    return null;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Best-effort removal of a staging file; leftovers are inert and never read. */
async function swallowUnlink(fs: JournalFs, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Already gone or not removable — never touch anything else.
  }
}
