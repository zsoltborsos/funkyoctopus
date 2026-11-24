import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { embeddedStatePath } from '../../server/src/upkeep/embedded-state.ts';
import { journalPath, type JournalPhase } from './journal.ts';
import {
  BACKUP_NAME_PREFIX,
  BASELINE_BUILD_TIMEOUT_MS,
  GIT_READ_TIMEOUT_MS,
  MAX_DIAGNOSTIC_CHARS,
  NPM_LS_TIMEOUT_MS,
  runPreflight,
  type PreflightOptions,
  type PreflightRefusal,
  type PreflightResult,
} from './preflight.ts';
import type { CommandChild } from '../../server/src/upkeep/run-command.ts';
import { sentinelPath } from './sentinel.ts';
import { sha256Hex, stateDirFor } from '../../server/src/upkeep/state-path.ts';
import { CoordinationFakeFs } from './test/fake-fs.ts';

const SDK = '@earendil-works/pi-coding-agent';
const REPO = '/repo';
const HEAD = 'a'.repeat(40);
const STATE_DIR = stateDirFor(REPO, '/state-root');

/** Byte-exact manifests: the preflight must snapshot exactly these bytes. */
const PACKAGE_JSON =
  '{\n  "name": "funkyoctopus",\n  "version": "0.1.0",\n  "dependencies": { "@earendil-works/pi-coding-agent": "0.84.1" }\n}\n';
const PACKAGE_LOCK =
  '{\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "funkyoctopus", "dependencies": { "@earendil-works/pi-coding-agent": "0.84.1" } },\n    "node_modules/@earendil-works/pi-coding-agent": { "version": "0.84.1" }\n  }\n}\n';
const NPM_LS_JSON = JSON.stringify({
  version: '0.1.0',
  name: 'funkyoctopus',
  dependencies: { [SDK]: { version: '0.84.1', resolved: 'https://registry.npmjs.org/x' } },
});

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

function eacces(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
}

function isInsidePath(path: string, ancestor: string): boolean {
  const rel = relative(ancestor, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Valid journal JSON for one transaction; schema matches journal.ts. */
function journalJson(transactionId: string, phase: JournalPhase): string {
  return JSON.stringify({
    schemaVersion: 1,
    transactionId,
    phase,
    createdAt: 1_000,
    repo: { canonicalPath: REPO, head: HEAD, branch: 'master' },
    versions: { installed: '0.84.1', candidate: '0.85.0' },
    verificationLevel: 'live',
    manifests: {
      packageJson: { content: PACKAGE_JSON, sha256: sha256Hex(PACKAGE_JSON) },
      packageLock: { content: PACKAGE_LOCK, sha256: sha256Hex(PACKAGE_LOCK) },
    },
    paths: { backup: '/repo-node_modules-backup-x', logs: ['/state/log.log'] },
  });
}

/** Valid persisted embedded state; only `status` varies per test. */
function embeddedStateJson(status: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    installedVersion: null,
    latestVersion: null,
    verifiedVersion: null,
    verificationLevel: 'unknown',
    status,
    lastCheckAt: null,
    lastPromotionAttemptAt: null,
    lastPromotionResult: null,
    lastRecoveryAttemptAt: null,
    lastRecoveryResult: null,
  });
}

/** Preflight-only device and canonical-path controls layered on the shared coordination fake. */
class FakeFs extends CoordinationFakeFs {
  readonly realpathErrors = new Map<string, Error>();
  readonly realpathOverrides = new Map<string, string>();
  readonly devices = new Map<string, number>();
  readonly deviceErrors = new Map<string, Error>();

  override realpath(path: string): Promise<string> {
    this.events.push(`realpath ${path}`);
    const forced = this.realpathErrors.get(path);
    if (forced) return Promise.reject(forced);
    return Promise.resolve(this.realpathOverrides.get(path) ?? path);
  }

  statDevice(path: string): Promise<number> {
    this.events.push(`statDevice ${path}`);
    const forced = this.deviceErrors.get(path);
    if (forced) return Promise.reject(forced);
    const device = this.devices.get(path);
    return device === undefined ? Promise.reject(enoent(path)) : Promise.resolve(device);
  }
}

interface ScriptOutcome {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** The child never closes until the test drives emitClose (timeout tests). */
  hang?: boolean;
  /** The child emits an error event instead of output (spawn-error tests). */
  spawnError?: Error;
}

type Script = Record<string, ScriptOutcome>;

/** Scriptable fake child; emits its canned outcome on the next microtask. */
class FakeChild implements CommandChild {
  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stdout', cb });
    },
  };
  readonly stderr = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stderr', cb });
    },
  };
  private readonly dataHandlers: { stream: 'stdout' | 'stderr'; cb: (chunk: Buffer) => void }[] = [];
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private readonly closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  kills: string[] = [];
  private emitted = false;

  constructor(private readonly outcome: ScriptOutcome) {
    queueMicrotask(() => this.drive());
  }

  on(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === 'error') this.errorHandlers.push(listener as (error: Error) => void);
    else this.closeHandlers.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  emitClose(code: number | null, signal: string | null): void {
    this.emitted = true;
    for (const listener of [...this.closeHandlers]) listener(code, signal);
  }

  private drive(): void {
    if (this.emitted) return;
    if (this.outcome.spawnError) {
      this.emitted = true;
      for (const listener of [...this.errorHandlers]) listener(this.outcome.spawnError);
      return;
    }
    if (this.outcome.hang) return;
    const stdout = this.outcome.stdout ?? '';
    const stderr = this.outcome.stderr ?? '';
    if (stdout) for (const handler of this.dataHandlers) if (handler.stream === 'stdout') handler.cb(Buffer.from(stdout));
    if (stderr) for (const handler of this.dataHandlers) if (handler.stream === 'stderr') handler.cb(Buffer.from(stderr));
    this.emitClose(this.outcome.code ?? 0, null);
  }
}

/** Records every spawn call; routes by `command args` to the script. */
class ScriptedSpawn {
  calls: { command: string; args: string[]; cwd: string | URL | undefined }[] = [];
  children: FakeChild[] = [];

  constructor(private readonly script: Script) {}

  spawn(command: string, args: string[], options: SpawnOptions): CommandChild {
    const key = [command, ...args].join(' ');
    const outcome = this.script[key];
    if (!outcome) throw new Error(`unexpected command: ${key}`);
    this.calls.push({ command, args, cwd: options.cwd });
    const child = new FakeChild(outcome);
    this.children.push(child);
    return child;
  }

  lastChild(): FakeChild {
    const child = this.children[this.children.length - 1];
    if (!child) throw new Error('no child spawned');
    return child;
  }
}

interface TestWorld {
  fs: FakeFs;
  spawn: ScriptedSpawn;
}

function defaultScript(): Script {
  return {
    'git symbolic-ref --short HEAD': { stdout: 'master\n' },
    'git rev-parse HEAD': { stdout: `${HEAD}\n` },
    'git rev-parse --show-toplevel': { stdout: `${REPO}\n` },
    'git status --porcelain=v1 --untracked-files=all': { stdout: '' },
    [`npm ls ${SDK} --json`]: { stdout: NPM_LS_JSON },
    'npm run build': { stdout: 'build ok\n' },
  };
}

function makeWorld(script: Script = defaultScript()): TestWorld {
  const fs = new FakeFs();
  fs.seed(join(REPO, 'package.json'), PACKAGE_JSON);
  fs.seed(join(REPO, 'package-lock.json'), PACKAGE_LOCK);
  // The real source tree and its sibling backup parent share one device.
  fs.devices.set(join(REPO, 'node_modules'), 1);
  fs.devices.set(dirname(REPO), 1);
  return { fs, spawn: new ScriptedSpawn(script) };
}

function defaultOptions(world: TestWorld, overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    sdk: SDK,
    repoPath: REPO,
    disabled: false,
    fs: world.fs,
    command: { spawn: (command, args, options) => world.spawn.spawn(command, args, options) },
    readLatest: () => Promise.resolve('0.85.0'),
    statDevice: (path) => world.fs.statDevice(path),
    stateRoot: '/state-root',
    randomId: () => 'tx-1',
    ...overrides,
  };
}

function refusalOf(result: PreflightResult): PreflightRefusal {
  expect(result.kind).toBe('refused');
  if (result.kind !== 'refused') throw new Error(`expected refusal, got ${result.kind}`);
  return result.refusal;
}

/** Mutation ops the read-only preflight must never perform. */
function mutationEvents(fs: FakeFs): string[] {
  const mutationOperations = ['write', 'writeFile', 'rename', 'unlink', 'mkdir', 'chmod', 'rmdir'];
  return fs.events.filter((event) =>
    mutationOperations.some((operation) => event === operation || event.startsWith(`${operation} `)),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preflight fake mutation-event guard', () => {
  it('recognizes every path-bearing mutation event emitted by the shared fake', async () => {
    const fs = new FakeFs();
    fs.seed('/old', 'content');

    await fs.mkdir('/dir', { recursive: false });
    await fs.writeFile('/written', 'content', {});
    await fs.rename('/old', '/new');
    await fs.unlink('/new');
    await fs.chmod('/dir', 0o700);
    await fs.rmdir('/dir');

    expect(mutationEvents(fs)).toEqual([
      'mkdir /dir',
      'write /written',
      'rename /old -> /new',
      'unlink /new',
      'chmod /dir',
      'rmdir /dir',
    ]);
  });
});

describe('preflight — disabled and canonical identity order', () => {
  it('refuses disabled upkeep first, before any fs or command I/O', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world, { disabled: true }));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('disabled');
    expect(world.fs.events).toEqual([]);
    expect(world.spawn.calls).toEqual([]);
  });

  it('reports an unresolvable repository path as an error, not a refusal', async () => {
    const world = makeWorld();
    world.fs.realpathErrors.set(REPO, enoent(REPO));
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('could not resolve the repository path');
  });

  it('refuses a git root that does not match the canonical repository', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git rev-parse --show-toplevel': { stdout: '/elsewhere\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('repo_root_mismatch');
    if (refusal.code === 'repo_root_mismatch') {
      expect(refusal.gitRoot).toBe('/elsewhere');
      expect(refusal.canonical).toBe(REPO);
    }
    // identity is the second check: only the top-level git call ran
    expect(world.spawn.calls.length).toBe(1);
  });

  it('refuses when the git root cannot be read at all', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git rev-parse --show-toplevel': { stderr: 'fatal: not a git repository\n', code: 128 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('repo_identity');
    if (refusal.code === 'repo_identity') expect(refusal.command.diagnostic).toContain('not a git repository');
  });
});

describe('preflight — transaction sentinel/journal state', () => {
  it('refuses an active transaction before any command beyond git identity', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-a' }));
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'armed'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') {
      expect(refusal.transactionId).toBe('tx-a');
      expect(refusal.phase).toBe('armed');
    }
    // identity (git top-level) ran; nothing else did
    expect(world.spawn.calls.map((call) => call.args.join(' '))).toEqual(['rev-parse --show-toplevel']);
    // the backup device stat never ran either — transaction refusal precedes it
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('refuses a sentinel/journal transaction-id mismatch (failed closed)', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-a' }));
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-b', 'armed'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') expect(refusal.reason).toContain('does not match');
  });

  it('refuses a corrupt journal behind a sentinel (failed closed)', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-a' }));
    world.fs.seed(journalPath(STATE_DIR), 'not json');
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') expect(refusal.reason).toContain('journal');
  });

  it('refuses an orphan prepared journal (sentinel missing, journal prepared)', async () => {
    const world = makeWorld();
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'prepared'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') {
      expect(refusal.transactionId).toBe('tx-a');
      expect(refusal.phase).toBe('prepared');
    }
  });

  it('refuses a committed journal without a sentinel as pending cleanup', async () => {
    const world = makeWorld();
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'committed'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('cleanup_pending');
  });

  it('refuses cleanup_pending embedded status before any command beyond git identity', async () => {
    const world = makeWorld();
    world.fs.seed(embeddedStatePath(STATE_DIR), embeddedStateJson('cleanup_pending'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('cleanup_pending');
    expect(world.spawn.calls.map((call) => call.args.join(' '))).toEqual(['rev-parse --show-toplevel']);
    // the backup device stat never ran either — cleanup refusal precedes it
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('fails closed when embedded state is unreadable', async () => {
    const world = makeWorld();
    world.fs.seed(embeddedStatePath(STATE_DIR), 'garbage');
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('embedded_state_unreadable');
    // the backup device stat never ran either — unreadable state precedes it
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });
});

describe('preflight — transaction/cleanup refusal precedes the backup device stat', () => {
  // Every regression makes the node_modules stat fail (e.g. an absent tree),
  // which would refuse as backup_device_unreadable if the device probe ran
  // first. The transaction/cleanup refusal must win without ever statting it.

  it('refuses an active mutating transaction without statting node_modules', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-a' }));
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'mutating'));
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), enoent(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') {
      expect(refusal.transactionId).toBe('tx-a');
      expect(refusal.phase).toBe('mutating');
    }
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('refuses a completed committed journal as cleanup pending without statting node_modules', async () => {
    const world = makeWorld();
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'committed'));
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), enoent(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('cleanup_pending');
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('refuses an orphan prepared journal without statting node_modules', async () => {
    const world = makeWorld();
    world.fs.seed(journalPath(STATE_DIR), journalJson('tx-a', 'prepared'));
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), enoent(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') {
      expect(refusal.transactionId).toBe('tx-a');
      expect(refusal.phase).toBe('prepared');
    }
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('refuses failed-closed sentinel evidence without statting node_modules', async () => {
    const world = makeWorld();
    world.fs.seed(sentinelPath(STATE_DIR), JSON.stringify({ transactionId: 'tx-a' }));
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), enoent(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('transaction_state');
    if (refusal.code === 'transaction_state') expect(refusal.reason).toContain('sentinel');
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });

  it('refuses cleanup_pending embedded status without statting node_modules', async () => {
    const world = makeWorld();
    world.fs.seed(embeddedStatePath(STATE_DIR), embeddedStateJson('cleanup_pending'));
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), enoent(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('cleanup_pending');
    expect(world.fs.events.some((event) => event.startsWith('statDevice '))).toBe(false);
  });
});

describe('preflight — branch, HEAD, and clean tree', () => {
  it('refuses a detached HEAD', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git symbolic-ref --short HEAD': { stderr: 'fatal: ref HEAD is not a symbolic ref\n', code: 1 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('detached_head');
    // refused at the branch check: only identity + symbolic-ref ran
    expect(world.spawn.calls.length).toBe(2);
  });

  it('refuses when HEAD is not a full 40-hex sha', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git rev-parse HEAD': { stdout: 'HEAD\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('bad_head');
  });

  it('refuses when HEAD cannot be read', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git rev-parse HEAD': { stderr: 'fatal: ambiguous argument HEAD\n', code: 128 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('bad_head');
  });

  it('refuses tracked working-tree changes', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: ' M package.json\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('dirty_tree');
    if (refusal.code === 'dirty_tree') {
      expect(refusal.tracked).toEqual([' M package.json']);
      expect(refusal.untracked).toEqual([]);
    }
    // refused before manifests/npm: only identity + the three git reads ran
    expect(world.spawn.calls.length).toBe(4);
    expect(world.fs.events.some((event) => event === 'read /repo/package.json')).toBe(false);
  });

  it('refuses untracked files (and never cleans, stashes, or resets)', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: '?? new-file.txt\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('dirty_tree');
    if (refusal.code === 'dirty_tree') {
      expect(refusal.tracked).toEqual([]);
      expect(refusal.untracked).toEqual(['new-file.txt']);
    }
    // only read-only git reads happened; zero mutation ops
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses both tracked and untracked changes together', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: ' M package.json\n?? new.txt\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('dirty_tree');
    if (refusal.code === 'dirty_tree') {
      expect(refusal.tracked).toEqual([' M package.json']);
      expect(refusal.untracked).toEqual(['new.txt']);
    }
  });

  it('produces a typed refusal when a git read times out', async () => {
    vi.useFakeTimers();
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { hang: true },
    });
    const pending = runPreflight(defaultOptions(world));
    await vi.advanceTimersByTimeAsync(GIT_READ_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1_000); // SIGKILL grace
    world.spawn.lastChild().emitClose(null, 'SIGKILL');
    const result = await pending;
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('git_status_failed');
    if (refusal.code === 'git_status_failed') {
      expect(refusal.command.outcome).toBe('terminated');
      expect(refusal.command.diagnostic).toBe('');
    }
    expect(world.spawn.lastChild().kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('preflight — manifests and npm ls baseline', () => {
  it('refuses an unreadable package.json', async () => {
    const world = makeWorld();
    world.fs.readErrors.set(join(REPO, 'package.json'), eacces(join(REPO, 'package.json')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('manifest_unreadable');
    if (refusal.code === 'manifest_unreadable') expect(refusal.path).toBe(join(REPO, 'package.json'));
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
  });

  it('refuses an unreadable package-lock.json', async () => {
    const world = makeWorld();
    world.fs.readErrors.set(join(REPO, 'package-lock.json'), eacces(join(REPO, 'package-lock.json')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('manifest_unreadable');
    if (refusal.code === 'manifest_unreadable') expect(refusal.path).toBe(join(REPO, 'package-lock.json'));
  });

  it('refuses a manifest that is not valid JSON', async () => {
    const world = makeWorld();
    world.fs.seed(join(REPO, 'package.json'), 'not json');
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('manifest_invalid');
  });

  it('refuses when npm ls exits nonzero (bounded diagnostic)', async () => {
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: { stderr: 'npm ERR! code ELSPROBLEMS\nnpm ERR! missing: x@1.0.0\n', code: 1 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('npm_ls_failed');
    if (refusal.code === 'npm_ls_failed') {
      expect(refusal.command.outcome).toBe('exit');
      expect(refusal.command.exitCode).toBe(1);
      expect(refusal.command.diagnostic).toContain('ELSPROBLEMS');
    }
  });

  it('produces a typed refusal when npm ls times out', async () => {
    vi.useFakeTimers();
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: { hang: true },
    });
    const pending = runPreflight(defaultOptions(world));
    await vi.advanceTimersByTimeAsync(NPM_LS_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    world.spawn.lastChild().emitClose(null, 'SIGKILL');
    const result = await pending;
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('npm_ls_failed');
    if (refusal.code === 'npm_ls_failed') expect(refusal.command.outcome).toBe('terminated');
  });

  it('refuses malformed npm ls JSON', async () => {
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: { stdout: 'garbage' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('npm_ls_malformed');
  });

  it('refuses npm ls problems via baseline needs_attention', async () => {
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: {
        stdout: JSON.stringify({
          name: 'funkyoctopus',
          problems: ['unmet peer dependency x@1.0.0'],
          dependencies: { [SDK]: { version: '0.84.1' } },
        }),
      },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('baseline_needs_attention');
    if (refusal.code === 'baseline_needs_attention') {
      expect(refusal.issues).toContainEqual({ code: 'npm_ls_problems', problems: ['unmet peer dependency x@1.0.0'] });
    }
  });

  it('refuses npm ls resolving a different version via baseline needs_attention', async () => {
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: {
        stdout: JSON.stringify({ name: 'funkyoctopus', dependencies: { [SDK]: { version: '0.84.2' } } }),
      },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('baseline_needs_attention');
    if (refusal.code === 'baseline_needs_attention') {
      expect(refusal.issues).toContainEqual({
        code: 'npm_ls_version_mismatch',
        dependency: SDK,
        expected: '0.84.1',
        actual: '0.84.2',
      });
    }
  });

  it('refuses a non-exact package.json declaration via baseline needs_attention', async () => {
    const world = makeWorld();
    world.fs.seed(join(REPO, 'package.json'), PACKAGE_JSON.replace('"0.84.1"', '"^0.84.1"'));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('baseline_needs_attention');
    if (refusal.code === 'baseline_needs_attention') {
      expect(refusal.issues).toContainEqual({ code: 'package_json_not_exact', dependency: SDK, raw: '^0.84.1' });
    }
  });

  it('keeps command diagnostics bounded on noisy output', async () => {
    const world = makeWorld({
      ...defaultScript(),
      [`npm ls ${SDK} --json`]: { stderr: 'x'.repeat(100_000), code: 1 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('npm_ls_failed');
    if (refusal.code === 'npm_ls_failed') {
      expect(refusal.command.diagnostic.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    }
  });
});

describe('preflight — stable latest and baseline build', () => {
  it('refuses a failed fresh stable-latest lookup', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world, { readLatest: () => Promise.resolve(null) }));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('latest_failed');
    // refused before the build
    expect(world.spawn.calls.some((call) => call.args[0] === 'run')).toBe(false);
  });

  it('refuses malformed latest output', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world, { readLatest: () => Promise.resolve('garbage') }));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('latest_rejected');
  });

  it('refuses a prerelease latest tag', async () => {
    const world = makeWorld();
    const result = await runPreflight(
      defaultOptions(world, { readLatest: () => Promise.resolve('0.85.0-beta.1') }),
    );
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('latest_rejected');
    if (refusal.code === 'latest_rejected') expect(refusal.reason).toContain('not an exact stable version');
  });

  it('refuses a downgrade', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world, { readLatest: () => Promise.resolve('0.83.0') }));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('latest_rejected');
    if (refusal.code === 'latest_rejected') expect(refusal.reason).toContain('downgrade');
  });

  it('refuses a baseline build failure with a bounded diagnostic', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'npm run build': { stderr: 'error TS2322: type mismatch\nvite build failed\n', code: 1 },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('baseline_build_failed');
    if (refusal.code === 'baseline_build_failed') {
      expect(refusal.command.outcome).toBe('exit');
      expect(refusal.command.exitCode).toBe(1);
      expect(refusal.command.diagnostic).toContain('TS2322');
    }
  });

  it('refuses a baseline build timeout as a terminated command', async () => {
    vi.useFakeTimers();
    const world = makeWorld({
      ...defaultScript(),
      'npm run build': { hang: true },
    });
    const pending = runPreflight(defaultOptions(world));
    await vi.advanceTimersByTimeAsync(BASELINE_BUILD_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    world.spawn.lastChild().emitClose(null, 'SIGKILL');
    const result = await pending;
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('baseline_build_failed');
    if (refusal.code === 'baseline_build_failed') expect(refusal.command.outcome).toBe('terminated');
  });
});

describe('preflight — ready context', () => {
  it('returns an immutable ready context with every pre-mutation fact', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    const context = result.context;
    expect(context.decision).toBe('ready');
    expect(context.canonicalRepo).toBe(REPO);
    expect(context.stateDir).toBe(STATE_DIR);
    expect(context.branch).toBe('master');
    expect(context.head).toBe(HEAD);
    expect(context.installedVersion).toBe('0.84.1');
    expect(context.candidateVersion).toBe('0.85.0');
    // byte-exact manifest snapshots with their hashes
    expect(context.manifests.packageJson).toEqual({ content: PACKAGE_JSON, sha256: sha256Hex(PACKAGE_JSON) });
    expect(context.manifests.packageLock).toEqual({ content: PACKAGE_LOCK, sha256: sha256Hex(PACKAGE_LOCK) });
    // deterministic same-filesystem sibling under the repo parent
    expect(context.backup).toBe(join('/', `repo-${BACKUP_NAME_PREFIX}-${HEAD.slice(0, 12)}-tx-1`));
    expect(isInsidePath(context.backup, REPO)).toBe(false);
    // bounded log paths under the state dir
    expect(context.logs).toEqual([
      join(STATE_DIR, 'promotion-tx-1.log'),
      join(STATE_DIR, 'promotion-tx-1.stderr.log'),
    ]);
    expect(isInsidePath(context.logs[0] ?? '', REPO)).toBe(false);
    // deeply immutable
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.manifests)).toBe(true);
    expect(Object.isFrozen(context.manifests.packageJson)).toBe(true);
    expect(Object.isFrozen(context.logs)).toBe(true);
    expect(() => {
      (context as { decision: string }).decision = 'noop';
    }).toThrow();
    expect(() => {
      (context.manifests as { packageJson: { content: string } }).packageJson.content = 'tampered';
    }).toThrow();
  });

  it('runs every check in order and the build as the final gate, never mutating', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('ready');
    const commands = world.spawn.calls.map((call) => `${call.command} ${call.args.join(' ')}`);
    expect(commands).toEqual([
      'git rev-parse --show-toplevel',
      'git symbolic-ref --short HEAD',
      'git rev-parse HEAD',
      'git status --porcelain=v1 --untracked-files=all',
      `npm ls ${SDK} --json`,
      'npm run build',
    ]);
    for (const call of world.spawn.calls) expect(call.cwd).toBe(REPO);
    // the build is the last command — the boundary before any mutation
    expect(commands[commands.length - 1]).toBe('npm run build');
    // no full baseline verify
    expect(commands.some((command) => command.includes('verify'))).toBe(false);
    // zero mutation ops and no files created
    expect(mutationEvents(world.fs)).toEqual([]);
    expect([...world.fs.files.keys()].sort()).toEqual([
      join(REPO, 'package-lock.json'),
      join(REPO, 'package.json'),
    ]);
  });

  it('refuses a state dir that would land inside the repository', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world, { stateRoot: '/repo/inner' }));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('path_inside_repo');
    if (refusal.code === 'path_inside_repo') {
      expect(refusal.path).toContain('/repo/inner');
      expect(refusal.repo).toBe(REPO);
    }
  });

  it('varies the backup/log suffix per run (transaction-safe uniqueness)', async () => {
    const world = makeWorld();
    let next = 0;
    const ids = ['tx-1', 'tx-2'];
    const options = defaultOptions(world, { randomId: () => ids[Math.min(next++, 1)] ?? 'tx-2' });
    const first = await runPreflight(options);
    const second = await runPreflight(options);
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready');
    expect(first.context.backup).not.toBe(second.context.backup);
    expect(first.context.logs[0]).not.toBe(second.context.logs[0]);
  });
});

describe('preflight — no-op when already current', () => {
  it('returns a noop context when installed equals latest, skipping the build', async () => {
    const world = makeWorld();
    const result = await runPreflight(
      defaultOptions(world, { readLatest: () => Promise.resolve('0.84.1') }),
    );
    expect(result.kind).toBe('noop');
    if (result.kind !== 'noop') return;
    const context = result.context;
    expect(context.decision).toBe('noop');
    expect(context.installedVersion).toBe('0.84.1');
    expect(context.candidateVersion).toBe('0.84.1');
    expect(context.head).toBe(HEAD);
    expect(context.manifests.packageJson.content).toBe(PACKAGE_JSON);
    // no build ran and nothing mutated
    expect(world.spawn.calls.some((call) => call.args[0] === 'run')).toBe(false);
    expect(mutationEvents(world.fs)).toEqual([]);
  });
});

describe('preflight — git status seam is config-proof (porcelain v1, all untracked)', () => {
  it('passes the exact pinned status arguments to git', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('ready');
    const statusCall = world.spawn.calls.find((call) => call.command === 'git' && call.args[0] === 'status');
    // the exact argument vector is the seam contract: no config file can
    // change the reported format or hide untracked files
    expect(statusCall?.args).toEqual(['status', '--porcelain=v1', '--untracked-files=all']);
  });

  it('lists every untracked file individually, never collapsing directories', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: '?? src/new.ts\n?? docs/notes.md\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('dirty_tree');
    if (refusal.code === 'dirty_tree') {
      expect(refusal.untracked).toEqual(['src/new.ts', 'docs/notes.md']);
    }
  });

  it('keeps a v1 rename on one line and classifies it as tracked', async () => {
    const world = makeWorld({
      ...defaultScript(),
      'git status --porcelain=v1 --untracked-files=all': { stdout: 'R  old.ts -> new.ts\n' },
    });
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('dirty_tree');
    if (refusal.code === 'dirty_tree') expect(refusal.tracked).toEqual(['R  old.ts -> new.ts']);
  });
});

describe('preflight — backup same-filesystem safety', () => {
  it('requires the source tree and backup parent to share a device before ready', async () => {
    const world = makeWorld();
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('ready');
    // the actual source tree and the sibling backup parent are probed, in order
    expect(world.fs.events.filter((event) => event.startsWith('statDevice '))).toEqual([
      `statDevice ${join(REPO, 'node_modules')}`,
      `statDevice ${dirname(REPO)}`,
    ]);
  });

  it('passes the same-device check for a no-op decision too', async () => {
    const world = makeWorld();
    const result = await runPreflight(
      defaultOptions(world, { readLatest: () => Promise.resolve('0.84.1') }),
    );
    expect(result.kind).toBe('noop');
  });

  it('refuses a node_modules mount on a different filesystem', async () => {
    const world = makeWorld();
    world.fs.devices.set(join(REPO, 'node_modules'), 2);
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_mismatch');
    if (refusal.code === 'backup_device_mismatch') {
      expect(refusal.sourceTree).toBe(join(REPO, 'node_modules'));
      expect(refusal.backupParent).toBe(dirname(REPO));
      expect(refusal.sourceDevice).toBe(2);
      expect(refusal.backupDevice).toBe(1);
    }
  });

  it('compares the real source tree, not the repo root, when the repo is a mountpoint', async () => {
    const world = makeWorld();
    // the repo root is its own mount on device 9; node_modules lives on it
    world.fs.devices.set(REPO, 9);
    world.fs.devices.set(join(REPO, 'node_modules'), 9);
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_mismatch');
    // the repo root itself is never probed — only the two real targets
    expect(world.fs.events.some((event) => event === `statDevice ${REPO}`)).toBe(false);
  });

  it('allows a repo-root mount when node_modules is bind-mounted on the backup parent device', async () => {
    const world = makeWorld();
    world.fs.devices.set(REPO, 9);
    world.fs.devices.set(join(REPO, 'node_modules'), 1); // bind mount on the parent's device
    const result = await runPreflight(defaultOptions(world));
    expect(result.kind).toBe('ready');
  });

  it('refuses an unstatable source tree after state inspection but before branch, tree, build, or any mutation', async () => {
    const world = makeWorld();
    world.fs.deviceErrors.set(join(REPO, 'node_modules'), eacces(join(REPO, 'node_modules')));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_unreadable');
    if (refusal.code === 'backup_device_unreadable') {
      expect(refusal.path).toBe(join(REPO, 'node_modules'));
    }
    // the read-only transaction/embedded probes ran first (all absent here)
    expect(world.fs.events).toContain(`read ${sentinelPath(STATE_DIR)}`);
    expect(world.fs.events).toContain(`read ${journalPath(STATE_DIR)}`);
    expect(world.fs.events).toContain(`read ${embeddedStatePath(STATE_DIR)}`);
    // nothing after the device probe ran and nothing mutated
    expect(world.spawn.calls.some((call) => call.args[0] === 'symbolic-ref')).toBe(false);
    expect(world.spawn.calls.some((call) => call.args[0] === 'run')).toBe(false);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses an unstatable backup parent', async () => {
    const world = makeWorld();
    world.fs.deviceErrors.set(dirname(REPO), enoent(dirname(REPO)));
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_unreadable');
    if (refusal.code === 'backup_device_unreadable') expect(refusal.path).toBe(dirname(REPO));
  });

  it('refuses a non-finite device id', async () => {
    const world = makeWorld();
    world.fs.devices.set(join(REPO, 'node_modules'), NaN);
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_invalid');
    if (refusal.code === 'backup_device_invalid') {
      expect(refusal.path).toBe(join(REPO, 'node_modules'));
      expect(Number.isFinite(refusal.device)).toBe(false);
    }
  });

  it('refuses a device mismatch before the baseline build boundary', async () => {
    const world = makeWorld();
    world.fs.devices.set(join(REPO, 'node_modules'), 2);
    const result = await runPreflight(defaultOptions(world));
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_mismatch');
    // the build (the boundary before any mutation) never ran, nothing mutated
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
    expect(mutationEvents(world.fs)).toEqual([]);
  });

  it('refuses a device mismatch even when the installed version is already current', async () => {
    const world = makeWorld();
    world.fs.devices.set(join(REPO, 'node_modules'), 2);
    const result = await runPreflight(
      defaultOptions(world, { readLatest: () => Promise.resolve('0.84.1') }),
    );
    const refusal = refusalOf(result);
    expect(refusal.code).toBe('backup_device_mismatch');
    expect(world.spawn.calls.some((call) => call.command === 'npm')).toBe(false);
  });
});
