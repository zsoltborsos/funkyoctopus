import { token } from '@core/container/container.ts';
import type { HelmraiserEvent } from '@shared/transport/protocol.ts';
import type { SystemClient } from '@features/status/system.client.ts';
import type { PreferencesService } from '@features/settings/preferences.service.ts';
import type { WorkflowClient } from './workflow.client.ts';

/**
 * The slice of the transport the service needs: connection state and its
 * change subscription. `TransportClient` satisfies it structurally.
 */
export interface ConnectionSurface {
  getState: () => 'connecting' | 'open' | 'closed';
  subscribe: (listener: () => void) => () => void;
}

const SUMMARY: Record<HelmraiserEvent['event'], string> = {
  awaiting: 'Helmraiser: approval needed',
  failed: 'Helmraiser: run failed',
  landed: 'Helmraiser: run landed',
};

/**
 * Turns sidecar helmraiser-events into browser Notifications, while a tab is
 * open — the counterpart of the sidecar's optional desktop delivery, which
 * works with no tab. One subscription lives for the page's lifetime: it is
 * (re)opened whenever the transport connects, and cancelled when it drops or
 * the effect cleans up. Health decides duplicate suppression: when the
 * sidecar reports `desktopNotifications`, this service stays quiet so the
 * owner is told exactly once. Permission is only ever granted through the
 * Settings toggle; nothing here requests it.
 */
export class HelmraiserNotifications {
  /** What the last successful health read reported; refreshed per reconnect. */
  private desktopReported = false;
  private cancelStream: (() => void) | null = null;
  /** Stale-reconnect guard: a health read from an older connection is ignored. */
  private generation = 0;
  private disposed = false;
  /** Always-on in-page consumers; independent of notification preferences. */
  private readonly eventListeners = new Set<(event: HelmraiserEvent) => void>();

  constructor(
    private readonly workflow: WorkflowClient,
    private readonly system: SystemClient,
    private readonly preferences: PreferencesService,
    private readonly transport: ConnectionSurface,
  ) {}

  subscribeEvents(listener: (event: HelmraiserEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribes for the page lifetime; returns the effect cleanup. */
  start(openJobs: () => void): () => void {
    this.disposed = false;
    const unsubscribe = this.transport.subscribe(() => {
      if (this.transport.getState() === 'open') this.wire(openJobs);
      else this.dropStream();
    });
    if (this.transport.getState() === 'open') this.wire(openJobs);
    return () => {
      this.disposed = true;
      unsubscribe();
      this.dropStream();
    };
  }

  private wire(openJobs: () => void): void {
    if (this.cancelStream !== null || this.disposed) return;
    this.generation += 1;
    const generation = this.generation;
    // A failed health read must not block browser notifications: absence of
    // the flag means desktop delivery is not reported, so the browser acts.
    void this.system.health()
      .catch(() => undefined)
      .then((health) => {
        // Stale in-flight reads from a dropped connection must never open a
        // second stream: the newer wire owns the slot, and an overwrite would
        // leak one stream past cleanup and duplicate every notification.
        if (this.disposed || generation !== this.generation || this.cancelStream !== null) return;
        this.desktopReported = health?.desktopNotifications === true;
        this.cancelStream = this.workflow.observe({
          onEvent: (event) => this.onEvent(event, openJobs),
        });
      });
  }

  private dropStream(): void {
    this.cancelStream?.();
    this.cancelStream = null;
    // Dropping the stream invalidates any health read still in flight, so a
    // reconnect's wire owns the slot no matter how the old read settles.
    this.generation += 1;
  }

  private onEvent(event: HelmraiserEvent, openJobs: () => void): void {
    this.eventListeners.forEach((listener) => listener(event));
    if (!this.preferences.get().notifyHelmraiser) return;
    if (this.desktopReported) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const notification = new Notification(SUMMARY[event.event], { body: event.title });
    notification.onclick = (): void => {
      window.focus();
      openJobs();
    };
  }
}

export const HELMRAISER_NOTIFICATIONS = token<HelmraiserNotifications>('HelmraiserNotifications');
