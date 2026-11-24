/**
 * Shared pure mapping of pi's role-custom messages to the generic wire envelope.
 *
 * Used by both the live stream (`PiChat.send` and the observation stream) and
 * the reopen projection (`toCustomEvents`), so the two sources cannot drift.
 * Everything here is deterministic and JSON-safe: content is narrowed to plain
 * text, details are copied into a JSON-safe shape (never cyclic or non-JSON),
 * and the canonical id is always the persisted `custom_message` entry id — never
 * a fabricated fallback, which would duplicate against canonical readback.
 */

import type { CustomMessageEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';

/** The live role-custom message shape pi's `message_end` events carry. */
export interface CustomMessageLike {
  role: 'custom';
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

/** Safe plain text of pi custom-message content (string or text parts). */
export function customMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null ? part : null) as
      | { type?: unknown; text?: unknown }
      | null)
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part !== null && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/**
 * A JSON-safe copy of structured details: plain JSON values pass through, and
 * anything the wire cannot carry (cycles, functions, symbols, non-plain
 * objects) is neutralised instead of throwing. Shared references are copied,
 * not preserved — the wire only needs the value, never the graph identity.
 */
export function jsonSafeDetails(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    // functions, symbols, undefined
    return null;
  }
  if (seen.has(value)) {
    // cycle — the wire is JSON, so the reference becomes null
    return null;
  }
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((entry) => jsonSafeDetails(entry, seen));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = jsonSafeDetails(entry, seen);
    }
    result = copy;
  }
  seen.delete(value);
  return result;
}

/**
 * Per-session custom-message id reconciliation state.
 *
 * One state per live AgentSession, shared by every observer of that session's
 * events (chat.send's mapping and the observation stream), so the same message
 * object always resolves to the same canonical entry id and two distinct
 * identical events claim distinct entries in append order.
 */
export interface CustomIdState {
  /** Entry ids already claimed by a live event — never offered again. */
  claimed: Set<string>;
  /** Live message object → canonical entry id, so simultaneous observers of
   *  the same event agree without a second readback. */
  byMessage: WeakMap<object, string>;
}

/**
 * Create per-session reconciliation state. `initialClaimed` seeds the claimed
 * set with every custom_message entry id already persisted when the session is
 * armed: a resumed/opened session's history must never be claimable by a new
 * live event that happens to be semantically identical to an old one. Entries
 * appended after arming are not pre-claimed — they are exactly what a fresh
 * event must resolve to.
 */
export function createCustomIdState(initialClaimed?: Iterable<string>): CustomIdState {
  return { claimed: new Set(initialClaimed), byMessage: new WeakMap() };
}

/** Deep equality over JSON-safe values (plain objects, arrays, primitives). */
function jsonSafeEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => jsonSafeEqual(value, b[index]));
  }
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) =>
        jsonSafeEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function entryMatches(entry: SessionEntry, message: CustomMessageLike): boolean {
  if (entry.type !== 'custom_message') return false;
  return (
    entry.customType === message.customType &&
    entry.display === message.display &&
    customMessageText(entry.content) === customMessageText(message.content) &&
    jsonSafeEqual(jsonSafeDetails(entry.details), jsonSafeDetails(message.details))
  );
}

/**
 * Resolve the canonical persisted entry id for a live role-custom message.
 *
 * Matches semantically (customType, display, normalized content, JSON-safe
 * details) — never by timestamp — and picks the **oldest unmatched** entry in
 * append order, so a synchronous batch of identical events keeps its order and
 * each distinct event claims its own entry. The per-message cache makes
 * simultaneous observers of the same event object agree on one id.
 *
 * Returns null when nothing matches (or everything matching is claimed): pi
 * appends the entry before the deferral microtask, so a null here means the
 * event genuinely has no canonical persisted identity. The caller must not
 * emit an irreconcilable fallback that would duplicate against canonical
 * readback — skip and let readback recover (lossy is fine, wrong is not).
 */
export function resolveCustomEntryId(
  entries: SessionEntry[],
  state: CustomIdState,
  message: CustomMessageLike,
): string | null {
  const cached = state.byMessage.get(message);
  if (cached) return cached;
  for (const entry of entries) {
    if (state.claimed.has(entry.id)) continue;
    if (entryMatches(entry, message)) {
      state.claimed.add(entry.id);
      state.byMessage.set(message, entry.id);
      return entry.id;
    }
  }
  return null;
}

function toCustomChunk(input: {
  id: string;
  customType: string;
  display: boolean;
  content: unknown;
  details: unknown;
  timestamp: number;
}): ChatChunk {
  return {
    kind: 'custom-message',
    id: input.id,
    customType: input.customType,
    display: input.display,
    content: customMessageText(input.content),
    details: jsonSafeDetails(input.details),
    timestamp: input.timestamp,
  };
}

/** Live source: a role-custom `message_end` message → generic chunk. */
export function customMessageChunkFromLive(
  message: CustomMessageLike,
  id: string,
): ChatChunk {
  return toCustomChunk({
    id,
    customType: message.customType,
    display: message.display,
    content: message.content,
    details: message.details,
    timestamp: message.timestamp,
  });
}

/** Reopen source: a persisted `custom_message` entry → generic chunk. */
export function customMessageChunkFromEntry(entry: CustomMessageEntry): ChatChunk {
  return toCustomChunk({
    id: entry.id,
    customType: entry.customType,
    display: entry.display,
    content: entry.content,
    details: entry.details,
    timestamp: Date.parse(entry.timestamp),
  });
}
