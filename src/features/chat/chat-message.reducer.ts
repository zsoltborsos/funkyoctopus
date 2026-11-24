import type { ChatChunk } from '@shared/transport/protocol.ts';
import { isChatEventItem, isCrewAuditItem } from '@shared/transport/protocol.ts';
import type { ChatEventItem, ChatMessage, ChatStep, ChatTimelineItem } from './chat.types.ts';

function appendDelta(steps: ChatStep[], kind: 'text' | 'thinking', delta: string): ChatStep[] {
  const last = steps.at(-1);
  if (last?.kind === kind) {
    return [...steps.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...steps, { kind, text: delta }];
}

/** Folds one wire chunk into the ordered steps of an assistant turn. */
export function reduceChatChunk(message: ChatMessage, chunk: ChatChunk): ChatMessage {
  if (chunk.kind === 'text' || chunk.kind === 'thinking') {
    return { ...message, steps: appendDelta(message.steps, chunk.kind, chunk.delta) };
  }
  if (chunk.kind === 'tool-call' || chunk.kind === 'approval-request' || chunk.kind === 'compaction') {
    return { ...message, steps: [...message.steps, chunk] };
  }
  if (chunk.kind === 'usage') {
    return message;
  }
  // A custom message is a session-level timeline event, never a step of the
  // assistant turn. The caller inserts it into the timeline directly.
  if (chunk.kind === 'custom-message') {
    return message;
  }
  // Observation-stream control events and the agent-chunk envelope are never
  // `chat.send` chunks; guarded so the shared wire union cannot fall through
  // to the tool-result branch. (The service unwraps an agent-chunk's inner
  // chunk before calling this reducer.)
  if (
    chunk.kind === 'session-changed' ||
    chunk.kind === 'turn-started' ||
    chunk.kind === 'turn-ended' ||
    chunk.kind === 'agent-chunk' ||
    chunk.kind === 'approval-resolved'
  ) {
    return message;
  }

  const result: ChatStep = chunk;
  const existing = message.steps.findIndex(
    (step) => step.kind === 'tool-result' && step.callId === chunk.callId,
  );
  if (existing >= 0) {
    return {
      ...message,
      steps: message.steps.map((step, index) => (index === existing ? result : step)),
    };
  }

  const call = message.steps.findIndex(
    (step) => step.kind === 'tool-call' && step.callId === chunk.callId,
  );
  if (call < 0) {
    return { ...message, steps: [...message.steps, result] };
  }
  return {
    ...message,
    steps: [...message.steps.slice(0, call + 1), result, ...message.steps.slice(call + 1)],
  };
}

/**
 * Insert a custom event into the timeline, deduplicated by stable id, at its
 * chronological position (before the first item with a later timestamp; newer
 * events append). Never merges into a message.
 */
export function insertTimelineEvent(
  timeline: ChatTimelineItem[],
  event: ChatEventItem,
): ChatTimelineItem[] {
  if (timeline.some((item) => isChatEventItem(item) && item.id === event.id)) {
    return timeline;
  }
  const at = event.timestamp;
  const insertAt = timeline.findIndex((item) =>
    isChatEventItem(item) || isCrewAuditItem(item) ? item.timestamp > at : item.createdAt > at,
  );
  if (insertAt < 0) {
    return [...timeline, event];
  }
  return [...timeline.slice(0, insertAt), event, ...timeline.slice(insertAt)];
}
