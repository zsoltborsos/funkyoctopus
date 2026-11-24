import { execFile } from 'node:child_process';
import { setBackend, trackBackend } from '../health.ts';

/** What running `lb` produced. Injectable so tests need no store or CLI. */
export interface LbInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

export type LbCliRunner = (args: string[]) => Promise<LbInvocation>;

/** Bound a wedged CLI without putting it on a model turn's critical path. */
export const LB_TIMEOUT_MS = 20_000;

/** Shell conventions, so a caller can tell "no `lb`" and "too slow" from an ordinary failure. */
export const LB_NOT_FOUND = 127;
export const LB_TIMED_OUT = 124;

/**
 * FO is never an agent session: its reads must not borrow one's identity from
 * the sidecar's environment and move that session's cursor (as Helmraiser's own
 * reads strip it). Callers name FO's identity with flags where it matters.
 */
function lbEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LEEBOARD_SESSION;
  delete env.LEEBOARD_HARNESS;
  return env;
}

/**
 * The `lb` runner over `exec` (the process boundary). Leeboard is optional: a
 * missing `lb` is marked on the status strip as `not_installed` and said once
 * per process, however often the panel, the project list or a turn's end asks
 * again. Once `lb` answers (even with a failure), the mark is dropped.
 */
export function createLbRunner(
  exec: typeof execFile = execFile,
  warn: (message: string) => void = console.warn,
): LbCliRunner {
  let missingLogged = false;
  return (args) =>
    new Promise((resolve) => {
      exec(
        'lb',
        args,
        { timeout: LB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: lbEnv() },
        (error, stdout, stderr) => {
          // Resolved, never rejected: missing commands and non-zero exits are values.
          const raw = error as (Error & { code?: unknown; killed?: boolean }) | null;
          const code = !raw
            ? 0
            : typeof raw.code === 'number'
              ? raw.code
              : raw.code === 'ENOENT'
                ? LB_NOT_FOUND
                : raw.killed
                  ? LB_TIMED_OUT
                  : 1;
          if (code === LB_NOT_FOUND) {
            setBackend('leeboard', 'not_installed');
            if (!missingLogged) {
              missingLogged = true;
              warn("[leeboard] lb is not installed (not found on PATH): the Leeboard panel and Leeboard's project list are off");
            }
          } else {
            trackBackend('leeboard', false);
          }
          resolve({ code, stdout, stderr });
        },
      );
    });
}

export const defaultLbRunner: LbCliRunner = createLbRunner();
