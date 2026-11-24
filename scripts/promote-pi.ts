/**
 * Embedded-pi promotion script — `npm run promote:pi [-- --to <version>]`.
 *
 * The re-runnable replacement for the quarantined `tools/pi-upkeep` engine's
 * `--promote` (CURRENT_STATE.md decision 1): git is the journal, the gates are
 * the verdict, and nothing is written anywhere but the working tree.
 *
 *   refuse on a dirty tree or a live sidecar
 *   → `npm install --save-exact @earendil-works/pi-coding-agent@<candidate>`
 *   → `npm run verify` → `npm run test:runtime`
 *   → `git commit -m "chore(deps): embedded pi <candidate>"`
 *
 * Any failure after the install restores `package.json`/`package-lock.json`
 * from HEAD and runs `npm ci`, so the tree is back where it started and the
 * script can simply be run again. Re-running after a successful promotion is
 * a no-op ("already at <candidate>").
 *
 * Everything effectful is injected (`PromoteDeps`) so the decision sequence is
 * tested hermetically (`promote-pi.test.ts`); the production binding at the
 * bottom wires node's spawn, the shared sidecar probe and the stable-latest
 * registry reader, and runs only when this file is the entrypoint.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDED_SDK_PACKAGE, productionReadStableLatest } from '../server/src/upkeep/detect.ts';
import { probeSidecar, sidecarAddressFromEnv } from '../server/src/upkeep/sidecar-probe.ts';
import { compareStableVersions, exactStableString } from '../server/src/upkeep/versions.ts';

/** Exit codes: 0 promoted or nothing to do; 1 refused or failed (tree restored); 2 usage. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The two files a promotion touches; restored verbatim from HEAD on failure. */
export const TOUCHED_FILES = ['package.json', 'package-lock.json'] as const;

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface PromoteDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Long gate commands stream straight to the terminal; only the exit code comes back. */
  stream(command: string, args: readonly string[], cwd: string): Promise<number | null>;
  /** Short, quiet commands (git status, git commit, version reads). */
  capture(command: string, args: readonly string[], cwd: string): Promise<CaptureResult>;
  readFile(path: string): Promise<string>;
  /** `npm view <sdk> dist-tags.latest` through the sidecar's own bounded reader. */
  readLatest(): Promise<string | null>;
  probeSidecar(host: string, port: number): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = [
  'usage: npm run promote:pi [-- --to <version>]',
  '',
  'Promote the embedded pi SDK to the registry `latest` (or an explicit exact',
  'version), gated by `npm run verify` and `npm run test:runtime`, and commit',
  'the pin. Refuses on a dirty tree or a live sidecar; restores',
  'package.json/package-lock.json and runs `npm ci` on any failure.',
].join('\n');

type ParsedArgs = { kind: 'run'; to: string | null } | { kind: 'help' } | { kind: 'usage'; message: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let to: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--to') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) return { kind: 'usage', message: '--to needs a version' };
      if (exactStableString(value) === null) {
        return { kind: 'usage', message: `--to wants an exact stable version (x.y.z), got "${value}"` };
      }
      to = exactStableString(value);
      index += 1;
      continue;
    }
    return { kind: 'usage', message: `unknown argument "${arg ?? ''}"` };
  }
  return { kind: 'run', to };
}

function versionOf(packageJsonText: string): string | null {
  try {
    const parsed = JSON.parse(packageJsonText) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function pinOf(packageJsonText: string): string | null {
  try {
    const parsed = JSON.parse(packageJsonText) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const pin = parsed.dependencies?.[EMBEDDED_SDK_PACKAGE] ?? parsed.devDependencies?.[EMBEDDED_SDK_PACKAGE];
    return typeof pin === 'string' ? pin : null;
  } catch {
    return null;
  }
}

/** One decision sequence, start to finish; returns the process exit code. */
export async function promotePi(deps: PromoteDeps): Promise<number> {
  const parsed = parseArgs(deps.argv);
  if (parsed.kind === 'help') {
    deps.out(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === 'usage') {
    deps.err(`promote:pi: ${parsed.message}\n${USAGE}`);
    return EXIT_USAGE;
  }

  // Repository root, so every invocation (root or subdirectory) acts on the same tree.
  const top = await deps.capture('git', ['rev-parse', '--show-toplevel'], deps.cwd);
  const repo = top.code === 0 ? top.stdout.trim() : '';
  if (!repo) {
    deps.err('promote:pi: not inside a git checkout');
    return EXIT_FAILED;
  }

  // Baseline: package.json pin and the installed copy must agree before anything moves.
  const pin = pinOf(await deps.readFile(join(repo, 'package.json')).catch(() => ''));
  const installed = versionOf(
    await deps.readFile(join(repo, 'node_modules', EMBEDDED_SDK_PACKAGE, 'package.json')).catch(() => ''),
  );
  if (!pin || !installed) {
    deps.err(
      `promote:pi: cannot read the embedded pi baseline (package.json pin: ${pin ?? 'none'}, installed: ${installed ?? 'none'}) — run \`npm ci\` and retry`,
    );
    return EXIT_FAILED;
  }
  if (pin !== installed) {
    deps.err(
      `promote:pi: package.json pins ${EMBEDDED_SDK_PACKAGE}@${pin} but node_modules holds ${installed} — run \`npm ci\` first`,
    );
    return EXIT_FAILED;
  }

  // Candidate: explicit --to, else the registry's stable latest.
  let candidate = parsed.to;
  if (candidate === null) {
    const latest = await deps.readLatest();
    candidate = latest === null ? null : exactStableString(latest);
    if (candidate === null) {
      deps.err('promote:pi: could not read a stable `latest` for the embedded pi SDK from the registry (pass --to <version> to pin explicitly)');
      return EXIT_FAILED;
    }
    if ((compareStableVersions(candidate, installed) ?? 0) < 0) {
      deps.out(`promote:pi: installed ${installed} is ahead of registry latest ${candidate}; nothing to do (use --to to pin explicitly)`);
      return EXIT_OK;
    }
  }
  if (candidate === installed) {
    deps.out(`promote:pi: already at ${EMBEDDED_SDK_PACKAGE}@${installed}; nothing to do`);
    return EXIT_OK;
  }

  // Refusals — a clean tree so the gates judge exactly what gets committed, and
  // no sidecar so node_modules is not swapped under a live server.
  const status = await deps.capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], repo);
  if (status.code !== 0) {
    deps.err('promote:pi: `git status` failed; refusing to continue');
    return EXIT_FAILED;
  }
  if (status.stdout.trim() !== '') {
    deps.err(
      'promote:pi: working tree is not clean (tracked or untracked changes) — commit, stash or remove them first.\n' +
        '  If a previous promotion was interrupted: `git checkout -- package.json package-lock.json && npm ci`',
    );
    return EXIT_FAILED;
  }
  const sidecar = sidecarAddressFromEnv(deps.env);
  if (!Number.isInteger(sidecar.port) || sidecar.port < 1 || sidecar.port > 65_535) {
    deps.err(`promote:pi: SIDECAR_PORT is not a valid port (${deps.env.SIDECAR_PORT ?? ''}); refusing to guess`);
    return EXIT_FAILED;
  }
  if (await deps.probeSidecar(sidecar.host, sidecar.port)) {
    deps.err(`promote:pi: a sidecar answers on ${sidecar.host}:${sidecar.port} — stop it before promoting`);
    return EXIT_FAILED;
  }

  deps.out(`promote:pi: ${EMBEDDED_SDK_PACKAGE} ${installed} → ${candidate}`);

  const rollback = async (failedStep: string): Promise<number> => {
    deps.err(`promote:pi: ${failedStep} failed — restoring ${TOUCHED_FILES.join(' + ')} and running npm ci`);
    const restore = await deps.capture('git', ['checkout', '--', ...TOUCHED_FILES], repo);
    const reinstall = restore.code === 0 ? await deps.stream('npm', ['ci'], repo) : null;
    if (restore.code !== 0 || reinstall !== 0) {
      deps.err(
        'promote:pi: ROLLBACK INCOMPLETE — finish it by hand: `git checkout -- package.json package-lock.json && npm ci`',
      );
    } else {
      deps.err(`promote:pi: rolled back to ${installed}; the tree is clean again (re-run after fixing the cause)`);
    }
    return EXIT_FAILED;
  };

  const install = await deps.stream('npm', ['install', '--save-exact', `${EMBEDDED_SDK_PACKAGE}@${candidate}`], repo);
  if (install !== 0) return rollback('npm install');

  const verify = await deps.stream('npm', ['run', 'verify'], repo);
  if (verify !== 0) return rollback('npm run verify');

  const runtime = await deps.stream('npm', ['run', 'test:runtime'], repo);
  if (runtime !== 0) return rollback('npm run test:runtime');

  const add = await deps.capture('git', ['add', '--', ...TOUCHED_FILES], repo);
  if (add.code !== 0) return rollback('git add');
  // The pre-commit hook is `npm run verify`, which just passed on this exact
  // tree; skipping it here avoids a second ≈45 s run of the same gate.
  const commit = await deps.capture(
    'git',
    ['commit', '--no-verify', '-m', `chore(deps): embedded pi ${candidate}`],
    repo,
  );
  if (commit.code !== 0) {
    deps.err(commit.stderr.trim() || commit.stdout.trim());
    return rollback('git commit');
  }

  deps.out(`promote:pi: committed "chore(deps): embedded pi ${candidate}" (pre-commit hook skipped: verify already ran on this tree)`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Production binding — inert when imported.
// ---------------------------------------------------------------------------

function streamCommand(command: string, args: readonly string[], cwd: string): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code));
  });
}

function captureCommand(command: string, args: readonly string[], cwd: string): Promise<CaptureResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export function productionDeps(argv: readonly string[], env: NodeJS.ProcessEnv): PromoteDeps {
  return {
    argv,
    env,
    cwd: process.cwd(),
    stream: streamCommand,
    capture: captureCommand,
    readFile: (path) => readFile(path, 'utf8'),
    readLatest: productionReadStableLatest(),
    probeSidecar,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  void promotePi(productionDeps(process.argv.slice(2), process.env)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`promote:pi failed — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT_FAILED;
    },
  );
}
