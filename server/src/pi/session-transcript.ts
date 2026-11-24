/**
 * Projects a stored pi session into the cockpit's chat view model.
 *
 * This is the read half of chat persistence: pi's `SessionManager` owns the transcript
 * on disk, and the browser renders a *projection* of it. The projection is
 * deliberately one-way and lossy — it exists for reading a past conversation,
 * not for round-tripping one. pi remains the only writer of session files.
 *
 * It lives on the server, next to `toolChunk()` in `pi-chat.ts`, because doing
 * it in the browser reducer would mean shipping pi's `SessionEntry` types across
 * the wire — exactly what the projected `ChatSessionInfo` exists to prevent.
 *
 * The governing rule: **lossy is fine, wrong is not.** An entry type or content
 * part we do not recognise is skipped, never rendered as a placeholder. A new pi
 * entry type must not be able to break a rehydrated transcript.
 */

import { parseSkillBlock, type SessionEntry, type SessionInfo, type SessionManager } from '@earendil-works/pi-coding-agent';
import {
  CREW_TOOLS,
  type ChatCrewAuditItem,
  type ChatEventItem,
  type ChatMessage,
  type ChatSessionInfo,
  type ChatStep,
  type ChatTimelineItem,
} from '../../../src/shared/transport/protocol.ts';
import { record, resultDetails, resultDiff, resultText, toolSummary } from './tool-result.ts';
import { customMessageChunkFromEntry } from './custom-message.ts';

/** A session with no name and no messages still needs something in the list. */
const UNTITLED = 'untitled chat';

/** Epoch ms from a pi ISO timestamp; 0 rather than NaN when it is unparseable. */
function at(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

/** pi message content is either a bare string or an array of typed parts. */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => record(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join('');
}

/**
 * User content parts → ordered steps: the text first, then every image part in
 * the order it was attached. A message with images but no text keeps its image
 * steps; one with neither yields nothing and is skipped by the caller.
 */
function userSteps(content: unknown): ChatStep[] {
  const steps: ChatStep[] = [];
  const text = plainText(content);
  if (text) steps.push({ kind: 'text', text });
  if (!Array.isArray(content)) return steps;
  for (const raw of content) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      steps.push({ kind: 'image', mimeType: part.mimeType, data: part.data });
    }
  }
  return steps;
}

/** Assistant content parts → ordered steps. Unknown part types are dropped. */
function assistantSteps(content: unknown): ChatStep[] {
  if (!Array.isArray(content)) return [];
  const steps: ChatStep[] = [];
  for (const raw of content) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      steps.push({ kind: 'text', text: part.text });
    } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking) {
      steps.push({ kind: 'thinking', text: part.thinking });
    } else if (part.type === 'toolCall' && typeof part.id === 'string') {
      const tool = typeof part.name === 'string' ? part.name : 'tool';
      steps.push({
        kind: 'tool-call',
        callId: part.id,
        tool,
        summary: toolSummary(tool, part.arguments),
        args: part.arguments,
      });
    }
  }
  return steps;
}

/**
 * Project the entries of a stored session into renderable messages.
 *
 * Pass `manager.buildContextEntries()` rather than `getEntries()`: that follows
 * the current leaf and is compaction-aware, so the transcript shown matches the
 * context the agent itself will continue from.
 *
 * Approvals are **not** reconstructed. An `approval-request` step is a live
 * interaction, not a fact about the transcript, and a stored session has no
 * pending approval by definition.
 */
export function toMessages(entries: SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  /** callId → the assistant message that issued it, for attaching results. */
  const byCallId = new Map<string, ChatMessage>();
  /**
   * The model in force as we walk the transcript. `model_change` entries are
   * otherwise dropped, but they are the only record of which model actually held
   * a given turn — without this, a rehydrated chat gets labelled with whatever
   * the composer is set to today, which is wrong for every chat but the last.
   */
  let model: string | undefined;

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      model = typeof entry.modelId === 'string' ? entry.modelId : undefined;
      continue;
    }
    if (entry.type === 'compaction') {
      // Mark the compaction rather than dropping it, so a rehydrated chat does
      // not silently look shorter than the conversation actually was.
      messages.push({
        id: entry.id,
        role: 'assistant',
        historical: true,
        steps: [{ kind: 'text', text: `⋯ earlier context compacted\n\n${entry.summary}` }],
        createdAt: at(entry.timestamp),
      });
      continue;
    }
    if (entry.type !== 'message') continue;

    const message = record(entry.message);
    if (!message) continue;

    if (message.role === 'user') {
      const steps = userSteps(message.content);
      if (steps.length === 0) continue;
      messages.push({
        id: entry.id,
        role: 'user',
        // Provenance: every stored projection is historical; live reducer
        // messages are created without the flag.
        historical: true,
        steps,
        createdAt: at(entry.timestamp),
      });
    } else if (message.role === 'assistant') {
      const steps = assistantSteps(message.content);
      if (steps.length === 0) continue;
      const projected: ChatMessage = {
        id: entry.id,
        role: 'assistant',
        historical: true,
        steps,
        createdAt: at(entry.timestamp),
        ...(model ? { model } : {}),
      };
      for (const step of steps) {
        if (step.kind === 'tool-call') byCallId.set(step.callId, projected);
      }
      messages.push(projected);
    } else if (message.role === 'toolResult') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : null;
      // A result whose call we never saw is dropped rather than attached to the
      // nearest message — a misattributed tool result is worse than a missing one.
      const owner = callId ? byCallId.get(callId) : undefined;
      if (!callId || !owner) continue;
      const output = resultText(message);
      const diff = resultDiff(message);
      const details = resultDetails(message);
      const step: ChatStep = { kind: 'tool-result', callId, ok: !message.isError };
      if (message.isError) {
        step.error = output ?? 'Tool execution failed';
      } else if (output) {
        step.output = output;
      }
      if (diff) step.diff = diff;
      if (details !== undefined) step.details = details;
      owner.steps = [...owner.steps, step];
    }
  }

  return messages;
}

/** The first user message in a session, as a history-row label. */
function firstUserText(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = record(entry.message);
    if (message?.role !== 'user') continue;
    const text = plainText(message.content).trim();
    if (text) return text;
  }
  return '';
}

/**
 * Collapse a label to one line so a history row cannot blow out the dropdown.
 * pi stores a `/skill:name args` message expanded into the skill's whole body;
 * it is titled as it was typed.
 */
export function toTitle(raw: string): string {
  const skill = parseSkillBlock(raw);
  const typed = skill ? `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ''}` : raw;
  const line = typed.replace(/\s+/gu, ' ').trim();
  if (!line) return UNTITLED;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** pi's `SessionInfo` → the wire type. Dates become ISO-8601, per convention. */
export function toSessionInfo(info: SessionInfo): ChatSessionInfo {
  return {
    path: info.path,
    engine: 'pi',
    id: info.id,
    cwd: info.cwd,
    title: toTitle(info.name ?? info.firstMessage),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
  };
}

/**
 * The same wire shape for the *live* session, read from its manager rather than
 * from a directory listing — so the cockpit can name and highlight the open chat
 * without re-listing the whole directory after every action.
 *
 * Returns null for an in-memory session: it has no file, so it is not a row in
 * any history list. That is the meta-session case, and it is meant to be
 * invisible here.
 */
export function describeManager(manager: SessionManager): ChatSessionInfo | null {
  const path = manager.getSessionFile();
  if (!path || !manager.isPersisted()) return null;
  const entries = manager.getEntries();
  const messages = entries.filter((entry) => entry.type === 'message');
  const created = manager.getHeader()?.timestamp ?? entries[0]?.timestamp;
  const modified = entries.at(-1)?.timestamp ?? created;
  return {
    path,
    engine: 'pi',
    id: manager.getSessionId(),
    cwd: manager.getCwd(),
    title: toTitle(manager.getSessionName() ?? firstUserText(entries)),
    created: new Date(created ? at(created) : Date.now()).toISOString(),
    modified: new Date(modified ? at(modified) : Date.now()).toISOString(),
    messageCount: messages.length,
  };
}

/**
 * custom_message entries → generic timeline events, chronological, deduped by
 * stable entry id.
 *
 * Reads raw `getEntries()` (not the compaction-aware context): crew events are
 * durable across normal pi compaction, so a reopened transcript must keep them
 * even when the surrounding prose was compacted away.
 */
export function toCustomEvents(entries: SessionEntry[]): ChatEventItem[] {
  const seen = new Set<string>();
  const events: ChatEventItem[] = [];
  for (const entry of entries) {
    if (entry.type !== 'custom_message') continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    events.push(customMessageChunkFromEntry(entry) as ChatEventItem);
  }
  return events;
}

/**
 * The full reopened timeline: the compaction-aware message projection merged
 * with every raw custom event.
 *
 * `contextEntries` is `buildContextEntries()` (compaction-aware); `rawEntries`
 * is `getEntries()` (the whole file). Custom events older than the compaction
 * marker land on its historical side — they are durable history, not lost with
 * the compacted prose — and later events are interleaved chronologically with
 * the retained messages. Ties on equal timestamps keep messages before events
 * (deterministic).
 */
/** The crew tools the audit projection rehydrates — the shared, contract-pinned list. */
const CREW_AUDIT_TOOLS = new Set<string>(CREW_TOOLS);

interface RawToolCall {
  id: string;
  name: string;
  args?: unknown;
}

function rawToolCalls(content: unknown): RawToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => record(part))
    .filter(
      (part): part is { type: 'toolCall'; id: string; name?: unknown; arguments?: unknown } =>
        part !== null && part.type === 'toolCall' && typeof part.id === 'string',
    )
    .map((part) => ({
      id: part.id,
      name: typeof part.name === 'string' ? part.name : 'tool',
      args: part.arguments,
    }));
}

/** The toolResult entry following `fromIndex` for `callId`, if any. */
function findToolResult(
  entries: SessionEntry[],
  fromIndex: number,
  callId: string,
): { ok: boolean; output?: string; error?: string; details?: unknown } | undefined {
  for (let index = fromIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
    if (entry.message.toolCallId !== callId) continue;
    const output = resultText(entry.message);
    const error = entry.message.isError ? (output ?? 'Tool execution failed') : undefined;
    const details = resultDetails(entry.message);
    const out: { ok: boolean; output?: string; error?: string; details?: unknown } = {
      ok: !entry.message.isError,
    };
    if (!entry.message.isError && output) out.output = output;
    if (error) out.error = error;
    if (details !== undefined) out.details = details;
    return out;
  }
  return undefined;
}

/**
 * Historical crew audit items derived from raw persisted entries — the
 * pre-compaction crew tool activity that ordinary projection loses.
 *
 * Only the shared contract-pinned crew tools are rehydrated, and only when
 * their call is NOT already in the projected context messages (post-marker/current-context
 * calls render inline and must not duplicate). Text/thinking and unrelated
 * tools are never restored.
 */
function toCrewAuditItems(
  contextCallIds: Set<string>,
  rawEntries: SessionEntry[],
): ChatCrewAuditItem[] {
  const items: ChatCrewAuditItem[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index]!;
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    for (const call of rawToolCalls(entry.message.content)) {
      if (!CREW_AUDIT_TOOLS.has(call.name)) continue;
      if (contextCallIds.has(call.id)) continue;
      const result = findToolResult(rawEntries, index, call.id);
      const item: ChatCrewAuditItem = {
        kind: 'crew-tool-audit',
        id: `${entry.id}:${call.id}`,
        timestamp: at(entry.timestamp),
        historical: true,
        call: {
          callId: call.id,
          tool: call.name,
          ...(call.args !== undefined ? { args: call.args } : {}),
        },
      };
      if (result) {
        const narrowed: NonNullable<ChatCrewAuditItem['result']> = { ok: result.ok };
        if (result.output !== undefined) narrowed.output = result.output;
        if (result.error !== undefined) narrowed.error = result.error;
        if (result.details !== undefined) narrowed.details = result.details;
        item.result = narrowed;
      }
      items.push(item);
    }
  }
  return items;
}

/**
 * Root→leaf active entries reachable from the current leaf via public
 * parentId links. Abandoned branch entries never enter the raw projection, so
 * fork calls/results cannot become phantom audits or cross-pair.
 */
function activePathEntries(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * Active-branch custom events: the root→leaf path reached from the current
 * leaf via public parentId links, projected through `toCustomEvents`.
 *
 * Abandoned branch customs never surface, so a branch-scoped reopen cannot be
 * immediately reintroduced by a readback that walks the whole file. A null or
 * missing leaf yields nothing — never an all-file fallback.
 */
export function toActiveCustomEvents(
  entries: SessionEntry[],
  leafId: string | null,
): ChatEventItem[] {
  return toCustomEvents(activePathEntries(entries, leafId));
}

function itemTime(item: ChatTimelineItem): number {
  return 'role' in item ? item.createdAt : item.timestamp;
}

function mergeByTime(groups: ChatTimelineItem[][]): ChatTimelineItem[] {
  const items: Array<{ at: number; order: number; item: ChatTimelineItem }> = [];
  for (const group of groups) {
    for (const item of group) {
      items.push({ at: itemTime(item), order: items.length, item });
    }
  }
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  return items.map((entry) => entry.item);
}

/**
 * The full reopened timeline: the compaction-aware message projection merged
 * with every raw custom event and the historical crew audit items that
 * survive compaction. Custom events and audits older than the compaction
 * marker land on its historical side; later items interleave chronologically.
 */
export function toTimeline(
  contextEntries: SessionEntry[],
  rawEntries: SessionEntry[],
  leafId: string | null,
): ChatTimelineItem[] {
  // Branch-scope the raw durable projection to the current leaf path; the
  // production caller passes sessionManager.getLeafId().
  const activeEntries = activePathEntries(rawEntries, leafId);
  const messages = toMessages(contextEntries);
  const events = toCustomEvents(activeEntries);
  const contextCallIds = new Set(
    messages
      .flatMap((message) => message.steps)
      .filter((step): step is Extract<ChatStep, { kind: 'tool-call' }> => step.kind === 'tool-call')
      .map((step) => step.callId),
  );
  const audits = toCrewAuditItems(contextCallIds, activeEntries);
  const compaction = [...activeEntries].reverse().find((entry) => entry.type === 'compaction');
  if (!compaction) {
    return mergeByTime([messages, events, audits]);
  }
  const compactionAt = at(compaction.timestamp);
  const historical: ChatTimelineItem[] = [];
  const retained: ChatTimelineItem[] = [];
  for (const item of [...events, ...audits]) {
    (item.timestamp < compactionAt ? historical : retained).push(item);
  }
  const markerIndex = messages.findIndex((message) => message.id === compaction.id);
  if (markerIndex < 0) {
    return mergeByTime([messages, events, audits]);
  }
  return [
    ...messages.slice(0, markerIndex + 1),
    ...mergeByTime([historical]),
    ...mergeByTime([messages.slice(markerIndex + 1), retained]),
  ];
}
