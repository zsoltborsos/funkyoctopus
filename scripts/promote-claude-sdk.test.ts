import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_SDK_PACKAGE as SDK } from '../server/src/upkeep/claude-sdk-drift.ts';
import type { CommandOutcome } from '../server/src/upkeep/run-command.ts';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, parseArgs, productionDeps, promoteClaudeSdk, readNpmSdkVersion, selectCandidate, type PromoteDeps } from './promote-claude-sdk.ts';

const ROOT = '/repo';
const PIN = '0.3.302';
const NEXT = '0.3.305';
const BINARY = '@anthropic-ai/claude-agent-sdk-linux-x64';
const OVERRIDE = 'file:./stubs/no-claude-binary';
const INSTALL = `npm install --save-exact ${SDK}@${NEXT}`;
const VERIFY = 'npm run verify';
const ADD = 'git add -- package.json package-lock.json';
const COMMIT = `git commit --no-verify -m chore(deps): claude agent sdk ${NEXT}`;
const RESTORE = 'git restore --source=HEAD --staged --worktree -- package.json package-lock.json';
const CI = 'npm ci';

function harness() {
  const calls: string[] = [];
  const cwds: [string, string][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map([
    [`${ROOT}/package.json`, JSON.stringify({ dependencies: { [SDK]: PIN }, overrides: { [BINARY]: OVERRIDE } })],
    [`${ROOT}/node_modules/${SDK}/package.json`, JSON.stringify({ version: PIN })],
    [`${ROOT}/stubs/no-claude-binary/package.json`, '{"name":"no-claude-binary","version":"0.0.0"}'],
  ]);
  const failures = new Map<string, number | null | 'throw'>();
  const dirty = { value: '' };
  const installUpdates = { pin: true, installed: true };
  const execute = (command: string, args: readonly string[], cwd: string) => {
    const key = [command, ...args].join(' ');
    calls.push(key); cwds.push([key, cwd]);
    if (failures.get(key) === 'throw') throw new Error(`${key} rejected`);
    return failures.has(key) ? failures.get(key) as number | null : 0;
  };
  const deps: PromoteDeps = {
    argv: [], env: {}, cwd: `${ROOT}/sub`,
    stream: vi.fn<PromoteDeps['stream']>((command, args, cwd) => {
      const code = execute(command, args, cwd);
      if (code === 0 && command === 'npm' && args[0] === 'install') {
        const candidate = args[2]?.slice(`${SDK}@`.length);
        if (installUpdates.pin) files.set(`${ROOT}/package.json`, JSON.stringify({ dependencies: { [SDK]: candidate }, overrides: { [BINARY]: OVERRIDE } }));
        if (installUpdates.installed) files.set(`${ROOT}/node_modules/${SDK}/package.json`, JSON.stringify({ version: candidate }));
      }
      return Promise.resolve(code);
    }),
    capture: vi.fn<PromoteDeps['capture']>((command, args, cwd) => Promise.resolve({ code: execute(command, args, cwd), stderr: '',
      stdout: args[0] === 'rev-parse' ? `${ROOT}\n` : args[0] === 'status' ? dirty.value : '' })),
    readFile: vi.fn<PromoteDeps['readFile']>((path) => {
      calls.push(`read ${path}`);
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
    }),
    realpath: vi.fn<PromoteDeps['realpath']>((path) => { calls.push(`realpath ${path}`); return Promise.resolve(`${ROOT}/stubs/no-claude-binary`); }),
    probeSidecar: vi.fn<PromoteDeps['probeSidecar']>((host, port) => { calls.push(`probe ${host}:${port}`); return Promise.resolve(false); }),
    readCliVersion: vi.fn().mockResolvedValue('2.1.305'),
    readPublishedVersion: vi.fn().mockResolvedValue(NEXT), readLatest: vi.fn().mockResolvedValue('0.3.999'),
    out: (line) => out.push(line), err: (line) => err.push(line),
  };
  return { deps, calls, cwds, out, err, files, failures, dirty, installUpdates };
}

describe('Claude promotion candidates', () => {
  it('parses exact --to, help and defaults', () => {
    expect(parseArgs([])).toEqual({ kind: 'run', to: null });
    expect(parseArgs(['--to', ' 0.3.9 '])).toEqual({ kind: 'run', to: '0.3.9' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });
  it.each([['--to'], ['--to', '^0.3.9'], ['--to', 'latest'], ['--to', '0.3.9-beta'], ['--unknown']].map((args) => ({ args })))('rejects invalid args $args', ({ args }) => {
    expect(parseArgs(args).kind).toBe('usage');
  });
  it('explicit lower candidate bypasses all readers', async () => {
    const { deps } = harness();
    expect(await selectCandidate('0.3.9', deps)).toBe('0.3.9');
    expect(deps.readCliVersion).not.toHaveBeenCalled();
    expect(deps.readPublishedVersion).not.toHaveBeenCalled();
    expect(deps.readLatest).not.toHaveBeenCalled();
  });
  it('paired candidate wins over latest, even below the installed SDK', async () => {
    const h = harness();
    vi.mocked(h.deps.readCliVersion).mockResolvedValue('2.1.9');
    vi.mocked(h.deps.readPublishedVersion).mockResolvedValue('0.3.9');
    expect(await selectCandidate(null, h.deps)).toBe('0.3.9');
    expect(h.deps.readPublishedVersion).toHaveBeenCalledWith('0.3.9');
    expect(h.deps.readLatest).not.toHaveBeenCalled();
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_OK);
    expect(h.calls).toContain(`npm install --save-exact ${SDK}@0.3.9`);
  });
  it.each(['missing', 'throw', 'malformed', 'wrong', 'no-cli', 'unsupported', 'cli-throw'])('falls back to stable latest: %s', async (mode) => {
    const { deps } = harness();
    if (mode === 'missing') vi.mocked(deps.readPublishedVersion).mockResolvedValue(null);
    if (mode === 'throw') vi.mocked(deps.readPublishedVersion).mockRejectedValue(new Error('network'));
    if (mode === 'malformed') vi.mocked(deps.readPublishedVersion).mockResolvedValue('0.3.305-beta');
    if (mode === 'wrong') vi.mocked(deps.readPublishedVersion).mockResolvedValue('0.3.306');
    if (mode === 'no-cli') vi.mocked(deps.readCliVersion).mockResolvedValue(null);
    if (mode === 'unsupported') vi.mocked(deps.readCliVersion).mockResolvedValue('2.2.305');
    if (mode === 'cli-throw') vi.mocked(deps.readCliVersion).mockRejectedValue(new Error('missing'));
    expect(await selectCandidate(null, deps)).toBe('0.3.999');
  });
  it.each([null, 'latest', '^0.3.9', '0.3.9-beta', 'throw'])('cannot select invalid/unavailable latest %s', async (latest) => {
    const { deps } = harness();
    vi.mocked(deps.readCliVersion).mockResolvedValue(null);
    if (latest === 'throw') vi.mocked(deps.readLatest).mockRejectedValue(new Error('network'));
    else vi.mocked(deps.readLatest).mockResolvedValue(latest);
    expect(await selectCandidate(null, deps)).toBeNull();
  });
  it.each([null, NEXT])('uses bounded registry arguments for %s', async (candidate) => {
    const run = vi.fn().mockResolvedValue({ kind: 'exit', code: 0, facts: { stdout: JSON.stringify(NEXT), droppedBytes: 0 } });
    expect(await readNpmSdkVersion(candidate, run)).toBe(NEXT);
    expect(run).toHaveBeenCalledWith({ command: 'npm', args: candidate === null
      ? ['view', SDK, 'dist-tags.latest', '--json'] : ['view', `${SDK}@${candidate}`, 'version', '--json'],
    timeoutMs: 30_000, maxOutputBytes: 4096 });
  });
  it.each(['nonzero', 'null', 'timeout', 'error', 'reject', 'truncated', 'array', 'prerelease', 'malformed'])('registry failure stays unknown: %s', async (mode) => {
    const outcome: CommandOutcome = { kind: 'exit', code: mode === 'null' ? null : mode === 'nonzero' ? 1 : 0, signal: null,
      facts: { stdout: mode === 'array' ? '[]' : mode === 'prerelease' ? '"0.3.9-beta"' : mode === 'malformed' ? 'broken' : '"0.3.9"',
        stderr: '', log: '', droppedBytes: mode === 'truncated' ? 1 : 0 } };
    const run = vi.fn().mockResolvedValue(outcome);
    if (mode === 'reject') run.mockRejectedValue(new Error('failed'));
    if (mode === 'timeout') run.mockResolvedValue({ kind: 'terminated', reason: 'timeout', facts: outcome.facts });
    if (mode === 'error') run.mockResolvedValue({ kind: 'error', code: 'ENOENT', message: 'missing', facts: outcome.facts });
    expect(await readNpmSdkVersion(null, run)).toBeNull();
  });
});

describe('Claude SDK promotion preflight', () => {
  it('help, usage and production binding construction are inert', async () => {
    const h = harness();
    h.deps.argv = ['--help'];
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_OK);
    h.deps.argv = ['--to', 'next'];
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_USAGE);
    expect(h.calls).toEqual([]);
    expect(productionDeps([], {}).readLatest).toBeTypeOf('function');
  });
  it.each(['outside', 'status-failed', 'tracked', 'untracked', 'git-reject', 'live', 'probe-reject', 'late-live', 'late-probe-reject', 'bad-port'])('refuses %s without rollback', async (mode) => {
    const h = harness();
    if (mode === 'outside') h.failures.set('git rev-parse --show-toplevel', 128);
    if (mode === 'status-failed') h.failures.set('git status --porcelain=v1 --untracked-files=all', 1);
    if (mode === 'git-reject') h.failures.set('git status --porcelain=v1 --untracked-files=all', 'throw');
    if (mode === 'tracked') h.dirty.value = ' M package.json\n';
    if (mode === 'untracked') h.dirty.value = '?? new-file\n';
    if (mode === 'live') vi.mocked(h.deps.probeSidecar).mockResolvedValue(true);
    if (mode === 'probe-reject') vi.mocked(h.deps.probeSidecar).mockRejectedValue(new Error('probe failed'));
    if (mode === 'late-live') vi.mocked(h.deps.probeSidecar).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    if (mode === 'late-probe-reject') vi.mocked(h.deps.probeSidecar).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('probe failed'));
    if (mode === 'bad-port') h.deps.env.SIDECAR_PORT = 'invalid';
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).not.toContain(INSTALL);
    expect(h.calls).not.toContain(RESTORE);
    expect(h.calls).not.toContain(CI);
  });
  it.each(['missing-root', 'missing-sdk', 'range', 'mismatch', 'prerelease', 'null-root', 'primitive-sdk', 'bad-json', 'no-override', 'changed-override', 'no-candidate'])('refuses bad baseline/candidate: %s', async (mode) => {
    const h = harness();
    if (mode === 'missing-root') h.files.delete(`${ROOT}/package.json`);
    if (mode === 'missing-sdk') h.files.delete(`${ROOT}/node_modules/${SDK}/package.json`);
    if (mode === 'range') h.files.set(`${ROOT}/package.json`, JSON.stringify({ dependencies: { [SDK]: '^0.3.302' }, overrides: { [BINARY]: OVERRIDE } }));
    if (mode === 'mismatch') h.files.set(`${ROOT}/node_modules/${SDK}/package.json`, '{"version":"0.3.301"}');
    if (mode === 'prerelease') h.files.set(`${ROOT}/node_modules/${SDK}/package.json`, '{"version":"0.3.302-beta"}');
    if (mode === 'null-root') h.files.set(`${ROOT}/package.json`, 'null');
    if (mode === 'primitive-sdk') h.files.set(`${ROOT}/node_modules/${SDK}/package.json`, '1');
    if (mode === 'bad-json') h.files.set(`${ROOT}/package.json`, 'broken');
    if (mode === 'no-override' || mode === 'changed-override') h.files.set(`${ROOT}/package.json`, JSON.stringify({ dependencies: { [SDK]: PIN }, overrides: { [BINARY]: mode === 'no-override' ? undefined : 'real-binary' } }));
    if (mode === 'no-candidate') { vi.mocked(h.deps.readCliVersion).mockResolvedValue(null); vi.mocked(h.deps.readLatest).mockResolvedValue(null); }
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).not.toContain(INSTALL);
    expect(h.calls).not.toContain(RESTORE);
  });
  it('checks clean tree and live sidecar even for a no-op; no-op validates the stub', async () => {
    const h = harness();
    h.deps.argv = ['--to', PIN];
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_OK);
    expect(h.calls).toContain('git status --porcelain=v1 --untracked-files=all');
    expect(h.deps.probeSidecar).toHaveBeenCalledTimes(1);
    expect(h.deps.realpath).toHaveBeenCalled();
    expect(h.calls).not.toContain(VERIFY);
    expect(h.calls).not.toContain(ADD);
    h.dirty.value = '?? scratch';
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    h.dirty.value = '';
    vi.mocked(h.deps.probeSidecar).mockResolvedValue(true);
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
  });
  it('refuses an invalid existing stub in a no-op without rollback', async () => {
    const h = harness(); h.deps.argv = ['--to', PIN];
    vi.mocked(h.deps.realpath).mockRejectedValue(new Error('dangling'));
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).not.toContain(RESTORE);
  });
});

describe('Claude SDK promotion transaction', () => {
  it('installs exact, validates override/stub, verifies and commits; only prints the live next step', async () => {
    const h = harness();
    h.deps.env = { SIDECAR_HOST: 'localhost', SIDECAR_PORT: '9001' };
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_OK);
    expect(h.deps.probeSidecar).toHaveBeenCalledTimes(2);
    expect(h.deps.probeSidecar).toHaveBeenCalledWith('localhost', 9001);
    expect(h.calls.filter((s) => s.startsWith('npm ') || s.startsWith('git add') || s.startsWith('git commit'))).toEqual([INSTALL, VERIFY, ADD, COMMIT]);
    const installIndex = h.calls.indexOf(INSTALL);
    const verifyIndex = h.calls.indexOf(VERIFY);
    expect(h.calls.slice(installIndex + 1, verifyIndex)).toEqual([
      `read ${ROOT}/package.json`, `read ${ROOT}/node_modules/${SDK}/package.json`,
      `read ${ROOT}/package.json`, `realpath ${ROOT}/node_modules/${BINARY}`, `read ${ROOT}/stubs/no-claude-binary/package.json`,
    ]);
    expect(h.cwds[0]?.[1]).toBe(`${ROOT}/sub`);
    expect(h.cwds.slice(1).every(([, cwd]) => cwd === ROOT)).toBe(true);
    expect(h.out.join('\n')).toContain('npx vitest run --config vitest.runtime.config.ts server/src/runtime/claude-code.runtime.test.ts');
    expect(h.out.join('\n')).toContain('Re-record session-transcript fixtures');
    expect(h.out.join('\n')).toContain('not declared by its types');
    expect(h.calls.join('\n')).not.toMatch(/test:runtime|vitest run|claude --/);
  });
  it.each(['pin', 'installed', 'both'])('rolls back a zero-exit install when %s stays unchanged', async (unchanged) => {
    const h = harness();
    if (unchanged === 'pin' || unchanged === 'both') h.installUpdates.pin = false;
    if (unchanged === 'installed' || unchanged === 'both') h.installUpdates.installed = false;
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).toContain(INSTALL);
    expect(h.calls).not.toContain(VERIFY);
    expect(h.calls).not.toContain(ADD);
    expect(h.calls).not.toContain(COMMIT);
    expect(h.calls.slice(-2)).toEqual([RESTORE, CI]);
    expect(h.err.join('\n')).toContain('requested version');
  });
  it('explicit --to bypasses candidate reads throughout the transaction', async () => {
    const h = harness(); h.deps.argv = ['--to', NEXT];
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_OK);
    expect(h.deps.readCliVersion).not.toHaveBeenCalled();
    expect(h.deps.readLatest).not.toHaveBeenCalled();
  });
  it.each([INSTALL, VERIFY, ADD, COMMIT].flatMap((stage) => [1, null, 'throw'].map((result) => ({ stage, result }))))('rolls back $stage on $result', async ({ stage, result }) => {
    const h = harness(); h.failures.set(stage, result as number | null | 'throw');
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.slice(-2)).toEqual([RESTORE, CI]);
    expect(h.calls.filter((s) => s === RESTORE)).toHaveLength(1);
    expect(h.calls.filter((s) => s === CI)).toHaveLength(1);
  });
  it.each([INSTALL, VERIFY, ADD, COMMIT])('rolls back rejected runner promises at %s', async (stage) => {
    const h = harness();
    const stream = h.deps.stream;
    const capture = h.deps.capture;
    h.deps.stream = (command, args, cwd) => [command, ...args].join(' ') === stage
      ? Promise.reject(new Error('runner rejected')) : stream(command, args, cwd);
    h.deps.capture = (command, args, cwd) => [command, ...args].join(' ') === stage
      ? Promise.reject(new Error('runner rejected')) : capture(command, args, cwd);
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls.slice(-2)).toEqual([RESTORE, CI]);
  });
  it.each(['override', 'missing-link', 'missing-manifest', 'real-binary', 'wrong-version'])('rolls back failed stub check: %s', async (mode) => {
    const h = harness();
    const original = h.deps.stream;
    h.deps.stream = async (command, args, cwd) => {
      const result = await original(command, args, cwd);
      if (args[0] === 'install') {
        if (mode === 'override') h.files.set(`${ROOT}/package.json`, '{}');
        if (mode === 'missing-link') vi.mocked(h.deps.realpath).mockRejectedValue(new Error('ENOENT'));
        if (mode === 'missing-manifest') h.files.delete(`${ROOT}/stubs/no-claude-binary/package.json`);
        if (mode === 'real-binary') h.files.set(`${ROOT}/stubs/no-claude-binary/package.json`, JSON.stringify({ name: BINARY, version: NEXT }));
        if (mode === 'wrong-version') h.files.set(`${ROOT}/stubs/no-claude-binary/package.json`, '{"name":"no-claude-binary","version":"1.0.0"}');
      }
      return result;
    };
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.calls).not.toContain(VERIFY);
    expect(h.calls.slice(-2)).toEqual([RESTORE, CI]);
  });
  it.each([RESTORE, CI].flatMap((stage) => [1, null, 'throw'].map((result) => ({ stage, result }))))('reports incomplete rollback for $stage / $result', async ({ stage, result }) => {
    const h = harness(); h.failures.set(COMMIT, 1); h.failures.set(stage, result as number | null | 'throw');
    expect(await promoteClaudeSdk(h.deps)).toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('ROLLBACK INCOMPLETE');
    expect(h.err.join('\n')).toContain(`${RESTORE} && npm ci`);
    if (stage === RESTORE) expect(h.calls).not.toContain(CI);
  });
  it('registers the npm entrypoint without changing the stub override', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string>; overrides: Record<string, string> };
    expect(pkg.scripts['promote:claude-sdk']).toBe('tsx scripts/promote-claude-sdk.ts');
    expect(pkg.overrides[BINARY]).toBe(OVERRIDE);
  });
});
