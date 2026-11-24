import { token } from '@core/container/container.ts';
import type { HelmraiserStatus } from '@shared/transport/protocol.ts';
import type { WorkflowClient } from './workflow.client.ts';
import { humaneError } from '@core/transport/humane-error.ts';

const POLL_MS = 5000;

export interface HelmraiserMonitorSnapshot {
  status: HelmraiserStatus | null;
  loading: boolean;
  /** Humane line; see `humaneError`. */
  error: string | null;
  /** Helmraiser is not running (`helmraiser_unavailable`): an empty queue is not "nothing to do". */
  unavailable: boolean;
}

const EMPTY: HelmraiserMonitorSnapshot = { status: null, loading: false, error: null, unavailable: false };

/**
 * Shared authoritative Helmraiser snapshot (`helmraiser status --json`). Polls on a
 * fixed interval while at least one subscriber listens — the queue changes even
 * when nothing is running — and stops when the last subscriber leaves.
 */
export class HelmraiserMonitor {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly workflow: WorkflowClient, private readonly pollMs = POLL_MS) {}

  getSnapshot = (): HelmraiserMonitorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.startPolling();
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  };

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    // Keep the last error on screen until this load answers, so a background
    // poll does not blink the unavailable line off and on every interval.
    this.set({ ...this.snapshot, loading: true });
    this.refreshing = this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async load(): Promise<void> {
    try {
      const status = await this.workflow.status();
      this.set({ status, loading: false, error: null, unavailable: false });
    } catch (error) {
      const fault = humaneError(error, 'Helmraiser unreachable');
      // Not running is something waiting on you, not a fault: keep polling so
      // the panel recovers the moment Helmraiser starts answering.
      this.set({ ...this.snapshot, status: null, loading: false, error: fault.message, unavailable: fault.unavailable });
    }
  }

  private startPolling(): void {
    if (!this.timer && this.listeners.size > 0) this.timer = setInterval(() => void this.refresh(), this.pollMs);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private set(snapshot: HelmraiserMonitorSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export const HELMRAISER_MONITOR = token<HelmraiserMonitor>('HelmraiserMonitor');
