import { afterEach, describe, expect, it, vi } from 'vitest';
import type { execFile } from 'node:child_process';
import { LB_NOT_FOUND, createLbRunner } from './cli.ts';
import { backends, trackBackend } from '../health.ts';

type ExecCallback = (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void;

/** A stand-in for `execFile` at the process boundary: answers every spawn the same way. */
function fakeExec(answer: { error?: Error & { code?: unknown }; stdout?: string; stderr?: string }) {
  const exec = vi.fn((_file: string, _args: readonly string[], _options: unknown, callback: ExecCallback) => {
    callback(answer.error ?? null, answer.stdout ?? '', answer.stderr ?? '');
  });
  return exec as unknown as typeof execFile & typeof exec;
}

const enoent = Object.assign(new Error('spawn lb ENOENT'), { code: 'ENOENT' });

afterEach(() => {
  trackBackend('leeboard', false);
});

describe('the lb runner when lb is not installed', () => {
  it('answers every call as not found, marks Leeboard not installed, and says so once per process', async () => {
    const warn = vi.fn();
    const run = createLbRunner(fakeExec({ error: enoent }), warn);

    for (let call = 0; call < 4; call += 1) {
      await expect(run(['brief', '--json'])).resolves.toEqual({ code: LB_NOT_FOUND, stdout: '', stderr: '' });
    }

    expect(backends.leeboard).toBe('not_installed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[leeboard] lb is not installed (not found on PATH): the Leeboard panel and Leeboard's project list are off");
  });

  it('drops the not-installed mark once lb answers, even with a non-zero exit', async () => {
    const warn = vi.fn();
    const missing = createLbRunner(fakeExec({ error: enoent }), warn);
    await missing(['list']);
    expect(backends.leeboard).toBe('not_installed');

    const present = createLbRunner(fakeExec({ error: Object.assign(new Error('exit 4'), { code: 4 }), stderr: 'no such entry' }), warn);
    await expect(present(['show', 'rule-x'])).resolves.toEqual({ code: 4, stdout: '', stderr: 'no such entry' });
    expect(Object.keys(backends)).not.toContain('leeboard');
  });

  it('adds no Leeboard entry to the status strip while lb works', async () => {
    const run = createLbRunner(fakeExec({ stdout: '[]' }), vi.fn());
    await expect(run(['project', 'list', '--json'])).resolves.toEqual({ code: 0, stdout: '[]', stderr: '' });
    expect(Object.keys(backends)).not.toContain('leeboard');
  });
});
