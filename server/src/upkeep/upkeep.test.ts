import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_UPKEEP_INTERVAL_MS,
  MissingBinaryError,
  TailBuffer,
  Upkeep,
  driftOf,
  runPiCommand,
  type UpkeepOptions,
} from './upkeep.ts';
import {
  EMBEDDED_STATE_FILE,
  defaultEmbeddedState,
  parseEmbeddedState,
  type EmbeddedStateFs,
} from './embedded-state.ts';
import { ensureStateDir } from './state-path.ts';
import type { ClaudeSdkUpkeepInfo } from '../../../src/shared/transport/protocol.ts';

/** Fake global `pi` for the production-runner tests. */
const FAKE_PI = `#!/bin/sh
if [ "$1" = "missing" ]; then echo "no such command" >&2; exit 1; fi
if [ "$1" = "huge" ]; then head -c 100000 /dev/zero | tr '\\0' 'x'; printf 'done'; exit 0; fi
printf 'line one\\nline two\\n'
`;

function makeDeps(
  overrides: Partial<
    Omit<
      UpkeepOptions,
      'runUpdate' | 'readGlobalVersion' | 'readEmbeddedVersion' | 'readInstalledVersion' | 'readStableLatest'
    >
  > = {},
) {
  const clock = { now: 0 };
  const runUpdate = vi
    .fn<(signal: AbortSignal) => Promise<string>>()
    .mockResolvedValue('up to date');
  const readGlobalVersion = vi.fn<() => Promise<string | null>>().mockResolvedValue('0.84.1');
  const readEmbeddedVersion = vi.fn<() => Promise<string | null>>().mockResolvedValue('0.81.1');
  const readInstalledVersion = vi.fn<() => Promise<string | null>>().mockResolvedValue('0.84.1');
  const readStableLatest = vi.fn<() => Promise<string | null>>().mockResolvedValue('0.84.1');
  const deps: UpkeepOptions = {
    disabled: overrides.disabled ?? false,
    intervalMs: overrides.intervalMs ?? 5_000,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    runUpdate,
    readGlobalVersion,
    readEmbeddedVersion,
    readInstalledVersion,
    readStableLatest,
    now: overrides.now ?? (() => clock.now),
  };
  if (overrides.readClaudeSdk !== undefined) deps.readClaudeSdk = overrides.readClaudeSdk;
  if (overrides.deferUpdate !== undefined) deps.deferUpdate = overrides.deferUpdate;
  if (overrides.minIntervalMs !== undefined) deps.minIntervalMs = overrides.minIntervalMs;
  if (overrides.embeddedState !== undefined) deps.embeddedState = overrides.embeddedState;
  return {
    deps,
    clock,
    runUpdate,
    readGlobalVersion,
    readEmbeddedVersion,
    readInstalledVersion,
    readStableLatest,
  };
}

/** In-memory fs for the durable-state tests; keys are full file paths. */
function memoryFs() {
  const files = new Map<string, string>();
  const fs: EmbeddedStateFs = {
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
      }
      return Promise.resolve(content);
    },
    writeFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const content = files.get(from);
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' }));
      }
      files.delete(from);
      files.set(to, content);
      return Promise.resolve();
    },
    unlink: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(undefined),
    chmod: () => Promise.resolve(undefined),
  };
  return { files, fs };
}

const realStateFs: EmbeddedStateFs = {
  mkdir: (path, options) => mkdir(path, options),
  chmod: (path, mode) => chmod(path, mode),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Claude upkeep lifecycle', () => {
  const info: ClaudeSdkUpkeepInfo = { status: 'drift', cliVersion: '2.1.305', sdkVersion: '0.3.302' };

  it('is cache-only before startup, refreshes on cadence, and explicitly rechecks on startup', async () => {
    vi.useFakeTimers();
    const readClaudeSdk = vi.fn().mockResolvedValue(info);
    const { deps, clock } = makeDeps({ readClaudeSdk });
    const upkeep = new Upkeep(deps);
    expect(upkeep.snapshot().claudeSdk?.status).toBe('unknown');
    upkeep.snapshot();
    expect(readClaudeSdk).not.toHaveBeenCalled();
    await upkeep.startup();
    expect(upkeep.snapshot().claudeSdk).toEqual(info);
    for (let i = 0; i < 10; i++) upkeep.snapshot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readClaudeSdk).toHaveBeenCalledTimes(1);
    clock.now = 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(readClaudeSdk).toHaveBeenCalledTimes(2);
    await upkeep.startup();
    expect(readClaudeSdk).toHaveBeenCalledTimes(3);
    expect(upkeep.snapshot().status).toBe('updated');
    expect(upkeep.snapshot().embedded.status).toBe('current');
    upkeep.dispose();
    upkeep.maybeRun();
    await upkeep.startup();
    expect(readClaudeSdk).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve', 'reject'])('refreshes at the first 24h tick when the initial reader is late to %s', async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish: (value: ClaudeSdkUpkeepInfo) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const readClaudeSdk = vi.fn<() => Promise<ClaudeSdkUpkeepInfo>>().mockResolvedValue(info)
      .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const { deps } = makeDeps({ readClaudeSdk, intervalMs: DEFAULT_UPKEEP_INTERVAL_MS, now: () => Date.now() });
    const upkeep = new Upkeep(deps);
    try {
      const start = upkeep.startup();
      await vi.advanceTimersByTimeAsync(1000);
      expect(readClaudeSdk).toHaveBeenCalledTimes(1);
      if (outcome === 'resolve') finish(info);
      else fail(new Error('late failure'));
      await start;
      expect(upkeep.snapshot().claudeSdk?.status).toBe(outcome === 'resolve' ? 'drift' : 'unknown');
      await vi.advanceTimersByTimeAsync(DEFAULT_UPKEEP_INTERVAL_MS - 1001);
      expect(readClaudeSdk).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(readClaudeSdk).toHaveBeenCalledTimes(2);
      expect(upkeep.snapshot().claudeSdk).toEqual(info);
    } finally {
      upkeep.dispose();
    }
  });

  it('is single-flight while pi tracks complete, preserving their fields on completion', async () => {
    let finish: (value: ClaudeSdkUpkeepInfo) => void = () => undefined;
    const readClaudeSdk = vi.fn(() => new Promise<ClaudeSdkUpkeepInfo>((resolve) => { finish = resolve; }));
    const { deps } = makeDeps({ readClaudeSdk });
    const upkeep = new Upkeep(deps);
    const start = upkeep.startup();
    await vi.waitFor(() => expect(upkeep.snapshot().status).toBe('updated'));
    upkeep.maybeRun();
    const repeated = upkeep.startup();
    expect(readClaudeSdk).toHaveBeenCalledTimes(1);
    finish(info);
    await Promise.all([start, repeated]);
    expect(upkeep.snapshot()).toMatchObject({ claudeSdk: info, status: 'updated', globalPiVersion: '0.84.1', embedded: { status: 'current' } });
    upkeep.dispose();
  });

  it.each(['deferred', 'failed', 'pending'])('runs independently of %s pi update', async (mode) => {
    const readClaudeSdk = vi.fn().mockResolvedValue(info);
    const { deps, runUpdate } = makeDeps({ readClaudeSdk, deferUpdate: () => mode === 'deferred' ? 'busy' : null });
    let release: (output: string) => void = () => undefined;
    if (mode === 'failed') runUpdate.mockRejectedValue(new Error('failed'));
    if (mode === 'pending') runUpdate.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const upkeep = new Upkeep(deps);
    const start = upkeep.startup();
    await vi.waitFor(() => expect(upkeep.snapshot().claudeSdk).toEqual(info));
    release('done');
    await start;
    expect(upkeep.snapshot().claudeSdk).toEqual(info);
    upkeep.dispose();
  });

  it.each(['sync', 'async'])('caches unknown on %s failure and retries only when due', async (mode) => {
    const readClaudeSdk = vi.fn<() => Promise<ClaudeSdkUpkeepInfo>>(() => {
      if (mode === 'sync') throw new Error('failed');
      return Promise.reject(new Error('failed'));
    });
    const { deps, clock } = makeDeps({ readClaudeSdk });
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    expect(upkeep.snapshot().claudeSdk).toEqual({ status: 'unknown', cliVersion: null, sdkVersion: null });
    upkeep.maybeRun();
    expect(readClaudeSdk).toHaveBeenCalledTimes(1);
    readClaudeSdk.mockResolvedValue(info);
    clock.now = 5000;
    upkeep.maybeRun();
    await vi.waitFor(() => expect(upkeep.snapshot().claudeSdk).toEqual(info));
    upkeep.dispose();
  });

  it('leaves the field absent without a reader and never reads when disabled', async () => {
    const plain = new Upkeep(makeDeps().deps);
    expect(plain.snapshot()).not.toHaveProperty('claudeSdk');
    plain.dispose();
    const readClaudeSdk = vi.fn().mockResolvedValue(info);
    const disabled = new Upkeep(makeDeps({ readClaudeSdk, disabled: true }).deps);
    await disabled.startup();
    disabled.maybeRun();
    expect(readClaudeSdk).not.toHaveBeenCalled();
    disabled.dispose();
  });
});

describe('upkeep lifecycle', () => {
  it('runs at every startup regardless of freshness', async () => {
    const { deps, runUpdate } = makeDeps();
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    await upkeep.startup();
    expect(runUpdate).toHaveBeenCalledTimes(2);
    upkeep.dispose();
  });

  it('never runs when disabled', async () => {
    const { deps, runUpdate, readGlobalVersion, readEmbeddedVersion } = makeDeps({
      disabled: true,
    });
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    upkeep.maybeRun();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readGlobalVersion).not.toHaveBeenCalled();
    expect(readEmbeddedVersion).not.toHaveBeenCalled();
    expect(upkeep.snapshot().disabled).toBe(true);
    expect(upkeep.snapshot().status).toBe('idle');
    upkeep.dispose();
  });

  it('records startup failure as a status and never rejects', async () => {
    const { deps, runUpdate } = makeDeps();
    runUpdate.mockRejectedValue(new Error('boom'));
    const upkeep = new Upkeep(deps);
    await expect(upkeep.startup()).resolves.toBeUndefined();
    expect(upkeep.snapshot().status).toBe('failed');
    expect(upkeep.snapshot().lastResult).toBe('boom');
    expect(upkeep.snapshot().lastRunAt).not.toBeNull();
    upkeep.dispose();
  });

  it('records a missing binary as its own status', async () => {
    const { deps, runUpdate } = makeDeps();
    runUpdate.mockRejectedValue(new MissingBinaryError('pi'));
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    expect(upkeep.snapshot().status).toBe('missing_binary');
    upkeep.dispose();
  });

  it('skips a scheduled tick fresher than the minimum interval, then runs once the minimum has passed', async () => {
    vi.useFakeTimers();
    const { deps, clock, runUpdate } = makeDeps({ minIntervalMs: 8_000 });
    const upkeep = new Upkeep(deps);
    await upkeep.startup(); // run 1 completes at clock 0
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000); // 5s tick — only 5s after the run
    expect(runUpdate).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000); // 10s tick — past the 8s minimum
    expect(runUpdate).toHaveBeenCalledTimes(2);
    upkeep.dispose();
  });

  it('defaults the scheduled freshness threshold to the configured interval', async () => {
    vi.useFakeTimers();
    const { deps, clock, runUpdate } = makeDeps({ intervalMs: 10_000 });
    const upkeep = new Upkeep(deps);
    await upkeep.startup(); // run 1 completes at clock 0
    // A trigger before the interval has elapsed is too fresh to repeat.
    clock.now += 5_000;
    upkeep.maybeRun();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    // Once the interval has elapsed, the guard passes.
    clock.now += 5_000;
    upkeep.maybeRun();
    expect(runUpdate).toHaveBeenCalledTimes(2);
    upkeep.dispose();
  });

  it('defers the update while pi chat sessions are live, says why, and runs at the first tick they are gone', async () => {
    vi.useFakeTimers();
    let reason: string | null = '2 pi chat sessions live';
    const { deps, clock, runUpdate } = makeDeps({ intervalMs: 5_000 });
    const upkeep = new Upkeep({ ...deps, deferUpdate: () => reason });
    await upkeep.startup();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(upkeep.snapshot()).toMatchObject({
      status: 'deferred',
      lastRunAt: null,
      lastResult: '2 pi chat sessions live',
      deferredSince: 0,
    });

    // Still live at the next tick: deferred again, and asked again rather than waiting a whole interval.
    // The deferral keeps the time it began, so a long one can be shown.
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(upkeep.snapshot().deferredSince).toBe(0);

    reason = null;
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(upkeep.snapshot()).toMatchObject({ status: 'updated', lastRunAt: 10_000, deferredSince: null });
    upkeep.dispose();
  });

  it('never defers embedded detection: it reads, and touches nothing', async () => {
    const { deps, runUpdate, readStableLatest } = makeDeps();
    const upkeep = new Upkeep({ ...deps, deferUpdate: () => 'live' });
    await upkeep.startup();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    upkeep.dispose();
  });

  it('is single-flight under concurrent triggers', async () => {
    const { deps, runUpdate } = makeDeps();
    let release!: () => void;
    runUpdate.mockImplementation(
      () => new Promise<string>((resolve) => { release = () => resolve('ok'); }),
    );
    const upkeep = new Upkeep(deps);
    const first = upkeep.startup();
    upkeep.maybeRun(); // concurrent trigger — must not start another updater
    await vi.waitFor(() => expect(runUpdate).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(runUpdate).toHaveBeenCalledTimes(1);
    upkeep.dispose();
  });

  it('records a timeout and leaves the updater able to run again', async () => {
    vi.useFakeTimers();
    const { deps, runUpdate } = makeDeps();
    runUpdate.mockImplementation(() => new Promise<string>(() => undefined)); // never settles
    const upkeep = new Upkeep(deps);
    const pending = upkeep.startup();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(upkeep.snapshot().status).toBe('timed_out');
    expect(upkeep.snapshot().lastResult).toContain('timed out');
    expect(upkeep.snapshot().lastRunAt).not.toBeNull();
    // a later trigger still runs
    runUpdate.mockResolvedValue('up to date');
    await upkeep.startup();
    expect(upkeep.snapshot().status).toBe('updated');
    upkeep.dispose();
  });

  it('caches versions at startup, refreshes them after a later run, and never shells out on snapshot reads', async () => {
    const { deps, readGlobalVersion, readEmbeddedVersion } = makeDeps();
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    expect(upkeep.snapshot().globalPiVersion).toBe('0.84.1');
    expect(upkeep.snapshot().embeddedSdkVersion).toBe('0.81.1');
    expect(upkeep.snapshot().drift).toBe('behind');
    // the five-second status poll only reads the cache
    upkeep.snapshot();
    upkeep.snapshot();
    expect(readGlobalVersion).toHaveBeenCalledTimes(1);
    expect(readEmbeddedVersion).toHaveBeenCalledTimes(1);
    // refreshed after the next run
    readEmbeddedVersion.mockResolvedValue('0.86.0');
    await upkeep.startup();
    expect(upkeep.snapshot().embeddedSdkVersion).toBe('0.86.0');
    expect(upkeep.snapshot().drift).toBe('ahead');
    expect(readGlobalVersion).toHaveBeenCalledTimes(2);
    upkeep.dispose();
  });

  it('computes every drift state numerically', () => {
    expect(driftOf('0.84.1', '0.84.1')).toBe('equal');
    expect(driftOf('0.84.1', '0.81.1')).toBe('behind');
    expect(driftOf('0.81.1', '0.84.1')).toBe('ahead');
    expect(driftOf('0.9.0', '0.10.0')).toBe('ahead'); // numeric, not lexical
    expect(driftOf(null, '0.81.1')).toBe('unknown');
    expect(driftOf('0.84.1', null)).toBe('unknown');
    expect(driftOf('0.84.1', 'nightly')).toBe('unknown');
  });

  it('prevents later runs after disposal and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const { deps, runUpdate } = makeDeps();
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    upkeep.dispose();
    expect(vi.getTimerCount()).toBe(0);
    upkeep.maybeRun();
    void upkeep.startup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runUpdate).toHaveBeenCalledTimes(1); // only the pre-disposal startup run
  });

  it('dispose before startup prevents any later work and arms nothing', async () => {
    vi.useFakeTimers();
    const { deps, runUpdate, readStableLatest } = makeDeps();
    const upkeep = new Upkeep(deps);
    expect(vi.getTimerCount()).toBe(0);
    upkeep.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await upkeep.startup();
    upkeep.maybeRun();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readStableLatest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms nothing at construction and runs nothing until startup begins (regression: pre-listen interval)', async () => {
    vi.useFakeTimers();
    const { deps, clock, runUpdate, readStableLatest, readInstalledVersion } = makeDeps({
      intervalMs: 5_000,
      minIntervalMs: 5_000,
    });
    const upkeep = new Upkeep(deps);
    // A short configured interval must not exist before startup: advancing
    // several intervals after construction runs nothing and leaves no timers.
    expect(vi.getTimerCount()).toBe(0);
    clock.now += 5_000 * 4;
    await vi.advanceTimersByTimeAsync(5_000 * 4);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readStableLatest).not.toHaveBeenCalled();
    expect(readInstalledVersion).not.toHaveBeenCalled();
    expect(upkeep.snapshot().status).toBe('idle');
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
    // startup (post-listen) arms the scheduler and begins both tracks exactly once.
    await upkeep.startup();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    expect(readInstalledVersion).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // scheduled repeats follow the configured cadence, freshness-guarded. The
    // interval first fires one interval of fake time after arming, so the
    // clock is advanced only when the guard is meant to pass.
    await vi.advanceTimersByTimeAsync(5_000); // first fire — still fresh
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000); // second fire — past the interval
    expect(runUpdate).toHaveBeenCalledTimes(2);
    expect(readStableLatest).toHaveBeenCalledTimes(2);
    upkeep.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeated startup keeps a single scheduler while retaining explicit runs', async () => {
    vi.useFakeTimers();
    const { deps, runUpdate } = makeDeps();
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    await upkeep.startup();
    expect(runUpdate).toHaveBeenCalledTimes(2); // explicit-run behavior retained
    expect(vi.getTimerCount()).toBe(1); // no duplicate interval
    upkeep.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose is idempotent', () => {
    const { deps } = makeDeps();
    const upkeep = new Upkeep(deps);
    expect(() => {
      upkeep.dispose();
      upkeep.dispose();
    }).not.toThrow();
  });
});

describe('embedded detection', () => {
  it('runs embedded detection only after startup/listen, never before', async () => {
    const { deps, readStableLatest, readInstalledVersion } = makeDeps();
    const upkeep = new Upkeep(deps);
    expect(readStableLatest).not.toHaveBeenCalled();
    expect(readInstalledVersion).not.toHaveBeenCalled();
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    await upkeep.startup();
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    expect(readInstalledVersion).toHaveBeenCalledTimes(1);
    upkeep.dispose();
  });

  it('starts global upkeep and embedded detection independently at startup', async () => {
    const { deps, runUpdate, readStableLatest } = makeDeps();
    let releaseUpdate!: () => void;
    let releaseDetect!: () => void;
    runUpdate.mockImplementation(() => new Promise<string>((resolve) => { releaseUpdate = () => resolve('ok'); }));
    readStableLatest.mockImplementation(() => new Promise<string | null>((resolve) => { releaseDetect = () => resolve('0.85.0'); }));
    const upkeep = new Upkeep(deps);
    const started = upkeep.startup();
    // Both began before either settled: neither waits for the other.
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    releaseDetect();
    releaseUpdate();
    await started;
    expect(upkeep.snapshot().embedded.status).toBe('available');
    upkeep.dispose();
  });

  it('a failing global run does not suppress embedded detection, and vice versa', async () => {
    const { deps, runUpdate, readStableLatest, readInstalledVersion } = makeDeps();
    runUpdate.mockRejectedValue(new Error('global boom'));
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    expect(upkeep.snapshot().status).toBe('failed');
    expect(upkeep.snapshot().embedded.status).toBe('current');
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    // the embedded failure is isolated too: a registry boom never blocks the global track
    runUpdate.mockResolvedValue('up to date');
    readStableLatest.mockRejectedValue(new Error('registry boom'));
    await upkeep.startup();
    expect(upkeep.snapshot().status).toBe('updated');
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    expect(readInstalledVersion).toHaveBeenCalled();
    upkeep.dispose();
  });

  it('keeps global and embedded single-flight independently', async () => {
    const { deps, runUpdate, readStableLatest } = makeDeps();
    let releaseUpdate!: () => void;
    runUpdate.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseUpdate = () => resolve('ok'); }));
    const upkeep = new Upkeep(deps);
    const pending = upkeep.startup();
    upkeep.maybeRun(); // global is running; embedded already checked
    expect(runUpdate).toHaveBeenCalledTimes(1);
    releaseUpdate();
    await pending;
    let releaseDetect!: () => void;
    readStableLatest.mockImplementationOnce(() => new Promise<string | null>((resolve) => { releaseDetect = () => resolve('0.85.0'); }));
    const pendingDetect = upkeep.startup();
    upkeep.maybeRun(); // embedded is detecting; global is fresh
    expect(readStableLatest).toHaveBeenCalledTimes(2);
    releaseDetect();
    await pendingDetect;
    upkeep.dispose();
  });

  it('embedded detection follows the configured interval, never a hard-coded freshness', async () => {
    vi.useFakeTimers();
    const { deps, clock, readStableLatest } = makeDeps({ minIntervalMs: 8_000 });
    const upkeep = new Upkeep(deps);
    await upkeep.startup(); // check 1 completes at clock 0
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000); // tick fresher than the minimum
    expect(readStableLatest).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000); // tick past the minimum
    expect(readStableLatest).toHaveBeenCalledTimes(2);
    upkeep.dispose();
  });

  it('disabled suppresses embedded detection as well as global upkeep', async () => {
    const { deps, runUpdate, readStableLatest, readInstalledVersion } = makeDeps({ disabled: true });
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    upkeep.maybeRun();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readStableLatest).not.toHaveBeenCalled();
    expect(readInstalledVersion).not.toHaveBeenCalled();
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    upkeep.dispose();
  });

  it('snapshot reads never run detection or version commands', async () => {
    const { deps, readStableLatest, readInstalledVersion } = makeDeps();
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    const latestCalls = readStableLatest.mock.calls.length;
    const installedCalls = readInstalledVersion.mock.calls.length;
    upkeep.snapshot();
    upkeep.snapshot();
    upkeep.snapshot();
    expect(readStableLatest).toHaveBeenCalledTimes(latestCalls);
    expect(readInstalledVersion).toHaveBeenCalledTimes(installedCalls);
    upkeep.dispose();
  });

  it('reports a transient checking status while detection is in flight', async () => {
    const { deps, readStableLatest } = makeDeps();
    let release!: () => void;
    readStableLatest.mockImplementationOnce(() => new Promise<string | null>((resolve) => { release = () => resolve('0.85.0'); }));
    const upkeep = new Upkeep(deps);
    const pending = upkeep.startup();
    expect(upkeep.snapshot().embedded.status).toBe('checking');
    release();
    await pending;
    expect(upkeep.snapshot().embedded.status).toBe('available');
    upkeep.dispose();
  });

  it('records current, available, and unknown on detection outcomes', async () => {
    const { deps, readStableLatest, readInstalledVersion } = makeDeps();
    readInstalledVersion.mockResolvedValue('0.84.1');
    const upkeep = new Upkeep(deps);
    // current: installed equals stable latest
    readStableLatest.mockResolvedValue('0.84.1');
    await upkeep.startup();
    expect(upkeep.snapshot().embedded.status).toBe('current');
    expect(upkeep.snapshot().embedded.latestVersion).toBe('0.84.1');
    // available: a strictly greater stable latest
    readStableLatest.mockResolvedValue('0.85.0');
    await upkeep.startup();
    expect(upkeep.snapshot().embedded.status).toBe('available');
    expect(upkeep.snapshot().embedded.latestVersion).toBe('0.85.0');
    expect(upkeep.snapshot().embedded.installedVersion).toBe('0.84.1');
    // failure: an unreachable registry never claims availability
    readStableLatest.mockResolvedValue(null);
    await upkeep.startup();
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    expect(upkeep.snapshot().embedded.latestVersion).toBeNull();
    // malformed/prerelease latest is never promotable
    readStableLatest.mockResolvedValue('0.85.0-beta.1');
    await upkeep.startup();
    expect(upkeep.snapshot().embedded.status).toBe('unknown');
    expect(upkeep.snapshot().embedded.latestVersion).toBeNull();
    upkeep.dispose();
  });

  it('preserves verification, promotion, and recovery fields while detection updates its own', async () => {
    const { files, fs } = memoryFs();
    const initial = defaultEmbeddedState();
    initial.status = 'promotion_failed';
    initial.verifiedVersion = '0.84.1';
    initial.verificationLevel = 'deterministic_only';
    initial.lastPromotionAttemptAt = 123;
    initial.lastPromotionResult = 'candidate gate failed';
    const { deps, readStableLatest } = makeDeps({
      embeddedState: { stateDir: '/state/dir', fs, initial },
    });
    readStableLatest.mockResolvedValue('0.85.0');
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    const embedded = upkeep.snapshot().embedded;
    expect(embedded.status).toBe('promotion_failed'); // preserved over detection
    expect(embedded.verifiedVersion).toBe('0.84.1');
    expect(embedded.verificationLevel).toBe('deterministic_only');
    expect(embedded.lastPromotionAttemptAt).toBe(123);
    expect(embedded.lastPromotionResult).toBe('candidate gate failed');
    expect(embedded.lastRecoveryAttemptAt).toBeNull();
    // detection-owned fields still updated and persisted
    expect(embedded.installedVersion).toBe('0.84.1');
    expect(embedded.latestVersion).toBe('0.85.0');
    expect(embedded.lastCheckAt).toBe(0);
    const persisted = JSON.parse(files.get('/state/dir/embedded-state.json') ?? '') as {
      status: string;
      verifiedVersion: string;
      verificationLevel: string;
      latestVersion: string;
      lastCheckAt: number;
    };
    expect(persisted.status).toBe('promotion_failed');
    expect(persisted.verifiedVersion).toBe('0.84.1');
    expect(persisted.verificationLevel).toBe('deterministic_only');
    expect(persisted.latestVersion).toBe('0.85.0');
    expect(persisted.lastCheckAt).toBe(0);
    upkeep.dispose();
  });

  it.each(['0.84.1-beta.1', '0.84.1+build.5', 'v0.84.1', 'nightly'])(
    'normalizes a non-exact installed read (%s) to null and fails closed, preserving recovery fields',
    async (rawInstalled) => {
      const { files, fs } = memoryFs();
      const initial = defaultEmbeddedState();
      initial.status = 'recovery_required';
      initial.lastRecoveryAttemptAt = 7;
      initial.lastRecoveryResult = 'cleanup pending';
      const { deps, readInstalledVersion, readStableLatest } = makeDeps({
        embeddedState: { stateDir: '/state/dir', fs, initial },
      });
      readInstalledVersion.mockResolvedValue(rawInstalled);
      readStableLatest.mockResolvedValue('0.85.0');
      const upkeep = new Upkeep(deps);
      await upkeep.startup();
      const embedded = upkeep.snapshot().embedded;
      // the raw non-exact string is never decided on or stored
      expect(embedded.installedVersion).toBeNull();
      expect(embedded.latestVersion).toBeNull();
      expect(embedded.status).toBe('recovery_required'); // recovery preserved
      expect(embedded.lastRecoveryAttemptAt).toBe(7);
      expect(embedded.lastRecoveryResult).toBe('cleanup pending');
      expect(embedded.lastCheckAt).toBe(0);
      // the persisted bytes pass the strict loader — no durable-field wipe on restart
      const raw = files.get('/state/dir/embedded-state.json');
      expect(raw).toBeDefined();
      const parsed = parseEmbeddedState(raw ?? '');
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.state.installedVersion).toBeNull();
        expect(parsed.state.status).toBe('recovery_required');
        expect(parsed.state.lastRecoveryAttemptAt).toBe(7);
      }
      upkeep.dispose();
    },
  );

  it('normalizes a whitespace-padded installed read to its exact form before deciding', async () => {
    const { deps, readInstalledVersion, readStableLatest } = makeDeps();
    readInstalledVersion.mockResolvedValue(' 0.84.1\n');
    readStableLatest.mockResolvedValue('0.85.0');
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    const embedded = upkeep.snapshot().embedded;
    expect(embedded.installedVersion).toBe('0.84.1'); // canonical, not the raw read
    expect(embedded.status).toBe('available');
    expect(embedded.latestVersion).toBe('0.85.0');
    upkeep.dispose();
  });

  it('preserves promotion fields when a malformed installed read fails closed', async () => {
    const { files, fs } = memoryFs();
    const initial = defaultEmbeddedState();
    initial.status = 'promotion_failed';
    initial.verifiedVersion = '0.84.1';
    initial.verificationLevel = 'deterministic_only';
    initial.lastPromotionAttemptAt = 123;
    initial.lastPromotionResult = 'candidate gate failed';
    const { deps, readInstalledVersion, readStableLatest } = makeDeps({
      embeddedState: { stateDir: '/state/dir', fs, initial },
    });
    readInstalledVersion.mockResolvedValue('1.2'); // malformed — not exact stable
    readStableLatest.mockResolvedValue('0.85.0');
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    const embedded = upkeep.snapshot().embedded;
    expect(embedded.status).toBe('promotion_failed');
    expect(embedded.installedVersion).toBeNull();
    expect(embedded.latestVersion).toBeNull();
    expect(embedded.verifiedVersion).toBe('0.84.1');
    expect(embedded.verificationLevel).toBe('deterministic_only');
    expect(embedded.lastPromotionAttemptAt).toBe(123);
    expect(embedded.lastPromotionResult).toBe('candidate gate failed');
    expect(parseEmbeddedState(files.get('/state/dir/embedded-state.json') ?? '').ok).toBe(true);
    upkeep.dispose();
  });

  it('persists detection outcomes under the state dir with private mode (real fs)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-upkeep-embedded-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realStateFs);
    const { deps } = makeDeps({
      embeddedState: { stateDir, fs: realStateFs, initial: defaultEmbeddedState() },
    });
    const upkeep = new Upkeep(deps);
    await upkeep.startup();
    const path = join(stateDir, EMBEDDED_STATE_FILE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const parsed = parseEmbeddedState(await readFile(path, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.status).toBe('current');
    await rm(base, { recursive: true, force: true });
    upkeep.dispose();
  });
});

describe('TailBuffer', () => {
  it('retains a bounded tail as data arrives, newest bytes last', () => {
    const buf = new TailBuffer(32);
    for (let i = 0; i < 100; i++) {
      buf.push(Buffer.from(`|${i}`));
      expect(buf.byteLength).toBeLessThanOrEqual(32);
    }
    expect(buf.toString().endsWith('|99')).toBe(true);
  });

  it('trims a single oversized chunk to the tail', () => {
    const buf = new TailBuffer(16);
    buf.push(Buffer.from('a'.repeat(1000)));
    expect(buf.byteLength).toBe(16);
    expect(buf.toString()).toBe('a'.repeat(16));
  });

  it('drops the head chunks while keeping the newest in order', () => {
    const buf = new TailBuffer(64);
    for (let i = 0; i < 50; i++) buf.push(Buffer.from(`chunk-${i};`));
    const out = buf.toString();
    expect(out).toContain('chunk-49;');
    expect(out).not.toContain('chunk-0;');
    expect(out).not.toContain('chunk-4;');
  });
});

describe('production runner', () => {
  it('runs the binary, bounds output and surfaces exit failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upkeep-'));
    const bin = join(dir, 'pi');
    await writeFile(bin, FAKE_PI, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    try {
      const version = await runPiCommand(['--version'], new AbortController().signal);
      expect(version).toContain('line two');
      const huge = await runPiCommand(['huge'], new AbortController().signal);
      expect(huge).toHaveLength(16 * 1024);
      expect(huge).toMatch(/done$/);
      await expect(
        runPiCommand(['missing'], new AbortController().signal),
      ).rejects.toThrow('exited with code 1');
    } finally {
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps an absent binary to MissingBinaryError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upkeep-'));
    const previousPath = process.env.PATH;
    process.env.PATH = dir; // nothing executable on PATH
    try {
      await expect(
        runPiCommand(['update', '--all'], new AbortController().signal),
      ).rejects.toBeInstanceOf(MissingBinaryError);
    } finally {
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips project-local node_modules/.bin shims when resolving the binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upkeep-'));
    const globalBin = join(dir, 'bin');
    const localBin = join(dir, 'node_modules', '.bin');
    await mkdir(globalBin, { recursive: true });
    await mkdir(localBin, { recursive: true });
    await writeFile(join(globalBin, 'pi'), '#!/bin/sh\necho global pi\nexit 0\n', { mode: 0o755 });
    await writeFile(join(localBin, 'pi'), '#!/bin/sh\necho embedded pi\nexit 0\n', { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${localBin}:${globalBin}`;
    try {
      await expect(runPiCommand(['--version'], new AbortController().signal)).resolves.toContain(
        'global pi',
      );
    } finally {
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
