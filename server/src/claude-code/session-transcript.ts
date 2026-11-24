/**
 * Projects a stored Claude Code session into the cockpit's chat view model.
 *
 * Claude Code owns the transcript (decision 12); the Agent SDK's
 * `getSessionMessages` reads it, and this turns what it returns into
 * `ChatMessage`s for a reopened chat, a reload and a follower tab. Like its pi
 * counterpart it is one-way and lossy, and the rule is the same: **lossy is
 * fine, wrong is not.** An entry or content block it does not recognise is
 * skipped, never rendered as a placeholder, so a newer `claude` cannot break a
 * rehydrated transcript.
 *
 * What a stored entry looks like was recorded, not assumed
 * (`fixtures/session-messages.json`): every content block of one API message is
 * its own entry; a tool result is a user entry carrying `tool_result` blocks;
 * entries have a `timestamp` and flags (`isCompactSummary`, `is_meta`,
 * `isCompletedLocalCommand`) that the SDK's types leave out. After a `/compact`
 * the chain starts at the stored summary, so the history before it is not
 * returned at all.
 */

import type { ChatMessage, ChatStep } from '../../../src/shared/transport/protocol.ts';
import { isRecord } from '../util/records.ts';
import { toolResultChunk, toolSummary } from './chunks.ts';

const COMMAND_NAME = /<command-name>\s*(.*?)\s*<\/command-name>/su;
const COMMAND_ARGS = /<command-args>\s*(.*?)\s*<\/command-args>/su;
/** A local command's output (`/context`, `/compact`'s "Compacted"): the CLI's, not a conversation turn. */
const LOCAL_OUTPUT = /^\s*<local-command-(?:stdout|stderr|caveat)>/u;
/** What the CLI writes as a user message when the owner interrupts a turn. */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/u;

/** Epoch ms of an entry's ISO `timestamp`; null when it has none or cannot be read. */
function timeOf(entry: Record<string, unknown>): number | null {
  if (typeof entry.timestamp !== 'string') return null;
  const ms = Date.parse(entry.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** A subagent's entry: one that names the tool call that spawned it, or the agent that did. */
function isSubagent(entry: Record<string, unknown>): boolean {
  const spawned = entry.parent_tool_use_id;
  const by = entry.parent_agent_id;
  return (spawned !== null && spawned !== undefined) || (by !== null && by !== undefined);
}

/** The text of a user content value, the typed command if it is one, and nothing for CLI noise. */
function userText(content: unknown, localCommand: boolean): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
          .join('\n')
      : '';
  const command = COMMAND_NAME.exec(text)?.[1];
  if (command !== undefined && command !== '') {
    const args = COMMAND_ARGS.exec(text)?.[1] ?? '';
    return args === '' ? command : `${command} ${args}`;
  }
  if (localCommand || LOCAL_OUTPUT.test(text) || INTERRUPTED.test(text.trim())) return '';
  return text.trim() === '' ? '' : text;
}

/** A user entry's steps: the text first, then each image in the order it was attached. */
function userSteps(content: unknown, localCommand: boolean): ChatStep[] {
  const steps: ChatStep[] = [];
  const text = userText(content, localCommand);
  if (text !== '') steps.push({ kind: 'text', text });
  if (!Array.isArray(content)) return steps;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) continue;
    const { source } = block;
    if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      steps.push({ kind: 'image', mimeType: source.media_type, data: source.data });
    }
  }
  return steps;
}

/** An assistant entry's steps. Empty thinking (the signature alone) and unknown blocks are dropped. */
function assistantSteps(content: unknown): ChatStep[] {
  if (!Array.isArray(content)) return [];
  const steps: ChatStep[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      steps.push({ kind: 'text', text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
      steps.push({ kind: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      steps.push({
        kind: 'tool-call',
        callId: block.id,
        tool: block.name,
        summary: toolSummary(block.name, block.input),
        args: block.input,
      });
    }
  }
  return steps;
}

/**
 * Project the entries `getSessionMessages` returned into renderable messages.
 *
 * Everything between two prompts of the owner's is one assistant message, as a
 * live turn is: its thinking, calls, results and text in the order they
 * happened. Compaction is marked rather than dropped, so a rehydrated chat does
 * not silently look shorter than the conversation was.
 */
export function toMessages(entries: readonly unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  /** callId → the assistant message that issued it, for attaching results. */
  const owners = new Map<string, ChatMessage>();
  /** The assistant message the current turn is adding to; a prompt or a compaction ends it. */
  let open: ChatMessage | null = null;
  let lastAt = 0;

  const idOf = (entry: Record<string, unknown>): string =>
    typeof entry.uuid === 'string' ? entry.uuid : `stored-${messages.length}`;

  for (const entry of entries) {
    if (!isRecord(entry) || isSubagent(entry)) continue;
    lastAt = timeOf(entry) ?? lastAt;
    const body = isRecord(entry.message) ? entry.message : null;

    if (entry.type === 'assistant') {
      // Claude Code's own notices (a local command's output, "No response requested.") are not the model's words.
      if (!body || body.model === '<synthetic>') continue;
      const steps = assistantSteps(body.content);
      if (steps.length === 0) continue;
      if (!open) {
        open = {
          id: idOf(entry),
          role: 'assistant',
          historical: true,
          steps: [],
          createdAt: lastAt,
          ...(typeof body.model === 'string' ? { model: body.model } : {}),
        };
        messages.push(open);
      }
      open.steps.push(...steps);
      for (const step of steps) {
        if (step.kind === 'tool-call') owners.set(step.callId, open);
      }
      continue;
    }

    if (entry.type !== 'user' || !body) continue;
    if (entry.isCompactSummary === true) {
      messages.push({ id: idOf(entry), role: 'assistant', historical: true, steps: [{ kind: 'compaction' }], createdAt: lastAt });
      open = null;
      continue;
    }
    // Injected context, and input that did not come from the owner at this keyboard.
    if (entry.is_meta === true) continue;
    if (isRecord(entry.origin) && entry.origin.kind !== 'human') continue;

    if (Array.isArray(body.content)) {
      for (const block of body.content) {
        const result = toolResultChunk(block)[0];
        if (result?.kind !== 'tool-result') continue;
        const owner = owners.get(result.callId);
        // A result whose call was never seen is dropped, not attached to the nearest message.
        if (!owner || owner.steps.some((step) => step.kind === 'tool-result' && step.callId === result.callId)) continue;
        const at = owner.steps.findIndex((step) => step.kind === 'tool-call' && step.callId === result.callId);
        owner.steps.splice(at + 1, 0, result);
      }
    }
    const steps = userSteps(body.content, entry.isCompletedLocalCommand === true);
    if (steps.length === 0) continue;
    messages.push({ id: idOf(entry), role: 'user', historical: true, steps, createdAt: lastAt });
    open = null;
  }
  settleCompactions(messages);
  return messages;
}

/**
 * The stored chain starts with the compaction summary and keeps the messages
 * that survived it after, though they are older: the summary was written when
 * the compaction happened. Move each marker past the messages strictly older
 * than it, so it reads where it happened. Equal or unreadable times move nothing.
 */
function settleCompactions(messages: ChatMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const marker = messages[index];
    if (marker?.steps[0]?.kind !== 'compaction') continue;
    let end = index;
    while ((messages[end + 1]?.createdAt ?? Infinity) < marker.createdAt) end += 1;
    if (end === index) continue;
    messages.splice(index, 1);
    messages.splice(end, 0, marker);
  }
}
