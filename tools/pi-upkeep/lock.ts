/**
 * Repository-scoped atomic lock.
 *
 * Startup, promotion, and recovery coordinate through one lock directory per
 * repository state directory. Acquisition first stages the complete owner
 * metadata in a unique private pending file OUTSIDE the lock directory, then
 * atomically claims the lock with `mkdir` of the lock directory, then
 * atomically publishes the owner by `rename`-ing the pending file to
 * `lockDir/owner-<instance>.json`, and finally verifies after publication
 * that the directory holds exactly its own entry. Because the pending file is
 * fully written before the claim and moved by an atomic rename, the lock
 * directory never exposes partial owner JSON, so no schedule can leave a
 * half-written token for a competitor to misjudge. A pause or crash before
 * the mkdir leaves only an inert pending file (never read for locking); a
 * pause between mkdir and rename leaves an empty claim that the grace
 * interval reclaims; a pause between rename and verification fails the
 * post-publication check and removes only its own token. Stale recovery is
 * conservative. A single valid owner entry is judged purely by liveness: it
 * is removed only when its recorded PID is positively not alive, and
 * ambiguity (unreadable or missing metadata, invalid pid, unknown liveness)
 * refuses instead of deleting. An incomplete claim — an empty lock directory
 * (crash between mkdir and publish, or between unlink and rmdir during
 * release) or a single legacy token that cannot be read/parsed into a valid
 * owner — refuses while younger than `INCOMPLETE_CLAIM_GRACE_MS` and is
 * reclaimable once older. A multi-entry directory (a paused publisher's
 * token landing beside a reclaimer's, both creators then dying, or a
 * reclamation crashing mid-unlink) is reclaimed only when every entry is a
 * valid owner token, every recorded PID probes positively dead, and every
 * token is at least as old as the grace period; reclamation removes exactly
 * the classified filenames and rmdir's the directory only when it is empty,
 * so a competitor publishing a fresh token mid-reclaim leaves ENOTEMPTY and
 * its new lock survives. Any malformed, young, live, ambiguous, or changed
 * entry refuses the whole reclaim.
 * Reclamation and release unlink only the exact judged owner filename and
 * then rmdir the now-empty lock directory — never a recursive delete.
 * Because the owner filename embeds the acquisition token, a late removal of
 * an old-token path can never hit a lock a competitor has re-created under a
 * new token: that unlink simply gets ENOENT and the new lock is left
 * untouched.
 */

import { randomUUID } from 'node:crypto';
import { messageOf } from './errors.ts';
import { join } from 'node:path';
import type { CoordinationFsOps, CoordinationStat } from '../../server/src/upkeep/state-path.ts';

export const LOCK_DIR = 'lock';
/** Stale recovery retries once; a competitor winning in between is a refusal. */
export const MAX_ACQUIRE_ATTEMPTS = 2;

/** Filename prefix of acquisition staging files (kept outside lockDir). */
const PENDING_OWNER_PREFIX = 'pending-owner-';

/**
 * Incomplete-claim grace period in milliseconds.
 *
 * A lock directory that is empty, or holds a single legacy owner token that
 * cannot be read or parsed into a valid owner, is an interrupted claim — the
 * creator crashed between mkdir and publish, or a releaser crashed between
 * unlink and rmdir. While a claim is younger than the grace period it is
 * treated as live (its creator may be paused mid-flight) and refuses; once
 * older it is presumed abandoned and may be reclaimed. The value is short
 * yet safely longer than a normal mkdir + publish (well under a millisecond
 * on a local state directory); correctness does not depend on its length,
 * because the staged pending file plus post-publication ownership
 * verification below keep a single holder even when a paused creator is
 * reclaimed: the resumed creator can never acquire over the reclaimer's
 * lock, only back off. The same grace also bounds opportunistic cleanup of
 * abandoned pending files (see `sweepOrphanPending`).
 */
export const INCOMPLETE_CLAIM_GRACE_MS = 250;

export type ProcessStatus = 'alive' | 'dead' | 'ambiguous';

/**
 * Positive liveness probe: `process.kill(pid, 0)` succeeds or reports EPERM
 * only for an existing process; ESRCH positively proves the pid is not alive;
 * anything else is ambiguous.
 */
export function probeProcess(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'ambiguous';
  }
}

export interface LockOwner {
  pid: number;
  host: string;
  startedAt: number;
  /** Random token per acquisition; distinguishes a re-acquired lock of the same process. */
  instance: string;
}

export interface LockDeps {
  fs: CoordinationFsOps;
  pid: number;
  host: string;
  probe: (pid: number) => ProcessStatus;
  now?: () => number;
  randomId?: () => string;
}

export interface HeldLock {
  readonly owner: LockOwner;
  release(): Promise<ReleaseOutcome>;
}

export type ReleaseOutcome = 'released' | 'not_owned';

export type AcquireOutcome =
  | { kind: 'acquired'; lock: HeldLock }
  | { kind: 'contended'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Unique per-acquisition owner filename; the token is the acquisition
 * instance (a random UUID in production), so the filename alone identifies
 * one acquisition and cannot collide with a competitor's re-created lock.
 */
export function ownerFileName(instance: string): string {
  return `owner-${instance}.json`;
}

/** Unique per-acquisition staging filename, written OUTSIDE the lock directory. */
export function pendingFileName(instance: string): string {
  return `${PENDING_OWNER_PREFIX}${instance}.json`;
}

export function lockDirFor(stateDir: string): string {
  return join(stateDir, LOCK_DIR);
}

export function ownerFileFor(stateDir: string, instance: string): string {
  return join(lockDirFor(stateDir), ownerFileName(instance));
}

export function pendingFileFor(stateDir: string, instance: string): string {
  return join(stateDir, pendingFileName(instance));
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isEnotempty(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOTEMPTY'
  );
}

/** Outcome of removing a lock entry after judging its token. */
type VerifiedRemoval =
  | { kind: 'removed' }
  /** The token file is already gone — the lock was replaced or removed elsewhere. */
  | { kind: 'not_owned' }
  /** Unlink/rmdir failed in a way that must not be force-resolved. */
  | { kind: 'refuse'; reason: string };

/**
 * Contention verdict for an existing lock directory: refuse (live/ambiguous
 * owner, malformed/young/changed multi-entry state, or unjudgeable state),
 * reclaim a positively-dead valid owner's exact token, reclaim an abandoned
 * incomplete claim (empty dir, or one token), or reclaim a multi-entry
 * directory whose every token is a valid owner with a positively-dead pid
 * and a grace-period-aged token.
 */
type ContentionDecision =
  | { kind: 'refuse'; reason: string }
  | { kind: 'stale'; filename: string }
  | { kind: 'reclaim_empty' }
  | { kind: 'reclaim_incomplete'; filename: string }
  | { kind: 'reclaim_multi'; filenames: string[] };

export class RepositoryLock {
  private readonly stateDir: string;
  private readonly lockDir: string;

  constructor(
    stateDir: string,
    private readonly deps: LockDeps,
  ) {
    this.stateDir = stateDir;
    this.lockDir = lockDirFor(stateDir);
  }

  async acquire(): Promise<AcquireOutcome> {
    const owner = this.owner();
    const pendingPath = pendingFileFor(this.stateDir, owner.instance);
    // Stage the complete owner metadata OUTSIDE the lock directory before
    // claiming, so the lock directory never observes partial JSON. A crash
    // here leaves only this inert pending file, which nothing ever reads for
    // locking and which the next successful holder opportunistically sweeps.
    try {
      await this.deps.fs.writeFile(pendingPath, JSON.stringify(owner, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      await this.removeOwnPending(owner.instance);
      return { kind: 'error', message: `could not stage lock owner: ${messageOf(error)}` };
    }
    let lastReason = 'lock is held';
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        await this.deps.fs.mkdir(this.lockDir, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (!isEexist(error)) {
          await this.removeOwnPending(owner.instance);
          return { kind: 'error', message: `could not acquire lock: ${messageOf(error)}` };
        }
        // The lock directory exists — decide whether the recorded claim is
        // stale (a positively-dead valid owner) or an abandoned incomplete
        // claim (empty dir, or a single token older than the grace period).
        const decision = await this.decideContention();
        if (decision.kind === 'refuse') {
          await this.removeOwnPending(owner.instance);
          return { kind: 'contended', reason: decision.reason };
        }
        // Reclaim by removing exactly the judged token and then the now-empty
        // lock directory — or, for an abandoned empty dir, the dir itself.
        // Never a recursive delete that could destroy a lock a competitor
        // re-created in the meantime (a re-created lock lives under a new
        // token filename, so an unlink here would get ENOENT instead).
        const reclaim =
          decision.kind === 'reclaim_empty'
            ? await this.removeEmptyDir()
            : decision.kind === 'reclaim_incomplete'
              ? await this.removeIncompleteToken(decision.filename)
              : decision.kind === 'reclaim_multi'
                ? await this.removeMultiTokens(decision.filenames)
                : await this.removeVerified(decision.filename);
        if (reclaim.kind === 'removed') {
          lastReason = 'lock was re-created while recovering an incomplete or stale claim';
          continue;
        }
        if (reclaim.kind === 'not_owned') {
          lastReason = 'lock ownership changed while recovering an incomplete or stale claim';
          continue;
        }
        await this.removeOwnPending(owner.instance);
        return { kind: 'contended', reason: reclaim.reason };
      }
      // The directory is ours — publish atomically by renaming the completed
      // pending file into place. If a competitor reclaimed the empty
      // directory while this acquisition was paused, the rename either fails
      // ENOENT (the directory is gone) or lands as a second unique token that
      // the post-publication verification below rejects; both paths leave at
      // most one holder.
      try {
        await this.deps.fs.rename(pendingPath, join(this.lockDir, ownerFileName(owner.instance)));
      } catch (error) {
        if (!isEnoent(error)) {
          await this.cleanupOwnClaim(owner.instance);
          return { kind: 'error', message: `could not record lock owner: ${messageOf(error)}` };
        }
        // The lock directory vanished (reclaimed and not yet re-created) while
        // this acquisition paused between mkdir and rename — or the staged
        // pending file was swept by the current holder. Either way the atomic
        // rename published nothing, so the staged pending file is retained
        // intact for the retry and lockDir is left untouched: a competitor may
        // hold a fresh claim there, and cleanup must never delete a directory
        // this acquisition does not own.
        lastReason = 'lock was reclaimed while publishing owner metadata';
        continue;
      }
      // Post-publication verification: the lock is acquired only once we
      // observe exactly our own token in the directory. If this acquisition
      // was paused after its mkdir and a competitor reclaimed and acquired,
      // our rename landed as a second token; the verification fails and we
      // remove only our own token — never the competitor's directory or
      // owner.
      if (!(await this.verifyOwnership(owner))) {
        await this.removeOwnTokenOnly(owner.instance);
        return {
          kind: 'contended',
          reason: 'lock ownership changed while recording owner metadata',
        };
      }
      // The lock is provably held now — opportunistically sweep abandoned
      // pending files, which can never disturb a holder or a fresh claim.
      await this.sweepOrphanPending();
      return { kind: 'acquired', lock: this.held(owner) };
    }
    await this.removeOwnPending(owner.instance);
    return { kind: 'contended', reason: lastReason };
  }

  /**
   * Reads the lock directory and decides between a live/ambiguous valid
   * owner (refuse), a positively-dead valid owner (stale, removable), an
   * abandoned empty claim (reclaim_empty), an abandoned single incomplete
   * token (reclaim_incomplete), and an all-dead multi-entry reclaim
   * (reclaim_multi). A single valid owner is decided purely by liveness —
   * its age never matters; single incomplete claims are reclaimed only once
   * older than the grace period. A multi-entry directory is reclaimed only
   * when every entry is a valid owner with a positively-dead pid and a token
   * at least as old as the grace period; anything else refuses. Decisions
   * retain the exact owner filenames so reclamation can unlink those tokens
   * and nothing else.
   */
  private async decideContention(): Promise<ContentionDecision> {
    let entries: string[];
    try {
      entries = await this.deps.fs.readdir(this.lockDir);
    } catch (error) {
      return { kind: 'refuse', reason: `lock directory is unreadable: ${messageOf(error)}` };
    }
    if (entries.length === 0) {
      // An empty lock directory is an interrupted claim (crash between mkdir
      // and publish, or between unlink and rmdir during release). Reclaim
      // only once it is older than the grace period; a fresh empty dir may be
      // a live acquisition still mid-flight.
      const age = await this.ageOf(this.lockDir);
      if (age !== null && age >= INCOMPLETE_CLAIM_GRACE_MS) {
        return { kind: 'reclaim_empty' };
      }
      return {
        kind: 'refuse',
        reason:
          age === null
            ? 'lock is held but has no readable owner metadata and its age cannot be established'
            : 'lock is held but has no readable owner metadata (fresh claim in progress)',
      };
    }
    if (entries.length === 1) {
      const filename = entries[0]!;
      if (!filename.startsWith('owner-') || !filename.endsWith('.json')) {
        return { kind: 'refuse', reason: `lock directory entry is not an owner file: ${filename}` };
      }
      const path = join(this.lockDir, filename);
      const judged = await this.readOwnerToken(path);
      if (judged.kind === 'invalid') {
        return this.incompleteDecision(filename, path, judged.reason);
      }
      // A valid owner entry is judged purely by liveness, regardless of age:
      // a live or ambiguous owner always refuses; only a positively-dead
      // owner is stale and removable.
      const status = this.deps.probe(judged.owner.pid);
      if (status === 'alive') {
        return { kind: 'refuse', reason: `lock is held by live pid ${judged.owner.pid}` };
      }
      if (status === 'ambiguous') {
        return { kind: 'refuse', reason: `cannot determine whether owner pid ${judged.owner.pid} is alive` };
      }
      return { kind: 'stale', filename };
    }
    // Multi-entry state: a paused publisher's rename landed beside a
    // reclaimer's token (or a reclamation crashed mid-unlink). Reclaim only
    // when EVERY entry is a valid owner token with a positively-dead pid and
    // a token at least as old as the grace period; any malformed, young,
    // live, ambiguous, or changed entry refuses the whole reclaim.
    const filenames: string[] = [];
    for (const filename of entries) {
      if (!filename.startsWith('owner-') || !filename.endsWith('.json')) {
        return { kind: 'refuse', reason: `lock directory entry is not an owner file: ${filename}` };
      }
      const path = join(this.lockDir, filename);
      const judged = await this.readOwnerToken(path);
      if (judged.kind === 'invalid') {
        return { kind: 'refuse', reason: judged.reason };
      }
      const status = this.deps.probe(judged.owner.pid);
      if (status === 'alive') {
        return { kind: 'refuse', reason: `lock is held by live pid ${judged.owner.pid}` };
      }
      if (status === 'ambiguous') {
        return { kind: 'refuse', reason: `cannot determine whether owner pid ${judged.owner.pid} is alive` };
      }
      const age = await this.ageOf(path);
      if (age === null) {
        return { kind: 'refuse', reason: `lock owner token age cannot be established: ${filename}` };
      }
      if (age < INCOMPLETE_CLAIM_GRACE_MS) {
        return {
          kind: 'refuse',
          reason: `lock owner token is younger than the incomplete-claim grace period: ${filename}`,
        };
      }
      filenames.push(filename);
    }
    return { kind: 'reclaim_multi', filenames };
  }

  /**
   * Reads one owner token and validates its owner shape: a valid owner has a
   * positive integer pid. Unreadable, unparseable, or invalid-pid tokens come
   * back as invalid with a message; the caller decides between an age-gated
   * incomplete-claim reclamation (single entry) and an outright refusal
   * (multi-entry).
   */
  private async readOwnerToken(
    path: string,
  ): Promise<{ kind: 'valid'; owner: LockOwner } | { kind: 'invalid'; reason: string }> {
    let raw: string;
    try {
      raw = await this.deps.fs.readFile(path);
    } catch (error) {
      return { kind: 'invalid', reason: `lock owner metadata is unreadable: ${messageOf(error)}` };
    }
    let owner: LockOwner;
    try {
      owner = JSON.parse(raw) as LockOwner;
    } catch {
      return { kind: 'invalid', reason: 'lock owner metadata is not valid JSON' };
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
      return { kind: 'invalid', reason: `lock owner pid is invalid: ${String(owner.pid)}` };
    }
    return { kind: 'valid', owner };
  }

  /**
   * A single owner token that cannot be read or parsed into a valid owner is
   * an incomplete claim: reclaimable only once older than the grace period,
   * so a live process still mid-write is never stolen from. A stat failure,
   * future mtime, or missing mtime fails closed into a fresh refusal.
   */
  private async incompleteDecision(
    filename: string,
    path: string,
    freshReason: string,
  ): Promise<ContentionDecision> {
    const age = await this.ageOf(path);
    if (age !== null && age >= INCOMPLETE_CLAIM_GRACE_MS) {
      return { kind: 'reclaim_incomplete', filename };
    }
    return {
      kind: 'refuse',
      reason: age === null ? `${freshReason}; claim age unknown` : `${freshReason} (fresh claim in progress)`,
    };
  }

  /**
   * Age of a path in milliseconds, or `null` when the age cannot be
   * established. Stat errors, a non-finite or negative mtime, and a future
   * mtime (relative to the injected clock) all fail closed: an incomplete
   * claim of unknowable age is refused, never reclaimed.
   */
  private async ageOf(path: string): Promise<number | null> {
    let stat: CoordinationStat;
    try {
      stat = await this.deps.fs.stat(path);
    } catch {
      return null;
    }
    const mtime = stat.mtimeMs;
    if (!Number.isFinite(mtime) || mtime < 0) return null;
    const now = this.now();
    if (mtime > now) return null;
    return now - mtime;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Post-publication acquisition check: the directory must contain exactly
   * this acquisition's own token file, and its recorded pid+instance must
   * match. Anything else — an extra token from a competitor who reclaimed a
   * paused empty claim, a replaced token, or an unreadable directory — fails
   * closed and the acquisition is refused.
   */
  private async verifyOwnership(owner: LockOwner): Promise<boolean> {
    let entries: string[];
    try {
      entries = await this.deps.fs.readdir(this.lockDir);
    } catch {
      return false;
    }
    if (entries.length !== 1) return false;
    const filename = ownerFileName(owner.instance);
    if (entries[0] !== filename) return false;
    let raw: string;
    try {
      raw = await this.deps.fs.readFile(join(this.lockDir, filename));
    } catch {
      return false;
    }
    try {
      const recorded = JSON.parse(raw) as LockOwner;
      return recorded.pid === owner.pid && recorded.instance === owner.instance;
    } catch {
      return false;
    }
  }

  private owner(): LockOwner {
    return {
      pid: this.deps.pid,
      host: this.deps.host,
      startedAt: this.deps.now ? this.deps.now() : Date.now(),
      instance: this.deps.randomId ? this.deps.randomId() : randomId(),
    };
  }

  private held(owner: LockOwner): HeldLock {
    return { owner, release: () => this.release(owner) };
  }

  private async release(owner: LockOwner): Promise<ReleaseOutcome> {
    const removal = await this.removeVerified(ownerFileName(owner.instance));
    return removal.kind === 'removed' ? 'released' : 'not_owned';
  }

  /**
   * Token-verified removal shared by stale reclamation and release: unlink the
   * exact owner filename this handle judged stale or owns, then rmdir the lock
   * directory only when it is empty. Each acquisition writes a unique
   * filename, so an ENOENT here proves the lock was replaced or removed by
   * someone else and the re-created lock is never touched. Non-empty
   * directories refuse; nothing is ever recursively deleted.
   */
  private async removeVerified(filename: string): Promise<VerifiedRemoval> {
    try {
      await this.deps.fs.unlink(join(this.lockDir, filename));
    } catch (error) {
      if (isEnoent(error)) return { kind: 'not_owned' };
      return { kind: 'refuse', reason: `could not unlink lock owner: ${messageOf(error)}` };
    }
    try {
      await this.deps.fs.rmdir(this.lockDir);
    } catch (error) {
      if (isEnoent(error)) return { kind: 'not_owned' };
      if (isEnotempty(error)) {
        return { kind: 'refuse', reason: 'lock directory is not empty; refusing to remove a replaced lock' };
      }
      return { kind: 'refuse', reason: `could not remove lock directory: ${messageOf(error)}` };
    }
    return { kind: 'removed' };
  }

  /**
   * Removes an abandoned empty lock directory. Only rmdir is used — never a
   * recursive delete — so if a competitor re-created the directory and wrote
   * its owner in between, the rmdir fails ENOTEMPTY and refuses.
   */
  private async removeEmptyDir(): Promise<VerifiedRemoval> {
    try {
      await this.deps.fs.rmdir(this.lockDir);
    } catch (error) {
      if (isEnoent(error)) return { kind: 'not_owned' };
      if (isEnotempty(error)) {
        return { kind: 'refuse', reason: 'lock directory is not empty; refusing to remove a replaced lock' };
      }
      return { kind: 'refuse', reason: `could not remove lock directory: ${messageOf(error)}` };
    }
    return { kind: 'removed' };
  }

  /**
   * Removes a single incomplete token only if it is still incomplete at
   * removal time. The paused writer may complete its write between the
   * contention judgment and this removal, turning the token into a valid
   * owner that may already have passed its own post-write verification;
   * stripping it then would destroy a lock someone else just acquired.
   * Re-reading right before the unlink detects that and refuses instead
   * (conservative: a later acquisition re-judges the now-valid owner through
   * the normal liveness path).
   */
  private async removeIncompleteToken(filename: string): Promise<VerifiedRemoval> {
    try {
      const raw = await this.deps.fs.readFile(join(this.lockDir, filename));
      const owner = JSON.parse(raw) as LockOwner;
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        return {
          kind: 'refuse',
          reason: 'incomplete owner token became a valid owner during reclamation',
        };
      }
    } catch {
      // Still incomplete or unreadable — proceed with the exact-token removal.
    }
    return this.removeVerified(filename);
  }

  /**
   * Removes every judged stale token of a multi-entry reclaim, then rmdir's
   * the lock directory only when it is empty. Each classified filename is
   * re-read right before its unlink: an entry that changed in the meantime
   * (became unreadable, unparseable, or a live/ambiguous owner) or vanished
   * refuses the whole reclaim. A competitor publishing a fresh token while
   * the reclaim is in flight leaves ENOTEMPTY and its new lock is preserved
   * untouched — nothing is ever recursively deleted.
   */
  private async removeMultiTokens(filenames: string[]): Promise<VerifiedRemoval> {
    for (const filename of filenames) {
      const path = join(this.lockDir, filename);
      const judged = await this.readOwnerToken(path);
      if (judged.kind === 'invalid' || this.deps.probe(judged.owner.pid) !== 'dead') {
        return { kind: 'refuse', reason: `lock owner token changed during reclamation: ${filename}` };
      }
      try {
        await this.deps.fs.unlink(path);
      } catch (error) {
        if (isEnoent(error)) {
          return { kind: 'refuse', reason: `lock owner token disappeared during reclamation: ${filename}` };
        }
        return { kind: 'refuse', reason: `could not unlink lock owner: ${messageOf(error)}` };
      }
    }
    try {
      await this.deps.fs.rmdir(this.lockDir);
    } catch (error) {
      if (isEnoent(error)) return { kind: 'not_owned' };
      if (isEnotempty(error)) {
        return { kind: 'refuse', reason: 'lock directory is not empty; refusing to remove a replaced lock' };
      }
      return { kind: 'refuse', reason: `could not remove lock directory: ${messageOf(error)}` };
    }
    return { kind: 'removed' };
  }

  /**
   * Best-effort removal of only this acquisition's own token file after its
   * post-write verification failed. Never rmdirs: the directory may now
   * belong to a competitor who reclaimed a paused claim and acquired, so only
   * the exact token filename this acquisition wrote is touched.
   */
  private async removeOwnTokenOnly(instance: string): Promise<void> {
    try {
      await this.deps.fs.unlink(join(this.lockDir, ownerFileName(instance)));
    } catch {
      // Already gone (ENOENT) or not removable — never touch anything else.
    }
  }

  /**
   * Failure-path cleanup for a claim this invocation staged but did not fully
   * publish: remove only its own pending file and its own (never-published)
   * token, then rmdir the lock directory only if it is empty. Never touches
   * foreign content — an ENOENT on the token means the directory was
   * reclaimed and re-created by a competitor, whose lock is left alone (the
   * rmdir then fails ENOTEMPTY).
   */
  private async cleanupOwnClaim(instance: string): Promise<void> {
    await this.removeOwnPending(instance);
    try {
      await this.deps.fs.unlink(join(this.lockDir, ownerFileName(instance)));
    } catch (error) {
      if (!isEnoent(error)) return; // keep any foreign content untouched
    }
    try {
      await this.deps.fs.rmdir(this.lockDir);
    } catch {
      // Already gone or not empty — never force-remove a possibly replaced dir.
    }
  }

  /** Best-effort removal of only this acquisition's own pending staging file. */
  private async removeOwnPending(instance: string): Promise<void> {
    try {
      await this.deps.fs.unlink(pendingFileFor(this.stateDir, instance));
    } catch {
      // Already gone (ENOENT) or not removable — never touch anything else.
    }
  }

  /**
   * Opportunistic cleanup of abandoned pending owner files, run only while
   * this acquisition provably holds the lock. A pending file is a staging
   * file for exactly one acquisition; removing it can never disturb a holder
   * (a holder's pending was already consumed by its own rename) and only
   * makes a paused acquirer's later rename fail ENOENT; its retry then finds
   * the holder's live owner (or an empty-dir refusal) and backs off without
   * acquiring — so sweeping can never create a second holder. Only
   * files older than the grace period are removed, leaving a live acquirer
   * mid-claim untouched; every error is swallowed so cleanup never blocks or
   * fails an acquisition. An orphan surviving until the next holder is swept
   * here; until then it is inert — nothing ever reads pending files for
   * locking.
   */
  private async sweepOrphanPending(): Promise<void> {
    let entries: string[];
    try {
      entries = await this.deps.fs.readdir(this.stateDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(PENDING_OWNER_PREFIX) || !entry.endsWith('.json')) continue;
      const age = await this.ageOf(join(this.stateDir, entry));
      if (age === null || age < INCOMPLETE_CLAIM_GRACE_MS) continue;
      try {
        await this.deps.fs.unlink(join(this.stateDir, entry));
      } catch {
        // Already gone or not removable — best effort only.
      }
    }
  }
}

function randomId(): string {
  return randomUUID();
}
