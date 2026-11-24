/**
 * The chat view model. `ChatRole` / `ChatStep` / `ChatMessage` are the wire
 * contract (the server sends whole messages when a stored session is reopened),
 * so they are defined in `protocol.ts` and re-exported here — the feature keeps
 * importing them from its own module.
 */
export type {
  ChatCrewAuditItem,
  ChatEventItem,
  ChatMessage,
  ChatRole,
  ChatStep,
  ChatTimelineItem,
} from '@shared/transport/protocol.ts';
export { isChatEventItem, isCrewAuditItem } from '@shared/transport/protocol.ts';

/** Context-window occupancy of the live pi session, as pi reports it. */
export interface ChatUsage {
  /** Estimated context tokens, or null when pi cannot estimate yet. */
  tokens: number | null;
  contextWindow: number;
  /** Occupancy as a percentage of the window, or null when `tokens` is null. */
  percent: number | null;
}
