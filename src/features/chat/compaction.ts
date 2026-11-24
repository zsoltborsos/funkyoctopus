import type { ChatStep } from '@shared/transport/protocol.ts';

/** `33213` as `33k`; under a thousand it stays exact. */
function tokens(count: number): string {
  return count < 1000 ? String(count) : `${Math.round(count / 1000)}k`;
}

/**
 * The one dim line that marks where an engine compacted the conversation's
 * context. A live compaction knows its trigger and sizes; a reopened transcript
 * can only say that it happened.
 */
export function compactionLabel(step: Extract<ChatStep, { kind: 'compaction' }>): string {
  const base = step.trigger === 'auto' ? 'context auto-compacted' : 'context compacted';
  if (step.preTokens === undefined) return base;
  if (step.postTokens === undefined) return `${base} · from ${tokens(step.preTokens)} tokens`;
  return `${base} · ${tokens(step.preTokens)} → ${tokens(step.postTokens)} tokens`;
}
