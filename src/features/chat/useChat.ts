import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { CHAT_SESSION, type QueuedMessage } from './chat-session.service.ts';
import type { ChatTurnOptions } from './chat-orchestrator.client.ts';
import type { ChatImageAttachment, ChatSessionInfo } from '@shared/transport/protocol.ts';
import type { ChatTimelineItem, ChatUsage } from './chat.types.ts';
import type { LiveCrewAgent } from './crew-live.ts';

export interface UseChat {
  messages: ChatTimelineItem[];
  busy: boolean;
  usage: ChatUsage | null;
  sessions: ChatSessionInfo[];
  /** The open chat's title and working folder, as the sidecar last reported them. */
  activeSession: ChatSessionInfo | null;
  activeSessionPath: string | null;
  activeCrew: LiveCrewAgent[];
  crewUnread: number;
  /** Messages typed while a turn was streaming, waiting their turn. */
  queued: QueuedMessage[];
  /** Present while another client owns the shared turn. */
  turnNotice: string | null;
  /** Queued messages an engine refusal handed back, waiting for the composer. */
  returned: QueuedMessage[];
  send: (text: string, opts?: ChatTurnOptions, images?: ChatImageAttachment[]) => void;
  /** Stops the turn and hands back the queued messages it cleared. */
  cancel: () => QueuedMessage[];
  /** Drops one queued message and returns it, so its text can be restored. */
  unqueue: (id: string) => QueuedMessage | null;
  /** Takes the messages handed back, for the composer; each is given once. */
  takeReturned: () => QueuedMessage[];
  resolveApproval: (requestId: string, approved: boolean) => Promise<void>;
  /** FO's own `/compact` (pi); rejects with what to tell the owner. */
  compact: (instructions?: string) => Promise<void>;
  /** FO's own `/rename` (pi). */
  rename: (name: string) => Promise<void>;
  newChat: () => Promise<void>;
  /** True when it opened here; false when another tab held it and that tab was shown instead. */
  openChat: (path: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  markCrewSeen: () => void;
  setCrewViewed: (viewed: boolean) => void;
}

/**
 * React binding for the container-owned conversation. The transcript lives in
 * `ChatSession`, so switching cockpit views (which unmounts the panel) no longer
 * discards it.
 */
export function useChat(): UseChat {
  const session = useService(CHAT_SESSION);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    send: (text, opts, images) => session.send(text, opts, images),
    cancel: () => session.cancel(),
    unqueue: (id) => session.unqueue(id),
    takeReturned: () => session.takeReturned(),
    resolveApproval: (requestId, approved) => session.resolveApproval(requestId, approved),
    compact: (instructions) => session.compact(instructions),
    rename: (name) => session.rename(name),
    newChat: () => session.newChat(),
    openChat: (path) => session.openChat(path),
    refresh: () => session.refresh(),
    markCrewSeen: () => session.markCrewSeen(),
    setCrewViewed: (viewed) => session.setCrewViewed(viewed),
  };
}
