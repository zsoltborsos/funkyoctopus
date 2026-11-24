import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSidecar } from '../server/src/upkeep/sidecar-probe.ts';
import { DEFAULT_SIDECAR_PORT } from '../src/shared/transport/protocol.ts';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceDeps {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  nodeVersion: string;
  homeDir: string;
  run(command: string, args: readonly string[], cwd: string): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  waitForHealth(): Promise<boolean>;
  /** One quick probe: does anything already answer on the service port? */
  portInUse(): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

const SERVICE = 'funkyoctopus.service';

const DEFAULT_PORT = DEFAULT_SIDECAR_PORT;
const PORT_TAKEN =
  `port ${DEFAULT_PORT} is already answering but funkyoctopus.service is not running; stop the other ` +
  'sidecar first (an old `npm run dev:all`?), or the health check would pass against it';
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** systemd expands `%` specifiers in most settings; a literal `%` is `%%`. */
function systemdLiteral(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`unit value contains a newline: ${JSON.stringify(value)}`);
  return value.replaceAll('%', '%%');
}

/** Quoting for ExecStart= and Environment=, which unquote; WorkingDirectory= does not. */
function systemdQuote(value: string): string {
  return `"${systemdLiteral(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function miseNodeLatest(value: string): string {
  return value.replace(
    /\/mise\/installs\/node\/(?!latest\/)[^/:\r\n]+(?=\/)/g,
    '/mise/installs/node/latest',
  );
}

export function renderUnit(deployDir: string, node: string, path: string, desktopNotifications = false): string {
  return `[Unit]
Description=FunkyOctopus agent cockpit
After=network.target

[Service]
WorkingDirectory=${systemdLiteral(deployDir)}
ExecStart=${systemdQuote(miseNodeLatest(node))} --import tsx server/src/entrypoint.ts
Environment=${systemdQuote(`PATH=${path.split(':').map(miseNodeLatest).join(':')}`)}
Environment=FUNKYOCTOPUS_SERVE_UI=1
Environment=SIDECAR_HOST=127.0.0.1
Environment=SIDECAR_PORT=${DEFAULT_PORT}
${desktopNotifications ? 'Environment=FUNKYOCTOPUS_DESKTOP_NOTIFY=1\n' : ''}Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

interface Options {
  deployDir: string;
  deployDirExplicit: boolean;
  ref?: string;
  removeCopy: boolean;
  node?: string;
  path?: string;
}

function parseOptions(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string,
): Options | string {
  const configuredDir = env.FUNKYOCTOPUS_DEPLOY_DIR;
  const defaultDir = configuredDir ?? join(homeDir, '.local', 'share', 'funkyoctopus', 'app');
  const options: Options = {
    deployDir: resolve(cwd, defaultDir),
    deployDirExplicit: configuredDir !== undefined,
    removeCopy: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--deploy-dir' || arg === '--node' || arg === '--path') {
      const value = args[index + 1];
      if (!value) return `${arg} needs a value`;
      if (arg === '--deploy-dir') {
        options.deployDir = resolve(cwd, value);
        options.deployDirExplicit = true;
      } else if (arg === '--node') options.node = value;
      else options.path = value;
      index += 1;
    } else if (arg === '--remove-copy' && command === 'uninstall') {
      options.removeCopy = true;
    } else if (arg?.startsWith('-')) {
      return `unknown option ${arg}`;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (command === 'deploy' || command === 'install') {
    if (positional.length > 1) return `${command} accepts at most one ref`;
    options.ref = positional[0] ?? 'master';
  } else if (positional.length > 0) {
    return `${command} does not accept positional arguments`;
  }
  if (command === 'render-unit' && (!options.deployDirExplicit || !options.node || options.path === undefined)) {
    return 'render-unit needs --deploy-dir, --node and --path';
  }
  return options;
}

async function commandOk(deps: ServiceDeps, command: string, args: readonly string[] = ['--version']): Promise<boolean> {
  return (await deps.run(command, args, deps.cwd)).code === 0;
}

/**
 * Cheap optional probe: is `notify-send` on the PATH this installer runs with?
 * Missing it is never an error — the unit just omits desktop notifications.
 */
function notifySendAvailable(deps: ServiceDeps): Promise<boolean> {
  return commandOk(deps, 'notify-send');
}

async function repoRoot(deps: ServiceDeps): Promise<string | null> {
  const result = await deps.run('git', ['rev-parse', '--show-toplevel'], deps.cwd);
  return result.code === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : null;
}

async function readOptional(deps: ServiceDeps, path: string): Promise<string | undefined> {
  try {
    return await deps.readFile(path);
  } catch {
    return undefined;
  }
}

async function writeUnit(deps: ServiceDeps, unitPath: string, content: string): Promise<boolean> {
  if ((await readOptional(deps, unitPath)) === content) return false;
  await deps.makeDir(dirname(unitPath));
  await deps.writeFile(unitPath, content);
  return true;
}

function unitPath(deps: ServiceDeps): string {
  return join(deps.homeDir, '.config', 'systemd', 'user', SERVICE);
}

function workingDirectoryFromUnit(content: string): string | undefined {
  const line = content.split('\n').find((candidate) => candidate.startsWith('WorkingDirectory='));
  if (line === undefined) return undefined;
  const value = line.slice('WorkingDirectory='.length);
  if (!value.startsWith('"') || !value.endsWith('"')) return value || undefined;
  let decoded = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length - 1) {
      index += 1;
      decoded += value[index];
    } else {
      decoded += character;
    }
  }
  return decoded || undefined;
}

async function recoverDeployDir(deps: ServiceDeps, options: Options): Promise<void> {
  if (options.deployDirExplicit) return;
  const existingUnit = await readOptional(deps, unitPath(deps));
  const deployedDir = existingUnit === undefined ? undefined : workingDirectoryFromUnit(existingUnit);
  if (deployedDir !== undefined) options.deployDir = resolve(deps.cwd, deployedDir);
}

async function install(deps: ServiceDeps, options: Options): Promise<number> {
  const major = Number(deps.nodeVersion.split('.')[0]);
  if (!Number.isInteger(major) || major < 26) {
    deps.err(`service:install: Node 26 or newer is required (running ${deps.nodeVersion})`);
    return EXIT_FAILED;
  }
  if (!(await commandOk(deps, 'git'))) {
    deps.err('service:install: git is required');
    return EXIT_FAILED;
  }
  if (!(await commandOk(deps, 'systemctl', ['--user', 'show-environment']))) {
    deps.err('service:install: systemctl --user is not reachable (Linux/systemd user instance required)');
    return EXIT_FAILED;
  }
  // Each tool's own cheap probe: neither helmraiser nor lb has a --version flag.
  // Without the pi CLI only the sidecar's global `pi update --all` is skipped.
  for (const [optional, args] of [['pi', ['--version']], ['helmraiser', ['version']], ['lb', ['--help']]] as const) {
    if (!(await commandOk(deps, optional, args))) deps.err(`service:install: warning: ${optional} is not on PATH; FunkyOctopus will degrade without it`);
  }

  const repo = await repoRoot(deps);
  if (repo === null) {
    deps.err('service:install: not inside a git checkout');
    return EXIT_FAILED;
  }
  const worktrees = await deps.run('git', ['worktree', 'list', '--porcelain'], repo);
  if (worktrees.code !== 0) {
    deps.err('service:install: could not inspect git worktrees');
    return EXIT_FAILED;
  }
  const deployed = worktrees.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
    .includes(options.deployDir);
  if (!deployed) {
    const add = await deps.run('git', ['worktree', 'add', '--detach', options.deployDir, options.ref ?? 'master'], repo);
    if (add.code !== 0) {
      deps.err(add.stderr.trim() || 'service:install: could not create deployed worktree');
      return EXIT_FAILED;
    }
  }
  if ((await deps.run('npm', ['ci'], options.deployDir)).code !== 0 ||
      (await deps.run('npm', ['run', 'build'], options.deployDir)).code !== 0) {
    deps.err('service:install: install or build failed');
    return EXIT_FAILED;
  }
  const wasActive = (await deps.run('systemctl', ['--user', 'is-active', '--quiet', SERVICE], deps.cwd)).code === 0;
  if (!wasActive && (await deps.portInUse())) {
    deps.err(`service:install: ${PORT_TAKEN}`);
    return EXIT_FAILED;
  }
  const content = renderUnit(
    options.deployDir,
    deps.env.npm_node_execpath || deps.execPath,
    deps.env.PATH ?? '',
    await notifySendAvailable(deps),
  );
  const unitChanged = await writeUnit(deps, unitPath(deps), content);
  if ((await deps.run('systemctl', ['--user', 'daemon-reload'], deps.cwd)).code !== 0 ||
      (await deps.run('systemctl', ['--user', 'enable', '--now', SERVICE], deps.cwd)).code !== 0) {
    deps.err('service:install: could not enable the systemd user service');
    return EXIT_FAILED;
  }
  if (unitChanged && wasActive &&
      (await deps.run('systemctl', ['--user', 'restart', SERVICE], deps.cwd)).code !== 0) {
    deps.err('service:install: changed unit was enabled but the active service could not be restarted');
    return EXIT_FAILED;
  }
  if (!(await deps.waitForHealth())) {
    deps.err('service:install: service did not become healthy; logs: journalctl --user -u funkyoctopus -f');
    return EXIT_FAILED;
  }
  deps.out(`FunkyOctopus is ready at http://127.0.0.1:${DEFAULT_PORT}`);
  deps.out('Deploy: npm run deploy');
  deps.out('Logs: journalctl --user -u funkyoctopus -f');
  deps.out('Uninstall: npm run service:uninstall');
  return EXIT_OK;
}

async function deploy(deps: ServiceDeps, options: Options): Promise<number> {
  const dirty = await deps.run('git', ['status', '--porcelain'], options.deployDir);
  if (dirty.code !== 0 || dirty.stdout.trim() !== '') {
    deps.err('deploy: deployed copy has uncommitted changes; refusing to continue');
    return EXIT_FAILED;
  }
  const beforeResult = await deps.run('git', ['rev-parse', 'HEAD'], options.deployDir);
  const before = beforeResult.stdout.trim();
  if (beforeResult.code !== 0 || !before) {
    deps.err('deploy: cannot read the deployed commit');
    return EXIT_FAILED;
  }
  const rollbackHint = (): void => deps.err(`Roll back with: npm run deploy -- ${before}`);
  const checkout = await deps.run('git', ['checkout', '--detach', options.ref ?? 'master'], options.deployDir);
  if (checkout.code !== 0) {
    deps.err(checkout.stderr.trim() || 'deploy: checkout failed');
    rollbackHint();
    return EXIT_FAILED;
  }
  const afterResult = await deps.run('git', ['rev-parse', 'HEAD'], options.deployDir);
  const after = afterResult.stdout.trim();
  const lockDiff = await deps.run('git', ['diff', '--quiet', before, after, '--', 'package-lock.json'], options.deployDir);
  if (lockDiff.code !== 0 && (await deps.run('npm', ['ci'], options.deployDir)).code !== 0) {
    deps.err('deploy: npm ci failed');
    rollbackHint();
    return EXIT_FAILED;
  }
  if ((await deps.run('npm', ['run', 'build'], options.deployDir)).code !== 0) {
    deps.err('deploy: build failed');
    rollbackHint();
    return EXIT_FAILED;
  }
  const changed = await writeUnit(
    deps,
    unitPath(deps),
    renderUnit(
      options.deployDir,
      deps.env.npm_node_execpath || deps.execPath,
      deps.env.PATH ?? '',
      await notifySendAvailable(deps),
    ),
  );
  if (changed && (await deps.run('systemctl', ['--user', 'daemon-reload'], deps.cwd)).code !== 0) {
    deps.err('deploy: systemd daemon-reload failed');
    rollbackHint();
    return EXIT_FAILED;
  }
  const active = (await deps.run('systemctl', ['--user', 'is-active', '--quiet', SERVICE], deps.cwd)).code === 0;
  if (!active && (await deps.portInUse())) {
    deps.err(`deploy: ${PORT_TAKEN}`);
    rollbackHint();
    return EXIT_FAILED;
  }
  if ((await deps.run('systemctl', ['--user', 'restart', SERVICE], deps.cwd)).code !== 0 ||
      !(await deps.waitForHealth())) {
    deps.err('deploy: restarted service did not become healthy');
    rollbackHint();
    return EXIT_FAILED;
  }
  deps.out(`deployed ${after.slice(0, 7)} (was ${before.slice(0, 7)})`);
  return EXIT_OK;
}

async function uninstall(deps: ServiceDeps, options: Options): Promise<number> {
  if ((await deps.run('systemctl', ['--user', 'disable', '--now', SERVICE], deps.cwd)).code !== 0) {
    deps.err('service:uninstall: could not disable and stop the systemd user service');
    return EXIT_FAILED;
  }
  try {
    await deps.removeFile(unitPath(deps));
  } catch (error) {
    deps.err(`service:uninstall: could not remove the unit: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  if ((await deps.run('systemctl', ['--user', 'daemon-reload'], deps.cwd)).code !== 0) {
    deps.err('service:uninstall: unit removed but systemd daemon-reload failed');
    return EXIT_FAILED;
  }
  if (options.removeCopy) {
    const repo = await repoRoot(deps);
    if (repo === null || (await deps.run('git', ['worktree', 'remove', options.deployDir], repo)).code !== 0) {
      deps.err('service:uninstall: service removed, but deployed worktree could not be removed');
      return EXIT_FAILED;
    }
  }
  deps.out(options.removeCopy ? 'FunkyOctopus service and deployed copy removed' : 'FunkyOctopus service removed; deployed copy kept');
  return EXIT_OK;
}

export const USAGE = 'usage: service.ts install|deploy|uninstall|render-unit [options]';

export async function serviceMain(deps: ServiceDeps): Promise<number> {
  const command = deps.argv[0];
  if (!command || !['install', 'deploy', 'uninstall', 'render-unit'].includes(command)) {
    deps.err(USAGE);
    return EXIT_USAGE;
  }
  const parsed = parseOptions(command, deps.argv.slice(1), deps.env, deps.homeDir, deps.cwd);
  if (typeof parsed === 'string') {
    deps.err(`service: ${parsed}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (command === 'render-unit') {
    deps.out(renderUnit(parsed.deployDir, parsed.node ?? '', parsed.path ?? ''));
    return EXIT_OK;
  }
  await recoverDeployDir(deps, parsed);
  if (command === 'install') return install(deps, parsed);
  if (command === 'deploy') return deploy(deps, parsed);
  return uninstall(deps, parsed);
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probeTimeout = Math.min(1_500, deadline - Date.now());
    if (await probeSidecar('127.0.0.1', DEFAULT_PORT, probeTimeout)) {
      const requestTimeout = Math.min(1_500, deadline - Date.now());
      if (requestTimeout > 0) {
        try {
          const response = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, {
            signal: AbortSignal.timeout(requestTimeout),
          });
          if (response.ok) return true;
        } catch {
          // Service may still be starting or accepted TCP without answering HTTP.
        }
      }
    }
    const sleepMs = Math.min(500, deadline - Date.now());
    if (sleepMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, sleepMs));
  }
  return false;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await serviceMain({
    argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,
    execPath: process.execPath, nodeVersion: process.versions.node, homeDir: process.env.HOME ?? '',
    run: runCommand,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile,
    removeFile: (path) => rm(path, { force: true }),
    makeDir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    waitForHealth,
    portInUse: () => probeSidecar('127.0.0.1', DEFAULT_PORT, 1_500),
    out: console.log,
    err: console.error,
  });
  process.exitCode = code;
}
