import { token } from '@core/container/container.ts';
import type { PreferencesService } from '@features/settings/preferences.service.ts';
import type { ChatEventItem, ChatTimelineItem } from './chat.types.ts';
import { isChatEventItem, isCrewAuditItem } from './chat.types.ts';
import { crewResultDetails } from './crew-card.ts';
import type { LiveCrewAgent } from './crew-live.ts';

export interface TurnAttentionTicket {
  readonly eligibleAtArrival: boolean;
  /** The tab the turn ended in: a click shows it. */
  readonly chatId: string;
}

const ATTENTION_STATUSES = new Set(['completed', 'needs_input', 'error']);

/**
 * Browser-only attention policy for chat and crew completion.
 *
 * ChatSession supplies only events from its live ingestion paths. This class
 * owns the browser conditions, notification click action, turn de-duplication,
 * and the pending scroll hand-off needed when ChatPanel is unmounted.
 */
export class ChatAttentionNotifications {
  /** Shows the chat view on that tab; true when that switched tabs (its panel mounts next). */
  private openChat: ((chatId: string) => boolean) | null = null;
  private scrollToLatest: (() => void) | null = null;
  private pendingScroll = false;
  /**
   * An end without a later matching start is a duplicate, not a new turn. Keyed
   * by tab and origin: one client can run turns in two tabs.
   */
  private readonly endedOrigins = new Set<string>();

  constructor(private readonly preferences: PreferencesService) {}

  /** Keep click navigation active for the app lifetime. */
  start(openChat: (chatId: string) => boolean): () => void {
    this.openChat = openChat;
    return () => {
      if (this.openChat === openChat) this.openChat = null;
    };
  }

  /** Register the mounted transcript's real jump-to-latest action. */
  attachScroller(scrollToLatest: () => void): () => void {
    this.scrollToLatest = scrollToLatest;
    if (this.pendingScroll) {
      this.pendingScroll = false;
      scrollToLatest();
    }
    return () => {
      if (this.scrollToLatest === scrollToLatest) this.scrollToLatest = null;
    };
  }

  turnStarted(chatId: string, origin: string | null): void {
    this.endedOrigins.delete(JSON.stringify([chatId, origin]));
  }

  /** Capture eligibility synchronously, before transcript reconciliation awaits. */
  beginTurnEnded(chatId: string, origin: string | null): TurnAttentionTicket | null {
    const key = JSON.stringify([chatId, origin]);
    if (this.endedOrigins.has(key)) return null;
    this.endedOrigins.add(key);
    return { eligibleAtArrival: this.canNotify(), chatId };
  }

  /** Deliver after the completed transcript is available, if still eligible. */
  finishTurnEnded(ticket: TurnAttentionTicket | null, timeline: ChatTimelineItem[], title: string | null): void {
    if (!ticket?.eligibleAtArrival || !this.canNotify()) return;
    const body = title?.trim() || lastAssistantText(timeline).slice(0, 80);
    this.show('FO: turn finished', body, ticket.chatId);
  }

  /** Notify newly reached crew attention states, never unchanged snapshots. */
  crewChanged(
    chatId: string,
    event: ChatEventItem,
    before: LiveCrewAgent[],
    after: LiveCrewAgent[],
    liveEvent: boolean,
  ): void {
    if (!liveEvent || !this.canNotify()) return;

    if (event.customType === 'crew-result') {
      const details = crewResultDetails(event.details);
      if (!details || !ATTENTION_STATUSES.has(details.status)) return;
      const row = details.agentId
        ? before.find((agent) => agent.agentId === details.agentId)
        : undefined;
      if (row?.status === details.status) return;
      const label = row?.agentName ?? details.agentName;
      if (label) this.show(`FO: crew agent ${details.status}`, label, chatId);
      return;
    }

    if (event.customType !== 'crew-status') return;
    for (const agent of after) {
      if (!ATTENTION_STATUSES.has(agent.status)) continue;
      const previous = before.find((row) => row.agentId === agent.agentId);
      if (previous?.status === agent.status) continue;
      this.show(`FO: crew agent ${agent.status}`, agent.agentName, chatId);
    }
  }

  private canNotify(): boolean {
    return (
      this.preferences.get().notifyChat &&
      document.visibilityState !== 'visible' &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    );
  }

  private show(title: string, body: string, chatId: string): void {
    const notification = new Notification(title, { body });
    notification.onclick = (): void => {
      window.focus();
      // Showing another tab mounts its panel: the scroll waits for that one.
      const switched = this.openChat?.(chatId) === true;
      const scroll = this.scrollToLatest;
      if (scroll && !switched) scroll();
      else this.pendingScroll = true;
    };
  }
}

function lastAssistantText(timeline: ChatTimelineItem[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (!item || isChatEventItem(item) || isCrewAuditItem(item) || item.role !== 'assistant') continue;
    return item.steps
      .filter((step): step is Extract<(typeof item.steps)[number], { kind: 'text' }> => step.kind === 'text')
      .map((step) => step.text)
      .join('');
  }
  return '';
}

export const CHAT_ATTENTION_NOTIFICATIONS = token<ChatAttentionNotifications>(
  'ChatAttentionNotifications',
);
