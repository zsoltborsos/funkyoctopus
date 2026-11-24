/**
 * Pure crew audit parsing, correlation and dedup.
 *
 * Everything here is defensive and render-only: recognized `crew_*` tool
 * activity is parsed from untrusted args/results into compact audit models,
 * spawns are correlated to later crew-result cards by agent id, genuine
 * semantic redelivery is suppressed, and consecutive identical crew-list
 * warnings collapse. Durable timeline data is never mutated or deleted — this
 * module only decides what the renderer shows.
 */

import type { ChatCrewAuditItem, ChatStep, ChatTimelineItem } from './chat.types.ts';
import { CREW_TOOLS, isChatEventItem, isCrewAuditItem, type CrewTool } from '@shared/transport/protocol.ts';
import { crewResultDetails } from './crew-card.ts';

type ToolCallStep = Extract<ChatStep, { kind: 'tool-call' }>;
type ToolResultStep = Extract<ChatStep, { kind: 'tool-result' }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function narrowString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Narrowed, untrusted crew tool-call arguments — strings only. */
export interface CrewAuditArgs {
  agent?: string;
  brief?: string;
  task?: string;
  target?: string;
  message?: string;
}

export function narrowCrewArgs(args: unknown): CrewAuditArgs {
  const input = record(args);
  if (!input) return {};
  const ids = input.subagent_ids;
  const multi = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
  const task = record(input.task);
  const out: CrewAuditArgs = {};
  const agent = narrowString(input.subagent);
  if (agent) out.agent = agent;
  const brief = narrowString(input.brief);
  if (brief) out.brief = brief;
  const goal = narrowString(task?.goal);
  if (goal) out.task = goal;
  const target =
    narrowString(input.subagent_id) ??
    (multi.length > 0 ? `${multi.length} ids` : undefined) ??
    (input.all === true ? 'all' : undefined);
  if (target) out.target = target;
  const message = narrowString(input.message);
  if (message) out.message = message;
  return out;
}

/**
 * Spawn agent id, from the structured result details first: `subagent_id`
 * (pi-crew 1.0.34) or `id` (1.0.28). Then the exact output text: 1.0.34's JSON
 * `{"subagent_id":"<id>"}` or 1.0.28's `Subagent '<name>' spawned as <id>.` —
 * nothing else. Never partial-matches, truncates, or guesses from arbitrary
 * prose. The id alphabet matches the installed generator (`name` + hex): alnum
 * plus `._-`.
 */
export function spawnAgentId(details: unknown, output: string | undefined): string | undefined {
  const structured = record(details);
  const fromDetails = narrowString(structured?.subagent_id) ?? narrowString(structured?.id);
  if (fromDetails) return fromDetails;
  const fromJson = jsonSubagentId(output);
  if (fromJson) return fromJson;
  const match = /^Subagent '([^']+)' spawned as ([A-Za-z0-9._-]+)\.$/.exec(output ?? '');
  // `$` may match before a final line terminator; the whole-string check keeps
  // the match exact so a trailing newline is never accepted.
  if (!match || match[0] !== output) return undefined;
  return match[2];
}

const AGENT_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Narrowed 1.0.34 tool acknowledgement fields from a JSON tool-result output:
 * `{"subagent_id":"<id>"}` (spawn/respond/done),
 * `{"aborted_ids":[...],"missing_ids":[...],"foreign_ids":[...]}` (abort)
 * and `{"error":"..."}` (errors). Only a JSON object is accepted; unknown
 * fields, non-arrays and junk members are dropped — never arbitrary prose.
 */
export interface CrewAck {
  subagentId?: string;
  /** String members of `aborted_ids` — may be empty when the key exists. */
  abortedIds?: string[];
  error?: string;
}

export function crewAcknowledgement(output: string | undefined): CrewAck | undefined {
  if (!output?.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  const rec = record(parsed);
  if (!rec) return undefined;
  const ack: CrewAck = {};
  const id = narrowString(rec.subagent_id);
  if (id && AGENT_ID.test(id)) ack.subagentId = id;
  if (Array.isArray(rec.aborted_ids)) {
    ack.abortedIds = rec.aborted_ids.filter(
      (member): member is string => typeof member === 'string' && AGENT_ID.test(member),
    );
  }
  const error = narrowString(rec.error);
  if (error) ack.error = error;
  return Object.keys(ack).length > 0 ? ack : undefined;
}

function jsonSubagentId(output: string | undefined): string | undefined {
  return crewAcknowledgement(output)?.subagentId;
}

/** Compact audit card model for a recognized crew tool step. */
export type CrewAuditModel =
  | {
      kind: 'spawn';
      callId: string;
      agent?: string;
      agentId?: string;
      task?: string;
      /** 'interrupted' when no later waiting/terminal result exists — never active. */
      status?: 'interrupted';
      error?: string;
    }
  | { kind: 'list'; callId: string; error?: string }
  | { kind: 'status'; callId: string; error?: string }
  | { kind: 'abort'; callId: string; target?: string; error?: string }
  | { kind: 'respond'; callId: string; target?: string; message?: string; error?: string }
  | { kind: 'done'; callId: string; target?: string; error?: string };

/** Adapt a raw audit item's carried call/result to ChatStep shapes (summary is
 *  the exact tool name) for either the audit model or the generic fallback. */
export function crewAuditItemSteps(item: ChatCrewAuditItem): {
  call: ToolCallStep;
  result?: ToolResultStep;
} {
  const call: ToolCallStep = {
    kind: 'tool-call',
    callId: item.call.callId,
    tool: item.call.tool,
    summary: item.call.tool,
    ...(item.call.args !== undefined ? { args: item.call.args } : {}),
  };
  const steps: { call: ToolCallStep; result?: ToolResultStep } = { call };
  if (item.result) {
    const result: ToolResultStep = {
      kind: 'tool-result',
      callId: item.call.callId,
      ok: item.result.ok,
      ...(item.result.output !== undefined ? { output: item.result.output } : {}),
      ...(item.result.error !== undefined ? { error: item.result.error } : {}),
      ...(item.result.details !== undefined ? { details: item.result.details } : {}),
    };
    steps.result = result;
  }
  return steps;
}

/** Adapt a historical raw audit item to the shared audit model. */
export function crewAuditFromRaw(item: ChatCrewAuditItem): CrewAuditModel | null {
  const { call, result } = crewAuditItemSteps(item);
  return crewAuditModel(call, result);
}

/** Is this one of the pi-crew tools FO renders as an audit (the shared, contract-pinned list)? */
export function isCrewTool(tool: string): tool is CrewTool {
  return (CREW_TOOLS as readonly string[]).includes(tool);
}

/** Parse a crew tool step into an audit model; null keeps the generic renderer. */
export function crewAuditModel(call: ToolCallStep, result?: ToolResultStep): CrewAuditModel | null {
  if (!isCrewTool(call.tool)) return null;
  const args = narrowCrewArgs(call.args);
  const ack = result ? crewAcknowledgement(result.output) : undefined;
  // Failed tool: the transport error first, then a 1.0.34 JSON error
  // acknowledgement, then the generic label.
  const error =
    result && !result.ok
      ? (result.error ?? ack?.error ?? 'Crew tool failed')
      : undefined;
  // Exhaustive over CrewTool: a name added to CREW_TOOLS must be handled here.
  switch (call.tool) {
    case 'crew_spawn': {
      if (!args.agent) return null;
      const model: CrewAuditModel = { kind: 'spawn', callId: call.callId, agent: args.agent };
      const agentId = result ? spawnAgentId(result.details, result.output) : undefined;
      if (agentId) model.agentId = agentId;
      const task = args.task ?? args.brief;
      if (task) model.task = task;
      if (error) model.error = error;
      return model;
    }
    case 'crew_list': {
      const model: CrewAuditModel = { kind: 'list', callId: call.callId };
      if (error) model.error = error;
      return model;
    }
    case 'crew_status': {
      const model: CrewAuditModel = { kind: 'status', callId: call.callId };
      if (error) model.error = error;
      return model;
    }
    case 'crew_abort': {
      // 1.0.34: the displayed target comes from the acknowledgement's
      // aborted_ids (one id, `<n> ids` for many, `0 ids` when empty), falling
      // back to the call arguments when no valid acknowledgement exists.
      const target =
        (ack?.abortedIds
          ? ack.abortedIds.length === 1
            ? ack.abortedIds[0]
            : `${ack.abortedIds.length} ids`
          : undefined) ?? args.target;
      if (!target) return null;
      const model: CrewAuditModel = { kind: 'abort', callId: call.callId, target };
      if (error) model.error = error;
      return model;
    }
    case 'crew_respond': {
      const target = ack?.subagentId ?? args.target;
      if (!target) return null;
      const model: CrewAuditModel = { kind: 'respond', callId: call.callId, target };
      if (args.message) model.message = args.message;
      if (error) model.error = error;
      return model;
    }
    case 'crew_done': {
      const target = ack?.subagentId ?? args.target;
      if (!target) return null;
      const model: CrewAuditModel = { kind: 'done', callId: call.callId, target };
      if (error) model.error = error;
      return model;
    }
  }
}

/** Correlated spawn metadata attached to a later crew-result card. */
export interface CrewResultEnrichment {
  task?: string;
  /** Result arrival minus spawn/assistant creation time; never negative. */
  durationMs?: number;
}

/** What the renderer needs: audits, enrichments and suppressed duplicates. */
export interface CrewRenderState {
  audits: Map<string, CrewAuditModel>;
  resultEnrichments: Map<string, CrewResultEnrichment>;
  hiddenResultIds: Set<string>;
  hiddenWarningIds: Set<string>;
}

const SETTLED_STATUSES = new Set(['waiting', 'completed', 'needs_input', 'done', 'error', 'aborted']);

/**
 * One pure pass over the timeline producing the render state.
 *
 * - audit models for recognized crew tool steps (by callId);
 * - spawn → later crew-result correlation (task + duration) by agentId;
 * - genuine semantic redelivery suppression (same agentId + status + body);
 * - consecutive identical crew-list-warning collapse;
 * - spawns without a later waiting/terminal result marked interrupted.
 *
 * The timeline itself is never mutated.
 */
export function projectCrewAudits(timeline: ChatTimelineItem[]): CrewRenderState {
  const audits = new Map<string, CrewAuditModel>();
  const resultEnrichments = new Map<string, CrewResultEnrichment>();
  const hiddenResultIds = new Set<string>();
  const hiddenWarningIds = new Set<string>();

  const spawns = new Map<string, { task?: string; callTime: number }>();
  /** callIds of spawn audits that came from stored/reopened history. */
  const historicalCallIds = new Set<string>();
  const settledAgents = new Set<string>();
  let lastResultKey: string | null = null;
  let lastWarning: string | null = null;

  for (const item of timeline) {
    if (isChatEventItem(item)) {
      if (item.customType === 'crew-result') {
        // A result breaks the warning window; it also resets its own window
        // when it cannot be parsed (an intervening, non-identical item).
        lastWarning = null;
        const details = crewResultDetails(item.details);
        if (details && details.agentId) {
          // The human report is the semantic body: 1.0.34's result.report,
          // then the legacy 1.0.28 body, then the raw content. For
          // needs_input the question (result.needs) is part of the semantic
          // body too: the same report with a different question is a new
          // question the owner must see, not a redelivery.
          const body = details.result?.report ?? details.body ?? item.content;
          const needs = details.result?.needs ?? '';
          const key = `${details.agentId}\u0000${details.status}\u0000${body}\u0000${needs}`;
          // Genuine redelivery is only the immediately preceding identical
          // event; any intervening item/status/question resets the window.
          if (lastResultKey === key) {
            hiddenResultIds.add(item.id);
          } else {
            lastResultKey = key;
          }
          if (SETTLED_STATUSES.has(details.status)) settledAgents.add(details.agentId);
          const spawn = spawns.get(details.agentId);
          if (spawn && item.timestamp > 0 && spawn.callTime > 0) {
            resultEnrichments.set(item.id, {
              ...(spawn.task ? { task: spawn.task } : {}),
              durationMs: Math.max(0, item.timestamp - spawn.callTime),
            });
          }
        } else {
          lastResultKey = null;
        }
      } else if (item.customType === 'crew-list-warning') {
        lastResultKey = null;
        const key = `${item.content}\u0000${JSON.stringify(item.details)}`;
        if (lastWarning === key) {
          hiddenWarningIds.add(item.id);
        } else {
          lastWarning = key;
        }
      } else {
        lastResultKey = null;
        lastWarning = null;
      }
    } else if (isCrewAuditItem(item)) {
      lastWarning = null;
      lastResultKey = null;
      const model = crewAuditFromRaw(item);
      if (!model) continue;
      audits.set(model.callId, model);
      if (model.kind === 'spawn') historicalCallIds.add(model.callId);
      if (model.kind === 'spawn' && model.agentId) {
        spawns.set(model.agentId, {
          ...(model.task ? { task: model.task } : {}),
          callTime: item.timestamp,
        });
      }
    } else {
      lastWarning = null;
      lastResultKey = null;
      const results = new Map<string, ToolResultStep>();
      for (const step of item.steps) {
        if (step.kind === 'tool-result') results.set(step.callId, step);
      }
      for (const step of item.steps) {
        if (step.kind !== 'tool-call') continue;
        const model = crewAuditModel(step, results.get(step.callId));
        if (!model) continue;
        audits.set(step.callId, model);
        if (model.kind === 'spawn') {
          if (item.historical === true) historicalCallIds.add(model.callId);
          if (model.agentId) {
            spawns.set(model.agentId, {
              ...(model.task ? { task: model.task } : {}),
              callTime: item.createdAt,
            });
          }
        }
      }
    }
  }

  // Only historical stored/reopened spawns without a later waiting/terminal
  // result read as unknown/interrupted — never active. A historical spawn
  // without a resolvable id is also unknown. Live pending spawns get no label
  // at all; Phase 5 owns any live strip.
  for (const audit of audits.values()) {
    if (audit.kind !== 'spawn' || !historicalCallIds.has(audit.callId)) continue;
    if (audit.agentId && settledAgents.has(audit.agentId)) continue;
    audit.status = 'interrupted';
  }

  return { audits, resultEnrichments, hiddenResultIds, hiddenWarningIds };
}

/** Duration text: never negative, compact. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
