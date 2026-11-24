/**
 * Shared rollback and old-state safety helpers.
 *
 * Both the transactional promotion engine (promote.ts) and the phase-aware
 * recovery engine (recover.ts) restore and verify the last-good state. The
 * safety logic lives here exactly once so the two never drift:
 *
 * - byte-exact atomic manifest restoration;
 * - offline tree restore driven by actual fs existence (the saved sibling is
 *   always the original tree; any in-repo tree it replaces is the
 *   candidate/broken tree) under a cancellation signal;
 * - byte-exact manifests + exact npm ls + production build verification;
 * - the `npm ci` fallback that preserves the last evidence tree first;
 * - the staged-index and config-proof clean-tree proofs that must hold
 *   before a transaction is cleared.
 *
 * Every external effect goes through injected seams: `RollbackSeams.fs` (the
 * coordination fs plus recursive rm and existence probing) and
 * `RollbackSeams.command` (runCommand's spawn seam). The transaction facts
 * come from `RollbackTarget`, satisfied structurally by both the preflight's
 * `PromotionContext` and the parsed `TransactionJournal`.
 */

import { join } from 'node:path';
import { validateBaseline } from './baseline.ts';
import type { ManifestSnapshot } from './journal.ts';
import { GIT_READ_TIMEOUT_MS, MAX_DIAGNOSTIC_CHARS, NPM_LS_TIMEOUT_MS } from './preflight.ts';
import type { PromoteFsOps } from './promote.ts';
import { runCommand, type CommandOutcome, type RunCommandDeps } from '../../server/src/upkeep/run-command.ts';
import { messageOf } from './errors.ts';

export { messageOf };

/** Filesystem rollback ceiling (upkeep command contract; tests inject shorter ones). */
export const ROLLBACK_FS_TIMEOUT_MS = 2 * 60 * 1000;
/** Ceiling for the fallback `npm ci` (upkeep command contract). */
export const FALLBACK_CI_TIMEOUT_MS = 10 * 60 * 1000;
/** Ceiling for a candidate/rollback production build (upkeep command contract). */
export const CANDIDATE_BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/** The only paths a promotion may ever stage or commit. */
export const EXPECTED_COMMIT_PATHS = new Set(['package.json', 'package-lock.json']);

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Transaction facts the rollback/verify helpers need; see the module doc. */
export interface RollbackTarget {
  /** Canonical repository root. */
  canonicalRepo: string;
  /** Same-filesystem sibling holding the saved original tree. */
  backup: string;
  /** Byte-exact original manifest snapshots to restore. */
  manifests: { packageJson: ManifestSnapshot; packageLock: ManifestSnapshot };
  /** Exact installed version the restored tree must agree on. */
  installedVersion: string;
}

/** External seams every rollback helper goes through. */
export interface RollbackSeams {
  fs: PromoteFsOps;
  command: RunCommandDeps;
  sdk: string;
}

export function runGit(
  deps: RunCommandDeps,
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandOutcome> {
  return runCommand(deps, { command: 'git', args, timeoutMs, cwd });
}

/** Reads the full 40-hex HEAD, or null on any failure/ambiguity. */
export async function readHead(command: RunCommandDeps, repo: string): Promise<string | null> {
  const outcome = await runGit(command, repo, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS);
  if (outcome.kind !== 'exit' || outcome.code !== 0) return null;
  const head = outcome.facts.stdout.trim();
  return FULL_SHA.test(head) ? head : null;
}

/**
 * Restores the exact manifests and the saved tree back offline, checking a
 * cancellation signal between every step. The tree restore is decided by
 * actual fs existence, never by a caller-supplied checkpoint flag: when the
 * saved sibling exists it is renamed back (replacing any in-repo tree, which
 * can only be the candidate/broken tree); otherwise the in-repo tree, if
 * any, is left for verification. On cancellation no later step runs and the
 * result is `cancelled`; the caller has already awaited the in-flight step.
 */
export async function restoreOffline(
  seams: RollbackSeams,
  target: RollbackTarget,
  record: (entry: string) => Promise<void>,
  signal: AbortSignal,
): Promise<{ kind: 'ok' } | { kind: 'failed'; reason: string } | { kind: 'cancelled' }> {
  if (signal.aborted) return { kind: 'cancelled' };
  let outcome: { kind: 'ok' } | { kind: 'failed'; reason: string } = { kind: 'ok' };
  try {
    await restoreManifests(seams.fs, target);
  } catch (error) {
    await record(`[rollback] manifest restore failed: ${messageOf(error)}`);
    outcome = { kind: 'failed', reason: 'manifest restore failed' };
  }
  if (signal.aborted) return { kind: 'cancelled' };
  if (outcome.kind !== 'ok') return outcome;
  await record('[rollback] manifests restored');
  let backupExists: boolean;
  let treeExists: boolean;
  try {
    [backupExists, treeExists] = await Promise.all([
      seams.fs.exists(target.backup),
      seams.fs.exists(join(target.canonicalRepo, 'node_modules')),
    ]);
  } catch (error) {
    return { kind: 'failed', reason: `could not inspect the backup/tree state: ${messageOf(error)}` };
  }
  if (signal.aborted) return { kind: 'cancelled' };
  if (!backupExists) return { kind: 'ok' };
  if (treeExists) {
    try {
      await seams.fs.rm(join(target.canonicalRepo, 'node_modules'), { recursive: true });
    } catch (error) {
      if (isEnoent(error)) {
        await record('[rollback] no candidate tree remained to remove');
      } else {
        await record(`[rollback] could not remove the candidate tree: ${messageOf(error)}`);
        return { kind: 'failed', reason: 'candidate tree removal failed' };
      }
    }
    if (signal.aborted) return { kind: 'cancelled' };
  }
  try {
    await seams.fs.rename(target.backup, join(target.canonicalRepo, 'node_modules'));
  } catch (error) {
    await record(`[rollback] could not rename the saved tree back: ${messageOf(error)}`);
    return { kind: 'failed', reason: 'saved tree rename failed' };
  }
  if (signal.aborted) return { kind: 'cancelled' };
  await record('[rollback] saved tree renamed back offline');
  return { kind: 'ok' };
}

/**
 * Requires byte-exact original manifests on disk, the recorded exact version
 * through npm ls, and a production build — only then may a rollback be
 * trusted and the transaction cleared.
 */
export async function verifyOldTree(
  seams: RollbackSeams,
  target: RollbackTarget,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<boolean> {
  const diskJson = await readManifestOrNull(seams.fs, join(target.canonicalRepo, 'package.json'));
  const diskLock = await readManifestOrNull(seams.fs, join(target.canonicalRepo, 'package-lock.json'));
  if (diskJson !== target.manifests.packageJson.content || diskLock !== target.manifests.packageLock.content) {
    await record('[verify] restored manifests are not the byte-exact originals');
    return false;
  }
  const ls = await runCommand(seams.command, {
    command: 'npm',
    args: ['ls', seams.sdk, '--json'],
    timeoutMs: NPM_LS_TIMEOUT_MS,
    cwd: target.canonicalRepo,
  });
  await recordCommand(`npm ls ${seams.sdk} --json`, ls);
  if (ls.kind !== 'exit' || ls.code !== 0) {
    await record('[verify] npm ls failed for the restored tree');
    return false;
  }
  const baseline = validateBaseline({
    sdk: seams.sdk,
    packageJson: parseJson(target.manifests.packageJson.content),
    packageLock: parseJson(target.manifests.packageLock.content),
    npmLs: parseJson(ls.facts.stdout),
  });
  if (baseline.kind !== 'ok' || baseline.version !== target.installedVersion) {
    await record('[verify] restored tree does not agree with the recorded baseline');
    return false;
  }
  const build = await runCommand(seams.command, {
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: CANDIDATE_BUILD_TIMEOUT_MS,
    cwd: target.canonicalRepo,
  });
  await recordCommand('npm run build', build);
  if (build.kind !== 'exit' || build.code !== 0) {
    await record('[verify] production build failed for the restored tree');
    return false;
  }
  await record('[verify] exact old npm ls + production build verified');
  return true;
}

/**
 * Fallback recovery: preserve/re-establish the last evidence tree (decided by
 * actual fs presence), remove the broken tree, run `npm ci` from the restored
 * exact lock with lifecycle scripts enabled, and repeat the exact npm ls +
 * build verification. A preserved-backup cleanup failure after a verified
 * fallback refuses finalization. Returns only `verified` when the fallback
 * fully verifies; anything else keeps the transaction blocked.
 */
export async function fallbackRestore(
  seams: RollbackSeams,
  target: RollbackTarget,
  record: (entry: string) => Promise<void>,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<{ kind: 'verified' } | { kind: 'failed'; reason: string }> {
  await record('[rollback] offline restore failed — npm ci fallback');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ROLLBACK_FS_TIMEOUT_MS);
  const fsPart = await fallbackFsPart(seams, target, record, controller.signal);
  clearTimeout(deadline);
  if (fsPart.kind === 'cancelled' || controller.signal.aborted) {
    return { kind: 'failed', reason: `fallback filesystem work exceeded its ${ROLLBACK_FS_TIMEOUT_MS}ms ceiling` };
  }
  if (fsPart.kind !== 'ok') return fsPart;
  const ci = await runCommand(seams.command, {
    command: 'npm',
    args: ['ci'],
    timeoutMs: FALLBACK_CI_TIMEOUT_MS,
    cwd: target.canonicalRepo,
  });
  await recordCommand('npm ci', ci);
  if (ci.kind !== 'exit' || ci.code !== 0) {
    return { kind: 'failed', reason: 'npm ci failed' };
  }
  const verified = await verifyOldTree(seams, target, record, recordCommand);
  if (!verified) {
    return { kind: 'failed', reason: 'fallback verification failed' };
  }
  // The preserved backup is now obsolete; a verified tree is the last-good.
  // The non-blocking cleanup exception applies only after a successful
  // commit, so a cleanup failure here must not finalize silently.
  try {
    await seams.fs.rm(target.backup, { recursive: true });
  } catch (error) {
    await record(`[rollback] could not remove the preserved backup after fallback: ${messageOf(error)}`);
    return { kind: 'failed', reason: `preserved backup cleanup failed: ${messageOf(error)}` };
  }
  await record('[rollback] fallback verified; backup removed');
  return { kind: 'verified' };
}

/**
 * The fallback's filesystem sequence: preserve the last evidence tree, restore
 * manifests, remove the broken tree. Cancellation stops further steps.
 */
export async function fallbackFsPart(
  seams: RollbackSeams,
  target: RollbackTarget,
  record: (entry: string) => Promise<void>,
  signal: AbortSignal,
): Promise<{ kind: 'ok' } | { kind: 'failed'; reason: string } | { kind: 'cancelled' }> {
  if (signal.aborted) return { kind: 'cancelled' };
  let backupExists: boolean;
  let treeExists: boolean;
  try {
    [backupExists, treeExists] = await Promise.all([
      seams.fs.exists(target.backup),
      seams.fs.exists(join(target.canonicalRepo, 'node_modules')),
    ]);
  } catch (error) {
    return { kind: 'failed', reason: `could not inspect the backup/tree state: ${messageOf(error)}` };
  }
  if (signal.aborted) return { kind: 'cancelled' };
  if (!backupExists && treeExists) {
    // The last evidence tree is still in the repo: preserve it at the backup
    // sibling before npm ci wipes it. npm ci must never destroy the only
    // evidence tree, so a failed preservation refuses the fallback.
    try {
      await seams.fs.rename(join(target.canonicalRepo, 'node_modules'), target.backup);
      await record('[rollback] last evidence tree preserved at the backup sibling');
    } catch (error) {
      await record(`[rollback] could not preserve the last evidence tree: ${messageOf(error)}`);
      return { kind: 'failed', reason: 'could not preserve the last evidence tree' };
    }
    if (signal.aborted) return { kind: 'cancelled' };
  }
  try {
    await restoreManifests(seams.fs, target);
  } catch (error) {
    await record(`[rollback] manifest restore failed in fallback: ${messageOf(error)}`);
    return { kind: 'failed', reason: 'manifest restore failed in fallback' };
  }
  if (signal.aborted) return { kind: 'cancelled' };
  try {
    await seams.fs.rm(join(target.canonicalRepo, 'node_modules'), { recursive: true });
  } catch (error) {
    // npm ci removes residue itself; the removal is best-effort here.
    await record(`[rollback] could not remove the broken tree: ${messageOf(error)}`);
  }
  if (signal.aborted) return { kind: 'cancelled' };
  return { kind: 'ok' };
}

/** Atomic restore of the exact recorded manifest bytes (in-repo temp + rename). */
export async function restoreManifests(fs: PromoteFsOps, target: RollbackTarget): Promise<void> {
  await atomicRestoreManifest(fs, target.canonicalRepo, 'package.json', target.manifests.packageJson.content);
  await atomicRestoreManifest(fs, target.canonicalRepo, 'package-lock.json', target.manifests.packageLock.content);
}

export async function atomicRestoreManifest(
  fs: PromoteFsOps,
  repo: string,
  name: string,
  content: string,
): Promise<void> {
  const target = join(repo, name);
  const temp = join(repo, `.promote-restore-${name}`);
  try {
    await fs.writeFile(temp, content, {});
    await fs.rename(temp, target);
  } catch (error) {
    await swallowUnlink(fs, temp);
    throw error;
  }
}

/** Un-stage the two npm manifests after a rollback; an extra staged path is ambiguous. */
export async function unstageStagedManifests(
  command: RunCommandDeps,
  repo: string,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<string | null> {
  const stagedOutcome = await runGit(command, repo, ['diff', '--cached', '--name-only', '-z'], GIT_READ_TIMEOUT_MS);
  await recordCommand('git diff --cached --name-only -z', stagedOutcome);
  if (stagedOutcome.kind !== 'exit' || stagedOutcome.code !== 0) {
    return `could not inspect the staged set after rollback: ${boundedTail(stagedOutcome)}`;
  }
  const staged = parseNulList(stagedOutcome.facts.stdout);
  const extra = staged.filter((path) => !EXPECTED_COMMIT_PATHS.has(path));
  if (extra.length > 0) {
    // Un-staging someone's staged work would destroy it: stay blocked.
    return `staged set after rollback contains unexpected paths: ${staged.join(', ')}`;
  }
  if (staged.length === 0) return null;
  const restore = await runGit(
    command,
    repo,
    ['restore', '--staged', '--', 'package.json', 'package-lock.json'],
    GIT_READ_TIMEOUT_MS,
  );
  await recordCommand('git restore --staged -- package.json package-lock.json', restore);
  if (restore.kind !== 'exit' || restore.code !== 0) {
    return `could not un-stage the npm manifests: ${boundedTail(restore)}`;
  }
  return null;
}

/** Config-proof clean-tree proof (v1 porcelain, all untracked) before finalizing. */
export async function proveCleanTree(
  command: RunCommandDeps,
  repo: string,
  recordCommand: (key: string, outcome: CommandOutcome) => Promise<void>,
): Promise<boolean> {
  const status = await runGit(
    command,
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    GIT_READ_TIMEOUT_MS,
  );
  await recordCommand('git status --porcelain=v1 --untracked-files=all', status);
  if (status.kind !== 'exit' || status.code !== 0 || status.facts.stdout.trim() !== '') {
    return false;
  }
  return true;
}

/** Keeps the last `limit` UTF-8 bytes of `text`, never splitting a character. */
export function byteTail(text: string, limit: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  // Skip continuation bytes forward from the cut so the tail never begins
  // mid-character; the result is at most `limit` bytes of valid UTF-8.
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/** Bounded tail of one command's combined output for refusal diagnostics. */
export function boundedTail(outcome: CommandOutcome): string {
  const raw = outcome.kind === 'error' ? outcome.message : outcome.facts.log;
  return byteTail(raw ?? '', MAX_DIAGNOSTIC_CHARS);
}

export function parseNulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

export async function readManifestOrNull(
  fs: Pick<PromoteFsOps, 'readFile'>,
  path: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Best-effort removal of a leftover staging file; never touches anything else. */
export async function swallowUnlink(fs: Pick<PromoteFsOps, 'unlink'>, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Already gone or not removable.
  }
}
