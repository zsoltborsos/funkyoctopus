import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { runHelmraiserJson, HelmraiserCli, MISSING_RECHECK_MS, type SpawnLike } from './cli.ts';
import type { HelmraiserStatus } from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { backends, setBackend } from '../health.ts';

/** Historical status output adapted to Helmraiser's count keys and store paths. */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/status.json', import.meta.url), 'utf8'),
) as HelmraiserStatus;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function spawnReturning(child: FakeChild) {
  const spawnFn = vi.fn(() => child);
  return spawnFn as unknown as SpawnLike & ReturnType<typeof vi.fn>;
}

/** Spawns a fake child, feeds it stdout, then closes it cleanly. */
function withCleanClose(args: string[], stdout: string) {
  const child = fakeChild();
  const spawnFn = spawnReturning(child);
  const pending = runHelmraiserJson(args, { bin: 'sq', spawnFn });
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', 0);
  return { pending, spawnFn };
}

describe('runHelmraiserJson', () => {
  it('maps a settings command exit-2 JSON validation error to a typed refusal, not success', async () => {
    const child = fakeChild();
    const spawnFn = spawnReturning(child);
    const args = ['drafts', 'settings', 'set', 'state', '--cooldown-hours', '0', '--json'];
    const pending = runHelmraiserJson(args, { spawnFn });
    const refusal = 'cooldown_hours must be greater than zero';
    child.stdout.emit('data', Buffer.from(JSON.stringify({ error: refusal })));
    child.emit('close', 2);
    await expect(pending).rejects.toBeInstanceOf(WireCallError);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error', message: expect.stringContaining(refusal),
    });
    expect(spawnFn).toHaveBeenCalledWith(expect.any(String), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  });
  it.each([
    ['request', ['drafts', 'request', '/workspace/paused', '--json']],
    ['cancel', ['drafts', 'request', '--cancel', '/workspace/paused', '--json']],
  ])('%s maps exit-2 JSON and stderr refusals without success', async (_name, args) => {
    for (const json of [true, false]) {
      const child = fakeChild();
      const pending = runHelmraiserJson(args, { spawnFn: spawnReturning(child) });
      const refusal = 'project is paused: /workspace/paused';
      if (json) child.stdout.emit('data', Buffer.from(JSON.stringify({ error: refusal })));
      else child.stderr.emit('data', Buffer.from(refusal));
      child.emit('close', 2);
      await expect(pending).rejects.toMatchObject({
        code: 'helmraiser_cli_error', message: expect.stringContaining(refusal),
      });
    }
  });
  it('spawns the binary with piped stdio and resolves the parsed JSON', async () => {
    const { pending, spawnFn } = withCleanClose(['status', '--json'], '{"ok":true}');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(spawnFn).toHaveBeenCalledWith('sq', ['status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('passes cwd when given', async () => {
    const child = fakeChild();
    const spawnFn = spawnReturning(child);
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn, cwd: '/tmp/p' });
    child.stdout.emit('data', Buffer.from('{}'));
    child.emit('close', 0);
    await pending;
    expect(spawnFn).toHaveBeenCalledWith('sq', ['status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/tmp/p',
    });
  });

  it('rejects with helmraiser_unavailable on ENOENT', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.emit('error', Object.assign(new Error('spawn sq ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_unavailable',
      message: 'Helmraiser CLI not found: sq',
    });
    await expect(pending).rejects.toBeInstanceOf(WireCallError);
  });

  it('rejects with helmraiser_cli_error on other spawn errors', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser status failed to start: EACCES',
    });
  });

  it('reports the last non-empty stderr line on a non-zero exit', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stderr.emit('data', Buffer.from('warn: drift\nfatal: lock held\n'));
    child.emit('close', 3);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser status exited 3: fatal: lock held',
    });
  });

  it('carries helmraiser queue remove\'s refusal (exit 2, JSON on stdout) as the rejection message', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['queue', 'remove', 'repo:x', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.from('{"error": "cannot remove task in status running; only queued tasks can be removed"}'));
    child.emit('close', 2);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser queue failed: cannot remove task in status running; only queued tasks can be removed',
    });
  });

  // Wording and exit codes from helmraiser's `retry` (src/helmraiser/cli/commands.py): a refused state is exit 2, a missing worktree exit 1.
  it.each([
    [2, 'run 142d660e-8ed6-4338-9413-5ad16510baaa failed with rejected; retry is only for a run that was blocked or failed verify'],
    [2, 'run 142d660e-8ed6-4338-9413-5ad16510baaa is running, not failed'],
    [1, 'run 142d660e-8ed6-4338-9413-5ad16510baaa cannot be retried: its worktree /repo/.helmraiser/worktrees/x or branch feature/x is gone'],
  ])('carries helmraiser retry\'s refusal (exit %i, JSON on stdout) as the rejection message', async (exit, refusal) => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['retry', '142d660e-8ed6-4338-9413-5ad16510baaa', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ error: refusal })));
    child.emit('close', exit);
    await expect(pending).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: `helmraiser retry failed: ${refusal}` });
  });

  // Wording and exit codes from helmraiser's `rework` (src/helmraiser/cli/commands.py); the first two were also run against the real binary on a throwaway data dir.
  it.each([
    [2, '--note or --rebase is required'],
    [1, 'unknown run: deadbeef'],
    [2, 'run 142d660e-8ed6-4338-9413-5ad16510baaa is running, not awaiting approval'],
    [2, 'run 142d660e-8ed6-4338-9413-5ad16510baaa requires a pending merge approval for rework (not a plan approval)'],
    [2, 'run 142d660e-8ed6-4338-9413-5ad16510baaa already contains main; nothing to rebase'],
    [1, 'run 142d660e-8ed6-4338-9413-5ad16510baaa cannot be reworked: its worktree /repo/.helmraiser/worktrees/x or branch feature/x is gone'],
  ])('carries helmraiser rework\'s refusal (exit %i, JSON on stdout) as the rejection message', async (exit, refusal) => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['rework', '142d660e-8ed6-4338-9413-5ad16510baaa', '--note', 'x', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ error: refusal })));
    child.emit('close', exit);
    await expect(pending).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: `helmraiser rework failed: ${refusal}` });
  });

  it('reports a JSON error envelope from stdout on a non-zero exit', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['approve', 'deadbeef'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.from('{"error": "unknown run: deadbeef"}'));
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser approve failed: unknown run: deadbeef',
    });
    await expect(pending).rejects.toBeInstanceOf(WireCallError);
  });

  it('keeps the stderr message when non-zero stdout is JSON without a string error', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['approve', 'deadbeef'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.from('{"detail": 3}'));
    child.stderr.emit('data', Buffer.from('fatal: nothing to approve\n'));
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser approve exited 1: fatal: nothing to approve',
    });
  });

  it('reports the message inside a boxed CLI error, not its border', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['nope'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stderr.emit('data', Buffer.from(
      "Usage: helmraiser [OPTIONS] COMMAND [ARGS]...\n"
      + '\u256d\u2500 Error \u2500\u2500\u256e\n'
      + "\u2502 No such command 'nope'. \u2502\n"
      + '\u2570\u2500\u2500\u2500\u2500\u256f\n',
    ));
    child.emit('close', 2);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: "helmraiser nope exited 2: No such command 'nope'.",
    });
  });

  it('rejects with helmraiser_bad_output naming the command on invalid JSON', async () => {
    const { pending } = withCleanClose(['status', '--json'], 'not json {');
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_bad_output',
      message: expect.stringContaining('helmraiser status --json did not produce JSON'),
    });
  });

  it('decodes stdout once over the complete bytes, keeping multibyte characters intact', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson<{ title: string }>(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    // 'ö' = 0xC3 0xB6, split across the two chunk boundary.
    child.stdout.emit('data', Buffer.concat([Buffer.from('{"title":"na', 'utf8'), Buffer.from([0xc3])]));
    child.stdout.emit('data', Buffer.concat([Buffer.from([0xb6]), Buffer.from('na"}', 'utf8')]));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ title: 'naöna' });
  });

  it('retains the last 8 KiB of stderr bytes and reports the last non-empty line', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    // More than 8 KiB in total, with a two-byte 'ö' in the final line: the
    // byte-based tail must keep the final line whole and decodable.
    const first = Buffer.from('x'.repeat(8200) + '\n', 'utf8');
    const last = Buffer.from('fötal: lock held\n', 'utf8');
    child.stderr.emit('data', first);
    child.stderr.emit('data', last);
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser status exited 1: fötal: lock held',
    });
  });

  it('reports exactly the retained 8192-byte suffix of oversized single-line stderr', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    const suffix = 'a'.repeat(8191) + 'Z';
    const input = Buffer.from('discarded:' + 'x'.repeat(8200) + suffix, 'utf8');
    child.stderr.emit('data', input);
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: `helmraiser status exited 1: ${suffix}`,
    });
  });

  it('retains 8192 bytes rather than characters across split UTF-8 stderr chunks', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    const suffix = 'ö'.repeat(4095) + 'é';
    const retained = Buffer.from(suffix, 'utf8');
    const prefix = Buffer.from('discarded:' + 'x'.repeat(8200), 'utf8');
    expect(retained.length).toBe(8192);
    // 4096 characters occupy 8192 bytes; the boundaries split the first ö and final é.
    child.stderr.emit('data', Buffer.concat([prefix, retained.subarray(0, 1)]));
    child.stderr.emit('data', retained.subarray(1, 8191));
    child.stderr.emit('data', retained.subarray(8191));
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: `helmraiser status exited 1: ${suffix}`,
    });
  });

  it('rejects with helmraiser_bad_output when stdout exceeds 4 MiB', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    await expect(pending).rejects.toMatchObject({ code: 'helmraiser_bad_output' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the child and reports the timeout', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], {
      bin: 'sq', spawnFn: spawnReturning(child), timeoutMs: 20,
    });
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error',
      message: 'helmraiser status timed out after 0.02 s',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('settles exactly once when error is followed by close', async () => {
    const child = fakeChild();
    const pending = runHelmraiserJson(['status', '--json'], { bin: 'sq', spawnFn: spawnReturning(child) });
    child.emit('error', Object.assign(new Error('spawn sq ENOENT'), { code: 'ENOENT' }));
    child.stdout.emit('data', Buffer.from('{"late":true}'));
    child.emit('close', 0);
    await expect(pending).rejects.toMatchObject({ code: 'helmraiser_unavailable' });
  });
});

describe('runHelmraiserJson with tailLines (JSONL output)', () => {
  const run = (child: FakeChild, tailLines: number) =>
    runHelmraiserJson(['log', 'r1', '--json'], { bin: 'sq', spawnFn: spawnReturning(child), tailLines });

  it('keeps the last N lines, counts every line, and rejoins lines split across chunks', async () => {
    const child = fakeChild();
    const pending = run(child, 2);
    child.stdout.emit('data', Buffer.from('{"id":1}\n{"id"'));
    child.stdout.emit('data', Buffer.from(':2}\n\n{"id":3}\n{"id":4'));
    child.stdout.emit('data', Buffer.from('}'));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ lines: ['{"id":3}', '{"id":4}'], total: 4 });
  });

  it('decodes a multibyte character split across chunks', async () => {
    const child = fakeChild();
    const pending = run(child, 5);
    const bytes = Buffer.from('{"t":"é"}\n');
    child.stdout.emit('data', bytes.subarray(0, 7));
    child.stdout.emit('data', bytes.subarray(7));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ lines: ['{"t":"é"}'], total: 1 });
  });

  it('reads past the 4 MiB single-document ceiling, since only the tail is retained', async () => {
    // A real failed run's `helmraiser log --json` was 4.5 MB (2026-10-19).
    const child = fakeChild();
    const pending = run(child, 2);
    const kib = `${'x'.repeat(1023)}\n`;
    for (let chunk = 0; chunk < 3; chunk += 1) child.stdout.emit('data', Buffer.from(kib.repeat(2048)));
    child.emit('close', 0);
    const result = await pending as { lines: string[]; total: number };
    expect(result.total).toBe(3 * 2048);
    expect(result.lines).toEqual(['x'.repeat(1023), 'x'.repeat(1023)]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([true, false])('accepts exactly 4 MiB of line bytes (terminated: %s)', async (terminated) => {
    const child = fakeChild();
    const pending = run(child, 2);
    const text = 'x'.repeat(4 * 1024 * 1024);
    child.stdout.emit('data', Buffer.from(text + (terminated ? '\n' : '')));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ lines: [text], total: 1 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['x', ' '])('rejects an oversized terminated line in one chunk (%j)', async (character) => {
    const child = fakeChild();
    const pending = run(child, 1);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'helmraiser_bad_output',
      message: 'helmraiser log produced a line longer than 4 MiB',
    });
    child.stdout.emit('data', Buffer.from(`before\n${character.repeat(4 * 1024 * 1024 + 1)}\nafter\n`));
    child.emit('close', 0);
    await rejection;
    await expect(pending).rejects.toBeInstanceOf(WireCallError);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects an oversized terminated line completed across chunks', async () => {
    const child = fakeChild();
    const pending = run(child, 2);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'helmraiser_bad_output',
      message: 'helmraiser log produced a line longer than 4 MiB',
    });
    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024, 'x'));
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('x\n'));
    child.emit('close', 0);
    await rejection;
    await expect(pending).rejects.toBeInstanceOf(WireCallError);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('accepts individually valid lines totaling over 4 MiB in one chunk', async () => {
    const child = fakeChild();
    const pending = run(child, 2);
    const lines = ['a', 'b', 'c'].map((character) => character.repeat(2 * 1024 * 1024));
    child.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ lines: lines.slice(-2), total: 3 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects with helmraiser_bad_output when one line alone outgrows 4 MiB', async () => {
    const child = fakeChild();
    const pending = run(child, 2);
    child.stdout.emit('data', Buffer.from('x'.repeat(5 * 1024 * 1024)));
    await expect(pending).rejects.toMatchObject({ code: 'helmraiser_bad_output' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('carries helmraiser\'s JSON error line as the rejection on a non-zero exit', async () => {
    const child = fakeChild();
    const pending = run(child, 2);
    child.stdout.emit('data', Buffer.from('{"error": "unknown run: nope"}\n'));
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      code: 'helmraiser_cli_error', message: 'helmraiser log failed: unknown run: nope',
    });
  });
});

describe('HelmraiserCli.status', () => {
  it('passes through older status and unknown extra fields', async () => {
    const older = { ...fixture };
    delete older.scouts;
    const future = { ...fixture, future_field: true };
    const cli = new HelmraiserCli(vi.fn().mockResolvedValueOnce(older).mockResolvedValueOnce(future));
    await expect(cli.status()).resolves.toEqual(older);
    await expect(cli.status()).resolves.toEqual(future);
  });
  it('parses Helmraiser *_count fields without legacy top-level keys and marks the backend up', async () => {
    setBackend('helmraiser', 'unknown');
    const runner = vi.fn().mockResolvedValue(fixture);
    const cli = new HelmraiserCli(runner);

    const status = await cli.status();
    expect(status).toEqual(fixture);
    expect(status).toMatchObject({ queued_count: 1, awaiting_count: 1, failed_24h_count: 1 });
    for (const key of ['queued', 'awaiting_approval', 'failed_24h']) expect(status).not.toHaveProperty(key);
    expect(runner).toHaveBeenCalledWith(['status', '--json']);
    expect(backends.helmraiser).toBe('up');
  });

  it('marks the backend down before rethrowing a failure of an installed CLI', async () => {
    setBackend('helmraiser', 'up');
    const runner = vi.fn().mockRejectedValue(new WireCallError('boom', 'helmraiser_cli_error'));
    const cli = new HelmraiserCli(runner);

    await expect(cli.status()).rejects.toMatchObject({ code: 'helmraiser_cli_error' });
    expect(backends.helmraiser).toBe('down');
  });

  it('marks a missing CLI not installed, not down, before rethrowing', async () => {
    setBackend('helmraiser', 'up');
    const runner = vi.fn().mockRejectedValue(new WireCallError('gone', 'helmraiser_unavailable'));
    const cli = new HelmraiserCli(runner, undefined, { warn: () => undefined });

    await expect(cli.status()).rejects.toMatchObject({ code: 'helmraiser_unavailable' });
    expect(backends.helmraiser).toBe('not_installed');
  });

  it('backs off a missing CLI: polls inside the recheck window answer without spawning, then it looks again and recovers', async () => {
    let clock = 1_000_000;
    const gone = new WireCallError('Helmraiser CLI not found: helmraiser', 'helmraiser_unavailable');
    const runner = vi.fn()
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce(fixture);
    const cli = new HelmraiserCli(runner, undefined, { now: () => clock, warn: () => undefined });

    await expect(cli.status()).rejects.toBe(gone);
    // The browser (5 s), the health probe (15 s) and the watcher (30 s) all land in the window.
    clock += 4_000;
    await expect(cli.status()).rejects.toMatchObject({ code: 'helmraiser_unavailable' });
    clock += MISSING_RECHECK_MS - 5_000;
    await expect(cli.status()).rejects.toMatchObject({ code: 'helmraiser_unavailable' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(backends.helmraiser).toBe('not_installed');

    clock += 2_000;
    await expect(cli.status()).resolves.toEqual(fixture);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(backends.helmraiser).toBe('up');
  });

  it('logs a missing CLI once per process, however often it is polled and re-checked', async () => {
    let clock = 0;
    const warn = vi.fn();
    const runner = vi.fn().mockRejectedValue(new WireCallError('gone', 'helmraiser_unavailable'));
    const cli = new HelmraiserCli(runner, undefined, { now: () => clock, warn });

    for (let poll = 0; poll < 5; poll += 1) {
      await expect(cli.status()).rejects.toMatchObject({ code: 'helmraiser_unavailable' });
      clock += MISSING_RECHECK_MS + 1;
    }
    expect(runner).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[helmraiser] not installed (gone): the Helmraiser view is off; looking again every 60 s');
  });

  it('shares one in-flight read between concurrent callers, then reads afresh', async () => {
    let finish: (status: HelmraiserStatus) => void = () => undefined;
    const runner = vi.fn()
      .mockReturnValueOnce(new Promise<HelmraiserStatus>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(fixture);
    const cli = new HelmraiserCli(runner);

    const first = cli.status();
    const second = cli.status();
    finish(fixture);
    await expect(Promise.all([first, second])).resolves.toEqual([fixture, fixture]);
    expect(runner).toHaveBeenCalledTimes(1);

    await cli.status();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('HelmraiserCli.report', () => {
  /**
   * The shape of `helmraiser report --since … --json --models`: the three
   * fat per-run fields (`fragment`, `verify_tails`, `leeboard_entries`) are what
   * make a real 7d report about 144 KB. Values are literals, written down here.
   */
  const rawReport = () => ({
    since: '7d',
    generated_at: '2026-11-22T16:00:00+00:00',
    since_seconds: 604_800,
    landed: [
      { run_id: 'aaaaaaaa-0000', task_id: '-home-example-projects-helmraiser:one', title: 'One', fragment: 'F'.repeat(4000), verify_tails: ['tail one'], leeboard_entries: [{ id: 'e1' }] },
      { run_id: 'bbbbbbbb-0000', task_id: '-home-example-projects-helmraiser:two', title: 'Two', fragment: 'F'.repeat(4000), verify_tails: ['tail two'], leeboard_entries: [] },
      { run_id: 'cccccccc-0000', task_id: '-home-example-projects-helmraiser:three', title: 'Three', fragment: 'F'.repeat(4000), verify_tails: [], leeboard_entries: [] },
    ],
    awaiting: [
      { run_id: 'dddddddd-0000', task_id: '-home-example-projects-funkyoctopus:four', title: 'Four', fragment: 'F'.repeat(4000), verify_tails: [], leeboard_entries: [] },
      { run_id: 'eeeeeeee-0000', task_id: '-home-example-projects-funkyoctopus:five', title: 'Five', fragment: 'F'.repeat(4000), verify_tails: [], leeboard_entries: [] },
    ],
    failed: [
      {
        run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
        task_id: '-home-example-projects-helmraiser:scout-preflight-evidence',
        title: 'Scout preflight evidence',
        failure_reason: 'timeout: pi session exceeded its time limit',
        ended_at: '2026-11-21T15:12:13+00:00',
        fragment: 'F'.repeat(4000),
        verify_tails: ['npm run verify: 3 failed'],
        leeboard_entries: [{ id: 'e2' }],
      },
    ],
    cost: {
      by_model: { 'opencode-go/glm-5.2': 3.5, 'openai-codex/gpt-5.5': 9 },
      total_usd: 12.5,
      spend: { 'opencode-go': { '5h': 1, '7d': 3.5, '30d': 3.5 } },
      warnings: ['one run had no cost record'],
    },
    models: [
      {
        model: 'opencode-go/glm-5.2', runs: 8, landed: 6, failed: 1, first_pass: 5, review_rounds: 2,
        avg_iterations: 1.5, avg_minutes: 14.25, cost_per_landed: 0.5833, median_minutes: 12, p90_minutes: 30,
      },
      {
        model: 'openai-codex/gpt-5.5', runs: 2, landed: 0, failed: 0, first_pass: 0, review_rounds: 0,
        avg_iterations: 1, avg_minutes: 9, cost_per_landed: null, median_minutes: 9, p90_minutes: 9,
      },
    ],
  });

  it('runs the report as a read with the five-minute timeout, never through the action guard', async () => {
    const runner = vi.fn().mockResolvedValue(rawReport());
    const beforeSpawn = vi.fn();
    await new HelmraiserCli(runner, beforeSpawn).report('7d');
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      ['report', '--since', '7d', '--json', '--models'],
      { timeoutMs: 300_000 },
    );
    expect(beforeSpawn).not.toHaveBeenCalled();
  });

  it('maps the raw report to the small wire shape and drops the per-run bulk', async () => {
    const raw = rawReport();
    const cli = new HelmraiserCli(vi.fn().mockResolvedValue(raw));
    const report = await cli.report('7d');
    expect(report).toEqual({
      since: '7d',
      generated_at: '2026-11-22T16:00:00+00:00',
      landed_count: 3,
      awaiting_count: 2,
      failed: [{
        run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
        task_id: '-home-example-projects-helmraiser:scout-preflight-evidence',
        title: 'Scout preflight evidence',
        failure_reason: 'timeout: pi session exceeded its time limit',
        ended_at: '2026-11-21T15:12:13+00:00',
      }],
      cost: { total_usd: 12.5, by_model: { 'opencode-go/glm-5.2': 3.5, 'openai-codex/gpt-5.5': 9 } },
      models: [
        { model: 'opencode-go/glm-5.2', runs: 8, landed: 6, failed: 1, first_pass: 5, review_rounds: 2, avg_iterations: 1.5, avg_minutes: 14.25, cost_per_landed: 0.5833 },
        { model: 'openai-codex/gpt-5.5', runs: 2, landed: 0, failed: 0, first_pass: 0, review_rounds: 0, avg_iterations: 1, avg_minutes: 9, cost_per_landed: null },
      ],
    });
    // The raw report is tens of KB here; what crosses the wire is under 2 KB.
    expect(JSON.stringify(raw).length).toBeGreaterThan(20_000);
    expect(JSON.stringify(report).length).toBeLessThan(2_000);
    expect(JSON.stringify(report)).not.toMatch(/fragment|verify_tails|leeboard_entries|warnings|spend/);
  });

  it('reports no model rows when an older Helmraiser sends no models, and nulls for missing failure facts', async () => {
    const raw = rawReport() as Record<string, unknown>;
    delete raw.models;
    const failed = raw.failed as Array<Record<string, unknown>>;
    delete failed[0]!.failure_reason;
    delete failed[0]!.ended_at;
    const report = await new HelmraiserCli(vi.fn().mockResolvedValue(raw)).report('24h');
    expect(report.since).toBe('24h');
    expect(report.models).toEqual([]);
    expect(report.failed).toEqual([{
      run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
      task_id: '-home-example-projects-helmraiser:scout-preflight-evidence',
      title: 'Scout preflight evidence',
      failure_reason: null,
      ended_at: null,
    }]);
  });

  it('shares one in-flight read per window, a different window gets its own, then reads afresh', async () => {
    const finish: Record<string, () => void> = {};
    const runner = vi.fn((args: string[]) => new Promise((resolve) => {
      finish[args[2]!] = () => resolve({ ...rawReport(), since: args[2] });
    }));
    const cli = new HelmraiserCli(runner as never);

    const first = cli.report('7d');
    const second = cli.report('7d');
    const month = cli.report('30d');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map(([args]) => args[2])).toEqual(['7d', '30d']);
    finish['7d']!();
    finish['30d']!();
    const [a, b, c] = await Promise.all([first, second, month]);
    expect(a).toBe(b);
    expect(c.since).toBe('30d');

    const again = cli.report('7d');
    expect(runner).toHaveBeenCalledTimes(3);
    finish['7d']!();
    await again;
  });

  it('lets a failed read through and does not keep it: the next call spawns again', async () => {
    const failure = new WireCallError('helmraiser report timed out after 300 s', 'helmraiser_cli_error');
    const runner = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(rawReport());
    const cli = new HelmraiserCli(runner);
    await expect(cli.report('30d')).rejects.toBe(failure);
    await expect(cli.report('30d')).resolves.toMatchObject({ since: '30d', landed_count: 3 });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('HelmraiserCli.stats', () => {
  /** The `helmraiser stats --since all --json` contract, trimmed to three scout rows; values are literals from a real ledger. */
  const rawStats = () => ({
    window: { since: 'all', since_seconds: null, generated_at: '2026-11-22T17:58:24.417553+00:00', project: null },
    runs: {
      overall: { landed: 807, failed: 86, aborted: 7, awaiting_approval: 0, active: 1 },
      by_project: [{ project: '/home/example/projects/funkyoctopus', landed: 52, failed: 2, aborted: 1, awaiting_approval: 0, active: 0 }],
    },
    quality: {
      first_time_right: { count: 515, rate: 0.638 }, rework_rate: 0.117, scope_request_rate: 0.097, retried_tasks: 37,
      review_verdicts: { pass: 692, concerns: 123, uncertain: 28, none: 58 },
    },
    failures: { timeout: { count: 3, run_ids: ['ac0e658b-c3cf-4d67-a748-234e920f422b'] } },
    cost: { total_usd: 1461.36, plan_usd: 151.0, implement_usd: 624.02, other_usd: 686.33, per_landed_usd: 1.81 },
    latency: {
      active_minutes: { median: 14.6, p90: 34.5 },
      approval_wait_minutes: { plan: { median: 0.76, p90: 14.8 }, scope: { median: null, p90: null }, merge: { median: 0.92, p90: 16.8 } },
    },
    scouts: [
      {
        project: '/home/example/projects/funkyoctopus', lens: 'state', scouts: 1, succeeded: 1, failed: 0, running: 0, drafts_written: 2,
        cost_usd: 0.2295504, pending: 0, queued: 0, landed: 2, dropped: 0,
        dropped_by_class: { wrong: 0, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 0 }, failed_drafts: 0, queued_unchanged: 0,
        queued_changed: 0, queued_unknown: 2, last_scout_ended_at: '2026-11-21T15:07:35.322397+00:00', last_scout_ok: true,
        last_scout_error: null, last_scout_drafts: 2, auto: false, cooldown_hours: 24,
        next_eligible_at: '2026-11-21T15:07:35.322397+00:00', scheduling_error: null, in_focus: true,
      },
    ],
    weekly: [{ week: '2026-W47', landed: 87, failed: 1, first_time_right_rate: 0.632, drafts_written: 41, drafts_landed: 32 }],
  });

  it('runs the stats as a read with the default timeout, never through the action guard, and returns the JSON unchanged', async () => {
    const raw = rawStats();
    const runner = vi.fn().mockResolvedValue(raw);
    const beforeSpawn = vi.fn();
    const stats = await new HelmraiserCli(runner, beforeSpawn).stats('all');
    expect(runner).toHaveBeenCalledExactlyOnceWith(['stats', '--since', 'all', '--json']);
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(stats).toBe(raw);
  });

  it('appends --project, a path with spaces staying one argument', async () => {
    const runner = vi.fn().mockResolvedValue(rawStats());
    await new HelmraiserCli(runner).stats('7d', '/work/repo one');
    expect(runner).toHaveBeenCalledExactlyOnceWith(['stats', '--since', '7d', '--json', '--project', '/work/repo one']);
  });

  it('shares one in-flight read per window and project, another key gets its own, then reads afresh', async () => {
    const finish: Array<() => void> = [];
    const runner = vi.fn((_args: string[]) => new Promise((resolve) => { finish.push(() => resolve(rawStats())); }));
    const cli = new HelmraiserCli(runner as never);

    const first = cli.stats('all');
    const second = cli.stats('all');
    const week = cli.stats('7d');
    const projectA = cli.stats('all', '/work/a');
    const projectAAgain = cli.stats('all', '/work/a');
    const projectB = cli.stats('all', '/work/b');
    expect(runner.mock.calls.map(([args]) => args.slice(2).join(' '))).toEqual([
      'all --json', '7d --json', 'all --json --project /work/a', 'all --json --project /work/b',
    ]);
    finish.forEach((resolve) => resolve());
    const [a, b, , c, d, e] = await Promise.all([first, second, week, projectA, projectAAgain, projectB]);
    expect(a).toBe(b);
    expect(c).toBe(d);
    expect(e).not.toBe(c);

    const again = cli.stats('all');
    expect(runner).toHaveBeenCalledTimes(5);
    finish.at(-1)!();
    await again;
  });

  it('lets a failed read through and does not keep it: the next call spawns again', async () => {
    const failure = new WireCallError('helmraiser stats failed: database requires migration', 'helmraiser_cli_error');
    const runner = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(rawStats());
    const cli = new HelmraiserCli(runner);
    await expect(cli.stats('30d')).rejects.toBe(failure);
    await expect(cli.stats('30d')).resolves.toMatchObject({ window: { since: 'all' } });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('HelmraiserCli actions', () => {
  /** A recording runner returning one distinct object per call. */
  function recordingRunner() {
    let n = 0;
    return vi.fn(() => Promise.resolve({ call: n++ })) as ReturnType<typeof vi.fn>;
  }

  it.each([
    ['approve without a note', (cli: HelmraiserCli) => cli.approve('run-1'), ['approve', 'run-1', '--json'], { timeoutMs: 120_000 }],
    ['approve with a note', (cli: HelmraiserCli) => cli.approve('run-1', 'looks good'), ['approve', 'run-1', '--json', '--note', 'looks good'], { timeoutMs: 120_000 }],
    ['approve with a blank note', (cli: HelmraiserCli) => cli.approve('run-1', '  '), ['approve', 'run-1', '--json'], { timeoutMs: 120_000 }],
    ['reject with a note', (cli: HelmraiserCli) => cli.reject('run-1', 'not ready'), ['reject', 'run-1', '--json', '--note', 'not ready'], undefined],
    ['reject without a note', (cli: HelmraiserCli) => cli.reject('run-1'), ['reject', 'run-1', '--json'], undefined],
    ['reject with a blank note', (cli: HelmraiserCli) => cli.reject('run-1', '  '), ['reject', 'run-1', '--json'], undefined],
    ['startWorker', (cli: HelmraiserCli) => cli.startWorker(), ['worker', 'start', '--json'], undefined],
    ['stopWorker', (cli: HelmraiserCli) => cli.stopWorker(), ['worker', 'stop', '--json'], undefined],
    ['pause', (cli: HelmraiserCli) => cli.pause(), ['queue', 'pause', '--json', '--reason', 'paused from FunkyOctopus'], undefined],
    ['resume', (cli: HelmraiserCli) => cli.resume(), ['queue', 'resume', '--json'], undefined],
    ['draft', (cli: HelmraiserCli) => cli.draft('/repo', 'T', 'goal'), ['add', '--project', '/repo', '--title', 'T', 'goal', '--json'], undefined],
    ['drafts listing', (cli: HelmraiserCli) => cli.drafts(), ['drafts', '--json'], undefined],
    ['request scouts', (cli: HelmraiserCli) => cli.requestScouts(['/repo one', '/repo-two']), ['drafts', 'request', '/repo one', '/repo-two', '--json'], undefined],
    ['cancel scouts', (cli: HelmraiserCli) => cli.cancelScouts(['/repo one', '/repo-two']), ['drafts', 'request', '--cancel', '/repo one', '/repo-two', '--json'], undefined],
    ['propose', (cli: HelmraiserCli) => cli.propose('/repo/.helmraiser/tasks/x.md'), ['intake', '/repo/.helmraiser/tasks/x.md', '--propose', '--json'], { timeoutMs: 300_000 }],
    ['queue task', (cli: HelmraiserCli) => cli.queue('/repo/.helmraiser/tasks/x.md'), ['intake', '/repo/.helmraiser/tasks/x.md', '--yes', '--json'], { timeoutMs: 120_000 }],
    ['queue task with origin', (cli: HelmraiserCli) => cli.queue('/repo/.helmraiser/tasks/x.md', 'fo:/absolute/session.jsonl'), ['intake', '/repo/.helmraiser/tasks/x.md', '--yes', '--origin', 'fo:/absolute/session.jsonl', '--json'], { timeoutMs: 120_000 }],
    ['drop draft', (cli: HelmraiserCli) => cli.dropDraft('repo:x', 'not useful now'), ['drafts', 'drop', 'repo:x', '--reason', 'not useful now', '--json'], undefined],
    ['drop draft with a class', (cli: HelmraiserCli) => cli.dropDraft('repo:x', 'not useful now', 'unwanted'), ['drafts', 'drop', 'repo:x', '--reason', 'not useful now', '--class', 'unwanted', '--json'], undefined],
    // Full task ids start with "-" (the project slug of an absolute path); helmraiser's own parser takes them as the task.
    ['queue remove', (cli: HelmraiserCli) => cli.queueRemove('-home-example-projects-demo-api:board-sync'), ['queue', 'remove', '-home-example-projects-demo-api:board-sync', '--json'], undefined],
    ['retry', (cli: HelmraiserCli) => cli.retry('142d660e-8ed6-4338-9413-5ad16510baaa'), ['retry', '142d660e-8ed6-4338-9413-5ad16510baaa', '--json'], undefined],
    ['retry with implement false', (cli: HelmraiserCli) => cli.retry('142d660e', false), ['retry', '142d660e', '--json'], undefined],
    ['retry --implement', (cli: HelmraiserCli) => cli.retry('142d660e', true), ['retry', '142d660e', '--implement', '--json'], undefined],
    ['rework with a note', (cli: HelmraiserCli) => cli.rework('142d660e', 'clarify widget'), ['rework', '142d660e', '--note', 'clarify widget', '--json'], undefined],
    ['rework with a note and rebase', (cli: HelmraiserCli) => cli.rework('142d660e', 'keep the 30 s limit', true), ['rework', '142d660e', '--note', 'keep the 30 s limit', '--rebase', '--json'], undefined],
    // Helmraiser accepts a rebase on its own and supplies its default note.
    ['rework with rebase alone', (cli: HelmraiserCli) => cli.rework('142d660e', undefined, true), ['rework', '142d660e', '--rebase', '--json'], undefined],
    // One argv element each, no shell: helmraiser's parser takes the value after --note whatever it looks like (checked against the real binary).
    ['rework with a note that looks like options', (cli: HelmraiserCli) => cli.rework('142d660e', '--rebase --json', false), ['rework', '142d660e', '--note', '--rebase --json', '--json'], undefined],
    ['rework with quotes, newlines and a leading dash', (cli: HelmraiserCli) => cli.rework('142d660e', '-x "quoted" \'single\'\nsecond line $(not run) `nor this`', false), ['rework', '142d660e', '--note', '-x "quoted" \'single\'\nsecond line $(not run) `nor this`', '--json'], undefined],
  ])('%s spawns exactly that command', async (_name, call, args, options) => {
    const runner = recordingRunner();
    const cli = new HelmraiserCli(runner as never);
    await expect(call(cli)).resolves.toEqual({ call: 0 });
    if (_name === 'drafts listing') expect(runner).toHaveBeenCalledWith(args);
    else expect(runner).toHaveBeenCalledWith(args, options);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['settings set', (cli: HelmraiserCli) => cli.setScoutSettings({ lens: 'docs', auto: false, cooldownHours: 1.5 }), ['drafts', 'settings', 'set', 'docs', '--auto', 'off', '--cooldown-hours', '1.5', '--json']],
    ['settings reset', (cli: HelmraiserCli) => cli.resetScoutSettings('tests'), ['drafts', 'settings', 'reset', 'tests', '--json']],
    ['approve', (cli: HelmraiserCli) => cli.approve('run-1', 'plan note'), ['approve', 'run-1', '--json', '--note', 'plan note']],
    ['reject', (cli: HelmraiserCli) => cli.reject('run-1', 'why'), ['reject', 'run-1', '--json', '--note', 'why']],
    ['startWorker', (cli: HelmraiserCli) => cli.startWorker(), ['worker', 'start', '--json']],
    ['stopWorker', (cli: HelmraiserCli) => cli.stopWorker(), ['worker', 'stop', '--json']],
    ['pause', (cli: HelmraiserCli) => cli.pause(), ['queue', 'pause', '--json', '--reason', 'paused from FunkyOctopus']],
    ['resume', (cli: HelmraiserCli) => cli.resume(), ['queue', 'resume', '--json']],
    ['draft', (cli: HelmraiserCli) => cli.draft('/repo', 'T', 'goal'), ['add', '--project', '/repo', '--title', 'T', 'goal', '--json']],
    ['propose', (cli: HelmraiserCli) => cli.propose('/repo/.helmraiser/tasks/x.md'), ['intake', '/repo/.helmraiser/tasks/x.md', '--propose', '--json']],
    ['queue task', (cli: HelmraiserCli) => cli.queue('/repo/.helmraiser/tasks/x.md'), ['intake', '/repo/.helmraiser/tasks/x.md', '--yes', '--json']],
    ['queue task with origin', (cli: HelmraiserCli) => cli.queue('/repo/.helmraiser/tasks/x.md', 'fo:/absolute/session.jsonl'), ['intake', '/repo/.helmraiser/tasks/x.md', '--yes', '--origin', 'fo:/absolute/session.jsonl', '--json']],
    ['drop draft', (cli: HelmraiserCli) => cli.dropDraft('repo:x', 'duplicate idea'), ['drafts', 'drop', 'repo:x', '--reason', 'duplicate idea', '--json']],
    ['drop draft with a class', (cli: HelmraiserCli) => cli.dropDraft('repo:x', 'duplicate idea', 'duplicate'), ['drafts', 'drop', 'repo:x', '--reason', 'duplicate idea', '--class', 'duplicate', '--json']],
    ['queue remove', (cli: HelmraiserCli) => cli.queueRemove('repo:x'), ['queue', 'remove', 'repo:x', '--json']],
    ['retry', (cli: HelmraiserCli) => cli.retry('142d660e'), ['retry', '142d660e', '--json']],
    ['retry --implement', (cli: HelmraiserCli) => cli.retry('142d660e', true), ['retry', '142d660e', '--implement', '--json']],
    ['rework', (cli: HelmraiserCli) => cli.rework('142d660e', 'fix the edge case', true), ['rework', '142d660e', '--note', 'fix the edge case', '--rebase', '--json']],
    ['request scouts', (cli: HelmraiserCli) => cli.requestScouts(['/repo one', '/repo-two']), ['drafts', 'request', '/repo one', '/repo-two', '--json']],
    ['cancel scouts', (cli: HelmraiserCli) => cli.cancelScouts(['/repo one', '/repo-two']), ['drafts', 'request', '--cancel', '/repo one', '/repo-two', '--json']],
  ])('%s awaits beforeSpawn before spawning', async (_name, call, args) => {
    const runner = recordingRunner();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const beforeSpawn = vi.fn(() => held);
    const cli = new HelmraiserCli(runner as never, beforeSpawn);

    const pending = call(cli);
    await Promise.resolve(); // flush microtasks: the action must be waiting on the gate
    expect(runner).not.toHaveBeenCalled();
    release();
    await pending;
    expect(beforeSpawn).toHaveBeenCalledWith(args);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('never calls beforeSpawn for status or drafts listing', async () => {
    setBackend('helmraiser', 'unknown');
    const runner = vi.fn().mockResolvedValueOnce(fixture).mockResolvedValueOnce([]);
    const beforeSpawn = vi.fn();
    const cli = new HelmraiserCli(runner, beforeSpawn);

    await cli.status();
    await cli.drafts();
    await cli.scoutSettings();
    await cli.allDrafts();
    expect(runner).toHaveBeenCalledWith(['drafts', 'settings', '--json']);
    expect(runner).toHaveBeenCalledWith(['drafts', '--all', '--json']);
    expect(beforeSpawn).not.toHaveBeenCalled();
  });

  describe('log', () => {
    const lines = [
      '{"id": 7, "run_id": "142d660e", "ts": 1.5, "source": "helmraiser", "stage": null, "session_id": null, "type": "run_start", "payload": {"task_id": "t"}}',
      'not json',
    ];

    it.each([
      ['without a cursor', undefined, ['log', '142d660e', '--json']],
      ['after an event id', 338270, ['log', '142d660e', '--json', '--since-id', '338270']],
      ['after id 0', 0, ['log', '142d660e', '--json', '--since-id', '0']],
    ])('reads %s, keeping the last 200 lines', async (_name, sinceId, args) => {
      const runner = vi.fn().mockResolvedValue({ lines, total: 2 });
      const cli = new HelmraiserCli(runner);
      const result = sinceId === undefined ? await cli.log('142d660e') : await cli.log('142d660e', sinceId);
      expect(runner).toHaveBeenCalledExactlyOnceWith(args, { tailLines: 200 });
      expect(result).toEqual({
        events: [{ id: 7, ts: 1.5, source: 'helmraiser', stage: null, type: 'run_start', payload: { task_id: 't' } }],
        truncated: false,
      });
    });

    it('says so when helmraiser printed more lines than were kept', async () => {
      const cli = new HelmraiserCli(vi.fn().mockResolvedValue({ lines, total: 422 }));
      await expect(cli.log('142d660e')).resolves.toMatchObject({ truncated: true });
    });

    it('is a read: it never waits on the action guard', async () => {
      const beforeSpawn = vi.fn();
      await new HelmraiserCli(vi.fn().mockResolvedValue({ lines, total: 2 }), beforeSpawn).log('142d660e');
      expect(beforeSpawn).not.toHaveBeenCalled();
    });

    it('lets the runner\'s rejection through', async () => {
      const cli = new HelmraiserCli(vi.fn().mockRejectedValue(new WireCallError('helmraiser log failed: unknown run: nope', 'helmraiser_cli_error')));
      await expect(cli.log('beef')).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'helmraiser log failed: unknown run: nope' });
    });
  });

  it.each(['state', 'docs', 'tests'] as const)('forwards and guards the %s lens', async (lens) => {
    for (const method of ['requestScouts', 'cancelScouts'] as const) {
      const args = ['drafts', 'request', ...(method === 'cancelScouts' ? ['--cancel'] : []), '/repo one', '/b', '--lens', lens, '--json'];
      const runner = recordingRunner();
      let release!: () => void;
      const guard = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
      const pending = new HelmraiserCli(runner as never, guard)[method](['/repo one', '/b'], lens);
      expect(guard).toHaveBeenCalledWith(args);
      expect(runner).not.toHaveBeenCalled();
      release();
      await expect(pending).resolves.toEqual({ call: 0 });
      expect(runner).toHaveBeenCalledExactlyOnceWith(args, undefined);
      runner.mockClear();
      await expect(new HelmraiserCli(runner as never, () => Promise.reject(new Error('denied')))[method](['/a'], lens)).rejects.toThrow('denied');
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it.each(['requestScouts', 'cancelScouts'] as const)('%s propagates exact results and guard rejection', async (method) => {
    const result = method === 'requestScouts'
      ? { requested: ['/a'], already_pending: ['/b'] }
      : { cancelled: ['/a'], not_pending: ['/b'] };
    const runner = vi.fn().mockResolvedValue(result);
    await expect(new HelmraiserCli(runner)[method](['/a', '/b'])).resolves.toBe(result);
    runner.mockClear();
    const cli = new HelmraiserCli(runner, vi.fn().mockRejectedValue(new Error('vault says no')));
    await expect(cli[method](['/a', '/b'])).rejects.toThrow('vault says no');
    expect(runner).not.toHaveBeenCalled();
  });

  it('a rejecting beforeSpawn stops drop from running', async () => {
    const runner = recordingRunner();
    const beforeSpawn = vi.fn().mockRejectedValue(new Error('vault says no'));
    const cli = new HelmraiserCli(runner as never, beforeSpawn);

    await expect(cli.dropDraft('repo:x', 'duplicate')).rejects.toMatchObject({ message: 'vault says no' });
    expect(runner).not.toHaveBeenCalled();
  });
});
