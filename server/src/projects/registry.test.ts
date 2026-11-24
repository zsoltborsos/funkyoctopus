import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownProjects, projectPathIndex } from './registry.ts';
import { remapCwd } from './remap.ts';
import { defaultLbRunner, LB_TIMEOUT_MS, type LbInvocation, type LbCliRunner } from '../leeboard/cli.ts';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

function runner(payload: Partial<LbInvocation>): LbCliRunner {
  return vi.fn((args) => {
    expect(args).toEqual(['project', 'list', '--json']);
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...payload });
  });
}

/** Scratch dir the fixture entries point at; recreated per test. */
let scratch = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'funkyoctopus-registry-'));
  await mkdir(join(scratch, 'helmraiser'), { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('defaultLbRunner', () => {
  it.each([
    [null, 0],
    [Object.assign(new Error('exit'), { code: 7 }), 7],
    // Shell conventions, so the Leeboard panel can tell "no lb" and "too slow" apart.
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), 127],
    [Object.assign(new Error('timeout'), { killed: true }), 124],
    [new Error('other'), 1],
  ])('resolves CLI success/failure as a value (%s)', async (error, code) => {
    // A missing lb is said once per process; this is not the test of that.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    execFile.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(error, 'output', 'diagnostic'));
    await expect(defaultLbRunner(['project', 'list', '--json'])).resolves.toEqual({
      code, stdout: 'output', stderr: 'diagnostic',
    });
    expect(execFile).toHaveBeenLastCalledWith(
      'lb', ['project', 'list', '--json'],
      { timeout: LB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: expect.any(Object) }, expect.any(Function),
    );
  });

  it("never lends FO an agent session's Leeboard identity from the sidecar's environment", async () => {
    vi.stubEnv('LEEBOARD_SESSION', 'someone-elses-session');
    vi.stubEnv('LEEBOARD_HARNESS', 'pi');
    vi.stubEnv('LEEBOARD_HOME', '/tmp/a-store');
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
      callback(null, '', ''));
    try {
      await defaultLbRunner(['brief', '--json']);
    } finally {
      vi.unstubAllEnvs();
    }
    const env = (execFile.mock.lastCall?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.LEEBOARD_SESSION).toBeUndefined();
    expect(env.LEEBOARD_HARNESS).toBeUndefined();
    expect(env.LEEBOARD_HOME).toBe('/tmp/a-store');
  });

});

describe('knownProjects', () => {
  it('uses Leeboard names and the first existing directory, with one entry per project', async () => {
    const root = join(scratch, 'helmraiser');
    const nested = join(root, 'nested');
    const other = join(scratch, 'demo-api');
    await mkdir(nested);
    await mkdir(other);
    const run = runner({ stdout: JSON.stringify([
      { name: 'helmraiser', aliases: ['old-name'], paths: [root, nested], remotes: [] },
      { name: 'demo-api', aliases: [], paths: [join(scratch, 'gone'), other], remotes: [] },
      { name: 'missing', paths: [join(scratch, 'missing')] },
    ]) });
    expect(await knownProjects(run)).toEqual([
      { id: root, name: 'helmraiser', path: root, envTier: 'normal' },
      { id: other, name: 'demo-api', path: other, envTier: 'normal' },
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not select a regular file as the folder', async () => {
    const file = join(scratch, 'plain.txt');
    await writeFile(file, 'x');
    const root = join(scratch, 'helmraiser');
    expect(await knownProjects(runner({ stdout: JSON.stringify([
      { name: 'file-only', paths: [file] },
      { name: 'real', paths: [file, root] },
    ]) }))).toEqual([{ id: root, name: 'real', path: root, envTier: 'normal' }]);
  });

  it('ignores malformed path elements without losing a usable entry', async () => {
    const root = join(scratch, 'helmraiser');
    expect(await knownProjects(runner({ stdout: JSON.stringify([
      { name: 'real', paths: [null, 7, {}, '', { path: root }, root] },
    ]) }))).toEqual([{ id: root, name: 'real', path: root, envTier: 'normal' }]);
  });
});

describe.each([
  ['selector', knownProjects],
  ['path index', projectPathIndex],
] as const)('%s defensive reads', (_name, read) => {
  it.each([
    ['non-zero exit', { code: 1, stdout: '', stderr: 'lb: the store is locked' }],
    ['unparsable JSON', { stdout: 'not json at all' }],
    ['non-array', { stdout: '{"projects":[]}' }],
    ['malformed entries', { stdout: JSON.stringify([
      null, 7, [], {}, { name: '', paths: ['/x'] },
      { name: 7, paths: ['/x'] }, { name: 'no-paths' },
      { name: 'bad-paths', paths: '/x' }, { name: 'empty-paths', paths: [null, '', {}] },
    ]) }],
  ])('returns an empty registry and warns on %s', async (_case, payload) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await read(runner(payload))).toEqual([]);
    expect(warn).toHaveBeenCalled();
    for (const [message] of warn.mock.calls) {
      expect(message).toMatch(/^\[projects\] lb project list /);
    }
  });

  it('returns an empty registry without a word when lb is not installed: the runner already said so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await read(runner({ code: 127, stdout: '', stderr: '' }))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns an empty registry if an injected runner rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejected: LbCliRunner = () => Promise.reject(new Error('spawn lb ENOENT'));
    expect(await read(rejected)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[projects] lb project list failed, treating as empty', '',
    );
  });

  it('skips malformed entries while preserving usable projects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = join(scratch, 'helmraiser');
    const result = await read(runner({ stdout: JSON.stringify([
      null, { name: 'helmraiser', paths: [root] }, { name: 'bad' },
    ]) }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'helmraiser', path: root });
  });
});

describe('projectPathIndex', () => {
  it('indexes only missing paths, deduplicated in order, and remaps a recorded cwd', async () => {
    const root = join(scratch, 'helmraiser');
    const nested = join(root, 'nested');
    const old = join(scratch, 'old-machine', 'helmraiser');
    const older = join(scratch, 'older-machine', 'helmraiser');
    const file = join(scratch, 'plain.txt');
    await mkdir(nested);
    await writeFile(file, 'x');
    const run = runner({ stdout: JSON.stringify([
      { name: 'helmraiser', aliases: [], paths: [old, root, nested, old, older, file], remotes: [] },
      { name: 'missing', paths: [join(scratch, 'gone-project')] },
    ]) });
    const index = await projectPathIndex(run);
    expect(run).toHaveBeenCalledOnce();
    expect(index).toEqual([{ name: 'helmraiser', path: root, oldPaths: [old, older] }]);
    expect(await remapCwd(join(old, 'nested'), index)).toEqual({
      cwd: nested, movedFrom: join(old, 'nested'),
    });
    expect(await remapCwd(join(old, 'gone-subfolder'), index)).toEqual({
      cwd: root, movedFrom: join(old, 'gone-subfolder'),
    });
  });
});
