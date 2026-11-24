import { describe, expect, it } from 'vitest';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ChatCrewAuditItem } from '../../../src/shared/transport/protocol.ts';
import { describeManager, toActiveCustomEvents, toCustomEvents, toMessages, toTimeline, toTitle } from './session-transcript.ts';

/** Terse entry builder — the projection only reads type, id, timestamp, message. */
function entry(type: string, id: string, extra: Record<string, unknown> = {}): SessionEntry {
  return {
    type,
    id,
    parentId: null,
    timestamp: '2026-07-25T10:00:00.000Z',
    ...extra,
  } as unknown as SessionEntry;
}

const message = (id: string, payload: unknown): SessionEntry =>
  entry('message', id, { message: payload });

describe('toMessages', () => {
  it('projects a full turn: user text, thinking, answer, and a tool call with its result', () => {
    const messages = toMessages([
      message('u1', { role: 'user', content: 'edit the app', timestamp: 0 }),
      message('a1', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it up' },
          { type: 'text', text: 'on it' },
          { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'src/App.tsx' } },
        ],
        timestamp: 0,
      }),
      message('t1', {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Successfully replaced 1 block.' }],
        details: { diff: '-old\n+new' },
        isError: false,
        timestamp: 0,
      }),
    ]);

    expect(messages).toEqual([
      {
        id: 'u1',
        role: 'user',
        historical: true,
        steps: [{ kind: 'text', text: 'edit the app' }],
        createdAt: Date.parse('2026-07-25T10:00:00.000Z'),
      },
      {
        id: 'a1',
        role: 'assistant',
        historical: true,
        createdAt: Date.parse('2026-07-25T10:00:00.000Z'),
        steps: [
          { kind: 'thinking', text: 'weighing it up' },
          { kind: 'text', text: 'on it' },
          {
            kind: 'tool-call',
            callId: 'call-1',
            tool: 'edit',
            summary: 'edit: src/App.tsx',
            args: { path: 'src/App.tsx' },
          },
          {
            kind: 'tool-result',
            callId: 'call-1',
            ok: true,
            output: 'Successfully replaced 1 block.',
            diff: '-old\n+new',
            details: { diff: '-old\n+new' },
          },
        ],
      },
    ]);
  });

  it('reads array-form user content and reports a failed tool result as an error', () => {
    const messages = toMessages([
      message('u1', {
        role: 'user',
        content: [{ type: 'text', text: 'run it' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
        timestamp: 0,
      }),
      message('a1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-9', name: 'bash', arguments: { command: 'ls /nope' } }],
        timestamp: 0,
      }),
      message('t1', {
        role: 'toolResult',
        toolCallId: 'call-9',
        toolName: 'bash',
        content: [{ type: 'text', text: 'No such file' }],
        isError: true,
        timestamp: 0,
      }),
    ]);

    expect(messages[0]?.steps).toEqual([
      { kind: 'text', text: 'run it' },
      { kind: 'image', mimeType: 'image/png', data: 'x' },
    ]);
    expect(messages[1]?.steps.at(-1)).toEqual({
      kind: 'tool-result',
      callId: 'call-9',
      ok: false,
      error: 'No such file',
    });
  });

  it('keeps an image-only user message, with no empty text step', () => {
    const messages = toMessages([
      message('u1', {
        role: 'user',
        content: [{ type: 'image', data: 'AAA', mimeType: 'image/jpeg' }],
        timestamp: 0,
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.steps).toEqual([{ kind: 'image', mimeType: 'image/jpeg', data: 'AAA' }]);
  });

  it('orders every user image after the text, whatever order the parts arrived in', () => {
    const messages = toMessages([
      message('u1', {
        role: 'user',
        content: [
          { type: 'image', data: 'one', mimeType: 'image/png' },
          { type: 'text', text: 'compare these' },
          { type: 'image', data: 'two', mimeType: 'image/webp' },
        ],
        timestamp: 0,
      }),
    ]);

    expect(messages[0]?.steps).toEqual([
      { kind: 'text', text: 'compare these' },
      { kind: 'image', mimeType: 'image/png', data: 'one' },
      { kind: 'image', mimeType: 'image/webp', data: 'two' },
    ]);
  });

  it('still skips a user message with neither text nor images', () => {
    const messages = toMessages([
      message('u1', { role: 'user', content: [{ type: 'text', text: '' }], timestamp: 0 }),
      message('u2', { role: 'user', content: 'kept', timestamp: 0 }),
    ]);

    expect(messages.map((m) => m.id)).toEqual(['u2']);
  });

  it('marks a compaction so a rehydrated chat does not look shorter than it was', () => {
    const messages = toMessages([
      entry('compaction', 'c1', {
        summary: 'we discussed the seam',
        firstKeptEntryId: 'u2',
        tokensBefore: 40_000,
      }),
      message('u2', { role: 'user', content: 'carry on', timestamp: 0 }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.steps[0]).toEqual({
      kind: 'text',
      text: '⋯ earlier context compacted\n\nwe discussed the seam',
    });
  });

  it('drops what it cannot render rather than guessing: unknown entries, parts, and orphan results', () => {
    const messages = toMessages([
      entry('model_change', 'm1', { provider: 'opencode-go', modelId: 'glm-5.2' }),
      entry('thinking_level_change', 'k1', { thinkingLevel: 'high' }),
      entry('label', 'l1', { targetId: 'u1', label: 'here' }),
      entry('session_info', 's1', { name: 'a chat' }),
      entry('a_type_pi_has_not_invented_yet', 'x1'),
      // A result whose call we never saw must not attach itself to the nearest
      // message — a misattributed tool result is worse than a missing one.
      message('t1', {
        role: 'toolResult',
        toolCallId: 'call-unknown',
        toolName: 'edit',
        content: [{ type: 'text', text: 'orphan' }],
        isError: false,
        timestamp: 0,
      }),
      message('a1', {
        role: 'assistant',
        content: [
          { type: 'somethingNew', payload: {} },
          { type: 'text', text: 'still fine' },
        ],
        timestamp: 0,
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.steps).toEqual([{ kind: 'text', text: 'still fine' }]);
  });

  it('labels each assistant turn with the model that was in force at the time', () => {
    const messages = toMessages([
      entry('model_change', 'm1', { provider: 'openai-codex', modelId: 'gpt-5.6-sol' }),
      message('u1', { role: 'user', content: 'hello', timestamp: 0 }),
      message('a1', { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }),
      entry('model_change', 'm2', { provider: 'opencode-go', modelId: 'grok-4.5' }),
      message('a2', { role: 'assistant', content: [{ type: 'text', text: 'still here' }], timestamp: 0 }),
    ]);

    // A rehydrated chat must not be labelled with today's composer setting.
    expect(messages.map((m) => m.model)).toEqual([undefined, 'gpt-5.6-sol', 'grok-4.5']);
  });

  it('never reconstructs an approval — a stored session has no pending one', () => {
    const messages = toMessages([
      message('a1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'deploy' } }],
        timestamp: 0,
      }),
    ]);

    expect(messages.flatMap((m) => m.steps).some((s) => s.kind === 'approval-request')).toBe(false);
  });
});

describe('describeManager', () => {
  /**
   * The meta-session invariant, asserted in code rather than in prose. A meta
   * session (enrichment, any later ritual) must stay
   * in-memory so it never lands in the owner's history. An in-memory session has no
   * file, so it can never become a history row; this is the check that fails if
   * a later refactor "unifies session creation" onto the persisting path.
   */
  it('refuses to describe an in-memory session, so meta sessions cannot reach history', () => {
    const manager = SessionManager.inMemory('/workspace');

    expect(manager.isPersisted()).toBe(false);
    expect(describeManager(manager)).toBeNull();
  });
});

const customEntry = (id: string, overrides: Record<string, unknown> = {}): SessionEntry =>
  entry('custom_message', id, {
    customType: 'crew-result',
    content: 'body',
    display: true,
    details: { agentId: 'scout-1' },
    ...overrides,
  });

describe('toTitle', () => {
  it('titles a message pi stored as an expanded /skill: pick as it was typed', () => {
    const block = '<skill name="tdd" location="/home/you/.pi/skills/tdd/SKILL.md">\nReferences are relative to /home/you/.pi/skills/tdd.\n\n# TDD\nbody\n</skill>';
    expect(toTitle(`${block}\n\nwrite the parser`)).toBe('/skill:tdd write the parser');
    expect(toTitle(block)).toBe('/skill:tdd');
  });

  it('leaves any other text as it was, on one line', () => {
    expect(toTitle('review\n  the diff')).toBe('review the diff');
    expect(toTitle('   ')).toBe('untitled chat');
  });
});

describe('toCustomEvents', () => {
  it('projects custom_message entries chronologically with stable entry ids', () => {
    const events = toCustomEvents([
      customEntry('e1', { timestamp: '2026-07-25T10:00:01.000Z' }),
      customEntry('e2', { timestamp: '2026-07-25T10:00:02.000Z' }),
    ]);

    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(events[0]).toEqual({
      kind: 'custom-message',
      id: 'e1',
      customType: 'crew-result',
      display: true,
      content: 'body',
      details: { agentId: 'scout-1' },
      timestamp: Date.parse('2026-07-25T10:00:01.000Z'),
    });
  });

  it('preserves display:false items in the data', () => {
    const events = toCustomEvents([
      customEntry('e1', { display: false, timestamp: '2026-07-25T10:00:01.000Z' }),
    ]);
    expect(events[0]?.display).toBe(false);
  });

  it('deduplicates by stable id', () => {
    const events = toCustomEvents([
      customEntry('e1', { timestamp: '2026-07-25T10:00:01.000Z' }),
      customEntry('e1', { timestamp: '2026-07-25T10:00:02.000Z' }),
    ]);
    expect(events).toHaveLength(1);
  });

  it('ignores non-custom entries', () => {
    expect(toCustomEvents([message('m1', { role: 'user', content: 'hi' })])).toEqual([]);
  });
});

/** Build a root→leaf parent chain from a flat item list. */
function chain(
  items: Array<{ type: string; id: string; extra?: Record<string, unknown> }>,
): { raw: SessionEntry[]; leafId: string } {
  const raw: SessionEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const parentId = index === 0 ? null : items[index - 1]!.id;
    raw.push(entry(items[index]!.type, items[index]!.id, { ...(items[index]!.extra ?? {}), parentId }));
  }
  return { raw, leafId: items.at(-1)!.id };
}

describe('toTimeline', () => {
  it('merges messages and events chronologically when there is no compaction', () => {
    const { raw, leafId } = chain([
      { type: 'message', id: 'm1', extra: { timestamp: '2026-07-25T10:00:01.000Z', message: { role: 'user', content: 'ask' } } },
      { type: 'custom_message', id: 'e1', extra: { timestamp: '2026-07-25T10:00:02.000Z', customType: 'crew-result', content: 'body', display: true, details: { agentId: 'x', status: 'done' } } },
      { type: 'message', id: 'm2', extra: { timestamp: '2026-07-25T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } },
    ]);
    const timeline = toTimeline(raw, raw, leafId);
    expect(timeline.map((i) => ('role' in i ? `m:${i.id}` : `e:${i.id}`))).toEqual([
      'm:m1',
      'e:e1',
      'm:m2',
    ]);
  });

  it('places pre-compaction events on the historical side of the compaction marker', () => {
    const { raw, leafId } = chain([
      { type: 'custom_message', id: 'old', extra: { timestamp: '2026-07-25T10:00:01.000Z', customType: 'crew-result', content: 'body', display: true, details: { agentId: 'x', status: 'done' } } },
      { type: 'message', id: 'gone', extra: { timestamp: '2026-07-25T10:00:02.000Z', message: { role: 'user', content: 'compacted away' } } },
      { type: 'compaction', id: 'c1', extra: { summary: 'summary', timestamp: '2026-07-25T10:00:04.000Z' } },
      { type: 'message', id: 'kept', extra: { timestamp: '2026-07-25T10:00:05.000Z', message: { role: 'user', content: 'after' } } },
      { type: 'custom_message', id: 'new', extra: { timestamp: '2026-07-25T10:00:06.000Z', customType: 'crew-result', content: 'body2', display: true, details: { agentId: 'y', status: 'done' } } },
    ]);
    // buildContextEntries keeps only the compaction marker and post-compaction
    // messages.
    const context = [raw[2]!, raw[3]!];
    const timeline = toTimeline(context, raw, leafId);

    const kinds = timeline.map((i) => ('role' in i ? `m:${i.id}` : `e:${i.id}`));
    // The historical event lands right after the compaction marker, before the
    // post-compaction message; the post-compaction event is chronologically
    // interleaved.
    expect(kinds).toEqual(['m:c1', 'e:old', 'm:kept', 'e:new']);
  });
});

describe('toMessages tool-result details', () => {
  it('preserves JSON-safe tool-result details and sanitizes cycles', () => {
    const cyclic: Record<string, unknown> = { x: 1 };
    cyclic.self = cyclic;
    const messages = toMessages([
      message('a1', {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'crew_spawn', arguments: { subagent: 'scout' } },
        ],
      }),
      message('t1', {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'crew_spawn',
        content: [{ type: 'text', text: 'ok' }],
        details: cyclic,
        isError: false,
      }),
    ]);
    const step = messages.flatMap((m) => m.steps).find((s) => s.kind === 'tool-result');
    expect(step).toMatchObject({ kind: 'tool-result', ok: true, details: { x: 1, self: null } });
  });
});

describe('toTimeline active branch scoping', () => {
  it('projects only the active branch: abandoned crew artifacts never phantom, no cross-branch pairing', () => {
    const base = entry('message', 'root', {
      timestamp: '2026-07-25T10:00:00.000Z',
      message: { role: 'assistant', content: [] },
    });
    const abandoned = [
      entry('message', 'aband-a', {
        parentId: 'root',
        timestamp: '2026-07-25T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c-x', name: 'crew_spawn', arguments: { subagent: 'scout' } }],
        },
      }),
      entry('message', 'aband-r', {
        parentId: 'aband-a',
        timestamp: '2026-07-25T10:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c-x',
          toolName: 'crew_spawn',
          content: [{ type: 'text', text: 'spawned as scout-abandoned.' }],
          details: { id: 'scout-abandoned' },
          isError: false,
        },
      }),
      entry('custom_message', 'aband-custom', {
        parentId: 'aband-r',
        timestamp: '2026-07-25T10:00:03.000Z',
        customType: 'crew-result',
        content: 'abandoned result body',
        display: true,
        details: { agentId: 'scout-abandoned', status: 'done' },
      }),
    ];
    const active = [
      entry('message', 'act-a', {
        parentId: 'root',
        timestamp: '2026-07-25T10:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c-x', name: 'crew_spawn', arguments: { subagent: 'scout' } }],
        },
      }),
      entry('message', 'act-r', {
        parentId: 'act-a',
        timestamp: '2026-07-25T10:00:05.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c-x',
          toolName: 'crew_spawn',
          content: [{ type: 'text', text: 'spawned as scout-active.' }],
          details: { id: 'scout-active' },
          isError: false,
        },
      }),
      entry('compaction', 'c-act', { parentId: 'act-r', summary: 's', timestamp: '2026-07-25T10:00:06.000Z' }),
      entry('message', 'post', {
        parentId: 'c-act',
        timestamp: '2026-07-25T10:00:07.000Z',
        message: { role: 'user', content: 'after' },
      }),
      entry('custom_message', 'act-custom', {
        parentId: 'post',
        timestamp: '2026-07-25T10:00:08.000Z',
        customType: 'crew-result',
        content: 'active result body',
        display: true,
        details: { agentId: 'scout-active', status: 'done' },
      }),
    ];
    const all = [base, ...abandoned, ...active];
    const context = [active[2]!, active[3]!]; // compaction + post-compaction message

    const timeline = toTimeline(context, all, 'act-custom');

    // The active pre-compaction spawn survives; the abandoned branch's
    // identical callId never becomes a phantom audit, and its result cannot
    // cross-pair with the active call.
    const audits = timeline.filter(
      (item): item is ChatCrewAuditItem => 'kind' in item && item.kind === 'crew-tool-audit',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ id: 'act-a:c-x', result: { details: { id: 'scout-active' } } });
    // The abandoned custom result never settles/correlates on the active path.
    expect(JSON.stringify(timeline)).not.toContain('abandoned result body');
    expect(JSON.stringify(timeline)).toContain('active result body');
  });
});

describe('toTimeline crew audit durability', () => {
  const { raw, leafId } = chain([
    { type: 'message', id: 'pre-a', extra: { timestamp: '2026-07-25T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'compacted prose' }, { type: 'toolCall', id: 'c-pre', name: 'crew_spawn', arguments: { subagent: 'scout', task: { goal: 'read probe' } } }, { type: 'toolCall', id: 'c-bash', name: 'bash', arguments: { command: 'ls' } }] } } },
    { type: 'message', id: 'pre-r', extra: { timestamp: '2026-07-25T10:00:02.000Z', message: { role: 'toolResult', toolCallId: 'c-pre', toolName: 'crew_spawn', content: [{ type: 'text', text: "Subagent 'scout' spawned as scout-1." }], details: { id: 'scout-1' }, isError: false } } },
    { type: 'compaction', id: 'c1', extra: { summary: 'compacted', timestamp: '2026-07-25T10:00:04.000Z' } },
    { type: 'message', id: 'post-a', extra: { timestamp: '2026-07-25T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c-post', name: 'crew_list', arguments: {} }] } } },
  ]);
  const context = [raw[2]!, raw[3]!];

  it('keeps a pre-marker crew spawn audit with its JSON-safe metadata', () => {
    const timeline = toTimeline(context, raw, leafId);
    expect(timeline).toContainEqual({
      kind: 'crew-tool-audit',
      id: 'pre-a:c-pre',
      timestamp: Date.parse('2026-07-25T10:00:01.000Z'),
      historical: true,
      call: { callId: 'c-pre', tool: 'crew_spawn', args: { subagent: 'scout', task: { goal: 'read probe' } } },
      result: { ok: true, output: "Subagent 'scout' spawned as scout-1.", details: { id: 'scout-1' } },
    });
  });

  it('does not rehydrate compacted prose or generic tools', () => {
    const timeline = toTimeline(context, raw, leafId);
    expect(JSON.stringify(timeline)).not.toContain('compacted prose');
    expect(
      timeline.some(
        (item) => 'kind' in item && item.kind === 'crew-tool-audit' && item.call.tool === 'bash',
      ),
    ).toBe(false);
  });

  it('does not duplicate a post-marker crew call already in the projected context', () => {
    const timeline = toTimeline(context, raw, leafId);
    expect(
      timeline.some(
        (item) => 'kind' in item && item.kind === 'crew-tool-audit' && item.call.callId === 'c-post',
      ),
    ).toBe(false);
  });

  it('keeps a later custom result at its durable chronological position', () => {
    const withResult = [
      ...raw,
      entry('custom_message', 'late-result', {
        parentId: leafId,
        timestamp: '2026-07-25T10:00:06.000Z',
        customType: 'crew-result',
        content: 'body',
        display: true,
        details: { agentId: 'scout-1', status: 'done' },
      }),
    ];
    const timeline = toTimeline(context, withResult, 'late-result');
    const ids = timeline.map((item) => ('role' in item ? `m:${item.id}` : `e:${item.id}`));
    // marker, historical audit, post message, late result — in order
    expect(ids.indexOf('e:late-result')).toBeGreaterThan(ids.indexOf('m:c1'));
    expect(ids.indexOf('m:c1')).toBeLessThan(ids.indexOf('m:post-a'));
    expect(ids.indexOf('e:late-result')).toBeGreaterThan(ids.indexOf('m:post-a'));
  });
});

describe('toActiveCustomEvents', () => {
  const custom = (id: string, parentId: string | null, content: string): SessionEntry =>
    entry('custom_message', id, {
      parentId,
      customType: 'crew-result',
      content,
      display: true,
      details: { agentId: id, status: 'done' },
    });

  it('yields only the active-path custom events', () => {
    const events = toActiveCustomEvents(
      [custom('aband-1', null, 'abandoned'), custom('leaf-1', 'base', 'active')],
      'leaf-1',
    );
    expect(events.map((e) => e.id)).toEqual(['leaf-1']);
  });

  it('returns no events for a null leaf — never an all-file fallback', () => {
    expect(toActiveCustomEvents([custom('only', null, 'x')], null)).toEqual([]);
  });

  it('returns no events when the leaf is missing from the store', () => {
    expect(toActiveCustomEvents([custom('x', null, 'x')], 'no-such-leaf')).toEqual([]);
  });

  it('terminates a cyclic parent chain without an all-file fallback', () => {
    const entries = [
      custom('a', 'b', 'a body'),
      custom('b', 'a', 'b body'),
      custom('off', null, 'off body'),
    ];
    const events = toActiveCustomEvents(entries, 'a');
    // Both cycle members are reachable; the unrelated entry is not on the
    // active path and must never leak in.
    expect(events.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});
