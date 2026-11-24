import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { config } from '../config.ts';
import { setBackend } from '../health.ts';
import { messageOf } from '../util/errors.ts';
import { parseHelmraiserLog, HELMRAISER_LOG_LIMIT } from './log.ts';
import { UNAVAILABLE_CODES, WireCallError, wireErrorCode } from '../../../src/shared/transport/errors.ts';
import type {
  HelmraiserCancelScoutsResult,
  HelmraiserRequestScoutsResult,
  HelmraiserDraftResult,
  HelmraiserDropClass,
  HelmraiserLogResult,
  HelmraiserProposalResult,
  HelmraiserQueueResult,
  HelmraiserReport,
  HelmraiserReportWindow,
  HelmraiserReworkResult,
  HelmraiserRetryResult,
  HelmraiserScoutedDraft,
  HelmraiserScoutLens,
  HelmraiserScoutSettings,
  HelmraiserScoutSettingsUpdate,
  HelmraiserStats,
  HelmraiserStatsWindow,
  HelmraiserStatus,
} from '../../../src/shared/transport/protocol.ts';

/** Injectable spawn so hermetic tests never run a real helmraiser binary. */
export type SpawnLike = typeof import('node:child_process').spawn;

/** Retained stdout ceiling; a bigger payload means helmraiser answered wrongly. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Retained stderr tail, for the exit-message line. */
const MAX_STDERR_BYTES = 8 * 1024;

export interface RunHelmraiserJsonOptions {
  cwd?: string;
  bin?: string;
  spawnFn?: SpawnLike;
  timeoutMs?: number;
  /**
   * For JSONL output (`helmraiser log --json`): resolve `{ lines, total }` with the
   * last N non-empty stdout lines instead of one parsed JSON document.
   */
  tailLines?: number;
}

/** What a `tailLines` run resolves: the last lines kept, and how many there were in all. */
export interface HelmraiserLines {
  lines: string[];
  total: number;
}

/** Streaming window over stdout lines: keeps the last `keep`, counts all of them. */
class LineWindow {
  readonly lines: string[] = [];
  total = 0;
  private partial: Buffer = Buffer.alloc(0);

  constructor(private readonly keep: number) {}

  /** Returns an oversized line's length, or the remaining partial line's length. */
  push(chunk: Buffer): number {
    const data = Buffer.concat([this.partial, chunk]);
    let start = 0;
    for (let end = data.indexOf(0x0a, start); end !== -1; end = data.indexOf(0x0a, start)) {
      const length = end - start;
      if (length > MAX_STDOUT_BYTES) return length;
      this.add(data.subarray(start, end));
      start = end + 1;
    }
    const partialLength = data.length - start;
    if (partialLength > MAX_STDOUT_BYTES) return partialLength;
    this.partial = Buffer.from(data.subarray(start));
    return this.partial.length;
  }

  /** Counts a final line that had no newline. */
  finish(): HelmraiserLines {
    this.add(this.partial);
    this.partial = Buffer.alloc(0);
    return { lines: this.lines, total: this.total };
  }

  private add(raw: Buffer): void {
    // Whole lines only, so a multibyte character is never split.
    const line = raw.toString('utf8').trim();
    if (line === '') return;
    this.total += 1;
    this.lines.push(line);
    if (this.lines.length > this.keep) this.lines.shift();
  }
}

/** Injectable runner so HelmraiserCli tests never spawn a real CLI. */
export type HelmraiserJsonRunner = <T>(
  args: string[],
  options?: RunHelmraiserJsonOptions,
) => Promise<T>;

function codeOf(error: NodeJS.ErrnoException): string | undefined {
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Helmraiser reports a failed command as exit 1 with `{"error": "…"}` on stdout
 * and nothing on stderr. Returns that error text, but only for a JSON object
 * (not an array) with a string `error`, so any other stdout keeps falling
 * through to the stderr-tail message.
 */
function stdoutErrorMessage(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON: the stderr tail is the honest answer.
  }
  return undefined;
}

/**
 * The last stderr line that says something. Helmraiser's CLI (typer) boxes its
 * errors, so box-drawing borders are stripped and border-only lines skipped.
 */
function lastNonEmptyLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[\u2500-\u257f]/g, '').trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

/**
 * Runs `helmraiser <args>` and resolves its parsed `--json` stdout. Every failure
 * becomes a typed rejection: the CLI missing is `helmraiser_unavailable`, a bad
 * answer or oversized payload is `helmraiser_bad_output`, and any other failure
 * (non-zero exit, spawn error, timeout) is `helmraiser_cli_error`. Settles
 * exactly once, so an `error` followed by `close` cannot double-settle.
 */
export async function runHelmraiserJson<T>(
  args: string[],
  { bin = config.helmraiserBin, spawnFn = spawn, timeoutMs = 30_000, cwd, tailLines }: RunHelmraiserJsonOptions = {},
): Promise<T> {
  const child = spawnFn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd !== undefined ? { cwd } : {}),
  }) as ChildProcess & {
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
  };

  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    let stdoutSize = 0;
    const stdoutChunks: Buffer[] = [];
    const lineWindow = tailLines === undefined ? null : new LineWindow(tailLines);
    let stderr = Buffer.alloc(0);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new WireCallError(
        `helmraiser ${args[0]} timed out after ${timeoutMs / 1000} s`,
        'helmraiser_cli_error',
      )));
    }, timeoutMs);

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (lineWindow) {
        // Only the tail is retained, so the total is unbounded; one line is not.
        if (lineWindow.push(chunk) > MAX_STDOUT_BYTES) {
          child.kill('SIGTERM');
          settle(() => reject(new WireCallError(
            `helmraiser ${args[0]} produced a line longer than 4 MiB`,
            'helmraiser_bad_output',
          )));
        }
        return;
      }
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_STDOUT_BYTES) {
        child.kill('SIGTERM');
        settle(() => reject(new WireCallError(
          `helmraiser ${args[0]} produced more than 4 MiB of stdout`,
          'helmraiser_bad_output',
        )));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Byte-accurate tail: a chunk boundary must not split the retained text.
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.subarray(stderr.length - MAX_STDERR_BYTES);
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (codeOf(error) === 'ENOENT') {
        settle(() => reject(new WireCallError(
          `Helmraiser CLI not found: ${bin}`,
          UNAVAILABLE_CODES.helmraiser,
        )));
      } else {
        settle(() => reject(new WireCallError(
          `helmraiser ${args[0]} failed to start: ${error.message}`,
          'helmraiser_cli_error',
        )));
      }
    });

    child.on('close', (code: number | null) => {
      settle(() => {
        if (code === 0 && lineWindow) {
          resolvePromise(lineWindow.finish() as T);
          return;
        }
        if (code === 0) {
          // Decode once over the complete bytes, so a chunk boundary cannot
          // split a multibyte UTF-8 character in a status title.
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          try {
            resolvePromise(JSON.parse(stdout) as T);
          } catch (error) {
            reject(new WireCallError(
              `helmraiser ${args.join(' ')} did not produce JSON: ${error instanceof Error ? error.message : String(error)}`,
              'helmraiser_bad_output',
            ));
          }
          return;
        }
        // Helmraiser's own failure envelope wins: it names the run/task that
        // failed, where stderr is often empty.
        const jsonError = stdoutErrorMessage(
          lineWindow ? lineWindow.finish().lines.join('\n') : Buffer.concat(stdoutChunks).toString('utf8'),
        );
        if (jsonError !== undefined) {
          reject(new WireCallError(
            `helmraiser ${args[0]} failed: ${jsonError}`,
            'helmraiser_cli_error',
          ));
          return;
        }
        reject(new WireCallError(
          `helmraiser ${args[0]} exited ${code}: ${lastNonEmptyLine(stderr.toString('utf8'))}`,
          'helmraiser_cli_error',
        ));
      });
    });
  });
}

/** The fields of `helmraiser report --json --models` the wire report keeps. */
interface RawReport {
  generated_at: string;
  landed: unknown[];
  awaiting: unknown[];
  failed: Array<{
    run_id: string;
    task_id: string;
    title: string;
    failure_reason?: string | null;
    ended_at?: string | null;
  }>;
  cost: { total_usd: number; by_model: Record<string, number> };
  /** Absent from Helmraiser builds that predate `--models`. */
  models?: HelmraiserReport['models'];
}

/**
 * Maps the raw report to the wire shape field by field. The raw one carries
 * `fragment`, `verify_tails` and `leeboard_entries` on every run (about 144 KB for
 * 7d), which never cross the wire.
 */
function toReport(since: HelmraiserReportWindow, raw: RawReport): HelmraiserReport {
  return {
    since,
    generated_at: raw.generated_at,
    landed_count: raw.landed.length,
    awaiting_count: raw.awaiting.length,
    failed: raw.failed.map((run) => ({
      run_id: run.run_id,
      task_id: run.task_id,
      title: run.title,
      failure_reason: run.failure_reason ?? null,
      ended_at: run.ended_at ?? null,
    })),
    cost: { total_usd: raw.cost.total_usd, by_model: raw.cost.by_model },
    models: (raw.models ?? []).map((row) => ({
      model: row.model,
      runs: row.runs,
      landed: row.landed,
      failed: row.failed,
      first_pass: row.first_pass,
      review_rounds: row.review_rounds,
      avg_iterations: row.avg_iterations,
      avg_minutes: row.avg_minutes,
      cost_per_landed: row.cost_per_landed,
    })),
  };
}

/**
 * How long a missing CLI is taken as still missing. The browser (5 s), the
 * health probe (15 s) and the watcher (30 s) all read `status`; once Helmraiser
 * is known to be absent they answer from memory and look again once a minute,
 * so a later install is noticed without a restart and nothing spawns in a loop.
 */
export const MISSING_RECHECK_MS = 60_000;

/** Seams of `HelmraiserCli` that tests replace: the clock, and where the one missing-CLI line goes. */
export interface HelmraiserCliOptions {
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * The CLI observation face of helmraiser: reads `helmraiser status --json` through
 * the runner and owns the helmraiser backend-map entry, the one liveness writer
 * for the helmraiser backend.
 */
export class HelmraiserCli {
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly runner: HelmraiserJsonRunner = runHelmraiserJson,
    /** Awaited before every action (never before `status`), e.g. the Vault guard. */
    private readonly beforeSpawn?: (args: string[]) => Promise<void>,
    { now = Date.now, warn = console.warn }: HelmraiserCliOptions = {},
  ) {
    this.now = now;
    this.warn = warn;
  }

  /** The read in flight; the watcher, health probe and RPC each poll on their own timer. */
  private statusRead: Promise<HelmraiserStatus> | null = null;

  /** When and how the last `status` found the CLI missing; null while it is there. */
  private missing: { at: number; error: Error } | null = null;

  /** The missing CLI is logged once per process, not once per re-check. */
  private missingLogged = false;

  /** The report reads in flight, by window. */
  private readonly reportReads = new Map<HelmraiserReportWindow, Promise<HelmraiserReport>>();

  /** The stats reads in flight, by window and project. */
  private readonly statsReads = new Map<string, Promise<HelmraiserStats>>();

  /**
   * `helmraiser report --since <window> --json --models`, a read like `status`.
   * It can take minutes, so the timeout is five. Concurrent callers for the
   * same window share one child; another window gets its own.
   */
  report(since: HelmraiserReportWindow): Promise<HelmraiserReport> {
    let read = this.reportReads.get(since);
    if (!read) {
      read = this.readReport(since).finally(() => {
        this.reportReads.delete(since);
      });
      this.reportReads.set(since, read);
    }
    return read;
  }

  private async readReport(since: HelmraiserReportWindow): Promise<HelmraiserReport> {
    const raw = await this.runner<RawReport>(
      ['report', '--since', since, '--json', '--models'],
      { timeoutMs: 300_000 },
    );
    return toReport(since, raw);
  }

  /**
   * `helmraiser stats --since <window> [--project <path>] --json`, a read like
   * `status`; the JSON crosses the wire as it came. Concurrent callers for the
   * same window and project share one child; another key gets its own.
   */
  stats(since: HelmraiserStatsWindow, project?: string): Promise<HelmraiserStats> {
    const key = JSON.stringify([since, project ?? null]);
    let read = this.statsReads.get(key);
    if (!read) {
      read = this.runner<HelmraiserStats>(
        ['stats', '--since', since, '--json', ...(project !== undefined ? ['--project', project] : [])],
      ).finally(() => {
        this.statsReads.delete(key);
      });
      this.statsReads.set(key, read);
    }
    return read;
  }

  /**
   * Concurrent callers share one `helmraiser status` child rather than each
   * spawning one. A CLI found missing answers from memory for `MISSING_RECHECK_MS`.
   */
  status(): Promise<HelmraiserStatus> {
    if (this.missing !== null && this.now() - this.missing.at < MISSING_RECHECK_MS) {
      return Promise.reject(this.missing.error);
    }
    this.statusRead ??= this.readStatus().finally(() => {
      this.statusRead = null;
    });
    return this.statusRead;
  }

  private async readStatus(): Promise<HelmraiserStatus> {
    try {
      const status = await this.runner<HelmraiserStatus>(['status', '--json']);
      this.missing = null;
      setBackend('helmraiser', 'up');
      return status;
    } catch (error) {
      if (error instanceof Error && wireErrorCode(error) === UNAVAILABLE_CODES.helmraiser) {
        this.missing = { at: this.now(), error };
        setBackend('helmraiser', 'not_installed');
        if (!this.missingLogged) {
          this.missingLogged = true;
          this.warn(`[helmraiser] not installed (${messageOf(error)}): the Helmraiser view is off; looking again every ${MISSING_RECHECK_MS / 1000} s`);
        }
      } else {
        this.missing = null;
        setBackend('helmraiser', 'down');
      }
      throw error;
    }
  }

  /** List scout-created drafts without treating the read as a guarded action. */
  allDrafts(): Promise<HelmraiserScoutedDraft[]> {
    return this.runner(['drafts', '--all', '--json']);
  }

  scoutSettings(): Promise<HelmraiserScoutSettings> {
    return this.runner(['drafts', 'settings', '--json']);
  }

  setScoutSettings(update: HelmraiserScoutSettingsUpdate): Promise<HelmraiserScoutSettings> {
    return this.action(['drafts', 'settings', 'set', update.lens,
      ...(update.auto !== undefined ? ['--auto', update.auto ? 'on' : 'off'] : []),
      ...(update.cooldownHours !== undefined ? ['--cooldown-hours', String(update.cooldownHours)] : []), '--json']);
  }

  resetScoutSettings(lens: HelmraiserScoutLens): Promise<HelmraiserScoutSettings> {
    return this.action(['drafts', 'settings', 'reset', lens, '--json']);
  }

  drafts(): Promise<HelmraiserScoutedDraft[]> {
    return this.runner<HelmraiserScoutedDraft[]>(['drafts', '--json']);
  }

  /**
   * A run's last ledger events from `helmraiser log --json`, a read like `status`.
   * `sinceId` returns only the events after it, for following a running run.
   */
  async log(runId: string, sinceId?: number): Promise<HelmraiserLogResult> {
    const args = ['log', runId, '--json'];
    if (sinceId !== undefined) args.push('--since-id', String(sinceId));
    const { lines, total } = await this.runner<HelmraiserLines>(args, { tailLines: HELMRAISER_LOG_LIMIT });
    return parseHelmraiserLog(lines, total);
  }

  requestScouts(projects: string[], lens?: HelmraiserScoutLens): Promise<HelmraiserRequestScoutsResult> {
    return this.action(['drafts', 'request', ...projects, ...(lens !== undefined ? ['--lens', lens] : []), '--json']);
  }

  cancelScouts(projects: string[], lens?: HelmraiserScoutLens): Promise<HelmraiserCancelScoutsResult> {
    return this.action(['drafts', 'request', '--cancel', ...projects, ...(lens !== undefined ? ['--lens', lens] : []), '--json']);
  }

  /** Approve a merge or plan; a whitespace-only note counts as no note. */
  approve(runId: string, note?: string): Promise<Record<string, unknown>> {
    const args = ['approve', runId, '--json'];
    if (note?.trim()) args.push('--note', note);
    return this.action(args, { timeoutMs: 120_000 });
  }

  /** Reject a finished run; a whitespace-only note counts as no note. */
  reject(runId: string, note?: string): Promise<Record<string, unknown>> {
    const args = ['reject', runId, '--json'];
    if (note?.trim()) args.push('--note', note);
    return this.action(args);
  }

  startWorker(): Promise<Record<string, unknown>> {
    return this.action(['worker', 'start', '--json']);
  }

  stopWorker(): Promise<Record<string, unknown>> {
    return this.action(['worker', 'stop', '--json']);
  }

  pause(): Promise<Record<string, unknown>> {
    return this.action(['queue', 'pause', '--json', '--reason', 'paused from FunkyOctopus']);
  }

  resume(): Promise<Record<string, unknown>> {
    return this.action(['queue', 'resume', '--json']);
  }

  /** Write a task draft with `helmraiser add`; the goal text is the last positional. */
  draft(project: string, title: string, text: string): Promise<HelmraiserDraftResult> {
    return this.action(['add', '--project', project, '--title', title, text, '--json']);
  }

  /** Ask intake for a proposal; the model can take a couple of minutes. */
  propose(path: string): Promise<HelmraiserProposalResult> {
    return this.action(['intake', path, '--propose', '--json'], { timeoutMs: 300_000 });
  }

  /** Queue exactly the drafted+proposed file, without asking the model again. */
  queue(path: string, origin?: string): Promise<HelmraiserQueueResult> {
    const args = ['intake', path, '--yes'];
    if (origin !== undefined) args.push('--origin', origin);
    args.push('--json');
    return this.action(args, { timeoutMs: 120_000 });
  }

  /** Drop one draft ledger entry while preserving Helmraiser as the state owner. */
  dropDraft(taskId: string, reason: string, dropClass?: HelmraiserDropClass): Promise<Record<string, unknown>> {
    return this.action(['drafts', 'drop', taskId, '--reason', reason, ...(dropClass ? ['--class', dropClass] : []), '--json']);
  }

  /** Take one queued task back to draft; the task file is untouched. */
  queueRemove(taskId: string): Promise<Record<string, unknown>> {
    return this.action(['queue', 'remove', taskId, '--json']);
  }

  /** Hand a failed run back to the worker; `implement` resumes at implement, not verify. */
  retry(runId: string, implement = false): Promise<HelmraiserRetryResult> {
    return this.action(['retry', runId, ...(implement ? ['--implement'] : []), '--json']);
  }

  /**
   * Hand a run awaiting merge back to the worker with feedback, a rebase, or both.
   * Helmraiser refuses a call with neither, so the caller supplies at least one.
   */
  rework(runId: string, note?: string, rebase = false): Promise<HelmraiserReworkResult> {
    return this.action([
      'rework', runId,
      ...(note !== undefined ? ['--note', note] : []),
      ...(rebase ? ['--rebase'] : []),
      '--json',
    ]);
  }

  /** Every action passes the guard before anything is spawned. */
  private async action<T>(args: string[], options?: RunHelmraiserJsonOptions): Promise<T> {
    if (this.beforeSpawn) await this.beforeSpawn(args);
    return this.runner<T>(args, options);
  }
}
