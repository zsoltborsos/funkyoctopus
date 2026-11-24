import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ChatMessage, ChatStep, ChatTimelineItem } from './chat.types.ts';
import { toTimeline } from '../../../server/src/pi/session-transcript.ts';
import {
  crewAuditModel,
  formatDuration,
  narrowCrewArgs,
  projectCrewAudits,
  spawnAgentId,
} from './crew-audit.ts';

type ToolCallStep = Extract<ChatStep, { kind: 'tool-call' }>;
type ToolResultStep = Extract<ChatStep, { kind: 'tool-result' }>;

const toolCall = (callId: string, tool: string, args?: unknown): ToolCallStep => ({
  kind: 'tool-call',
  callId,
  tool,
  summary: `${tool}: x`,
  ...(args !== undefined ? { args } : {}),
});

const toolResult = (
  callId: string,
  output?: string,
  details?: unknown,
  ok = true,
  error?: string,
): ToolResultStep => ({
  kind: 'tool-result',
  callId,
  ok,
  ...(output !== undefined ? { output } : {}),
  ...(details !== undefined ? { details } : {}),
  ...(error !== undefined ? { error } : {}),
});

const assistant = (id: string, createdAt: number, steps: ChatStep[]): ChatMessage => ({
  id,
  role: 'assistant',
  steps,
  createdAt,
});

const resultEvent = (
  id: string,
  agentId: string,
  status: string,
  body: string,
  timestamp: number,
): ChatTimelineItem => ({
  kind: 'custom-message',
  id,
  customType: 'crew-result',
  display: true,
  content: body,
  details: { agentId, status, body },
  timestamp,
});

const warningEvent = (id: string, content: string, timestamp: number): ChatTimelineItem => ({
  kind: 'custom-message',
  id,
  customType: 'crew-list-warning',
  display: true,
  content,
  details: null,
  timestamp,
});

describe('spawnAgentId', () => {
  it('prefers the structured result details id over the text', () => {
    expect(spawnAgentId({ id: 'scout-abc12345' }, "Subagent 'scout' spawned as scout-other.")).toBe(
      'scout-abc12345',
    );
  });

  it('falls back to the narrowly documented text form', () => {
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-abc12345.")).toBe(
      'scout-abc12345',
    );
  });

  it('reads pi-crew 1.0.34 details subagent_id and its JSON output', () => {
    expect(spawnAgentId({ action: 'spawn', subagent_id: 'scout-abc12345', name: 'scout' }, undefined)).toBe(
      'scout-abc12345',
    );
    expect(spawnAgentId(undefined, '{"subagent_id":"scout-abc12345"}')).toBe('scout-abc12345');
  });

  it('rejects malformed JSON output and ids outside the generator alphabet', () => {
    expect(spawnAgentId(undefined, '{"subagent_id":')).toBeUndefined();
    expect(spawnAgentId(undefined, '{"subagent_id":"scout 1; rm"}')).toBeUndefined();
    expect(spawnAgentId(undefined, '{"id":"scout-abc12345"}')).toBeUndefined();
  });

  it('never guesses from arbitrary prose', () => {
    expect(spawnAgentId(undefined, 'The subagent completed its work.')).toBeUndefined();
    expect(spawnAgentId(undefined, undefined)).toBeUndefined();
    expect(spawnAgentId('not-an-object', undefined)).toBeUndefined();
  });
});

describe('narrowCrewArgs', () => {
  it('narrows spawn agent, brief and task goal, dropping junk', () => {
    expect(narrowCrewArgs({ subagent: 'scout', brief: 'probe', task: { goal: 'read probe' }, junk: 12 })).toEqual({
      agent: 'scout',
      brief: 'probe',
      task: 'read probe',
    });
  });

  it('narrows abort single, multi and all targets', () => {
    expect(narrowCrewArgs({ subagent_id: 'scout-1' })).toEqual({ target: 'scout-1' });
    expect(narrowCrewArgs({ subagent_ids: ['a', 'b', 3] })).toEqual({ target: '2 ids' });
    expect(narrowCrewArgs({ all: true })).toEqual({ target: 'all' });
  });

  it('narrows respond target and message', () => {
    expect(narrowCrewArgs({ subagent_id: 'scout-1', message: 'go' })).toEqual({
      target: 'scout-1',
      message: 'go',
    });
  });
});

describe('crewAuditModel', () => {
  it('recognizes all crew action and discovery tools with valid args', () => {
    expect(
      crewAuditModel(toolCall('c1', 'crew_spawn', { subagent: 'scout' }), toolResult('c1', "Subagent 'scout' spawned as scout-1.", { id: 'scout-1' })),
    ).toEqual({ kind: 'spawn', callId: 'c1', agent: 'scout', agentId: 'scout-1' });
    expect(crewAuditModel(toolCall('c2', 'crew_list'))).toEqual({ kind: 'list', callId: 'c2' });
    expect(crewAuditModel(toolCall('c3', 'crew_abort', { subagent_id: 'scout-1' }))).toEqual({
      kind: 'abort',
      callId: 'c3',
      target: 'scout-1',
    });
    expect(
      crewAuditModel(toolCall('c4', 'crew_respond', { subagent_id: 'scout-1', message: 'go' })),
    ).toEqual({ kind: 'respond', callId: 'c4', target: 'scout-1', message: 'go' });
    expect(crewAuditModel(toolCall('c5', 'crew_done', { subagent_id: 'scout-1' }))).toEqual({
      kind: 'done',
      callId: 'c5',
      target: 'scout-1',
    });
  });

  it('projects a crew_status call and structured result as a read-only status audit', () => {
    const result = toolResult('c-status', undefined, {
      subagents: [
        {
          id: 'scout-1',
          name: 'scout',
          brief: 'Inspect the contract',
          status: 'running',
          model: 'provider/model',
          modelName: 'Model',
          workedMs: 1_500,
        },
      ],
    });

    expect(crewAuditModel(toolCall('c-status', 'crew_status'), result)).toEqual({
      kind: 'status',
      callId: 'c-status',
    });
  });

  it('returns null (generic fallback) on malformed args', () => {
    expect(crewAuditModel(toolCall('c1', 'crew_spawn'))).toBeNull();
    expect(crewAuditModel(toolCall('c3', 'crew_abort', {}))).toBeNull();
    expect(crewAuditModel(toolCall('c4', 'crew_respond', {}))).toBeNull();
    expect(crewAuditModel(toolCall('c5', 'crew_done', {}))).toBeNull();
    expect(crewAuditModel(toolCall('c6', 'bash', { command: 'ls' }))).toBeNull();
  });

  it('keeps a failed tool error on the audit card', () => {
    const model = crewAuditModel(
      toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
      toolResult('c1', 'boom', undefined, false, 'boom exploded'),
    );
    expect(model).toEqual({ kind: 'spawn', callId: 'c1', agent: 'scout', error: 'boom exploded' });
  });

  it('reads pi-crew 1.0.34 JSON acknowledgements for respond and done', () => {
    expect(
      crewAuditModel(
        toolCall('c4', 'crew_respond', { subagent_id: 'scout-1', message: 'go' }),
        toolResult('c4', '{"subagent_id":"scout-1"}'),
      ),
    ).toEqual({ kind: 'respond', callId: 'c4', target: 'scout-1', message: 'go' });
    expect(
      crewAuditModel(
        toolCall('c5', 'crew_done', { subagent_id: 'scout-1' }),
        toolResult('c5', '{"subagent_id":"scout-1"}'),
      ),
    ).toEqual({ kind: 'done', callId: 'c5', target: 'scout-1' });
  });

  it('prefers the ack subagent_id over the call-argument target', () => {
    expect(
      crewAuditModel(
        toolCall('c5', 'crew_done', { subagent_id: 'arg-id' }),
        toolResult('c5', '{"subagent_id":"ack-id"}'),
      ),
    ).toEqual({ kind: 'done', callId: 'c5', target: 'ack-id' });
  });

  it('derives the abort target from aborted_ids: one id, many, and empty', () => {
    expect(
      crewAuditModel(
        toolCall('c3', 'crew_abort', { subagent_ids: ['scout-1'] }),
        toolResult('c3', '{"aborted_ids":["scout-1"],"missing_ids":[],"foreign_ids":[]}'),
      ),
    ).toEqual({ kind: 'abort', callId: 'c3', target: 'scout-1' });
    expect(
      crewAuditModel(
        toolCall('c3', 'crew_abort', { subagent_ids: ['a', 'b', 'c'] }),
        toolResult('c3', '{"aborted_ids":["a-1","b-2","c-3"]}'),
      ),
    ).toEqual({ kind: 'abort', callId: 'c3', target: '3 ids' });
    expect(
      crewAuditModel(toolCall('c3', 'crew_abort', { subagent_ids: ['scout-1'] }), toolResult('c3', '{"aborted_ids":[]}')),
    ).toEqual({ kind: 'abort', callId: 'c3', target: '0 ids' });
  });

  it('falls back to call arguments when the abort output is not a valid ack', () => {
    for (const output of ['{"missing_ids":["scout-1"]}', '{"aborted_ids":', 'not json']) {
      expect(
        crewAuditModel(toolCall('c3', 'crew_abort', { subagent_id: 'scout-1' }), toolResult('c3', output)),
      ).toEqual({ kind: 'abort', callId: 'c3', target: 'scout-1' });
    }
  });

  it('accepts ack-identified respond/done/abort even with no target in args', () => {
    expect(
      crewAuditModel(toolCall('c4', 'crew_respond'), toolResult('c4', '{"subagent_id":"scout-1"}')),
    ).toEqual({ kind: 'respond', callId: 'c4', target: 'scout-1' });
    expect(
      crewAuditModel(toolCall('c5', 'crew_done'), toolResult('c5', '{"subagent_id":"scout-1"}')),
    ).toEqual({ kind: 'done', callId: 'c5', target: 'scout-1' });
    expect(
      crewAuditModel(toolCall('c3', 'crew_abort'), toolResult('c3', '{"aborted_ids":["scout-1"]}')),
    ).toEqual({ kind: 'abort', callId: 'c3', target: 'scout-1' });
  });

  it('uses a JSON error acknowledgement as the error text when the transport has none', () => {
    expect(
      crewAuditModel(
        toolCall('c5', 'crew_done', { subagent_id: 'scout-1' }),
        toolResult('c5', '{"error":"agent not found"}', undefined, false),
      ),
    ).toEqual({ kind: 'done', callId: 'c5', target: 'scout-1', error: 'agent not found' });
    expect(
      crewAuditModel(
        toolCall('c3', 'crew_abort', { subagent_id: 'scout-1' }),
        toolResult('c3', '{"error":"boom"}', undefined, false, 'transport boom'),
      ),
    ).toEqual({ kind: 'abort', callId: 'c3', target: 'scout-1', error: 'transport boom' });
  });

  it('never accepts malformed JSON or junk ack fields', () => {
    expect(
      crewAuditModel(toolCall('c5', 'crew_done'), toolResult('c5', '{"subagent_id":')),
    ).toBeNull();
    expect(
      crewAuditModel(toolCall('c5', 'crew_done'), toolResult('c5', '{"subagent_id":42}')),
    ).toBeNull();
    expect(
      crewAuditModel(toolCall('c3', 'crew_abort'), toolResult('c3', '{"aborted_ids":"scout-1"}')),
    ).toBeNull();
  });
});

describe('projectCrewAudits', () => {
  it('correlates a spawn with a later result: task and duration, chronology untouched', () => {
    const timeline: ChatTimelineItem[] = [
      assistant('a1', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout', task: { goal: 'read probe' } }),
        toolResult('c1', "Subagent 'scout' spawned as scout-1.", { id: 'scout-1' }),
      ]),
      resultEvent('e1', 'scout-1', 'done', 'the result', 25_000),
    ];
    const state = projectCrewAudits(timeline);

    expect(state.audits.get('c1')).toMatchObject({
      kind: 'spawn',
      agentId: 'scout-1',
      task: 'read probe',
    });
    expect(state.resultEnrichments.get('e1')).toEqual({ task: 'read probe', durationMs: 15_000 });
    // The projection never moves or merges timeline items.
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ id: 'a1' });
    expect(timeline[1]).toMatchObject({ id: 'e1' });
  });

  it('leaves an uncorrelated result as Phase 3 (no enrichment)', () => {
    const state = projectCrewAudits([resultEvent('e1', 'worker-9', 'done', 'hello', 5000)]);
    expect(state.resultEnrichments.get('e1')).toBeUndefined();
  });

  it('never reports a negative duration', () => {
    const timeline: ChatTimelineItem[] = [
      assistant('a1', 20_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', "...spawned as scout-1.", { id: 'scout-1' }),
      ]),
      resultEvent('e1', 'scout-1', 'done', 'x', 10_000),
    ];
    expect(projectCrewAudits(timeline).resultEnrichments.get('e1')?.durationMs).toBe(0);
  });

  it('marks a historical spawn without a later waiting/terminal result as interrupted, never active', () => {
    const timeline: ChatTimelineItem[] = [
      historicalAssistant('a1', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', "Subagent 'scout' spawned as scout-1.", { id: 'scout-1' }),
      ]),
    ];
    expect(projectCrewAudits(timeline).audits.get('c1')).toMatchObject({
      kind: 'spawn',
      agentId: 'scout-1',
      status: 'interrupted',
    });
  });

  it('suppresses only genuine crew-result redelivery (same agent+status+body)', () => {
    const timeline: ChatTimelineItem[] = [
      resultEvent('e1', 'scout-1', 'done', 'same body', 1000),
      resultEvent('e2', 'scout-1', 'done', 'same body', 2000),
      resultEvent('e3', 'scout-1', 'done', 'a different body', 3000),
      resultEvent('e4', 'scout-1', 'waiting', 'same body', 4000),
    ];
    const state = projectCrewAudits(timeline);
    expect([...state.hiddenResultIds].sort()).toEqual(['e2']);
  });

  it('correlates a 1.0.34 completed result and deduplicates by its report', () => {
    const result34 = (
      id: string,
      report: string,
      timestamp: number,
    ): ChatTimelineItem => ({
      kind: 'custom-message',
      id,
      customType: 'crew-result',
      display: true,
      content: '{"subagent_id":"scout-1","result":{"outcome":"completed","report":"' + report + '"}}',
      details: {
        agentId: 'scout-1',
        status: 'completed',
        result: { outcome: 'completed', report },
      },
      timestamp,
    });
    const timeline: ChatTimelineItem[] = [
      assistant('a1', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout', task: { goal: 'read probe' } }),
        toolResult('c1', '{"subagent_id":"scout-1"}'),
      ]),
      result34('e1', 'the report', 25_000),
      result34('e2', 'the report', 26_000),
    ];
    const state = projectCrewAudits(timeline);
    // The 1.0.34 result settles the historical spawn (not interrupted).
    expect(state.audits.get('c1')).toMatchObject({ kind: 'spawn', agentId: 'scout-1' });
    expect(state.audits.get('c1')).not.toHaveProperty('status');
    expect(state.resultEnrichments.get('e1')).toEqual({ task: 'read probe', durationMs: 15_000 });
    // Redelivery is judged by the human report, not the model-facing JSON.
    expect([...state.hiddenResultIds]).toEqual(['e2']);
  });

  it('keeps a needs_input 1.0.34 result as settled evidence for its spawn', () => {
    const timeline: ChatTimelineItem[] = [
      historicalAssistant('a1', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', '{"subagent_id":"scout-1"}'),
      ]),
      {
        kind: 'custom-message',
        id: 'e1',
        customType: 'crew-result',
        display: true,
        content: 'progress',
        details: {
          agentId: 'scout-1',
          status: 'needs_input',
          result: { outcome: 'needs_input', report: 'progress', needs: 'Which port?' },
        },
        timestamp: 20_000,
      },
    ];
    const state = projectCrewAudits(timeline);
    expect(state.audits.get('c1')).not.toHaveProperty('status');
    expect(state.resultEnrichments.get('e1')?.durationMs).toBe(10_000);
  });

  it('does not collapse two different waiting questions', () => {
    const timeline: ChatTimelineItem[] = [
      resultEvent('e1', 'scout-1', 'waiting', 'Which branch?', 1000),
      resultEvent('e2', 'scout-1', 'waiting', 'Which branch?', 2000),
      resultEvent('e3', 'scout-1', 'waiting', 'Which port?', 3000),
    ];
    const state = projectCrewAudits(timeline);
    expect([...state.hiddenResultIds]).toEqual(['e2']);
    expect(state.hiddenResultIds.has('e3')).toBe(false);
  });

  it('does not collapse two 1.0.34 needs_input results that differ only in needs', () => {
    const needsInput = (
      id: string,
      needs: string,
      timestamp: number,
    ): ChatTimelineItem => ({
      kind: 'custom-message',
      id,
      customType: 'crew-result',
      display: true,
      content: 'progress',
      details: {
        agentId: 'scout-1',
        status: 'needs_input',
        result: { outcome: 'needs_input', report: 'progress', needs },
      },
      timestamp,
    });
    const timeline: ChatTimelineItem[] = [
      needsInput('e1', 'Which branch?', 1000),
      needsInput('e2', 'Which branch?', 2000),
      needsInput('e3', 'Which port?', 3000),
    ];
    const state = projectCrewAudits(timeline);
    // Identical report+needs is a genuine redelivery; a different question
    // with the same report must stay visible.
    expect([...state.hiddenResultIds]).toEqual(['e2']);
    expect(state.hiddenResultIds.has('e3')).toBe(false);
  });

  it('collapses only consecutive identical crew-list-warnings', () => {
    const timeline: ChatTimelineItem[] = [
      warningEvent('w1', '⚠ active', 1000),
      warningEvent('w2', '⚠ active', 2000),
      resultEvent('e1', 'x', 'done', 'b', 3000),
      warningEvent('w3', '⚠ active', 4000),
      warningEvent('w4', '⚠ other', 5000),
    ];
    const state = projectCrewAudits(timeline);
    expect([...state.hiddenWarningIds]).toEqual(['w2']);
  });
});

describe('formatDuration', () => {
  it('formats clearly and never negative', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(83_000)).toBe('1m 23s');
  });
});

const auditItem = (
  id: string,
  timestamp: number,
  call: { callId: string; tool: string; args?: unknown },
  result?: { ok: boolean; output?: string; details?: unknown },
): ChatTimelineItem => ({
  kind: 'crew-tool-audit',
  id,
  timestamp,
  historical: true,
  call,
  ...(result ? { result } : {}),
});

const historicalAssistant = (id: string, createdAt: number, steps: ChatStep[]): ChatMessage => ({
  id,
  role: 'assistant',
  steps,
  createdAt,
  historical: true,
});

describe('spawnAgentId strict fallback', () => {
  it('requires the exact documented full output', () => {
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-abc12345.")).toBe(
      'scout-abc12345',
    );
  });

  it('supports the installed id alphabet (alnum, dot, underscore, hyphen)', () => {
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-a1b2.c3d4-e5f6_78.")).toBe(
      'scout-a1b2.c3d4-e5f6_78',
    );
  });

  it('never partial-matches prefix, suffix, newline or prose', () => {
    expect(spawnAgentId(undefined, 'The subagent spawned as scout-x.')).toBeUndefined();
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-x.")).toBe('scout-x');
    expect(spawnAgentId(undefined, "Prefix Subagent 'scout' spawned as scout-x.")).toBeUndefined();
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-x. trailing")).toBeUndefined();
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-x.\n")).toBeUndefined();
    expect(spawnAgentId(undefined, "Subagent 'scout' spawned as scout-x.\nmore prose")).toBeUndefined();
    expect(spawnAgentId(undefined, 'spawned as scout-x.')).toBeUndefined();
  });
});

describe('projectCrewAudits provenance', () => {
  it('treats raw historical audit items as audits and correlates their spawns', () => {
    const timeline: ChatTimelineItem[] = [
      auditItem('pre-a:c1', 10_000, { callId: 'c1', tool: 'crew_spawn', args: { subagent: 'scout' } }, {
        ok: true,
        output: "Subagent 'scout' spawned as scout-1.",
        details: { id: 'scout-1' },
      }),
      resultEvent('e1', 'scout-1', 'done', 'the result', 25_000),
    ];
    const state = projectCrewAudits(timeline);
    expect(state.audits.get('c1')).toMatchObject({ kind: 'spawn', agentId: 'scout-1' });
    expect(state.resultEnrichments.get('e1')).toEqual({ durationMs: 15_000 });
  });

  it('marks only historical unsettled spawns as interrupted — live pending stays unlabeled', () => {
    const livePending = projectCrewAudits([
      assistant('a-live', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', "...spawned as scout-1.", { id: 'scout-1' }),
      ]),
    ]);
    expect((livePending.audits.get('c1') as { status?: string } | undefined)?.status).toBeUndefined();

    const reopened = projectCrewAudits([
      historicalAssistant('a-hist', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', "...spawned as scout-1.", { id: 'scout-1' }),
      ]),
    ]);
    expect((reopened.audits.get('c1') as { status?: string } | undefined)?.status).toBe(
      'interrupted',
    );

    const rawHistorical = projectCrewAudits([
      auditItem('pre:c1', 10_000, { callId: 'c1', tool: 'crew_spawn', args: { subagent: 'scout' } }),
    ]);
    expect((rawHistorical.audits.get('c1') as { status?: string } | undefined)?.status).toBe(
      'interrupted',
    );
  });

  it('enriches a live result arrival without transient false interruption', () => {
    const timeline: ChatTimelineItem[] = [
      assistant('a-live', 10_000, [
        toolCall('c1', 'crew_spawn', { subagent: 'scout' }),
        toolResult('c1', "...spawned as scout-1.", { id: 'scout-1' }),
      ]),
      resultEvent('e1', 'scout-1', 'done', 'finished', 20_000),
    ];
    const state = projectCrewAudits(timeline);
    expect((state.audits.get('c1') as { status?: string } | undefined)?.status).toBeUndefined();
    expect(state.resultEnrichments.get('e1')).toEqual({ durationMs: 10_000 });
  });
});

describe('projectCrewAudits narrow dedup', () => {
  it('hides adjacent genuine redelivery', () => {
    const state = projectCrewAudits([
      resultEvent('e1', 'scout-1', 'done', 'same', 1000),
      resultEvent('e2', 'scout-1', 'done', 'same', 2000),
    ]);
    expect([...state.hiddenResultIds]).toEqual(['e2']);
  });

  it('retains an identical result separated by an intervening item', () => {
    const state = projectCrewAudits([
      resultEvent('e1', 'scout-1', 'done', 'same', 1000),
      resultEvent('e2', 'scout-1', 'waiting', 'another question', 2000),
      resultEvent('e3', 'scout-1', 'done', 'same', 3000),
    ]);
    expect(state.hiddenResultIds.has('e2')).toBe(false);
    expect(state.hiddenResultIds.has('e3')).toBe(false);
  });

  it('retains an identical waiting question separated by a message', () => {
    const state = projectCrewAudits([
      resultEvent('e1', 'scout-1', 'waiting', 'Which branch?', 1000),
      resultEvent('e2', 'scout-1', 'waiting', 'Which branch?', 2000),
      assistant('a1', 3000, [toolCall('c1', 'read', { path: 'x' })]),
      resultEvent('e3', 'scout-1', 'waiting', 'Which branch?', 4000),
    ]);
    expect([...state.hiddenResultIds]).toEqual(['e2']);
    expect(state.hiddenResultIds.has('e3')).toBe(false);
  });
});

describe('stored transcript provenance integration', () => {
  const storedEntry = (
    type: string,
    id: string,
    extra: Record<string, unknown> = {},
  ): SessionEntry => ({
    type,
    id,
    parentId: null,
    timestamp: '2026-07-25T10:00:00.000Z',
    ...extra,
  } as unknown as SessionEntry);

  const storedChain = (
    items: Array<{ type: string; id: string; extra?: Record<string, unknown> }>,
  ): { entries: SessionEntry[]; leafId: string } => {
    const entries: SessionEntry[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const parentId = index === 0 ? null : items[index - 1]!.id;
      entries.push(storedEntry(items[index]!.type, items[index]!.id, { ...(items[index]!.extra ?? {}), parentId }));
    }
    return { entries, leafId: items.at(-1)!.id };
  };

  it('projects a stored spawn as historical (interrupted) while a live equivalent stays unlabeled', () => {
    const { entries: raw, leafId } = storedChain([
      {
        type: 'message',
        id: 'post-a',
        extra: {
          timestamp: '2026-07-25T10:00:05.000Z',
          message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c-post', name: 'crew_spawn', arguments: { subagent: 'scout' } }] },
        },
      },
      {
        type: 'message',
        id: 'post-r',
        extra: {
          timestamp: '2026-07-25T10:00:06.000Z',
          message: { role: 'toolResult', toolCallId: 'c-post', toolName: 'crew_spawn', content: [{ type: 'text', text: "Subagent 'scout' spawned as scout-1." }], details: { id: 'scout-1' }, isError: false },
        },
      },
    ]);
    // Uncompacted stored transcript: toTimeline's projected messages must be
    // marked historical, so the browser projection treats the unsettled stored
    // spawn as unknown/interrupted — never as a live pending spawn.
    const state = projectCrewAudits(toTimeline(raw, raw, leafId));
    expect(
      (state.audits.get('c-post') as { status?: string } | undefined)?.status,
    ).toBe('interrupted');

    // The live constructed equivalent stays unmarked and unlabeled.
    const live: ChatTimelineItem[] = [
      {
        id: 'live-a',
        role: 'assistant',
        createdAt: 1,
        steps: [
          { kind: 'tool-call', callId: 'c-live', tool: 'crew_spawn', summary: 'crew_spawn: scout', args: { subagent: 'scout' } },
          { kind: 'tool-result', callId: 'c-live', ok: true, output: "Subagent 'scout' spawned as scout-1.", details: { id: 'scout-1' } },
        ],
      },
    ];
    expect(
      (projectCrewAudits(live).audits.get('c-live') as { status?: string } | undefined)?.status,
    ).toBeUndefined();
  });
});
