/** Explicit, re-runnable Claude SDK promotion. All effects are injected; imports are inert. */
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SDK_PACKAGE, productionClaudeSdkDriftDeps, readClaudeCliVersion, sdkVersionForCli } from '../server/src/upkeep/claude-sdk-drift.ts';
import { nodeSpawn, runCommand, type CommandOutcome, type RunCommandOptions } from '../server/src/upkeep/run-command.ts';
import { probeSidecar, sidecarAddressFromEnv } from '../server/src/upkeep/sidecar-probe.ts';
import { exactStableString } from '../server/src/upkeep/versions.ts';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const TOUCHED_FILES = ['package.json', 'package-lock.json'] as const;
const BINARY_PACKAGE = '@anthropic-ai/claude-agent-sdk-linux-x64';
const STUB_OVERRIDE = 'file:./stubs/no-claude-binary';
const RESTORE_ARGS = ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...TOUCHED_FILES];
const RECOVERY = 'git restore --source=HEAD --staged --worktree -- package.json package-lock.json && npm ci';
export const USAGE = [
  'usage: npm run promote:claude-sdk [-- --to <version>]',
  'Align the exact-pinned Agent SDK with the installed CLI, or use stable latest.',
  'Refuses a dirty tree or live sidecar. Only hermetic verification is automatic:',
  'npm run verify, then commit. The owner runs the live Claude canary interactively.',
  'Failures restore package.json/package-lock.json from HEAD and run npm ci.',
].join('\n');

type ParsedArgs = { kind: 'run'; to: string | null } | { kind: 'help' } | { kind: 'usage'; message: string };
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg !== '--to') return { kind: 'usage', message: `unknown argument "${arg ?? ''}"` };
    const value = argv[++i];
    if (value === undefined || value.startsWith('-')) return { kind: 'usage', message: '--to needs a version' };
    to = exactStableString(value);
    if (to === null) return { kind: 'usage', message: '--to wants an exact stable version (x.y.z)' };
  }
  return { kind: 'run', to };
}

export interface CandidateDeps {
  readCliVersion: () => Promise<string | null>;
  readPublishedVersion: (version: string) => Promise<string | null>;
  readLatest: () => Promise<string | null>;
}
export async function selectCandidate(to: string | null, deps: CandidateDeps): Promise<string | null> {
  if (to !== null) return exactStableString(to);
  try {
    const cli = await deps.readCliVersion();
    const paired = cli === null ? null : sdkVersionForCli(cli);
    if (paired !== null && await deps.readPublishedVersion(paired) === paired) return paired;
  } catch { /* A missing pairing is not a reason to skip the latest fallback. */ }
  try {
    const latest = await deps.readLatest();
    return latest === null ? null : exactStableString(latest);
  } catch {
    return null;
  }
}

type BoundedRunner = (options: RunCommandOptions) => Promise<CommandOutcome>;
export async function readNpmSdkVersion(candidate: string | null, run: BoundedRunner): Promise<string | null> {
  try {
    const args = candidate === null
      ? ['view', CLAUDE_SDK_PACKAGE, 'dist-tags.latest', '--json']
      : ['view', `${CLAUDE_SDK_PACKAGE}@${candidate}`, 'version', '--json'];
    const result = await run({ command: 'npm', args, timeoutMs: 30_000, maxOutputBytes: 4096 });
    if (result.kind !== 'exit' || result.code !== 0 || result.facts.droppedBytes > 0) return null;
    const value: unknown = JSON.parse(result.facts.stdout);
    return typeof value === 'string' ? exactStableString(value) : null;
  } catch {
    return null;
  }
}

export interface CaptureResult { code: number | null; stdout: string; stderr: string }
export interface PromoteDeps extends CandidateDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stream: (command: string, args: readonly string[], cwd: string) => Promise<number | null>;
  capture: (command: string, args: readonly string[], cwd: string) => Promise<CaptureResult>;
  readFile: (path: string) => Promise<string>;
  realpath: (path: string) => Promise<string>;
  probeSidecar: (host: string, port: number) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function manifest(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return record(parsed);
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function versionOf(pkg: Record<string, unknown>): string | null {
  return typeof pkg.version === 'string' ? exactStableString(pkg.version) : null;
}
function pinOf(pkg: Record<string, unknown>): string | null {
  const pin = record(pkg.dependencies)[CLAUDE_SDK_PACKAGE] ?? record(pkg.devDependencies)[CLAUDE_SDK_PACKAGE];
  // A pin must itself be canonical, not a tag/range or whitespace-wrapped version.
  return typeof pin === 'string' && exactStableString(pin) === pin ? pin : null;
}
function requireOverride(pkg: Record<string, unknown>): void {
  if (record(pkg.overrides)[BINARY_PACKAGE] !== STUB_OVERRIDE) throw new Error('required no-claude-binary override is missing or changed');
}
export async function verifyStub(repo: string, deps: Pick<PromoteDeps, 'readFile' | 'realpath'>): Promise<void> {
  requireOverride(manifest(await deps.readFile(join(repo, 'package.json'))));
  const target = await deps.realpath(join(repo, 'node_modules', BINARY_PACKAGE));
  const stub = manifest(await deps.readFile(join(target, 'package.json')));
  if (stub.name !== 'no-claude-binary' || stub.version !== '0.0.0') {
    throw new Error('bundled binary override does not resolve to no-claude-binary@0.0.0');
  }
}

export async function promoteClaudeSdk(deps: PromoteDeps): Promise<number> {
  const parsed = parseArgs(deps.argv);
  if (parsed.kind === 'help') { deps.out(USAGE); return EXIT_OK; }
  if (parsed.kind === 'usage') { deps.err(`${parsed.message}\n${USAGE}`); return EXIT_USAGE; }

  // Preflight refusals never restore files or touch node_modules.
  let repo: string;
  let installed: string;
  let candidate: string;
  let assertStopped: () => Promise<void>;
  try {
    const top = await deps.capture('git', ['rev-parse', '--show-toplevel'], deps.cwd);
    repo = top.code === 0 ? top.stdout.trim() : '';
    if (!repo) throw new Error('not inside a git checkout');
    const status = await deps.capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], repo);
    if (status.code !== 0) throw new Error('git status failed');
    if (status.stdout.trim()) throw new Error('working tree is not clean (tracked or untracked changes)');
    const sidecar = sidecarAddressFromEnv(deps.env);
    if (!Number.isInteger(sidecar.port) || sidecar.port < 1 || sidecar.port > 65_535) throw new Error('SIDECAR_PORT is not a valid port');
    assertStopped = async () => {
      if (await deps.probeSidecar(sidecar.host, sidecar.port)) throw new Error(`a sidecar answers on ${sidecar.host}:${sidecar.port} — stop it before promoting`);
    };
    await assertStopped();
    const pkg = manifest(await deps.readFile(join(repo, 'package.json')));
    const pin = pinOf(pkg);
    const current = versionOf(manifest(await deps.readFile(join(repo, 'node_modules', CLAUDE_SDK_PACKAGE, 'package.json'))));
    if (!pin || !current || pin !== current) throw new Error('SDK baseline is missing, non-exact or mismatched — run npm ci first');
    installed = current;
    requireOverride(pkg);
    const selected = await selectCandidate(parsed.to, deps);
    if (!selected) throw new Error('could not read a stable SDK candidate; pass --to <version> to pin explicitly');
    candidate = selected;
    if (candidate === installed) {
      await verifyStub(repo, deps);
      deps.out(`promote:claude-sdk: already at ${installed}; nothing to do`);
      return EXIT_OK;
    }
    await assertStopped();
  } catch (error) {
    deps.err(`promote:claude-sdk: refused — ${messageOf(error)}`);
    return EXIT_FAILED;
  }

  deps.out(`promote:claude-sdk: ${installed} → ${candidate}`);
  try {
    // Enter before install: a failed install can already have changed both manifests.
    if (await deps.stream('npm', ['install', '--save-exact', `${CLAUDE_SDK_PACKAGE}@${candidate}`], repo) !== 0) throw new Error('npm install failed');
    const pin = pinOf(manifest(await deps.readFile(join(repo, 'package.json'))));
    const current = versionOf(manifest(await deps.readFile(join(repo, 'node_modules', CLAUDE_SDK_PACKAGE, 'package.json'))));
    if (pin !== candidate || current !== candidate) {
      throw new Error(`SDK install did not produce requested version ${candidate} (package.json pin: ${pin ?? 'missing'}, installed: ${current ?? 'missing'})`);
    }
    await verifyStub(repo, deps);
    if (await deps.stream('npm', ['run', 'verify'], repo) !== 0) throw new Error('npm run verify failed');
    if ((await deps.capture('git', ['add', '--', ...TOUCHED_FILES], repo)).code !== 0) throw new Error('git add failed');
    const commit = await deps.capture('git', ['commit', '--no-verify', '-m', `chore(deps): claude agent sdk ${candidate}`], repo);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  } catch (error) {
    deps.err(`promote:claude-sdk: ${messageOf(error)} — restoring manifests and running npm ci`);
    try {
      if ((await deps.capture('git', RESTORE_ARGS, repo)).code !== 0) throw new Error('restore failed', { cause: error });
      if (await deps.stream('npm', ['ci'], repo) !== 0) throw new Error('npm ci failed', { cause: error });
    } catch (rollbackError) {
      deps.err(`promote:claude-sdk: ROLLBACK INCOMPLETE (${messageOf(rollbackError)}) — finish by hand: ${RECOVERY}`);
    }
    return EXIT_FAILED;
  }
  deps.out(`promote:claude-sdk: committed chore(deps): claude agent sdk ${candidate}`);
  deps.out('Owner-run next step (not executed): npx vitest run --config vitest.runtime.config.ts server/src/runtime/claude-code.runtime.test.ts');
  deps.out('Re-record session-transcript fixtures: server/src/claude-code/session-transcript.ts reads SDK fields not declared by its types.');
  return EXIT_OK;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function streamCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
}
async function captureCommand(command: string, args: readonly string[], cwd: string, run: BoundedRunner): Promise<CaptureResult> {
  const result = await run({ command, args: [...args], cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  return { code: result.kind === 'exit' && result.facts.droppedBytes === 0 ? result.code : null,
    stdout: result.facts.stdout, stderr: result.facts.stderr };
}
export function productionDeps(argv: readonly string[], env: NodeJS.ProcessEnv): PromoteDeps {
  const run: BoundedRunner = (options) => runCommand({ spawn: nodeSpawn }, { ...options, env });
  const cliDeps = productionClaudeSdkDriftDeps(env, env.npm_package_version ?? 'unknown');
  return { argv, env, cwd: process.cwd(),
    stream: (command, args, cwd) => streamCommand(command, args, cwd, env),
    capture: (command, args, cwd) => captureCommand(command, args, cwd, run),
    readFile: (path) => readFile(path, 'utf8'), realpath, probeSidecar,
    readCliVersion: () => readClaudeCliVersion(cliDeps),
    readPublishedVersion: (candidate) => readNpmSdkVersion(candidate, run),
    readLatest: () => readNpmSdkVersion(null, run),
    out: (line) => console.log(line), err: (line) => console.error(line) };
}
const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  void promoteClaudeSdk(productionDeps(process.argv.slice(2), process.env)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`promote:claude-sdk failed — ${messageOf(error)}`); process.exitCode = EXIT_FAILED; },
  );
}
