import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { nodeSpawn, runCommand, type SpawnFn } from '../upkeep/run-command.ts';

/** Retained stdout ceiling; `claude agents --json` is a few hundred bytes per session. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the configured `claude` to an absolute path, as `which` would: a
 * name with a slash is taken as that path, a bare name is searched through
 * `pathEnv`. The Agent SDK must always be handed this path (without it the
 * stubbed bundled binary fails loudly), and null means Claude Code is not
 * installed.
 */
export async function resolveClaudeBin(bin: string, pathEnv: string): Promise<string | null> {
  if (bin.includes('/')) {
    const path = resolve(bin);
    return (await isExecutableFile(path)) ? path : null;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const path = join(dir, bin);
    if (await isExecutableFile(path)) return path;
  }
  return null;
}

export interface ClaudeCliResult {
  exitCode: number;
  json: unknown;
}

export interface RunClaudeJsonOptions {
  /** The absolute path from `resolveClaudeBin`. */
  bin: string;
  /** The sanitized child environment (`claudeChildEnv`). */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  spawn?: SpawnFn;
}

/** Injectable runner so ClaudeCodeStatus tests never spawn a real `claude`. */
export type ClaudeJsonRunner = (args: string[], options: RunClaudeJsonOptions) => Promise<ClaudeCliResult>;

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs `claude <args>` and resolves its parsed stdout with the exit code. A
 * non-zero exit that still printed JSON resolves too: `claude auth status
 * --json` answers `{"loggedIn": false}` and exits 1, and the caller decides
 * what the exit means. Anything else is a typed rejection: the binary vanished
 * is `claude_unavailable`, unparseable output is `claude_bad_output`, and a
 * failed start, timeout or JSON-less failure is `claude_cli_error`.
 */
export async function runClaudeJson(
  args: string[],
  { bin, env, timeoutMs, spawn = nodeSpawn }: RunClaudeJsonOptions,
): Promise<ClaudeCliResult> {
  const outcome = await runCommand({ spawn }, { command: bin, args, timeoutMs, env, maxOutputBytes: MAX_OUTPUT_BYTES });
  const name = `claude ${args[0] ?? ''}`.trim();

  if (outcome.kind === 'error') {
    throw outcome.code === 'ENOENT'
      ? new WireCallError(`Claude Code not found: ${bin}`, 'claude_unavailable')
      : new WireCallError(`${name} failed to start: ${outcome.message}`, 'claude_cli_error');
  }
  if (outcome.kind === 'terminated') {
    throw new WireCallError(`${name} timed out after ${timeoutMs / 1000} s`, 'claude_cli_error');
  }

  const exitCode = outcome.code ?? -1;
  const parsed = parseJson(outcome.facts.stdout);
  if (parsed.ok) return { exitCode, json: parsed.value };
  if (exitCode === 0) {
    throw new WireCallError(`${name} did not produce JSON`, 'claude_bad_output');
  }
  throw new WireCallError(
    `${name} exited ${outcome.code ?? outcome.signal}: ${lastNonEmptyLine(outcome.facts.stderr)}`,
    'claude_cli_error',
  );
}
