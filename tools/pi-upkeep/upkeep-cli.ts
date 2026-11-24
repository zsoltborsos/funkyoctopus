/**
 * Production entry for `npm run upkeep:embedded`.
 *
 * Thin binding: wires real node fs, the real repository lock liveness probe,
 * read-only git top-level resolution, and the production preflight/promote/
 * canary/recover bindings into the pure injected coordinator (cli.ts), then
 * runs the parsed `process.argv` once and sets `process.exitCode`. The entry
 * never forces `process.exit`: a promotion whose live canary may still be
 * running retains the repository lock, and the process must be allowed to
 * keep its handles until it exits naturally (or is terminated by the
 * operator — the retained owner metadata is then reclaimed only after the
 * recorded pid is proven dead; there is no force bypass).
 *
 * The static import graph stays SDK-free: the embedded pi SDK is evaluated
 * only inside the production canary's `createChat`, after the candidate
 * install. This module performs no I/O at import time; the direct-run guard
 * below keeps the module inert when imported (the module-order probe imports
 * it and constructs the production deps without running a command).
 *
 * The sidecar itself takes no lock; the only thing keeping a promotion or
 * recovery from mutating `node_modules` under a live server is the sidecar
 * liveness probe (`server/src/upkeep/sidecar-probe.ts`, shared with
 * `scripts/promote-pi.ts`) — a bounded TCP connect to `SIDECAR_HOST:SIDECAR_PORT`
 * (defaults mirror `server/src/config.ts`: 127.0.0.1:14787).
 */

import { chmod, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionRunCanary } from './canary.ts';
import { MAX_REASON_BYTES, boundedReason } from './bounded-reason.ts';
import { runUpkeepCommand, type RepoResolution, type UpkeepCommandDeps } from './cli.ts';
import { probeProcess } from './lock.ts';
import { GIT_READ_TIMEOUT_MS, productionPreflight } from './preflight.ts';
import { productionPromote } from './promote.ts';
import { productionRecover } from './recover.ts';
import { nodeSpawn, runCommand } from '../../server/src/upkeep/run-command.ts';
import { probeSidecar, sidecarAddressFromEnv } from '../../server/src/upkeep/sidecar-probe.ts';
import { defaultStateRoot, type CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';

const fs: CoordinationFsOps = {
  mkdir,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile,
  realpath,
  readdir,
  chmod,
  stat,
  rename,
  unlink,
  rmdir,
};

/**
 * Read-only git top-level resolution: `git rev-parse --show-toplevel` from
 * the invoking cwd, canonicalized through realpath. npm runs the script from
 * the repository root, but a user may invoke it from a subdirectory; the
 * canonical top-level keeps every supported invocation on the same repo. The
 * command output is bounded by runCommand and never printed — only a short
 * refusal message surfaces.
 */
export function productionGitTopLevel(cwd: string): Promise<RepoResolution> {
  return runCommand(
    { spawn: nodeSpawn },
    {
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      timeoutMs: GIT_READ_TIMEOUT_MS,
      cwd,
    },
  ).then(async (outcome) => {
    if (outcome.kind !== 'exit' || outcome.code !== 0) {
      return { kind: 'error', message: 'could not read the git repository root (is this a git checkout?)' };
    }
    const raw = outcome.facts.stdout.trim();
    if (raw === '') return { kind: 'error', message: 'git reported an empty repository root' };
    try {
      const repo = await realpath(raw);
      return { kind: 'ok', repo };
    } catch (error) {
      return {
        kind: 'error',
        message: `could not resolve the repository path: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

/** Production binding of every injected seam; inert until invoked. */
export function productionUpkeepDeps(argv: readonly string[], env: NodeJS.ProcessEnv): UpkeepCommandDeps {
  const stateRoot = defaultStateRoot(env.XDG_STATE_HOME, homedir);
  const deps: UpkeepCommandDeps = {
    argv,
    disabled: env.FUNKYOCTOPUS_UPKEEP_DISABLED === '1',
    fs,
    probe: probeProcess,
    sidecar: { ...sidecarAddressFromEnv(env), probe: probeSidecar },
    pid: process.pid,
    host: osHostname(),
    cwd: process.cwd(),
    stateRoot,
    runGitTopLevel: productionGitTopLevel,
    runPreflight: (repo) => productionPreflight(repo)(),
    runPromote: (opts) => productionPromote(opts),
    runCanary: productionRunCanary,
    runRecover: (opts) => productionRecover(opts),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
  return deps;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return runUpkeepCommand(productionUpkeepDeps(argv, env));
}

// Direct-run guard: the module is inert when imported (the module-order probe
// imports it and constructs the production deps without executing a command).
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  void main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        boundedReason(
          `upkeep:embedded failed — ${error instanceof Error ? error.message : String(error)}`,
          MAX_REASON_BYTES,
        ),
      );
      process.exitCode = 1;
    },
  );
}
