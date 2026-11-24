import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MethodRegistry } from '../transport/registry.ts';
import { registerHelmraiserEventsSeam } from '../seams/helmraiser-events.ts';
import { HelmraiserWatcher, type HelmraiserStatusReader } from './watcher.ts';
import type { HelmraiserEvent, HelmraiserStatus } from '../../../src/shared/transport/protocol.ts';

const STATUS_PATH = 'status.json';

function status(overrides: Partial<HelmraiserStatus>): HelmraiserStatus {
  return {
    updated_at: new Date(0).toISOString(),
    queued_count: 0,
    queue_next: [],
    running: [],
    awaiting_count: 0,
    failed_24h_count: 0,
    spend: {},
    usage: {},
    caps_enforced: true,
    paused: null,
    held_providers: {},
    worker: { state: 'running' },
    queue: { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 },
    awaiting: [],
    failed: [],
    status_path: STATUS_PATH,
    ...overrides,
  };
}

function awaitingRow(runId: string, task: string, title?: string): HelmraiserStatus['awaiting'][number] {
  return {
    run_id: runId,
    task,
    pending: 'merge',
    verdict: '',
    cost_usd: 0,
    ...(title !== undefined ? { title } : {}),
  };
}

function failedRow(runId: string, task: string): HelmraiserStatus['failed'][number] {
  return { run_id: runId, task, reason: 'boom', ended_at: '' };
}

function landedRow(runId: string, task: string, title?: string): NonNullable<HelmraiserStatus['landed']>[number] {
  return {
    run_id: runId,
    task,
    ended_at: '',
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * A status read whose answers the test settles one poll at a time — the watcher
 * fires a baseline poll in `start()` before any interval timer exists, so
 * settling through this promise queue is what makes poll order explicit.
 */
function controllableReader(): {
  read: HelmraiserStatusReader;
  settleOnce: (value: HelmraiserStatus | Error) => void;
  pending: () => number;
} {
  const resolvers: ((value: HelmraiserStatus) => void)[] = [];
  const rejecters: ((error: Error) => void)[] = [];
  return {
    read: () => new Promise<HelmraiserStatus>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    }),
    settleOnce: (value) => {
      const resolve = resolvers.shift();
      const reject = rejecters.shift();
      if (value instanceof Error) reject?.(value);
      else resolve?.(value);
    },
    pending: () => resolvers.length,
  };
}

/** Drains the microtask queue the fake-timer clock cannot flush on its own. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Primes one pull so a later `push` resolves it instead of buffering. */
function prime(iterator: AsyncIterator<HelmraiserEvent>): Promise<IteratorResult<HelmraiserEvent>> {
  return iterator.next();
}

function callbackEvents(): { onEvent: (event: HelmraiserEvent) => void; events: HelmraiserEvent[] } {
  const events: HelmraiserEvent[] = [];
  return { onEvent: (event) => events.push(event), events };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HelmraiserWatcher', () => {
  it('baseline poll emits nothing, including pre-existing awaiting and failed rows', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    watcher.observe(controller.signal);
    watcher.start();
    reader.settleOnce(status({
      awaiting: [awaitingRow('a1', 't')],
      failed: [failedRow('f1', 't')],
    }));
    await settle();
    expect(events).toEqual([]);
    // The same rows again stay quiet: they were already on the baseline.
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({
      awaiting: [awaitingRow('a1', 't')],
      failed: [failedRow('f1', 't')],
    }));
    await settle();
    expect(events).toEqual([]);
    watcher.dispose();
    controller.abort();
  });

  it('a new landed id emits with the same baseline and title rules as the other lanes', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    // Baseline with a landed row already present: no alert for it.
    reader.settleOnce(status({ landed: [landedRow('done', 'already finished')] }));
    await settle();
    expect(events).toEqual([]);
    // A later poll re-reporting the same row stays just as quiet.
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({ landed: [landedRow('done', 'already finished')] }));
    await settle();
    expect(events).toEqual([]);
    // A genuinely new landed run alerts with the title fallback.
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    reader.settleOnce(status({
      landed: [
        landedRow('l1', 'ship the docs', 'Docs run finished'),
        landedRow('l2', 'ship the api'),
      ],
    }));
    const first = await pending;
    expect(first).toEqual({
      done: false,
      value: {
        kind: 'helmraiser-event',
        event: 'landed',
        runId: 'l1',
        task: 'ship the docs',
        title: 'Docs run finished',
      },
    });
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      { kind: 'helmraiser-event', event: 'landed', runId: 'l1', task: 'ship the docs', title: 'Docs run finished' },
      { kind: 'helmraiser-event', event: 'landed', runId: 'l2', task: 'ship the api', title: 'ship the api' },
    ]);
    watcher.dispose();
    controller.abort();
  });

  it('status output without a landed list (older helmraiser) is read as empty, not an error', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ landed: [landedRow('baseline', 't')] }));
    await settle();
    expect(events).toEqual([]);
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    // The landed key is absent entirely: no throw, no alert, baseline refresh.
    const olderStatus = status({});
    delete (olderStatus as { landed?: unknown }).landed;
    reader.settleOnce(olderStatus);
    await settle();
    expect(events).toEqual([]);
    // No landed event, and the watcher keeps flowing: the next poll can
    // still alert on a landed row again.
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({ landed: [landedRow('again', 't')] }));
    const event = (await pending).value;
    expect(event).toEqual({
      kind: 'helmraiser-event',
      event: 'landed',
      runId: 'again',
      task: 't',
      title: 't',
    });
    expect(events).toHaveLength(1);
    watcher.dispose();
    controller.abort();
  });

  it('a new awaiting id emits one correctly shaped event, with the title fallback', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    reader.settleOnce(status({
      awaiting: [
        awaitingRow('a1', 'merge the pr'),
        awaitingRow('a2', 't', 'named run'),
        // Older builds omit id and title entirely; the task names the event.
        { run_id: 'a3', task: 'deploy the api', pending: 'merge', verdict: '', cost_usd: 0 },
      ],
    }));
    const first = await pending;
    // Titles fall back id-first, then task: a2 has a title, a3 has neither.
    expect(events.map((event) => [event.runId, event.title])).toEqual([
      ['a1', 'merge the pr'],
      ['a2', 'named run'],
      ['a3', 'deploy the api'],
    ]);
    expect(first).toEqual({
      done: false,
      value: {
        kind: 'helmraiser-event',
        event: 'awaiting',
        runId: 'a1',
        task: 'merge the pr',
        title: 'merge the pr',
      },
    });
    // Buffered events drain in order without hanging.
    const second = await iterator.next();
    expect(second.value).toMatchObject({ runId: 'a2' });
    const third = await iterator.next();
    expect(third.value).toMatchObject({ runId: 'a3', title: 'deploy the api' });
    watcher.dispose();
    controller.abort();
  });

  it('repeating the same snapshot emits nothing further', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    reader.settleOnce(status({ awaiting: [awaitingRow('a-run', 'same task')] }));
    const event = (await pending).value;
    expect(event?.runId).toBe('a-run');
    // A third poll sees the identical snapshot; nothing else may fire.
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({ awaiting: [awaitingRow('a-run', 'same task')] }));
    await settle();
    expect(events).toHaveLength(1);
    watcher.dispose();
    controller.abort();
  });

  it('a new failed id emits, and status failures stay silent', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ failed: [] }));
    await settle();
    // Two failed reads emit nothing and leave the baseline untouched.
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(Error('helmraiser not answering'));
    await settle();
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(Error('helmraiser not answering'));
    await settle();
    expect(events).toEqual([]);
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    reader.settleOnce(status({ failed: [failedRow('f9', 'ship it')] }));
    const event = (await pending).value;
    expect(event).toEqual({
      kind: 'helmraiser-event',
      event: 'failed',
      runId: 'f9',
      task: 'ship it',
      title: 'ship it',
    });
    expect(events).toHaveLength(1);
    watcher.dispose();
    controller.abort();
  });

  it('first successful read after startup failures is still only a baseline', async () => {
    const reader = controllableReader();
    const { events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, events.push.bind(events), 30_000);
    const controller = new AbortController();
    watcher.start();
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(Error('unavailable at start'));
    await settle();
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({ awaiting: [awaitingRow('a1', 't')], failed: [failedRow('f1', 't')] }));
    await settle();
    expect(events).toEqual([]);
    watcher.dispose();
    controller.abort();
  });

  it('polls at 30 s and stops after dispose', async () => {
    const reader = controllableReader();
    const watcher = new HelmraiserWatcher(reader.read, undefined, 30_000);
    watcher.start();
    expect(reader.pending()).toBe(1);
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    vi.advanceTimersByTime(30_000);
    expect(reader.pending()).toBe(1);
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    watcher.dispose();
    // The interval is gone: three more windows raise no further reads.
    vi.advanceTimersByTime(120_000);
    expect(reader.pending()).toBe(0);
  });

  it('an aborted observer ends cleanly', async () => {
    const reader = controllableReader();
    const watcher = new HelmraiserWatcher(reader.read, undefined, 30_000);
    const controller = new AbortController();
    const iterator = watcher.observe(controller.signal)[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ awaiting: [awaitingRow('a1', 't')] }));
    await settle();
    const pending = iterator.next();
    controller.abort();
    // Only the observer's own end can settle this; a hung stream leaves it pending.
    const outcome = await Promise.race([
      pending.then((result) => (result.done ? 'ended' : 'value')),
      settle().then(() => 'still pending'),
    ]);
    expect(outcome).toBe('ended');
    watcher.dispose();
  });

  it('delivers to the event callback with no observer subscribed (desktop without a tab)', async () => {
    const reader = controllableReader();
    const { onEvent, events } = callbackEvents();
    const watcher = new HelmraiserWatcher(reader.read, onEvent, 30_000);
    watcher.start();
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    vi.advanceTimersByTime(30_000);
    reader.settleOnce(status({ awaiting: [awaitingRow('a1', 't')] }));
    await settle();
    expect(events.map((event) => [event.event, event.runId])).toEqual([['awaiting', 'a1']]);
    watcher.dispose();
  });

  it('helmraiser.observe exposes the same watcher through the seam', async () => {
    const reader = controllableReader();
    const watcher = new HelmraiserWatcher(reader.read, undefined, 30_000);
    const registry = new MethodRegistry();
    registerHelmraiserEventsSeam(registry, watcher);
    const entry = registry.get('helmraiser.observe');
    if (!entry || entry.kind !== 'stream') throw new Error('missing stream helmraiser.observe');
    const controller = new AbortController();
    const iterable = entry.handler({}, { signal: controller.signal }) as AsyncIterable<HelmraiserEvent>;
    const iterator = iterable[Symbol.asyncIterator]();
    watcher.start();
    reader.settleOnce(status({ awaiting: [] }));
    await settle();
    vi.advanceTimersByTime(30_000);
    const pending = prime(iterator);
    reader.settleOnce(status({ awaiting: [awaitingRow('b-run', 'deploy the api')] }));
    const event = (await pending).value;
    expect(event).toMatchObject({ event: 'awaiting', runId: 'b-run', task: 'deploy the api' });
    watcher.dispose();
    controller.abort();
  });
});
