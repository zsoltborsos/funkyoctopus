/**
 * Pure session-scoped live crew state.
 *
 * Driven only by live ChatSession chunks/events — never by stored transcript
 * projection. A recognized live `crew_spawn` tool call creates a provisional
 * running row; its successful result binds the subagent id; a correlated
 * documented `crew-result` transitions running/waiting or removes the row on a
 * terminal status; pi-crew's `crew-status` owner snapshot syncs bound rows and
 * removes the ones it no longer lists. Correlation is by agent id only — never
 * guessed by name.
 * Nothing is synthesized: no role, progress, or token telemetry.
 */

import type { ChatChunk } from '@shared/transport/protocol.ts';
import type { ChatEventItem } from './chat.types.ts';
import { crewResultDetails, type CrewStatus } from './crew-card.ts';
import { crewAcknowledgement, narrowCrewArgs, spawnAgentId } from './crew-audit.ts';

/** The 1.0.34 live statuses plus 1.0.28's stored waiting. */
export type LiveCrewStatus = 'running' | 'waiting' | 'completed' | 'needs_input';

/** Tools whose successful results carry 1.0.34 acknowledgement JSON. */
export type CrewControlTool = 'crew_abort' | 'crew_respond' | 'crew_done';

/**
 * Session-scoped memory of a live crew control call (abort/respond/done) so
 * its result can be paired by callId. Owned by ChatSession; never persisted
 * and never reconstructed from history.
 */
export interface PendingControlCall {
  tool: CrewControlTool;
  target: string | undefined;
}

export type PendingControlCalls = Map<string, PendingControlCall>;

/** One live row: only derived available fields, keyed by the spawn call id. */
export interface LiveCrewAgent {
  /** Stable local key: the tool call id that created the row. */
  key: string;
  callId: string;
  agentName: string;
  /** Bound subagent id once the successful spawn result resolves it. */
  agentId?: string;
  task?: string;
  status: LiveCrewStatus;
  /** Epoch ms the spawn call started. */
  startedAt: number;
  /** Last observed crew control activity, when correlated. */
  lastActivity?: string;
}

/** Discriminated live events the reducer consumes. */
export type LiveCrewEvent =
  | { kind: 'spawn-call'; callId: string; args: unknown; at: number }
  | {
      kind: 'spawn-result';
      callId: string;
      ok: boolean;
      details: unknown;
      output: string | undefined;
      at: number;
    }
  | { kind: 'crew-result'; agentId: string; status: CrewStatus; at: number }
  /** pi-crew 1.0.34's owner snapshot: every subagent still open for the owner. */
  | { kind: 'crew-status'; agents: { id: string; status: string }[]; at: number }
  | {
      kind: 'control-call';
      tool: CrewControlTool;
      target: string | undefined;
      at: number;
    }
  | {
      kind: 'control-result';
      tool: CrewControlTool;
      target: string | undefined;
      ok: boolean;
      output: string | undefined;
      at: number;
    };

/**
 * Reduce live crew rows for one event. Unknown/malformed events return the
 * rows unchanged.
 */
export function reduceLiveCrew(rows: LiveCrewAgent[], event: LiveCrewEvent): LiveCrewAgent[] {
  switch (event.kind) {
    case 'spawn-call': {
      const args = narrowCrewArgs(event.args);
      if (!args.agent) return rows;
      if (rows.some((row) => row.callId === event.callId)) return rows;
      const task = args.task ?? args.brief;
      const row: LiveCrewAgent = {
        key: event.callId,
        callId: event.callId,
        agentName: args.agent,
        status: 'running',
        startedAt: event.at,
      };
      if (task) row.task = task;
      return [...rows, row];
    }
    case 'spawn-result': {
      const next: LiveCrewAgent[] = [];
      for (const row of rows) {
        if (row.callId !== event.callId) {
          next.push(row);
          continue;
        }
        if (!event.ok) {
          // A failed spawn removes the provisional row.
          continue;
        }
        const id = spawnAgentId(event.details, event.output);
        // Lossy over permanently wrong: a success with no resolvable id drops
        // the provisional row rather than leaving an unbound phantom.
        if (id) next.push({ ...row, agentId: id });
      }
      return next;
    }
    case 'crew-result': {
      // 1.0.34: running/waiting/completed/needs_input keep the row visible and
      // set its status. 1.0.28's terminal `done`, plus `error` and `aborted`,
      // remove it.
      const transition =
        event.status === 'waiting' ||
        event.status === 'running' ||
        event.status === 'completed' ||
        event.status === 'needs_input'
          ? event.status
          : null;
      return rows.flatMap((row) => {
        if (row.agentId !== event.agentId) return [row];
        return transition ? [{ ...row, status: transition }] : [];
      });
    }
    case 'crew-status': {
      // The owner can close or follow up an agent in a turn the cockpit never
      // streamed (pi-crew triggers one per result); its snapshot is the only
      // live trace of that. Bound rows it no longer lists are closed.
      const open = new Map(event.agents.map((agent) => [agent.id, agent.status]));
      return rows.flatMap((row) => {
        if (row.agentId === undefined) return [row];
        if (!open.has(row.agentId)) return [];
        const status = open.get(row.agentId);
        return status === 'running' || status === 'completed' || status === 'needs_input'
          ? [{ ...row, status }]
          : [row];
      });
    }
    case 'control-call': {
      if (!event.target) return rows;
      return rows.map((row) =>
        row.agentId === event.target ? { ...row, lastActivity: event.tool } : row,
      );
    }
    case 'control-result': {
      if (!event.ok) return rows;
      const ack = crewAcknowledgement(event.output);
      const target = ack?.subagentId ?? event.target;
      if (event.tool === 'crew_abort') {
        // Closure comes only from the acknowledgement's aborted_ids;
        // missing_ids and foreign_ids never remove rows.
        const aborted = ack?.abortedIds;
        if (!aborted) return rows;
        const ids = new Set(aborted);
        return rows.filter((row) => row.agentId === undefined || !ids.has(row.agentId));
      }
      if (!target) return rows;
      if (event.tool === 'crew_respond') {
        return rows.map((row) => (row.agentId === target ? { ...row, status: 'running' } : row));
      }
      // crew_done: the owner closed the agent — remove its row.
      return rows.filter((row) => row.agentId !== target);
    }
    default:
      return rows;
  }
}

/**
 * Drop unbound provisional rows whose spawn never produced a result (turn end,
 * error, or cancel). Bound rows survive: subagent work is asynchronous and the
 * parent turn completing or cancelling says nothing about it.
 */
export function dropUnboundProvisional(rows: LiveCrewAgent[]): LiveCrewAgent[] {
  return rows.filter((row) => row.agentId !== undefined);
}

/** Map a live chat chunk (tool activity) to a live event, or null.
 *
 * `pending` remembers control calls by callId until their results arrive so a
 * control result can be paired with its call — never by arrival order or
 * target alone. The map is mutated: a call is recorded when its call chunk is
 * seen and deleted once its result is consumed.
 */
export function liveCrewEventFromChunk(
  chunk: ChatChunk,
  at: number,
  pending: PendingControlCalls,
): LiveCrewEvent | null {
  if (chunk.kind === 'tool-call') {
    if (chunk.tool === 'crew_spawn') {
      return { kind: 'spawn-call', callId: chunk.callId, args: chunk.args, at };
    }
    if (chunk.tool === 'crew_abort' || chunk.tool === 'crew_respond' || chunk.tool === 'crew_done') {
      pending.set(chunk.callId, { tool: chunk.tool, target: narrowCrewArgs(chunk.args).target });
      return {
        kind: 'control-call',
        tool: chunk.tool,
        target: narrowCrewArgs(chunk.args).target,
        at,
      };
    }
    return null;
  }
  if (chunk.kind === 'tool-result') {
    const remembered = pending.get(chunk.callId);
    if (remembered) {
      pending.delete(chunk.callId);
      return {
        kind: 'control-result',
        tool: remembered.tool,
        target: remembered.target,
        ok: chunk.ok,
        output: chunk.output,
        at,
      };
    }
    return {
      kind: 'spawn-result',
      callId: chunk.callId,
      ok: chunk.ok,
      details: chunk.details,
      output: chunk.output,
      at,
    };
  }
  return null;
}

/** Map a custom timeline event to a live event, or null (malformed/no id). */
export function liveCrewEventFromCustom(event: ChatEventItem): LiveCrewEvent | null {
  if (event.customType === 'crew-status') return crewStatusEvent(event);
  if (event.customType !== 'crew-result') return null;
  const details = crewResultDetails(event.details);
  if (!details || !details.agentId) return null;
  return { kind: 'crew-result', agentId: details.agentId, status: details.status, at: event.timestamp };
}

/** Parse a `{"type":"crew_status","agents":[{id,status}]}` snapshot, or null. */
function crewStatusEvent(event: ChatEventItem): LiveCrewEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  const snapshot = parsed as { type?: unknown; agents?: unknown } | null;
  if (snapshot?.type !== 'crew_status' || !Array.isArray(snapshot.agents)) return null;
  const agents = snapshot.agents.flatMap((agent: unknown) => {
    const { id, status } = (agent ?? {}) as { id?: unknown; status?: unknown };
    // An open id is kept even without a usable status: dropping it would
    // close a row that is still open.
    if (typeof id !== 'string') return [];
    return [{ id, status: typeof status === 'string' ? status : '' }];
  });
  return { kind: 'crew-status', agents, at: event.timestamp };
}

/**
 * Whether a *newly inserted* custom event should count toward unread:
 * displayable waiting/terminal crew-results and crew-list-warnings. Running,
 * malformed, display:false, unknown types, and non-custom items never count.
 */
export function shouldCountUnread(event: ChatEventItem): boolean {
  if (!event.display) return false;
  if (event.customType === 'crew-list-warning') return true;
  if (event.customType !== 'crew-result') return false;
  const details = crewResultDetails(event.details);
  if (!details || !details.agentId) return false;
  return details.status !== 'running';
}
