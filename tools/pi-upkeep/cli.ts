/**
 * `npm run upkeep:embedded` command coordinator.
 *
 * The explicit command contract, wired as a small injected coordinator so
 * tests fake the lock, preflight, promotion, recovery, and status seams and
 * prove ordering and no-effects:
 *
 * - no action: print bounded cached status + exact usage; never mutate, never
 *   contact the registry/model, never acquire or create the lock/state dir;
 * - `--promote`: refuse while a sidecar answers on the configured port, then
 *   fresh production preflight under the repository lock, then the
 *   transactional promotion with the live canary (or the explicit one-run
 *   `--skip-live-canary`);
 * - `--promote --skip-live-canary`: same, deterministic-only;
 * - `--recover`: same sidecar refusal, then phase-aware recovery under the
 *   same lock;
 * - unknown/conflicting arguments refuse with a nonzero exit.
 *
 * Actions disabled by `FUNKYOCTOPUS_UPKEEP_DISABLED=1` refuse before any I/O.
 * The sidecar takes no lock and checks no sentinel (it boots straight into
 * the server core), so the only sidecar↔updater exclusion is the liveness
 * probe: promotion/recovery refuse while anything accepts a connection on the
 * sidecar's host:port, before any state is touched. The repository lock
 * remains the updater↔updater exclusion. Promotion/recovery then resolve the
 * canonical git top-level read-only (so a command from any cwd inside the
 * checkout coordinates the same repository), derive the repository state dir,
 * refuse when it would land inside the repo, and only then create the state
 * chain and acquire the lock. The lock is held through completion and
 * released in a `finally` for every ordinary outcome; a promotion whose live
 * canary may still be running (`recovery_required` with `retainLockUntilExit`)
 * never releases it — the owner metadata stays until the process exits and
 * stale-lock recovery proves the recorded PID dead.
 *
 * Every printed line is bounded: engine reasons already leave through
 * boundedReason, and the coordinator re-bounds anything engine-derived so no
 * huge or secret command log can reach stdout/stderr. The CLI entry sets
 * `process.exitCode` and never forces `process.exit` — an unsafe retained
 * lock / live canary cleanup may need its handles.
 */

import { loadEmbeddedState } from '../../server/src/upkeep/embedded-state.ts';
import { readTransaction, type TransactionState } from './journal.ts';
import { MAX_REASON_BYTES, boundedReason } from './bounded-reason.ts';
import { RepositoryLock, type LockDeps, type ProcessStatus } from './lock.ts';
import { isInside, type PreflightRefusal, type PreflightResult, type PromotionContext } from './preflight.ts';
import type { CanaryOutcome, PromotionOutcome } from './promote.ts';
import type { RecoveryOutcome } from './recover.ts';
import { ensureStateDir, repositoryStateDir, type CoordinationFsOps, type HashFn } from '../../server/src/upkeep/state-path.ts';
import { messageOf } from './errors.ts';

/** Exact usage line printed by status, refusals, and argument errors. */
export const USAGE =
  'usage: npm run upkeep:embedded [-- --promote | -- --promote --skip-live-canary | -- --recover]';

export type UpkeepAction =
  | { kind: 'status' }
  | { kind: 'promote'; skipCanary: boolean }
  | { kind: 'recover' };

export type UpkeepParseResult =
  | { kind: 'ok'; action: UpkeepAction }
  | { kind: 'error'; message: string };

/**
 * Pure argument parser. Exactly one action flag is allowed; `--promote`
 * takes the optional `--skip-live-canary`; anything else — unknown flags,
 * conflicting actions, a skip without a promote, duplicates — is a refusal.
 */
export function parseUpkeepArgs(argv: readonly string[]): UpkeepParseResult {
  let action: UpkeepAction | null = null;
  for (const arg of argv) {
    if (arg === '--promote' || arg === '--recover') {
      if (action !== null) {
        return {
          kind: 'error',
          message: 'conflicting action flags: exactly one of --promote or --recover is allowed',
        };
      }
      action = arg === '--promote' ? { kind: 'promote', skipCanary: false } : { kind: 'recover' };
    } else if (arg === '--skip-live-canary') {
      if (action === null || action.kind !== 'promote') {
        return { kind: 'error', message: '--skip-live-canary requires --promote' };
      }
      if (action.skipCanary) {
        return { kind: 'error', message: 'duplicate flag: --skip-live-canary' };
      }
      action = { kind: 'promote', skipCanary: true };
    } else {
      return { kind: 'error', message: `unknown argument: ${JSON.stringify(arg)}` };
    }
  }
  return { kind: 'ok', action: action ?? { kind: 'status' } };
}

export type RepoResolution = { kind: 'ok'; repo: string } | { kind: 'error'; message: string };

/**
 * Where the sidecar listens and how to ask whether it does. Production binds
 * `SIDECAR_HOST`/`SIDECAR_PORT` exactly like `server/src/config.ts` and a
 * bounded TCP connect; tests inject a fake so `verify:tools` never touches a
 * real port.
 */
export interface SidecarProbe {
  host: string;
  port: number;
  /** Resolves true when something accepts a connection on host:port. */
  probe: (host: string, port: number) => Promise<boolean>;
}

export interface UpkeepCommandDeps {
  argv: readonly string[];
  /** `FUNKYOCTOPUS_UPKEEP_DISABLED=1` — actions refuse before any I/O. */
  disabled: boolean;
  fs: CoordinationFsOps;
  /** Liveness probe for the repository lock's stale-owner policy. */
  probe: (pid: number) => ProcessStatus;
  /** Sidecar liveness: promotion and recovery refuse while it answers. */
  sidecar: SidecarProbe;
  pid: number;
  host: string;
  /** Starting cwd for the read-only git top-level resolution. */
  cwd: string;
  stateRoot?: string;
  hash?: HashFn;
  now?: () => number;
  randomId?: () => string;
  /** Read-only `git rev-parse --show-toplevel` (canonicalized by the caller). */
  runGitTopLevel: (cwd: string) => Promise<RepoResolution>;
  /** Fresh preflight binding; production is `productionPreflight(repo)`. */
  runPreflight: (repo: string) => Promise<PreflightResult>;
  /** Promotion binding; production is `productionPromote({...})`. */
  runPromote: (opts: {
    runCanary: (signal: AbortSignal) => Promise<CanaryOutcome>;
    skipCanary: boolean;
  }) => (context: PromotionContext) => Promise<PromotionOutcome>;
  /** Live-canary binding; production is `productionRunCanary()`. */
  runCanary: () => (signal: AbortSignal) => Promise<CanaryOutcome>;
  /** Recovery binding; production is `productionRecover({...})`. */
  runRecover: (opts: { repo: string; stateDir: string; disabled: boolean }) => () => Promise<RecoveryOutcome>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Bounds any engine-derived line before it reaches stdout/stderr. */
function bound(line: string): string {
  return boundedReason(line, MAX_REASON_BYTES);
}

function actionLabel(kind: 'promote' | 'recover'): string {
  return kind === 'promote' ? 'promotion' : 'recovery';
}

export async function runUpkeepCommand(deps: UpkeepCommandDeps): Promise<number> {
  const parsed = parseUpkeepArgs(deps.argv);
  if (parsed.kind === 'error') {
    deps.err(bound(parsed.message));
    deps.err(USAGE);
    return 1;
  }
  const action = parsed.action;
  if (action.kind !== 'status' && deps.disabled) {
    deps.err(
      bound(
        `upkeep is disabled (FUNKYOCTOPUS_UPKEEP_DISABLED=1); ${action.kind} refuses before any inspection`,
      ),
    );
    deps.err(USAGE);
    return 1;
  }
  if (action.kind === 'status') return runStatus(deps);
  return runLockedAction(deps, action);
}

/**
 * Status: read only the persisted embedded state and the transaction
 * classification from the derived state dir. Never acquires or creates the
 * lock/state dir, never mutates, never contacts the registry or loads the
 * SDK. Absent state prints the unknown fields; unreadable state is reported
 * boundedly with a nonzero exit.
 */
async function runStatus(deps: UpkeepCommandDeps): Promise<number> {
  const resolved = await deps.runGitTopLevel(deps.cwd);
  if (resolved.kind === 'error') {
    deps.err(bound(resolved.message));
    deps.err(USAGE);
    return 1;
  }
  const repo = resolved.repo;
  let stateDir: string;
  try {
    stateDir = await deriveStateDir(deps, repo);
  } catch (error) {
    deps.err(bound(`could not derive the state directory: ${messageOf(error)}`));
    deps.err(USAGE);
    return 1;
  }
  const loaded = await loadEmbeddedState(stateDir, deps.fs);
  const transaction = await readTransaction(stateDir, deps.fs);
  if (loaded.kind === 'invalid') {
    deps.err(bound(`cached embedded upkeep state is unreadable — ${loaded.reason}`));
    deps.out(USAGE);
    return 1;
  }
  const state = loaded.kind === 'loaded' ? loaded.state : null;
  deps.out(bound(`embedded pi upkeep — ${repo}`));
  deps.out(bound(`  installed: ${state?.installedVersion ?? 'unknown'}`));
  deps.out(bound(`  latest: ${state?.latestVersion ?? 'unknown'}`));
  deps.out(bound(`  verified: ${state?.verifiedVersion ?? 'unknown'}`));
  deps.out(bound(`  verification: ${state?.verificationLevel ?? 'unknown'}`));
  deps.out(bound(`  status: ${state?.status ?? 'unknown'}`));
  deps.out(bound(`  transaction: ${transactionLabel(transaction)}`));
  if (state === null) deps.out(bound('  (no cached embedded upkeep state yet)'));
  deps.out(bound(USAGE));
  return 0;
}

/** Bounded one-line transaction classification for the status view. */
function transactionLabel(transaction: TransactionState): string {
  switch (transaction.kind) {
    case 'none':
      return 'none';
    case 'orphan_prepared':
      return `orphan prepared journal ${transaction.journal.transactionId} at ${transaction.journal.phase}`;
    case 'completed':
      return `committed journal ${transaction.journal.transactionId} awaiting backup cleanup`;
    case 'active':
      return `active transaction ${transaction.journal.transactionId} at ${transaction.journal.phase}`;
    case 'failed_closed':
      return `failed closed (${bound(transaction.reason)})`;
  }
}

async function deriveStateDir(deps: UpkeepCommandDeps, repo: string): Promise<string> {
  const pathDeps: Parameters<typeof repositoryStateDir>[1] = { fs: deps.fs };
  if (deps.stateRoot !== undefined) pathDeps.stateRoot = deps.stateRoot;
  if (deps.hash !== undefined) pathDeps.hash = deps.hash;
  return repositoryStateDir(repo, pathDeps);
}

/**
 * Promotion/recovery: resolve the repo read-only, derive and validate the
 * state dir, then create the state chain and acquire the repository lock —
 * held through completion and released in `finally` for every ordinary
 * outcome. A `recovery_required` promotion that may race a live canary
 * (`retainLockUntilExit`) is never released. Before any of that, a sidecar
 * answering on the configured port refuses the action outright — and a
 * promotion probes once more after its preflight, right before mutating: the
 * sidecar holds no lock, so this probe is the only thing keeping a promotion
 * from renaming `node_modules` under a live server.
 */
/**
 * Sidecar liveness refusal. Returns true (after printing the refusal) when the
 * action must not proceed: an invalid configured port, or anything accepting a
 * connection on the sidecar's host:port. Called before any state I/O and again
 * immediately before the destructive step (a preflight can run for minutes;
 * nothing stops a sidecar from being started in between).
 */
async function sidecarBlocks(deps: UpkeepCommandDeps, kind: 'promote' | 'recover'): Promise<boolean> {
  const { host, port } = deps.sidecar;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    deps.err(bound(`${actionLabel(kind)} blocked — invalid sidecar port ${String(port)} (SIDECAR_PORT)`));
    deps.err(USAGE);
    return true;
  }
  if (await deps.sidecar.probe(host, port)) {
    deps.err(bound(`${actionLabel(kind)} blocked — a sidecar answers on ${host}:${port}`));
    deps.err('stop the sidecar (it must not run during a promotion or recovery) and retry');
    deps.err(USAGE);
    return true;
  }
  return false;
}

async function runLockedAction(
  deps: UpkeepCommandDeps,
  action: { kind: 'promote'; skipCanary: boolean } | { kind: 'recover' },
): Promise<number> {
  if (await sidecarBlocks(deps, action.kind)) return 1;
  const resolved = await deps.runGitTopLevel(deps.cwd);
  if (resolved.kind === 'error') {
    deps.err(bound(resolved.message));
    deps.err(USAGE);
    return 1;
  }
  const repo = resolved.repo;
  let stateDir: string;
  try {
    stateDir = await deriveStateDir(deps, repo);
  } catch (error) {
    deps.err(bound(`could not derive the state directory: ${messageOf(error)}`));
    deps.err(USAGE);
    return 1;
  }
  if (isInside(stateDir, repo)) {
    deps.err(
      bound(
        `${action.kind} refused: the state directory ${JSON.stringify(stateDir)} would land inside the repository ${JSON.stringify(repo)}`,
      ),
    );
    deps.err('fix the state root (XDG_STATE_HOME) to point outside the repository, then retry');
    deps.err(USAGE);
    return 1;
  }
  try {
    await ensureStateDir(stateDir, deps.fs);
  } catch (error) {
    deps.err(bound(`could not create the state directory: ${messageOf(error)}`));
    deps.err(USAGE);
    return 1;
  }
  const lockDeps: LockDeps = { fs: deps.fs, pid: deps.pid, host: deps.host, probe: deps.probe };
  if (deps.now !== undefined) lockDeps.now = deps.now;
  if (deps.randomId !== undefined) lockDeps.randomId = deps.randomId;
  const lock = new RepositoryLock(stateDir, lockDeps);
  const acquisition = await lock.acquire();
  if (acquisition.kind !== 'acquired') {
    const reason = acquisition.kind === 'contended' ? acquisition.reason : acquisition.message;
    deps.err(bound(`${actionLabel(action.kind)} blocked — ${reason}`));
    deps.err('another updater owns the repository lock; wait for it to finish and retry');
    deps.err(USAGE);
    return 1;
  }
  const held = acquisition.lock;
  let retain = false;
  let code: number;
  try {
    if (action.kind === 'promote') {
      const result = await runPromotionAction(deps, repo, action.skipCanary);
      retain = result.retain;
      code = result.code;
    } else {
      code = await runRecoveryAction(deps, repo, stateDir);
    }
  } catch (error) {
    deps.err(bound(`unexpected ${action.kind} failure — ${messageOf(error)}`));
    deps.err(USAGE);
    code = 1;
  } finally {
    if (!retain) {
      try {
        await held.release();
      } catch (error) {
        deps.err(bound(`could not release the repository lock — ${messageOf(error)}`));
      }
    }
  }
  return code;
}

/**
 * Promotion under the held lock: fresh preflight first; refusals and
 * preflight errors are reported with exact guidance; a ready context runs
 * the transactional promotion with the default live canary or the explicit
 * one-run skip. `committed`/`noop` exit 0; `rolled_back`, `cleanup_pending`,
 * `recovery_required`, and `error` exit nonzero with exact recovery guidance.
 */
async function runPromotionAction(
  deps: UpkeepCommandDeps,
  repo: string,
  skipCanary: boolean,
): Promise<{ code: number; retain: boolean }> {
  const preflight = await deps.runPreflight(repo);
  if (preflight.kind === 'refused') {
    deps.err(bound(`promotion refused — ${preflight.refusal.reason}`));
    for (const line of refusalGuidance(preflight.refusal)) deps.err(line);
    deps.err(USAGE);
    return { code: 1, retain: false };
  }
  if (preflight.kind === 'error') {
    deps.err(bound(`promotion could not run — ${preflight.message}`));
    deps.err(USAGE);
    return { code: 1, retain: false };
  }
  if (preflight.kind === 'noop') {
    deps.out(`embedded pi is already current at ${preflight.context.installedVersion}`);
    return { code: 0, retain: false };
  }
  // The preflight (build, npm ls, registry read) can take minutes; re-check
  // right before the first mutation so a sidecar started meanwhile still blocks.
  if (await sidecarBlocks(deps, 'promote')) return { code: 1, retain: false };
  const promote = deps.runPromote({ runCanary: deps.runCanary(), skipCanary });
  const outcome = await promote(preflight.context);
  return formatPromotionOutcome(deps, outcome);
}

/** Exact recovery guidance per preflight refusal code. */
function refusalGuidance(refusal: PreflightRefusal): readonly string[] {
  switch (refusal.code) {
    case 'disabled':
      return ['unset FUNKYOCTOPUS_UPKEEP_DISABLED and retry'];
    case 'transaction_state':
      return ['an unresolved transaction must be resolved first:', 'run: npm run upkeep:embedded -- --recover'];
    case 'cleanup_pending':
      return ['pending backup cleanup must finish first:', 'run: npm run upkeep:embedded -- --recover'];
    case 'embedded_state_unreadable':
      return ['the cached upkeep state must be readable before promotion; do not delete it manually'];
    case 'path_inside_repo':
      return ['the state root (XDG_STATE_HOME) must point outside the repository'];
    case 'repo_identity':
    case 'repo_root_mismatch':
      return ['run the command from inside the repository checkout and retry'];
    case 'detached_head':
      return ['check out a named branch and retry'];
    case 'bad_head':
    case 'git_status_failed':
      return ['the repository could not be inspected; fix the checkout and retry'];
    case 'dirty_tree':
      return ['the working tree must be clean before promotion; commit or stash the changes and retry'];
    case 'manifest_unreadable':
    case 'manifest_invalid':
      return ['package.json and package-lock.json must be readable JSON before promotion'];
    case 'npm_ls_failed':
    case 'npm_ls_malformed':
      return ['the installed baseline must be inspectable; run npm ls and fix any errors'];
    case 'baseline_needs_attention':
      return ['the baseline is inconsistent; resolve the manifest/lock/npm ls disagreement before promoting'];
    case 'latest_failed':
      return ['the registry lookup failed; retry when the network or registry is reachable'];
    case 'latest_rejected':
      return ['the npm latest result is not promotable; retry when the stable dist-tag is valid'];
    case 'baseline_build_failed':
      return ['the baseline production build failed; fix the build and retry'];
    case 'backup_device_unreadable':
    case 'backup_device_invalid':
    case 'backup_device_mismatch':
      return ['the node_modules tree and its backup sibling must be on the same filesystem'];
  }
}

function formatPromotionOutcome(
  deps: UpkeepCommandDeps,
  outcome: PromotionOutcome,
): { code: number; retain: boolean } {
  switch (outcome.kind) {
    case 'committed':
      deps.out(
        `embedded pi promoted to ${outcome.candidate} and committed as ${outcome.commit.slice(0, 12)} (${outcome.verificationLevel})`,
      );
      return { code: 0, retain: false };
    case 'noop':
      deps.out(`embedded pi is already current at ${outcome.installed}`);
      return { code: 0, retain: false };
    case 'rolled_back':
      deps.err(bound(`promotion failed and was rolled back — ${outcome.reason}`));
      deps.err(`the previous embedded pi ${outcome.installed} is restored; if the working tree is not clean, run: npm run upkeep:embedded -- --recover`);
      return { code: 1, retain: false };
    case 'cleanup_pending':
      deps.err(bound(`promotion committed ${outcome.candidate} but backup cleanup is pending — ${outcome.reason}`));
      deps.err('run: npm run upkeep:embedded -- --recover to retry the cleanup');
      return { code: 1, retain: false };
    case 'recovery_required': {
      deps.err(bound(`promotion requires recovery — ${outcome.reason}`));
      deps.err('run: npm run upkeep:embedded -- --recover');
      if (outcome.retainLockUntilExit) {
        deps.err('the live canary may still be running; the repository lock is retained until this process exits');
        deps.err('if this process remains alive after this message, terminate it — the lock is reclaimed only after its recorded owner pid is proven dead; there is no force bypass');
      }
      return { code: 1, retain: outcome.retainLockUntilExit };
    }
    case 'error':
      deps.err(bound(`promotion failed — ${outcome.message}`));
      deps.err('run: npm run upkeep:embedded -- --recover if the repository needs recovery');
      return { code: 1, retain: false };
  }
}

/**
 * Recovery under the held lock: phase-aware `productionRecover`. `none`,
 * `restored`, and `finalized` exit 0; `cleanup_pending`, `blocked`, and
 * `error` exit nonzero with exact guidance.
 */
async function runRecoveryAction(deps: UpkeepCommandDeps, repo: string, stateDir: string): Promise<number> {
  const recover = deps.runRecover({ repo, stateDir, disabled: deps.disabled });
  const outcome = await recover();
  switch (outcome.kind) {
    case 'none':
      deps.out('no transaction evidence exists; nothing to recover');
      return 0;
    case 'restored':
      deps.out(`recovery restored embedded pi ${outcome.installed} — ${bound(outcome.reason)}`);
      return 0;
    case 'finalized':
      deps.out(
        `recovery finalized the committed candidate ${outcome.candidate} (${outcome.verificationLevel}) at ${outcome.commit.slice(0, 12)}`,
      );
      return 0;
    case 'cleanup_pending':
      deps.err(bound(`recovery finalized the commit but backup cleanup is still pending — ${outcome.reason}`));
      deps.err('run: npm run upkeep:embedded -- --recover again to retry the cleanup');
      return 1;
    case 'blocked':
      deps.err(bound(`recovery is blocked — ${outcome.reason}`));
      deps.err('the transaction evidence (sentinel, journal, backup, logs) is preserved; do not delete it manually');
      return 1;
    case 'error':
      deps.err(bound(`recovery failed — ${outcome.message}`));
      return 1;
  }
}
