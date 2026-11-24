import { describe, expect, it } from 'vitest';
import type { ChatChunk } from '@shared/transport/protocol.ts';
import type { ChatEventItem } from './chat.types.ts';
import {
  dropUnboundProvisional,
  liveCrewEventFromChunk,
  liveCrewEventFromCustom,
  reduceLiveCrew,
  shouldCountUnread,
  type LiveCrewAgent,
  type PendingControlCalls,
} from './crew-live.ts';

const pending = (): PendingControlCalls => new Map();

const row = (overrides: Partial<LiveCrewAgent> = {}): LiveCrewAgent => ({
  key: 'c1',
  callId: 'c1',
  agentName: 'scout',
  status: 'running',
  startedAt: 1000,
  ...overrides,
});

const chunk = (partial: ChatChunk): ChatChunk => partial;

describe('reduceLiveCrew spawn lifecycle', () => {
  it('creates a provisional running row from a recognized spawn call', () => {
    const rows = reduceLiveCrew([], {
      kind: 'spawn-call',
      callId: 'c1',
      args: { subagent: 'scout', task: { goal: 'read probe' } },
      at: 5000,
    });
    expect(rows).toEqual([
      { key: 'c1', callId: 'c1', agentName: 'scout', task: 'read probe', status: 'running', startedAt: 5000 },
    ]);
  });

  it('does nothing for a malformed spawn call or a duplicate callId', () => {
    expect(
      reduceLiveCrew([], { kind: 'spawn-call', callId: 'c1', args: { task: { goal: 'x' } }, at: 1 }),
    ).toEqual([]);
    expect(
      reduceLiveCrew([row()], { kind: 'spawn-call', callId: 'c1', args: { subagent: 'scout' }, at: 2 }),
    ).toEqual([row()]);
  });

  it('binds the structured id first, then the exact text fallback', () => {
    const structured = reduceLiveCrew([row()], {
      kind: 'spawn-result',
      callId: 'c1',
      ok: true,
      details: { id: 'scout-abc' },
      output: "Subagent 'scout' spawned as scout-other.",
      at: 3,
    });
    expect(structured[0]?.agentId).toBe('scout-abc');

    const text = reduceLiveCrew([row()], {
      kind: 'spawn-result',
      callId: 'c1',
      ok: true,
      details: undefined,
      output: "Subagent 'scout' spawned as scout-xyz.",
      at: 3,
    });
    expect(text[0]?.agentId).toBe('scout-xyz');
  });

  it('drops the provisional row on a success without a resolvable id — lossy over permanently wrong', () => {
    const rows = reduceLiveCrew([row()], {
      kind: 'spawn-result',
      callId: 'c1',
      ok: true,
      details: undefined,
      output: 'The subagent did its work.',
      at: 3,
    });
    expect(rows).toEqual([]);
  });

  it('removes the provisional row on a spawn error', () => {
    const rows = reduceLiveCrew([row()], {
      kind: 'spawn-result',
      callId: 'c1',
      ok: false,
      details: undefined,
      output: 'boom',
      at: 3,
    });
    expect(rows).toEqual([]);
  });

  it('ignores results for unknown callIds', () => {
    const rows = reduceLiveCrew([row()], {
      kind: 'spawn-result',
      callId: 'other',
      ok: true,
      details: undefined,
      output: 'x',
      at: 3,
    });
    expect(rows).toEqual([row()]);
  });
});

describe('reduceLiveCrew crew-result transitions', () => {
  it('transitions running→waiting and back, and removes on terminal statuses', () => {
    const waiting = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'crew-result',
      agentId: 'scout-1',
      status: 'waiting',
      at: 4,
    });
    expect(waiting[0]?.status).toBe('waiting');

    const running = reduceLiveCrew(waiting, {
      kind: 'crew-result',
      agentId: 'scout-1',
      status: 'running',
      at: 5,
    });
    expect(running[0]?.status).toBe('running');

    for (const status of ['done', 'error', 'aborted'] as const) {
      expect(
        reduceLiveCrew([row({ agentId: 'scout-1' })], {
          kind: 'crew-result',
          agentId: 'scout-1',
          status,
          at: 6,
        }),
      ).toEqual([]);
    }
  });

  it('keeps a 1.0.34 completed result visible with its status', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'crew-result',
      agentId: 'scout-1',
      status: 'completed',
      at: 4,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');

    // Needs_input keeps the row visible in its waiting status too.
    const needs = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'crew-result',
      agentId: 'scout-1',
      status: 'needs_input',
      at: 5,
    });
    expect(needs).toHaveLength(1);
    expect(needs[0]?.status).toBe('needs_input');
  });

  it('never removes or transitions an uncorrelated row', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'crew-result',
      agentId: 'someone-else',
      status: 'done',
      at: 4,
    });
    expect(rows).toEqual([row({ agentId: 'scout-1' })]);
  });
});

describe('reduceLiveCrew control results (1.0.34 acknowledgements)', () => {
  it('returns the row to running on a successful crew_respond ack', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1', status: 'needs_input' })], {
      kind: 'control-result',
      tool: 'crew_respond',
      target: 'scout-1',
      ok: true,
      output: '{"subagent_id":"scout-1"}',
      at: 5,
    });
    expect(rows[0]?.status).toBe('running');
  });

  it('prefers the ack subagent_id over the call target', () => {
    const rows = reduceLiveCrew(
      [row({ agentId: 'scout-1', status: 'needs_input' }), row({ key: 'c2', callId: 'c2', agentName: 'w', agentId: 'worker-1' })],
      {
        kind: 'control-result',
        tool: 'crew_respond',
        target: 'worker-1',
        ok: true,
        output: '{"subagent_id":"scout-1"}',
        at: 5,
      },
    );
    expect(rows[0]?.status).toBe('running');
    expect(rows[1]?.status).toBe('running');
  });

  it('removes the row on a successful crew_done ack', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1', status: 'completed' })], {
      kind: 'control-result',
      tool: 'crew_done',
      target: 'scout-1',
      ok: true,
      output: '{"subagent_id":"scout-1"}',
      at: 5,
    });
    expect(rows).toEqual([]);
  });

  it('keeps the row on a failed crew_done result', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'control-result',
      tool: 'crew_done',
      target: 'scout-1',
      ok: false,
      output: '{"error":"not found"}',
      at: 5,
    });
    expect(rows).toEqual([row({ agentId: 'scout-1' })]);
  });

  it('removes rows whose id is in a crew_abort ack aborted_ids, not missing/foreign', () => {
    const rows = [
      row({ agentId: 'scout-1' }),
      row({ key: 'c2', callId: 'c2', agentName: 'w1', agentId: 'worker-1' }),
      row({ key: 'c3', callId: 'c3', agentName: 'w2', agentId: 'worker-2' }),
    ];
    const next = reduceLiveCrew(rows, {
      kind: 'control-result',
      tool: 'crew_abort',
      target: 'scout-1',
      ok: true,
      output: '{"aborted_ids":["scout-1"],"missing_ids":["worker-1"],"foreign_ids":["worker-2"]}',
      at: 5,
    });
    expect(next.map((r) => r.agentId)).toEqual(['worker-1', 'worker-2']);
  });

  it('keeps rows when the id is only in missing_ids or the ack is malformed', () => {
    for (const output of ['{"missing_ids":["scout-1"]}', '{"aborted_ids":', 'no json at all']) {
      expect(
        reduceLiveCrew([row({ agentId: 'scout-1' })], {
          kind: 'control-result',
          tool: 'crew_abort',
          target: 'scout-1',
          ok: true,
          output,
          at: 5,
        }),
      ).toEqual([row({ agentId: 'scout-1' })]);
    }
  });

  it('drops non-string aborted_ids members', () => {
    expect(
      reduceLiveCrew([row({ agentId: 'scout-1' })], {
        kind: 'control-result',
        tool: 'crew_abort',
        target: 'scout-1',
        ok: true,
        output: '{"aborted_ids":["scout-1",42]}',
        at: 5,
      }),
    ).toEqual([]);
  });
});

describe('reduceLiveCrew crew-status snapshots (1.0.34)', () => {
  it('syncs bound rows to the owner snapshot and removes ids it no longer lists', () => {
    const rows = [
      row({ key: 'c1', callId: 'c1', agentId: 'a-1', status: 'completed' }),
      row({ key: 'c2', callId: 'c2', agentId: 'a-2', status: 'completed' }),
    ];
    // a-1 was closed and a-2 given a follow-up by a turn the cockpit did not
    // stream (pi-crew's own triggered turn).
    expect(
      reduceLiveCrew(rows, {
        kind: 'crew-status',
        agents: [{ id: 'a-2', status: 'running' }],
        at: 5,
      }),
    ).toEqual([row({ key: 'c2', callId: 'c2', agentId: 'a-2', status: 'running' })]);
  });

  it('never touches unbound provisional rows or invents rows', () => {
    const provisional = row({ key: 'c9', callId: 'c9' });
    expect(
      reduceLiveCrew([provisional], {
        kind: 'crew-status',
        agents: [{ id: 'a-7', status: 'running' }],
        at: 5,
      }),
    ).toEqual([provisional]);
  });

  it('keeps the row status when the snapshot status is unknown', () => {
    const bound = row({ agentId: 'a-1', status: 'completed' });
    expect(
      reduceLiveCrew([bound], { kind: 'crew-status', agents: [{ id: 'a-1', status: 'wat' }], at: 5 }),
    ).toEqual([bound]);
  });
});

describe('reduceLiveCrew control activity', () => {
  it('sets lastActivity only on a row correlated by bound agent id', () => {
    const rows = reduceLiveCrew([row({ agentId: 'scout-1' })], {
      kind: 'control-call',
      tool: 'crew_abort',
      target: 'scout-1',
      at: 5,
    });
    expect(rows[0]?.lastActivity).toBe('crew_abort');
    expect(rows[0]?.status).toBe('running');

    // No target or a non-matching target never invents or removes state.
    expect(
      reduceLiveCrew([row({ agentId: 'scout-1' })], {
        kind: 'control-call',
        tool: 'crew_done',
        target: undefined,
        at: 5,
      }),
    ).toEqual([row({ agentId: 'scout-1' })]);
    expect(
      reduceLiveCrew([row({ agentId: 'scout-1' })], {
        kind: 'control-call',
        tool: 'crew_done',
        target: 'other',
        at: 5,
      }),
    ).toEqual([row({ agentId: 'scout-1' })]);
  });
});

describe('liveCrewEventFromChunk', () => {
  it('maps live crew tool chunks and nothing else', () => {
    const spawnCall: ChatChunk = {
      kind: 'tool-call',
      callId: 'c1',
      tool: 'crew_spawn',
      summary: 'crew_spawn: scout',
      args: { subagent: 'scout' },
    };
    expect(liveCrewEventFromChunk(spawnCall, 1, pending())).toEqual({
      kind: 'spawn-call',
      callId: 'c1',
      args: { subagent: 'scout' },
      at: 1,
    });

    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-call', callId: 'c2', tool: 'crew_abort', summary: 'x', args: { subagent_id: 'scout-1' } }),
        2,
        pending(),
      ),
    ).toEqual({ kind: 'control-call', tool: 'crew_abort', target: 'scout-1', at: 2 });

    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-call', callId: 'c3', tool: 'read', summary: 'x', args: { path: 'f' } }),
        3,
        pending(),
      ),
    ).toBeNull();
    expect(liveCrewEventFromChunk(chunk({ kind: 'text', delta: 'hi' }), 3, pending())).toBeNull();
    expect(
      liveCrewEventFromChunk(chunk({ kind: 'usage', tokens: 1, contextWindow: 2, percent: 1 }), 3, pending()),
    ).toBeNull();
  });

  it('records control calls and pairs results by callId, consuming the pending entry', () => {
    const map = pending();
    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-call', callId: 'c9', tool: 'crew_done', summary: 'x', args: { subagent_id: 'scout-1' } }),
        1,
        map,
      ),
    ).toEqual({ kind: 'control-call', tool: 'crew_done', target: 'scout-1', at: 1 });
    expect([...map.entries()]).toEqual([['c9', { tool: 'crew_done', target: 'scout-1' }]]);

    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-result', callId: 'c9', ok: true, output: '{"subagent_id":"scout-1"}' }),
        2,
        map,
      ),
    ).toEqual({
      kind: 'control-result',
      tool: 'crew_done',
      target: 'scout-1',
      ok: true,
      output: '{"subagent_id":"scout-1"}',
      at: 2,
    });
    expect(map.size).toBe(0);
  });

  it('keeps treating an unpaired result as a possible spawn result', () => {
    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-result', callId: 'cx', ok: true, output: "Subagent 's' spawned as s-1.", details: { id: 's-1' } }),
        2,
        pending(),
      ),
    ).toEqual({
      kind: 'spawn-result',
      callId: 'cx',
      ok: true,
      output: "Subagent 's' spawned as s-1.",
      details: { id: 's-1' },
      at: 2,
    });
  });

  it('pairs only a result with the same callId — order never matters', () => {
    const map = pending();
    liveCrewEventFromChunk(
      chunk({ kind: 'tool-call', callId: 'cA', tool: 'crew_respond', summary: 'x', args: { subagent_id: 'a-1' } }),
      1,
      map,
    );
    liveCrewEventFromChunk(
      chunk({ kind: 'tool-call', callId: 'cB', tool: 'crew_done', summary: 'x', args: { subagent_id: 'b-1' } }),
      2,
      map,
    );
    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-result', callId: 'cB', ok: true, output: '{"subagent_id":"b-1"}' }),
        3,
        map,
      ),
    ).toMatchObject({ kind: 'control-result', tool: 'crew_done', target: 'b-1' });
    expect(
      liveCrewEventFromChunk(
        chunk({ kind: 'tool-result', callId: 'cA', ok: true, output: '{"subagent_id":"a-1"}' }),
        4,
        map,
      ),
    ).toMatchObject({ kind: 'control-result', tool: 'crew_respond', target: 'a-1' });
  });
});

describe('liveCrewEventFromCustom', () => {
  const event = (overrides: Partial<ChatEventItem> = {}): ChatEventItem => ({
    kind: 'custom-message',
    id: 'e1',
    customType: 'crew-result',
    display: true,
    content: 'body',
    details: { agentId: 'scout-1', status: 'done' },
    timestamp: 10,
    ...overrides,
  });

  it('maps a valid correlated crew-result', () => {
    expect(liveCrewEventFromCustom(event())).toEqual({
      kind: 'crew-result',
      agentId: 'scout-1',
      status: 'done',
      at: 10,
    });
  });

  it('maps a crew-status owner snapshot from its JSON content', () => {
    expect(
      liveCrewEventFromCustom(
        event({
          customType: 'crew-status',
          display: false,
          content: '{"type":"crew_status","agents":[{"id":"scout-1","status":"completed"},{"id":7},{"id":"scout-2"}]}',
          details: { crewContextId: 'x' },
        }),
      ),
    ).toEqual({
      kind: 'crew-status',
      agents: [
        { id: 'scout-1', status: 'completed' },
        { id: 'scout-2', status: '' },
      ],
      at: 10,
    });
  });

  it('returns null for a malformed crew-status snapshot', () => {
    const status = (content: string) =>
      liveCrewEventFromCustom(event({ customType: 'crew-status', display: false, content }));
    expect(status('not json')).toBeNull();
    expect(status('{"type":"crew_status"}')).toBeNull();
    expect(status('{"type":"crew_reminder","agents":[]}')).toBeNull();
  });

  it('returns null for malformed or non-crew events', () => {
    expect(liveCrewEventFromCustom(event({ customType: 'crew-list-warning' }))).toBeNull();
    expect(liveCrewEventFromCustom(event({ details: { status: 'wat' } }))).toBeNull();
    expect(liveCrewEventFromCustom(event({ details: { status: 'done' } }))).toBeNull();
  });
});

describe('shouldCountUnread', () => {
  const event = (overrides: Partial<ChatEventItem> = {}): ChatEventItem => ({
    kind: 'custom-message',
    id: 'e1',
    customType: 'crew-result',
    display: true,
    content: 'body',
    details: { agentId: 'scout-1', status: 'done' },
    timestamp: 10,
    ...overrides,
  });

  it('counts displayable waiting/terminal results and warnings', () => {
    expect(shouldCountUnread(event({ customType: 'crew-list-warning' }))).toBe(true);
    for (const status of ['waiting', 'completed', 'needs_input', 'done', 'error', 'aborted']) {
      expect(shouldCountUnread(event({ details: { agentId: 's', status } }))).toBe(true);
    }
  });

  it('never counts running, malformed, hidden, or unknown types', () => {
    expect(shouldCountUnread(event({ details: { agentId: 's', status: 'running' } }))).toBe(false);
    expect(shouldCountUnread(event({ display: false }))).toBe(false);
    expect(shouldCountUnread(event({ details: { status: 'wat' } }))).toBe(false);
    expect(shouldCountUnread(event({ details: { status: 'done' } }))).toBe(false);
    expect(shouldCountUnread(event({ customType: 'custom-thing' }))).toBe(false);
  });
});

describe('dropUnboundProvisional', () => {
  it('removes unbound provisional rows and keeps bound rows and other agents', () => {
    const rows = [
      row({ key: 'c1', callId: 'c1', agentId: 'scout-1' }),
      row({ key: 'c2', callId: 'c2', agentName: 'worker' }),
      row({ key: 'c3', callId: 'c3', agentId: 'worker-2' }),
    ];
    expect(dropUnboundProvisional(rows).map((r) => r.callId)).toEqual(['c1', 'c3']);
  });

  it('removes nothing when every row is bound', () => {
    const rows = [row({ agentId: 'scout-1' })];
    expect(dropUnboundProvisional(rows)).toEqual(rows);
  });
});
