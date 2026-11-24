import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowClient } from './workflow.client.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { HelmraiserMonitor } from './helmraiser-monitor.service.ts';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('HelmraiserMonitor', () => {
  it('loads helmraiser.status on the first subscription and exposes it with no Hub fields', async () => {
    vi.useFakeTimers();
    const fixture = makeHelmraiserStatus();
    const status = vi.fn().mockResolvedValue(fixture);
    const workflow = { status } as unknown as WorkflowClient;
    const monitor = new HelmraiserMonitor(workflow);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.waitFor(() => expect(monitor.getSnapshot().status).toBe(fixture));
    expect(monitor.getSnapshot()).toEqual({ status: fixture, loading: false, error: null, unavailable: false });
    expect(status).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('keeps polling every 5000 ms while subscribers remain, even for an idle queue', async () => {
    vi.useFakeTimers();
    const idle = { ...makeHelmraiserStatus(), running: [], queue_next: [], queued_count: 0 };
    const status = vi.fn().mockResolvedValue(idle);
    const workflow = { status } as unknown as WorkflowClient;
    const monitor = new HelmraiserMonitor(workflow);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0); // flush the immediate load, no clock movement
    expect(status).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4999);
    expect(status).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(2);

    // One listener leaving must not stop the polling the other still needs.
    const unsubscribe2 = monitor.subscribe(vi.fn());
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(status).toHaveBeenCalledTimes(3);

    unsubscribe2();
    await vi.advanceTimersByTimeAsync(20000);
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('keeps the unavailable line on screen while a background poll is loading', async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => undefined;
    const status = vi.fn()
      .mockRejectedValueOnce(new WireCallError('no cli', 'helmraiser_unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const monitor = new HelmraiserMonitor({ status } as unknown as WorkflowClient);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.waitFor(() => expect(monitor.getSnapshot().unavailable).toBe(true));
    await vi.advanceTimersByTimeAsync(5000); // second poll starts and hangs
    expect(monitor.getSnapshot().loading).toBe(true);
    expect(monitor.getSnapshot().unavailable).toBe(true);
    expect(monitor.getSnapshot().error).not.toBeNull();
    answer(makeHelmraiserStatus());
    await vi.waitFor(() => expect(monitor.getSnapshot().unavailable).toBe(false));
    expect(monitor.getSnapshot().error).toBeNull();
    unsubscribe();
  });

  it('maps helmraiser_unavailable to the humane start line and recovers by polling', async () => {
    vi.useFakeTimers();
    const status = vi.fn()
      .mockRejectedValueOnce(new WireCallError('Helmraiser is not reachable', 'helmraiser_unavailable'))
      .mockResolvedValue(makeHelmraiserStatus());
    const workflow = { status } as unknown as WorkflowClient;
    const monitor = new HelmraiserMonitor(workflow);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.waitFor(() => expect(monitor.getSnapshot().unavailable).toBe(true));
    expect(monitor.getSnapshot().error).toBe('Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net');
    expect(monitor.getSnapshot().status).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    expect(monitor.getSnapshot()).toMatchObject({ error: null, unavailable: false, loading: false });
    expect(monitor.getSnapshot().status).not.toBeNull();
    unsubscribe();
  });

  it('keeps a non-unavailable failure as a plain error and still polls', async () => {
    vi.useFakeTimers();
    const status = vi.fn().mockRejectedValue(new WireCallError('helmraiser status → 503', 'helmraiser_cli_error'));
    const workflow = { status } as unknown as WorkflowClient;
    const monitor = new HelmraiserMonitor(workflow);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.waitFor(() => expect(monitor.getSnapshot().error).toContain('503'));
    expect(monitor.getSnapshot().unavailable).toBe(false);
    expect(monitor.getSnapshot().status).toBeNull();

    const calls = status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(status.mock.calls.length).toBeGreaterThan(calls);
    unsubscribe();
  });

  it('never touches the Hub-era runs, agents or watch methods', async () => {
    vi.useFakeTimers();
    const runs = vi.fn();
    const agents = vi.fn();
    const watch = vi.fn();
    const status = vi.fn().mockResolvedValue(makeHelmraiserStatus());
    const workflow = { status, runs, agents, watch } as unknown as WorkflowClient;
    const monitor = new HelmraiserMonitor(workflow);
    const unsubscribe = monitor.subscribe(vi.fn());
    await vi.waitFor(() => expect(monitor.getSnapshot().status).not.toBeNull());
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).not.toHaveBeenCalled();
    expect(agents).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    unsubscribe();
  });
});
