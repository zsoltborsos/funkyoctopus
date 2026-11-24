import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { turnFixture, type TurnName } from '../test/claude-fixtures.ts';
import { ChunkMapper } from './chunks.ts';

/** Feeds a message sequence through one mapper, as the engine does for a turn. */
function replay(messages: unknown[], mapper = new ChunkMapper()) {
  const chunks: ChatChunk[] = [];
  let end: { error?: Error } | undefined;
  for (const message of messages) {
    const step = mapper.map(message);
    chunks.push(...step.chunks);
    if (step.end) {
      end = step.end;
      break;
    }
  }
  return { chunks, end };
}

const replayTurn = (name: TurnName) => replay(turnFixture(name).messages);

const joined = (chunks: ChatChunk[], kind: 'text' | 'thinking'): string =>
  chunks.flatMap((chunk) => (chunk.kind === kind ? [chunk.delta] : [])).join('');

describe('ChunkMapper: a text turn', () => {
  it('streams thinking and text deltas once each, then reports context use and ends', () => {
    const { chunks, end } = replayTurn('plain');

    // The literals are the recorded answer; the whole-message copies in the
    // stream (`assistant` blocks) must not repeat them.
    expect(joined(chunks, 'thinking')).toBe('17 times 23 breaks down into 17*20 plus 17*3, giving 340+51=391.\n\n');
    expect(joined(chunks, 'text')).toBe('17 × 23 = **391**.');
    expect(chunks.filter((chunk) => chunk.kind === 'text')).toHaveLength(3);

    // 2 fresh + 6597 cache-written + 11229 cache-read tokens on the last request,
    // against the recorded 1,000,000-token window: 17,828 / 1,000,000 = 1.7828 %.
    const usage = chunks.at(-1);
    expect(usage).toMatchObject({ kind: 'usage', tokens: 17828, contextWindow: 1_000_000 });
    expect(usage?.kind === 'usage' ? usage.percent : null).toBeCloseTo(1.7828, 4);
    expect(end).toEqual({});
  });
});

describe('ChunkMapper: compaction', () => {
  it('maps a manual /compact\'s boundary to one compaction chunk and ends the turn without an error', () => {
    const { chunks, end } = replayTurn('compact');

    // 14166 -> 2016 tokens are the recorded compact_metadata of a real /compact.
    expect(chunks).toEqual([{ kind: 'compaction', trigger: 'manual', preTokens: 14166, postTokens: 2016 }]);
    expect(end).toEqual({});
  });

  it('leaves out postTokens when the boundary does not report them, and keeps an auto trigger', () => {
    const { chunks } = replay([
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000 } },
    ]);

    expect(chunks).toEqual([{ kind: 'compaction', trigger: 'auto', preTokens: 180000 }]);
  });

  it.each([
    ['no metadata', { type: 'system', subtype: 'compact_boundary' }],
    ['an unknown trigger', { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'later', pre_tokens: 5 } }],
    ['no token count', { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }],
  ])('maps a boundary with %s to nothing rather than failing the turn', (_name, message) => {
    expect(replay([message]).chunks).toEqual([]);
  });
});

describe('ChunkMapper: what a local command prints (T2.4b)', () => {
  const system = (subtype: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    type: 'system',
    subtype,
    uuid: 'u',
    session_id: 's',
    ...extra,
  });

  it('passes local command output through as the turn’s text, set apart from text around it', () => {
    expect(new ChunkMapper().map(system('local_command_output', { content: 'Renamed to “palette”\n' })).chunks).toEqual([
      { kind: 'text', delta: '\n\nRenamed to “palette”\n\n' },
    ]);
  });

  it('passes an informational banner through, except the info level the CLI shows only when verbose', () => {
    const mapper = new ChunkMapper();
    for (const level of ['notice', 'suggestion', 'warning']) {
      expect(mapper.map(system('informational', { content: `a ${level}`, level })).chunks).toEqual([
        { kind: 'text', delta: `\n\na ${level}\n\n` },
      ]);
    }
    expect(mapper.map(system('informational', { content: 'verbose', level: 'info' })).chunks).toEqual([]);
  });

  it('shows nothing for an empty or malformed one', () => {
    const mapper = new ChunkMapper();
    expect(mapper.map(system('local_command_output', { content: '  ' })).chunks).toEqual([]);
    expect(mapper.map(system('informational', { content: 42, level: 'notice' })).chunks).toEqual([]);
  });
});

describe('ChunkMapper: a tool turn', () => {
  it('maps the tool call and its result by the SDK tool-use id', () => {
    const { chunks } = replayTurn('bash');
    const callId = 'toolu_01NdUCvwD9UAXLfko3Ko8TWU';

    expect(chunks.filter((chunk) => chunk.kind === 'tool-call' || chunk.kind === 'tool-result')).toEqual([
      {
        kind: 'tool-call',
        callId,
        tool: 'Bash',
        summary: 'Bash: echo fixture-ok',
        args: { command: 'echo fixture-ok', description: 'Print fixture-ok string' },
      },
      { kind: 'tool-result', callId, ok: true, output: 'fixture-ok' },
    ]);
    expect(joined(chunks, 'text')).toBe('The command printed `fixture-ok`, which is the exact text it was asked to echo.');
  });
});

describe('ChunkMapper: a tool the Vault denied', () => {
  it('reports the hook\'s refusal as a failed tool result and still ends the turn normally', () => {
    const { chunks, end } = replayTurn('denied');
    const callId = 'toolu_01JEciy4y7qVRsMwrBSxnUvx';

    expect(chunks.find((chunk) => chunk.kind === 'tool-call')).toMatchObject({
      callId,
      tool: 'Read',
      summary: 'Read: /home/example/project/blocked/secret.txt',
    });
    expect(chunks.find((chunk) => chunk.kind === 'tool-result')).toEqual({
      kind: 'tool-result',
      callId,
      ok: false,
      error: 'PreToolUse:Read hook error: Vault blocked access to /home/example/project/blocked',
    });
    expect(end).toEqual({});
  });
});

describe('ChunkMapper: replies that never streamed', () => {
  it('shows a local command\'s synthetic reply, which arrives only as a whole message', () => {
    const messages = JSON.parse(
      readFileSync(new URL('./fixtures/usage-query-messages.json', import.meta.url), 'utf8'),
    ) as unknown[];
    const { chunks } = replay(messages);

    expect(joined(chunks, 'text')).toBe(
      'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 72% used',
    );
  });
});

describe('ChunkMapper: an interrupted turn', () => {
  it('ends cleanly: the tool the owner stopped is a failed step, not a failed turn', () => {
    const { chunks, end } = replayTurn('interrupted');

    expect(chunks.find((chunk) => chunk.kind === 'tool-result')).toMatchObject({ ok: false });
    expect(end).toEqual({});
  });
});

describe('ChunkMapper: failures', () => {
  const failure = (end: { error?: Error } | undefined): { message: string; code?: string | undefined } => {
    if (!(end?.error instanceof WireCallError)) throw new Error('the turn did not end with a wire error');
    return { message: end.error.message, code: end.error.code };
  };

  it('tells a logged-out owner how to sign in, without echoing the CLI\'s own line', () => {
    const { chunks, end } = replayTurn('auth-failed');

    expect(chunks).toEqual([]);
    expect(failure(end)).toEqual({
      message: 'Claude Code is not logged in — run `claude`, then /login, in a terminal',
      code: 'claude_not_logged_in',
    });
  });

  it('names the window that rejected the turn and when it resets', () => {
    // The event shape is the recorded one; only the status is forced to rejected.
    const recorded = turnFixture('plain').messages.find((message) => message.type === 'rate_limit_event');
    const rejected = {
      ...recorded,
      rate_limit_info: { ...(recorded?.rate_limit_info as object), status: 'rejected', resetsAt: 1792280400 },
    };
    const { chunks, end } = replay([
      rejected,
      { type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'limit reached' }] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'limit reached', parent_tool_use_id: null },
    ]);

    expect(chunks).toEqual([]);
    const { message, code } = failure(end);
    expect(code).toBe('claude_rate_limited');
    expect(message).toMatch(/^Claude Code hit its usage limit — resets at (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
  });

  it('gives no reset time when the last limit event was only a warning', () => {
    const warning = turnFixture('plain').messages.find((message) => message.type === 'rate_limit_event');
    const { end } = replay([
      warning,
      { type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { id: 'm1', model: '<synthetic>', content: [] } },
      { type: 'result', subtype: 'success', is_error: true, parent_tool_use_id: null },
    ]);

    expect(failure(end).message).toBe('Claude Code hit its usage limit');
  });

  it('reports any other API error by name', () => {
    const { end } = replay([
      { type: 'assistant', error: 'overloaded', parent_tool_use_id: null, message: { id: 'm1', model: '<synthetic>', content: [] } },
      { type: 'result', subtype: 'success', is_error: true, parent_tool_use_id: null },
    ]);

    expect(failure(end)).toEqual({ message: 'Claude Code could not finish the turn (overloaded)', code: 'claude_turn_error' });
  });

  it('reports an error result that no assistant message explained, with its own words', () => {
    const { end } = replay([
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached the turn limit'], parent_tool_use_id: null },
    ]);

    expect(failure(end)).toEqual({ message: 'Reached the turn limit', code: 'claude_turn_error' });
  });
});

describe('ChunkMapper: context use', () => {
  it('reports what the turn\'s last request read, not the sum over its requests', () => {
    // The bash turn made two requests: 2 + 4336 + 13850 tokens, then 2 + 2106 + 18186.
    const { chunks } = replayTurn('bash');

    expect(chunks.filter((chunk) => chunk.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 20294, contextWindow: 1_000_000, percent: expect.closeTo(2.0294, 4) as number },
    ]);
  });

  it('says nothing when no model request was made', () => {
    const messages = JSON.parse(
      readFileSync(new URL('./fixtures/usage-query-messages.json', import.meta.url), 'utf8'),
    ) as unknown[];

    expect(replay(messages).chunks.some((chunk) => chunk.kind === 'usage')).toBe(false);
  });
});

describe('ChunkMapper: tolerance', () => {
  it('ignores anything it does not recognise, and never throws', () => {
    const noise = [
      null, 42, 'text', [], {},
      { type: 'system', subtype: 'a-subtype-from-a-newer-claude' },
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'a-type-from-a-newer-claude', payload: { deep: true } },
      { type: 'stream_event', event: 7 },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } },
      { type: 'assistant' },
      { type: 'assistant', message: { content: [{ type: 'tool_use' }, 'junk', null] } },
      { type: 'user', message: 'plain text' },
      { type: 'user', message: { content: [{ type: 'tool_result' }, { type: 'text', text: 'x' }] } },
    ];

    expect(replay(noise)).toEqual({ chunks: [], end: undefined });
  });

  it('leaves subagent traffic out of the conversation', () => {
    const subagent = 'toolu_parent';
    const { chunks } = replay([
      { type: 'stream_event', parent_tool_use_id: subagent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'inner' } } },
      { type: 'assistant', parent_tool_use_id: subagent, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', parent_tool_use_id: subagent, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    ]);

    expect(chunks).toEqual([]);
  });

  it('announces a tool call once even when its message repeats', () => {
    const toolUse = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };

    expect(replay([toolUse, toolUse]).chunks).toHaveLength(1);
  });
});

describe('ChunkMapper: tool steps', () => {
  const callFor = (tool: string, input: unknown): ChatChunk | undefined =>
    replay([{ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', model: 'x', content: [{ type: 'tool_use', id: 't', name: tool, input }] } }]).chunks[0];

  it.each([
    ['Bash', { command: 'git status' }, 'Bash: git status'],
    ['Bash', { command: 'cd app\nnpm test' }, 'Bash: cd app'],
    ['Read', { file_path: '/a/b.ts' }, 'Read: /a/b.ts'],
    ['Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }, 'Edit: /a/b.ts'],
    ['Write', { file_path: '/a/c.ts', content: '' }, 'Write: /a/c.ts'],
    ['Grep', { pattern: 'TODO', path: 'src' }, 'Grep: TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'Glob: **/*.ts'],
    ['WebFetch', { url: 'https://example.com' }, 'WebFetch'],
    ['Bash', {}, 'Bash'],
  ])('labels %s %j as "%s"', (tool, input, summary) => {
    expect(callFor(tool, input)).toMatchObject({ kind: 'tool-call', tool, summary });
  });

  it('clips a long command to one short line', () => {
    const summary = callFor('Bash', { command: 'x'.repeat(500) });
    expect(summary).toMatchObject({ summary: `Bash: ${'x'.repeat(119)}…` });
  });

  const resultFor = (content: unknown, isError = false): ChatChunk | undefined =>
    replay([{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content, is_error: isError }] } }]).chunks[0];

  it('joins a result\'s text parts and leaves its images out', () => {
    expect(resultFor([{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }])).toEqual({
      kind: 'tool-result', callId: 't', ok: true, output: 'one\ntwo',
    });
  });

  it('bounds an enormous result and says how much was left out', () => {
    const output = resultFor('y'.repeat(31_000));
    expect(output).toEqual({
      kind: 'tool-result', callId: 't', ok: true,
      output: `${'y'.repeat(30_000)}\n… [1000 more characters not shown]`,
    });
  });

  it('gives a failed result without text a reason anyway', () => {
    expect(resultFor('', true)).toEqual({ kind: 'tool-result', callId: 't', ok: false, error: 'Tool execution failed' });
  });
});
