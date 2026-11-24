/**
 * Automatic `pi update --all` upkeep.
 *
 * The updater is a background concern: it runs once after the sidecar listens
 * and then on a single unref'd interval, reports every outcome as a cached
 * status rather than an error, and never touches the repository — no npm, no
 * embedded SDK bump, no sidecar restart. Updated CLI/packages apply to newly
 * constructed sessions or a later sidecar restart; already loaded extension
 * code is not claimed to hot-swap.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type {
  ClaudeSdkUpkeepInfo,
  EmbeddedStatus,
  EmbeddedUpkeepInfo,
  UpkeepResult,
  UpkeepStatus,
  VersionDrift,
} from '../../../src/shared/transport/protocol.ts';
import {
  defaultEmbeddedState,
  embeddedInfoOf,
  persistedOf,
  saveEmbeddedState,
  type EmbeddedStateConfig,
} from './embedded-state.ts';
import { evaluateLatest, type LatestDecision } from './stable-latest.ts';
import { exactStableString } from './versions.ts';

export const DEFAULT_UPKEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** `pi update --all` gets five minutes; longer means the run is abandoned. */
export const UPKEEP_TIMEOUT_MS = 5 * 60 * 1000;
const VERSION_READ_TIMEOUT_MS = 10_000;
/** Bounded output: keep only the tail of whatever the updater printed. */
const MAX_OUTPUT_BYTES = 16 * 1024;
/** The embedded SDK lives under the repository's node_modules. */
const EMBEDDED_PKG_URL = new URL(
  '../../../node_modules/@earendil-works/pi-coding-agent/package.json',
  import.meta.url,
);

export class MissingBinaryError extends Error {}
export class UpkeepTimeoutError extends Error {}

/**
 * Bounded tail accumulator for combined child stdout/stderr: retains at most
 * `limit` bytes of the most recent output as it arrives, so a noisy updater
 * cannot grow memory without bound. Chunk order is preserved.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (this.length > this.limit) this.compact();
  }

  /** Total retained bytes — always ≤ limit. */
  get byteLength(): number {
    return this.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  private compact(): void {
    while (this.length > this.limit) {
      const head = this.chunks[0];
      if (!head) break;
      if (this.length - head.length >= this.limit) {
        this.length -= head.length;
        this.chunks.shift();
      } else {
        const overflow = this.length - this.limit;
        // Copy the trimmed head so the oversized source buffer can be freed.
        this.chunks[0] = Buffer.from(head.subarray(overflow));
        this.length -= overflow;
      }
    }
  }
}

/**
 * Resolves the **global** `pi` binary. The sidecar is started through npm/npx,
 * which prepends the repository's `node_modules/.bin` to PATH — and that shim
 * is the embedded SDK's pi, which refuses to self-update. The updater must
 * reach the global install, so project-local `.bin` shims are skipped.
 * Falls back to the bare name so a truly absent binary surfaces as ENOENT.
 */
export function resolveGlobalPi(): string {
  const binary = process.platform === 'win32' ? 'pi.exe' : 'pi';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || isProjectLocalBin(dir)) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}

function isProjectLocalBin(dir: string): boolean {
  const tail = dir.split(/[\\/]/).filter(Boolean).slice(-2);
  return tail[0] === 'node_modules' && tail[1] === '.bin';
}

/**
 * Runs a global `pi` command, keeping only the tail of its combined output.
 * Resolves with the bounded output; rejects with `MissingBinaryError` when the
 * binary is absent, an exit error for a nonzero status, or whatever the child
 * reported. Aborts on `signal` so the caller can abandon a hung updater.
 */
export function runPiCommand(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolveGlobalPi(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const retained = new TailBuffer(MAX_OUTPUT_BYTES);
    child.stdout?.on('data', (chunk: Buffer) => retained.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => retained.push(chunk));
    let settled = false;
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const detach = (): void => signal.removeEventListener('abort', onAbort);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      detach();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new MissingBinaryError('pi: command not found'));
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      detach();
      const output = retained.toString();
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `pi ${args.join(' ')} exited with code ${code ?? 'unknown'}: ${output || 'no output'}`,
          ),
        );
      }
    });
  });
}

/**
 * The global pi CLI version (`pi --version`), or null when the binary is
 * missing or the read times out. Cached by the Upkeep; the status poll never
 * shells out.
 */
export async function readGlobalPiVersion(): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), VERSION_READ_TIMEOUT_MS);
  try {
    const output = await runPiCommand(['--version'], abort.signal);
    const match = /^v?(\d+\.\d+(?:\.\d+)?)/.exec(output.trim());
    return match?.[1] ?? (output.trim() || null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The installed embedded SDK version from the repository's node_modules. */
export async function readEmbeddedSdkVersion(): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(EMBEDDED_PKG_URL, 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Drift of the embedded SDK relative to the global pi version: `behind` when
 * the embedded SDK lags the CLI, `ahead` when it leads, `unknown` when either
 * version could not be read or parsed.
 */
export function driftOf(
  globalPiVersion: string | null,
  embeddedSdkVersion: string | null,
): VersionDrift {
  if (globalPiVersion === null || embeddedSdkVersion === null) return 'unknown';
  const comparison = compareVersions(globalPiVersion, embeddedSdkVersion);
  if (comparison === null) return 'unknown';
  return comparison === 0 ? 'equal' : comparison < 0 ? 'ahead' : 'behind';
}

function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function summarizeOutput(output: string): string | null {
  const tail = output.trim().slice(-500);
  return tail || null;
}

/** The detection-owned status a stable-latest decision maps to. */
function embeddedStatusOf(decision: LatestDecision): EmbeddedStatus {
  switch (decision.kind) {
    case 'promotable':
      return 'available';
    case 'noop':
      return 'current';
    case 'reject':
      // No registry result (or a malformed/downgrade one) means we cannot
      // claim anything about availability — fail closed to unknown.
      return 'unknown';
  }
}

export interface UpkeepOptions {
  /** True when FUNKYOCTOPUS_UPKEEP_DISABLED=1 — nothing runs or schedules. */
  disabled?: boolean;
  /** Interval of the single scheduled maybeRun timer. */
  intervalMs: number;
  /**
   * Scheduled repeats must wait this long after a run before running again.
   * Defaults to `intervalMs`, so an overridden cadence guards itself.
   */
  minIntervalMs?: number;
  /** How long an update may run before it is abandoned as timed out. */
  timeoutMs?: number;
  /** Runs `pi update --all` (production) or a fake (tests). */
  runUpdate: (signal: AbortSignal) => Promise<string>;
  readGlobalVersion: () => Promise<string | null>;
  readEmbeddedVersion: () => Promise<string | null>;
  /**
   * Reads the installed SDK version for embedded detection. Production binds
   * the same reader as `readEmbeddedVersion`; a separate seam keeps the drift
   * read and the detection read independently countable in tests.
   */
  readInstalledVersion: () => Promise<string | null>;
  /**
   * Reads npm's stable `latest` for the embedded SDK; null on any failure.
   * Production binds the bounded `npm view` reader; tests inject a fake.
   */
  readStableLatest: () => Promise<string | null>;
  /** Independent read-only Claude pairing detection, never run by snapshot(). */
  readClaudeSdk?: () => Promise<ClaudeSdkUpkeepInfo>;
  /** Durable embedded state under the repository state dir. */
  embeddedState?: EmbeddedStateConfig;
  /**
   * Why `pi update --all` must wait, or null when it may run (see
   * `update-defer.ts`). A deferred run is recorded as such, with the time the
   * deferral began, and retried at the next scheduled tick.
   */
  deferUpdate?: () => string | null;
  /** Injectable clock so scheduled-freshness tests are deterministic. */
  now?: () => number;
}

export class Upkeep {
  private state: UpkeepResult;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Global `pi update --all` single-flight. */
  private running = false;
  /** Embedded stable-latest detection single-flight, independent of `running`. */
  private detecting = false;
  private detectingClaude = false;
  private claudeLastCheckAt: number | null = null;
  private disposed = false;

  constructor(private readonly options: UpkeepOptions) {
    this.state = {
      disabled: options.disabled === true,
      status: 'idle',
      lastRunAt: null,
      lastResult: null,
      globalPiVersion: null,
      embeddedSdkVersion: null,
      drift: 'unknown',
      deferredSince: null,
      embedded: embeddedInfoOf(options.embeddedState?.initial ?? defaultEmbeddedState()),
      ...(options.readClaudeSdk ? { claudeSdk: { status: 'unknown', cliVersion: null, sdkVersion: null } } : {}),
    };
    // The scheduler is deliberately NOT armed here: a short configured interval
    // must never run global upkeep or embedded detection before the sidecar
    // listens. startup(), invoked post-listen, arms the single interval.
  }

  /** The cached result the status poll reads — never shells out. */
  snapshot(): UpkeepResult {
    return { ...this.state };
  }

  /**
   * Runs once after every successful sidecar listen. All three tracks begin
   * immediately and independently; none is suppressed by freshness: each
   * startup is an explicit run. Resolves when all settle (or are skipped)
   * and never rejects.
   */
  async startup(): Promise<void> {
    if (this.isDisabled() || this.disposed) return;
    this.armScheduler();
    await Promise.all([this.runUpdateNow(), this.runDetectionNow(), this.runClaudeSdkDetectionNow()]);
  }

  /** Arms the single scheduled interval on first startup; later startups reuse it. */
  private armScheduler(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.maybeRun(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * The scheduled entry point: all three tracks guard themselves
   * with their own single-flight and freshness, so one slow or failed track
   * never suppresses the other.
   */
  maybeRun(): void {
    if (this.isDisabled() || this.disposed) return;
    if (!this.running && this.globalDue()) void this.runUpdateNow();
    if (!this.detecting && this.embeddedDue()) void this.runDetectionNow();
    if (!this.detectingClaude && this.claudeSdkDue()) void this.runClaudeSdkDetectionNow();
  }

  /** Clears the interval; idempotent, and later triggers are inert. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async runUpdateNow(): Promise<void> {
    if (this.running || this.isDisabled() || this.disposed) return;
    const deferred = this.options.deferUpdate?.() ?? null;
    if (deferred !== null) {
      // `lastRunAt` stays put, so the next scheduled tick finds the run due and asks again.
      this.state = {
        ...this.state,
        status: 'deferred',
        lastResult: deferred,
        deferredSince: this.state.deferredSince ?? this.now(),
      };
      return;
    }
    this.running = true;
    try {
      this.state = { ...this.state, status: 'updating' };
      let status: UpkeepStatus;
      let lastResult: string | null;
      try {
        const output = await this.runWithTimeout();
        status = 'updated';
        lastResult = summarizeOutput(output);
      } catch (error) {
        if (error instanceof UpkeepTimeoutError) status = 'timed_out';
        else if (error instanceof MissingBinaryError) status = 'missing_binary';
        else status = 'failed';
        lastResult = error instanceof Error ? error.message : String(error);
      }
      const [globalPiVersion, embeddedSdkVersion] = await Promise.all([
        this.options.readGlobalVersion().catch(() => null),
        this.options.readEmbeddedVersion().catch(() => null),
      ]);
      this.state = {
        ...this.state,
        status,
        lastResult,
        lastRunAt: this.now(),
        deferredSince: null,
        globalPiVersion,
        embeddedSdkVersion,
        drift: driftOf(globalPiVersion, embeddedSdkVersion),
      };
    } finally {
      this.running = false;
    }
  }

  private runWithTimeout(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
        reject(new UpkeepTimeoutError(`pi update --all timed out after ${this.timeoutMs()}ms`));
      }, this.timeoutMs());
      this.options.runUpdate(abort.signal).then(
        (output) => {
          clearTimeout(timer);
          resolve(output);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * One read-only embedded detection: read the installed version and npm's
   * stable `latest` independently (either may fail), decide through the pure
   * stable-latest evaluator, then update only the detection-owned cached
   * fields and persist them durably. Never mutates manifests, node_modules,
   * or Git, and never rejects.
   */
  private async runDetectionNow(): Promise<void> {
    if (this.detecting || this.isDisabled() || this.disposed) return;
    this.detecting = true;
    try {
      // Transient in-memory state only; a recovery-status is never hidden.
      this.state = {
        ...this.state,
        embedded: { ...this.state.embedded, status: this.checkingStatus() },
      };
      const [installedRaw, latestRaw] = await Promise.all([
        this.options.readInstalledVersion().catch(() => null),
        this.options.readStableLatest().catch(() => null),
      ]);
      // A raw CLI read may carry a leading v, prerelease, build metadata, or
      // trailing whitespace; only the exact-stable form is decided on and
      // stored, so persisted state always passes the strict loader.
      const installed = installedRaw === null ? null : exactStableString(installedRaw);
      const decision =
        installed === null
          ? {
              kind: 'reject' as const,
              installed: '',
              raw: latestRaw,
              reason: 'installed SDK version is unreadable',
            }
          : evaluateLatest(latestRaw, installed);
      const next = this.applyDetectionOutcome(decision, installed, this.now());
      this.state = { ...this.state, embedded: next };
      await this.persistEmbedded(next);
    } finally {
      this.detecting = false;
    }
  }

  private async runClaudeSdkDetectionNow(): Promise<void> {
    if (!this.options.readClaudeSdk || this.detectingClaude || this.isDisabled() || this.disposed) return;
    this.detectingClaude = true;
    // Freshness follows detection start, so a slow read cannot skip the next tick.
    this.claudeLastCheckAt = this.now();
    try {
      let claudeSdk: ClaudeSdkUpkeepInfo;
      try {
        claudeSdk = await this.options.readClaudeSdk();
      } catch {
        claudeSdk = { status: 'unknown', cliVersion: null, sdkVersion: null };
      }
      this.state = { ...this.state, claudeSdk };
    } finally {
      this.detectingClaude = false;
    }
  }

  private claudeSdkDue(): boolean {
    return this.claudeLastCheckAt === null || this.now() - this.claudeLastCheckAt >= this.minIntervalMs();
  }

  private applyDetectionOutcome(
    decision: LatestDecision,
    installed: string | null,
    now: number,
  ): EmbeddedUpkeepInfo {
    const current = this.state.embedded;
    const latestVersion =
      decision.kind === 'reject'
        ? null
        : decision.kind === 'noop'
          ? decision.latest
          : decision.candidate;
    return {
      ...current,
      installedVersion: installed,
      latestVersion,
      status: this.isRecoveryStatus(current.status) ? current.status : embeddedStatusOf(decision),
      lastCheckAt: now,
    };
  }

  private checkingStatus(): EmbeddedStatus {
    const current = this.state.embedded.status;
    return this.isRecoveryStatus(current) ? current : 'checking';
  }

  /** Promotion/recovery statuses detection must never overwrite. */
  private isRecoveryStatus(status: EmbeddedStatus): boolean {
    return (
      status === 'promotion_failed' ||
      status === 'needs_attention' ||
      status === 'recovery_required' ||
      status === 'cleanup_pending'
    );
  }

  private globalDue(): boolean {
    return (
      this.state.lastRunAt === null || this.now() - this.state.lastRunAt >= this.minIntervalMs()
    );
  }

  private embeddedDue(): boolean {
    const last = this.state.embedded.lastCheckAt;
    return last === null || this.now() - last >= this.minIntervalMs();
  }

  /** Durable write of the detection-owned fields; best-effort by design. */
  private async persistEmbedded(info: EmbeddedUpkeepInfo): Promise<void> {
    const store = this.options.embeddedState;
    if (!store) return;
    try {
      await saveEmbeddedState(store.stateDir, store.fs, persistedOf(info));
    } catch {
      // Persistence is best-effort: memory holds the honest state and the
      // status poll never touches disk, so a failed write changes nothing
      // the browser can observe beyond the next restart's seed state.
    }
  }

  private isDisabled(): boolean {
    return this.options.disabled === true;
  }

  private minIntervalMs(): number {
    return this.options.minIntervalMs ?? this.options.intervalMs;
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? UPKEEP_TIMEOUT_MS;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
