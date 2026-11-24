import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../upkeep/run-command.ts';
import { resolveClaudeBin, runClaudeJson } from './cli.ts';

describe('resolveClaudeBin', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-claude-bin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function install(name: string, mode: number, sub = '.'): Promise<string> {
    const folder = join(dir, sub);
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, '#!/bin/sh\n');
    await chmod(path, mode);
    return path;
  }

  it('finds a bare command on PATH and answers its absolute path', async () => {
    const claude = await install('claude', 0o755, 'bin');
    expect(await resolveClaudeBin('claude', `/nonexistent:${join(dir, 'bin')}`)).toBe(claude);
  });

  it('skips a PATH entry whose claude is not executable, taking the first that is', async () => {
    await install('claude', 0o644, 'first');
    const second = await install('claude', 0o755, 'second');
    expect(await resolveClaudeBin('claude', `${join(dir, 'first')}:${join(dir, 'second')}`)).toBe(second);
  });

  it('accepts an explicit path without consulting PATH', async () => {
    const claude = await install('my-claude', 0o755);
    expect(await resolveClaudeBin(claude, '')).toBe(claude);
  });

  it('answers null when nothing executable is found', async () => {
    expect(await resolveClaudeBin('claude', join(dir, 'empty'))).toBeNull();
    expect(await resolveClaudeBin(join(dir, 'missing'), '')).toBeNull();
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

/** A spawn whose child prints `stdout`/`stderr` and exits `code` on the next microtask. */
function spawnPrinting(stdout: string, code: number, stderr = '') {
  const spawn = vi.fn((_command: string, _args: string[], _options: object) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, null);
    });
    return child;
  });
  return spawn as typeof spawn & SpawnFn;
}

const ENV = { PATH: '/usr/bin' };

describe('runClaudeJson', () => {
  it('runs the resolved binary with the given arguments and the sanitized env, and parses stdout', async () => {
    const spawn = spawnPrinting('[{"a":1}]', 0);
    const result = await runClaudeJson(['agents', '--json'], { bin: '/opt/claude', env: ENV, timeoutMs: 1000, spawn });
    expect(result).toEqual({ exitCode: 0, json: [{ a: 1 }] });
    expect(spawn).toHaveBeenCalledWith('/opt/claude', ['agents', '--json'], expect.objectContaining({ env: ENV }));
  });

  it('hands back a non-zero exit that still printed JSON, as logged-out auth status does', async () => {
    const spawn = spawnPrinting('{"loggedIn":false}', 1);
    const result = await runClaudeJson(['auth', 'status', '--json'], { bin: 'c', env: ENV, timeoutMs: 1000, spawn });
    expect(result).toEqual({ exitCode: 1, json: { loggedIn: false } });
  });

  it('rejects a non-zero exit without JSON, naming the last stderr line', async () => {
    const spawn = spawnPrinting('', 2, 'warming up\nsomething broke\n');
    await expect(runClaudeJson(['agents', '--json'], { bin: 'c', env: ENV, timeoutMs: 1000, spawn }))
      .rejects.toMatchObject({ code: 'claude_cli_error', message: 'claude agents exited 2: something broke' });
  });

  it('rejects a clean exit whose stdout is not JSON', async () => {
    const spawn = spawnPrinting('not json', 0);
    await expect(runClaudeJson(['agents', '--json'], { bin: 'c', env: ENV, timeoutMs: 1000, spawn }))
      .rejects.toMatchObject({ code: 'claude_bad_output' });
  });

  it('rejects a binary that vanished after resolution as unavailable', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn c ENOENT'), { code: 'ENOENT' })));
      return child;
    }) as unknown as SpawnFn;
    await expect(runClaudeJson(['auth', 'status', '--json'], { bin: 'c', env: ENV, timeoutMs: 1000, spawn }))
      .rejects.toMatchObject({ code: 'claude_unavailable' });
  });

  it('kills a child that outlives the timeout and says so', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    });
    const spawn = vi.fn(() => child) as unknown as SpawnFn;
    await expect(runClaudeJson(['auth', 'status', '--json'], { bin: 'c', env: ENV, timeoutMs: 20, spawn }))
      .rejects.toMatchObject({ code: 'claude_cli_error', message: expect.stringContaining('timed out') as string });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
