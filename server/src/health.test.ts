import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backends, setBackend, startHealthProbes, trackBackend } from './health.ts';

describe('setBackend', () => {
  it('overwrites an existing entry', () => {
    setBackend('helmraiser', 'up');
    expect(backends.helmraiser).toBe('up');
    setBackend('helmraiser', 'down');
    expect(backends.helmraiser).toBe('down');
  });
});

describe('trackBackend', () => {
  it('drops an integration no chat slot runs, so the strip does not show it as unknown', () => {
    setBackend('pi', 'unknown');

    trackBackend('pi', false);
    trackBackend('pi', false);

    expect(Object.keys(backends)).not.toContain('pi');
    expect(Object.keys(backends)).toEqual(expect.arrayContaining(['helmraiser']));
  });

  it('brings it back as unknown when a slot runs it again, and leaves a known status alone', () => {
    trackBackend('pi', false);
    trackBackend('pi', true);
    expect(backends.pi).toBe('unknown');

    setBackend('pi', 'up');
    trackBackend('pi', true);
    expect(backends.pi).toBe('up');
    setBackend('pi', 'unknown');
  });
});

describe('startHealthProbes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs every probe once at start', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    const stop = startHealthProbes([a, b]);
    await Promise.resolve();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stop();
  });

  it('runs the probes again after the interval', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const stop = startHealthProbes([probe], 15_000);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(3);
    stop();
  });

  it('lets the other probes run when one rejects', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('down'));
    const healthy = vi.fn().mockResolvedValue(undefined);
    const stop = startHealthProbes([failing, healthy], 15_000);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('halts further runs once stopped', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const stop = startHealthProbes([probe], 15_000);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
