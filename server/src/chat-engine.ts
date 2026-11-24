import type {
  EngineKind,
  SessionRef,
  ChatChunk,
  ChatCommandsResult,
  ChatSessionInfo,
  ChatTimelineItem,
} from '../../src/shared/transport/protocol.ts';
import type { ChatTurnOptions } from './pi/pi-chat.ts';

export type { EngineKind, SessionRef } from '../../src/shared/transport/protocol.ts';

/**
 * What the chat seam and the slot registry (`chat-registry.ts`) use of a chat
 * engine: exactly the members they call. `PiChat` and `ClaudeCodeChat` both
 * satisfy it, so a slot holds either and the seams never learn which.
 */
export interface ChatEngine {
  readonly kind: EngineKind;
  send(
    text: string,
    signal: AbortSignal,
    opts?: ChatTurnOptions,
    origin?: string | null,
  ): AsyncIterable<ChatChunk>;
  observe(signal: AbortSignal, clientId?: string | null): AsyncIterable<ChatChunk>;
  setRoot(path: string | null, origin?: string | null): Promise<ChatTimelineItem[]>;
  newChat(origin?: string | null): Promise<ChatSessionInfo | null>;
  openChat(path: string, origin?: string | null): Promise<ChatTimelineItem[]>;
  listChats(root: string | null): Promise<ChatSessionInfo[]>;
  current(): Promise<ChatSessionInfo | null>;
  transcript(): Promise<ChatTimelineItem[]>;
  resolveApproval(requestId: string, approved: boolean): boolean;
  /** The `/` palette's commands for this engine (T2.4b); never starts a Claude Code process. */
  commands(): Promise<ChatCommandsResult>;
  /**
   * FunkyOctopus's own `/compact` and `/rename`, for an engine whose own are
   * not reachable as text (pi's are its TUI's). Claude Code runs its own
   * `/compact` and `/rename` sent as text, so it has neither.
   */
  compact?(instructions: string | undefined, origin: string | null): Promise<void>;
  rename?(name: string): Promise<ChatSessionInfo | null>;

  // What the slot registry reads and drives (T2.1). None of it builds or starts anything.

  /** The session the engine holds right now, read without building or starting one. */
  info(): ChatSessionInfo | null;
  /** The slot's working folder; null at the configured global root. */
  folder(): string | null;
  /**
   * Restore after a restart (T2.3): arm a stored session for the next send,
   * building, starting and sending nothing (limit 2). Claude's start-time
   * check still decides fork-or-resume (limit 5). False when the session is
   * gone; the engine is then as it was.
   */
  arm(session: { id: string; path: string }): Promise<boolean>;
  /** A client turn is live, or a run the engine did not start (pi-crew's) is streaming. */
  busy(): boolean;
  /** A child process of the engine's own is up or starting: Claude Code's `claude`. pi runs in-process. */
  running(): boolean;
  /** Subagents still running in sessions this engine switched away from (pi-crew); 0 where none can be. */
  subagentsLeftRunning(): number;
  /** Since when the engine's own child process has sat idle (no turn, approval or draining); null when it has none idle. */
  idleSince(): number | null;
  /** Close that idle process to make room under the cap; its session resumes on the next send. False when none is idle. */
  closeIdle(): boolean;
  /**
   * Calls `listener` whenever the held session changes, with the new one or
   * null when none is held. Returns the unsubscribe.
   */
  onIdentity(listener: (ref: SessionRef | null) => void): () => void;
  /** Ends the engine for good: its live session or process, its observers. Idempotent. */
  dispose(): Promise<void>;
}
