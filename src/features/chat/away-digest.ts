import { token } from '@core/container/container.ts';
import type { HelmraiserEvent } from '@shared/transport/protocol.ts';
import type { ChatLiveActivity, ChatSession } from './chat-session.service.ts';
import type { HelmraiserNotifications } from '@features/jobs/helmraiser-notifications.service.ts';

export const AWAY_THRESHOLD_MS = 60_000;
export const AWAY_DIGEST_LIMIT = 10;

export interface AwayDigestEntry {
  id: number;
  at: number;
  target: 'chat' | 'jobs';
  label: string;
  attention: boolean;
}

export interface AwayDigestSnapshot {
  entries: AwayDigestEntry[];
  overflow: number;
  shownAt: number;
}

const EMPTY: AwayDigestSnapshot | null = null;

/**
 * Page-lifetime, tab-local collection of live activity received while hidden.
 * It deliberately owns no storage: a reload or a new tab always starts empty.
 */
export class AwayDigest {
  private snapshot: AwayDigestSnapshot | null = EMPTY;
  private readonly listeners = new Set<() => void>();
  private hiddenAt: number | null = null;
  /** At most the newest renderable entries; total preserves the overflow count. */
  private captured: AwayDigestEntry[] = [];
  private capturedCount = 0;
  private sequence = 0;
  private cleanup: (() => void) | null = null;

  constructor(
    /** Live activity from every chat tab. */
    private readonly chat: Pick<ChatSession, 'subscribeActivity'>,
    private readonly helmraiser: HelmraiserNotifications,
    private readonly page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
    private readonly now: () => number = Date.now,
  ) {}

  getSnapshot = (): AwayDigestSnapshot | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Start page visibility and live-event capture. Idempotent for StrictMode. */
  start(): () => void {
    if (this.cleanup) return this.cleanup;
    const onVisibility = (): void => this.visibilityChanged();
    this.page.addEventListener('visibilitychange', onVisibility);
    const stopChat = this.chat.subscribeActivity((activity) => this.recordChat(activity));
    const stopHelmraiser = this.helmraiser.subscribeEvents((event) => this.recordHelmraiser(event));
    if (this.page.visibilityState === 'hidden') this.beginHiddenPeriod();
    const cleanup = (): void => {
      if (this.cleanup !== cleanup) return;
      this.page.removeEventListener('visibilitychange', onVisibility);
      stopChat();
      stopHelmraiser();
      this.cleanup = null;
    };
    this.cleanup = cleanup;
    return cleanup;
  }

  dismiss(): void {
    this.captured = [];
    this.capturedCount = 0;
    this.setSnapshot(null);
  }

  private visibilityChanged(): void {
    if (this.page.visibilityState === 'hidden') {
      this.beginHiddenPeriod();
      return;
    }
    if (this.hiddenAt === null) return;
    const elapsed = this.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (elapsed >= AWAY_THRESHOLD_MS && this.captured.length > 0) {
      const newest = [...this.captured].reverse();
      this.setSnapshot({
        entries: newest,
        overflow: Math.max(0, this.capturedCount - newest.length),
        shownAt: this.now(),
      });
    } else {
      this.captured = [];
      this.capturedCount = 0;
      this.setSnapshot(null);
    }
  }

  private beginHiddenPeriod(): void {
    this.hiddenAt = this.now();
    this.captured = [];
    this.capturedCount = 0;
    this.setSnapshot(null);
  }

  private recordChat(activity: ChatLiveActivity): void {
    if (activity.kind === 'turn-ended') {
      if (activity.failed) this.capture(activity.at, 'chat', 'A turn failed', true);
      else this.capture(activity.at, 'chat', 'A turn finished', false);
      return;
    }
    const state =
      activity.status === 'completed'
        ? 'completed'
        : activity.status === 'needs_input'
          ? 'needs input'
          : 'failed';
    this.capture(
      activity.at,
      'chat',
      `${activity.agentName} ${state}`,
      activity.status !== 'completed',
    );
  }

  private recordHelmraiser(event: HelmraiserEvent): void {
    const state =
      event.event === 'awaiting'
        ? 'needs approval'
        : event.event === 'failed'
          ? 'failed'
          : 'landed';
    this.capture(this.now(), 'jobs', `Helmraiser ${state} · ${event.title}`, event.event === 'awaiting');
  }

  private capture(
    at: number,
    target: AwayDigestEntry['target'],
    label: string,
    attention: boolean,
  ): void {
    if (this.hiddenAt === null || this.page.visibilityState !== 'hidden') return;
    this.sequence += 1;
    this.capturedCount += 1;
    this.captured.push({ id: this.sequence, at, target, label, attention });
    if (this.captured.length > AWAY_DIGEST_LIMIT) this.captured.shift();
  }

  private setSnapshot(snapshot: AwayDigestSnapshot | null): void {
    if (this.snapshot === snapshot) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export const AWAY_DIGEST = token<AwayDigest>('AwayDigest');

export function relativeAwayTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
