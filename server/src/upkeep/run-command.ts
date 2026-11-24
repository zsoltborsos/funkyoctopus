/**
 * Bounded injectable command-runner seam.
 *
 * Promotion and recovery run npm, git, and build commands. This seam wraps
 * `spawn` behind an injected function so hermetic tests never run a real
 * command, and enforces the bounded-output and strict-timeout contract:
 * stdout and stderr tails are retained per stream while data arrives (via
 * the shared TailBuffer), the returned log is bounded, a timeout escalates
 * SIGTERM -> SIGKILL after a grace period, and every settle path clears the
 * timeout/grace timers and detaches the external abort listener. The
 * outcome carries exit, signal, and error facts; the caller decides what a
 * nonzero exit means.
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { messageOf } from '../util/errors.ts';
import { TailBuffer } from './upkeep.ts';

/** Default per-stream retained output ceiling. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
/** Grace between SIGTERM and SIGKILL once a timeout fires. */
export const DEFAULT_KILL_GRACE_MS = 1_000;

/** The minimal child surface runCommand needs; a fake satisfies it in tests. */
export interface CommandChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => CommandChild;

/** The production binding: node's own spawn satisfies the minimal surface. */
export function nodeSpawn(command: string, args: string[], options: SpawnOptions): CommandChild {
  return spawn(command, args, options);
}

export interface CommandRunFacts {
  /** Retained tail of stdout. */
  stdout: string;
  /** Retained tail of stderr. */
  stderr: string;
  /** Bounded combined log of both streams in arrival order. */
  log: string;
  /** Bytes dropped because they exceeded the retained ceiling. */
  droppedBytes: number;
}

export type CommandOutcome =
  | { kind: 'exit'; code: number | null; signal: string | null; facts: CommandRunFacts }
  | { kind: 'terminated'; reason: 'timeout' | 'aborted'; facts: CommandRunFacts }
  | { kind: 'error'; message: string; code: string | undefined; facts: CommandRunFacts };

export interface RunCommandOptions {
  command: string;
  args: string[];
  /** Hard ceiling; the child is SIGTERM'd, then SIGKILL'd after the grace period. */
  timeoutMs: number;
  /** Per-stream retained output ceiling. */
  maxOutputBytes?: number;
  /** Grace between SIGTERM and SIGKILL after a timeout. */
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** External cancellation; the child is terminated like a timeout. */
  signal?: AbortSignal;
}

export interface RunCommandDeps {
  spawn: SpawnFn;
}

export function runCommand(deps: RunCommandDeps, options: RunCommandOptions): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    let child: CommandChild;
    try {
      child = deps.spawn(options.command, options.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    } catch (error) {
      resolve({
        kind: 'error',
        message: messageOf(error),
        code: codeOf(error),
        facts: emptyFacts(),
      });
      return;
    }

    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const stdout = new TailBuffer(maxOutputBytes);
    const stderr = new TailBuffer(maxOutputBytes);
    const log = new TailBuffer(maxOutputBytes);
    let droppedBytes = 0;
    const push = (stream: TailBuffer, chunk: Buffer): void => {
      const before = stream.byteLength;
      stream.push(chunk);
      droppedBytes += Math.max(0, chunk.length - (stream.byteLength - before));
      log.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => push(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => push(stderr, chunk));

    let settled = false;
    let terminated: 'timeout' | 'aborted' | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);

    const facts = (): CommandRunFacts => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      log: log.toString(),
      droppedBytes,
    });

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      detachAbort();
      resolve(outcome);
    };

    const detachAbort = (): void => {
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
    };

    const terminate = (reason: 'timeout' | 'aborted'): void => {
      // First termination reason wins; repeated calls must not overwrite the
      // reason or leak a second grace timer.
      if (settled || terminated !== null) return;
      terminated = reason;
      // Arm the SIGKILL escalation before SIGTERM so a child that closes
      // synchronously on SIGTERM still finds the timer cleared on settle.
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, killGraceMs);
      child.kill('SIGTERM');
    };

    const onAbort = (): void => {
      terminate('aborted');
    };

    // Register close/error before consulting a pre-aborted signal: a child
    // that closes synchronously on kill must always find its listeners.
    child.on('error', (error) => {
      finish({
        kind: 'error',
        message: messageOf(error),
        code: codeOf(error),
        facts: facts(),
      });
    });
    child.on('close', (code, signal) => {
      if (terminated !== null) {
        finish({ kind: 'terminated', reason: terminated, facts: facts() });
      } else {
        finish({ kind: 'exit', code, signal, facts: facts() });
      }
    });
    if (options.signal !== undefined) {
      if (options.signal.aborted) terminate('aborted');
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function emptyFacts(): CommandRunFacts {
  return { stdout: '', stderr: '', log: '', droppedBytes: 0 };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code !== undefined
    ? String((error as { code?: unknown }).code)
    : undefined;
}
