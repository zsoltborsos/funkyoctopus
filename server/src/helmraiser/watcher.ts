import type { HelmraiserEvent, HelmraiserStatus } from '../../../src/shared/transport/protocol.ts';
import { AsyncQueue } from '../util/async-queue.ts';

/** The sidecar keeps one Helmraiser watcher, so its interval can be tested. */
export type HelmraiserStatusReader = () => Promise<HelmraiserStatus>;

/** Row ids grouped the way the watcher notices them, so awaiting, failed and landed are separate. */
type Lane = 'awaiting' | 'failed' | 'landed';

/**
 * Watches `helmraiser status --json` and turns new awaiting-approval, new failed
 * and new landed run ids into events. The first successful poll is a baseline and
 * notifies nothing, so a sidecar restarted while a run is already parked does
 * not re-alert on the run that is still waiting; the same run_id leaving and
 * re-appearing across polls alerts again, because only unchanged ids stay
 * silent. A failed read emits nothing, throws nothing, and never replaces the
 * baseline — a flapping Helmraiser probe cannot resurrect an old alert.
 */
export class HelmraiserWatcher {
  /** Previous successful snapshot per lane; empty until the first succeeded. */
  private readonly seen = new Map<Lane, Set<string>>();
  private readonly observers = new Set<{ queue: AsyncQueue<HelmraiserEvent> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;

  constructor(
    private readonly read: HelmraiserStatusReader,
    private readonly onEvent?: (event: HelmraiserEvent) => void,
    private readonly intervalMs = 30_000,
  ) {}

  /** Polls immediately, then on the interval. Idempotent. */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stops polling; open observers end through their own abort signal. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One Helmraiser event stream per observer, ending when its signal aborts. */
  observe(signal: AbortSignal): AsyncIterable<HelmraiserEvent> {
    const queue = new AsyncQueue<HelmraiserEvent>();
    const observer = { queue };
    this.observers.add(observer);
    signal.addEventListener('abort', () => {
      this.observers.delete(observer);
      queue.close();
    }, { once: true });
    return queue;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const status = await this.read();
      const current: Record<Lane, Set<string>> = {
        awaiting: idsOf(status.awaiting),
        failed: idsOf(status.failed),
        landed: idsOf(status.landed ?? []),
      };
      for (const lane of ['awaiting', 'failed', 'landed'] as const) {
        const previous = this.seen.get(lane);
        if (previous === undefined) {
          // The first successful read for this lane is a baseline and alerts
          // nothing: a sidecar restarted while a run is parked must not
          // re-notify on the run that is already waiting.
          this.seen.set(lane, current[lane]);
          continue;
        }
        const fresh = [...current[lane]].filter((id) => !previous.has(id));
        this.seen.set(lane, current[lane]);
        for (const id of fresh) {
          const row = (status[lane] ?? []).find((candidate) => candidate.run_id === id);
          this.emit(lane, id, row?.task ?? '', row?.title ?? row?.id ?? row?.task ?? id);
        }
      }
    } catch {
      // Helmraiser unavailable: silence is the contract; the baseline stands.
    } finally {
      this.polling = false;
    }
  }

  private emit(event: Lane, runId: string, task: string, title: string): void {
    const payload: HelmraiserEvent = { kind: 'helmraiser-event', event, runId, task, title };
    this.onEvent?.(payload);
    for (const observer of this.observers) {
      observer.queue.push(payload);
    }
  }
}

function idsOf(rows: { run_id: string }[]): Set<string> {
  return new Set(rows.map((row) => row.run_id));
}
