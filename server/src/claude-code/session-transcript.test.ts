import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../src/shared/transport/protocol.ts';
import { toMessages } from './session-transcript.ts';

/**
 * Real `getSessionMessages` output for one haiku session (see the fixture's
 * description): read before a `/compact` and again after it and one more turn.
 */
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/session-messages.json', import.meta.url), 'utf8'),
) as { preCompact: Record<string, unknown>[]; postCompact: Record<string, unknown>[] };

const at = (iso: string): number => Date.parse(iso);

describe('toMessages: a stored session before any compaction', () => {
  const messages = toMessages(recorded.preCompact);

  it('turns 18 stored entries into 8 messages: a turn is one assistant message, however many API messages it took', () => {
    expect(messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
    expect(messages.every((message) => message.historical === true)).toBe(true);
  });

  it('keeps a plain exchange as text, stamped with the stored time and the model that answered', () => {
    expect(messages[0]).toMatchObject({
      role: 'user',
      steps: [{ kind: 'text', text: 'Reply with exactly: pineapple-7' }],
      createdAt: at('2026-10-18T09:39:25.491Z'),
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      steps: [{ kind: 'text', text: 'pineapple-7' }],
      model: 'claude-haiku-5-5',
      createdAt: at('2026-10-18T09:39:26.582Z'),
    });
  });

  it('pairs each tool call with its result by tool_use_id, a failure included, and drops the empty thinking', () => {
    expect(messages[3]?.steps).toEqual([
      {
        kind: 'tool-call',
        callId: 'toolu_01LCmyk4EqPnXqxoA1t9GWQ3',
        tool: 'Bash',
        summary: 'Bash: echo fixture-ok',
        args: { command: 'echo fixture-ok', description: 'Print fixture-ok string' },
      },
      { kind: 'tool-result', callId: 'toolu_01LCmyk4EqPnXqxoA1t9GWQ3', ok: true, output: 'fixture-ok' },
      {
        kind: 'tool-call',
        callId: 'toolu_01Psob69gdoDzQf4tw1yXnbD',
        tool: 'Read',
        summary: 'Read: /home/example/projects/alpha/notes.txt',
        args: { file_path: '/home/example/projects/alpha/notes.txt' },
      },
      { kind: 'tool-result', callId: 'toolu_01Psob69gdoDzQf4tw1yXnbD', ok: true, output: '1\thello-from-notes\n2\t' },
      {
        kind: 'tool-call',
        callId: 'toolu_01BsEe3B1D284V3FHkxrZiec',
        tool: 'Read',
        summary: 'Read: /home/example/projects/alpha/missing-file.txt',
        args: { file_path: '/home/example/projects/alpha/missing-file.txt' },
      },
      {
        kind: 'tool-result',
        callId: 'toolu_01BsEe3B1D284V3FHkxrZiec',
        ok: false,
        error: 'File does not exist. Note: your current working directory is /home/example/projects/alpha.',
      },
      {
        kind: 'text',
        text: 'The `echo fixture-ok` command printed `fixture-ok`, `notes.txt` read as `hello-from-notes`, and `missing-file.txt` failed with "File does not exist."',
      },
    ]);
  });

  it('keeps summarized thinking ahead of the answer it led to', () => {
    expect(messages[5]?.steps).toEqual([
      {
        kind: 'thinking',
        text: "17*23 breaks down as 17*20 plus 17*3, which is 340 plus 51, giving 391. Since they just want the final number, I'll output 391.\n\n",
      },
      { kind: 'text', text: '391' },
    ]);
  });

  it('shows a prompt with an image as its text and then the image', () => {
    expect(messages[6]?.steps).toEqual([
      { kind: 'text', text: 'What colour is this image? One word.' },
      {
        kind: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      },
    ]);
    expect(messages[7]?.steps).toEqual([{ kind: 'text', text: 'Red' }]);
  });

  it('gives every message a distinct id', () => {
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });
});

describe('toMessages: a stored session after /compact', () => {
  const messages = toMessages(recorded.postCompact);

  it('marks the compaction without the summary text, after the command that caused it', () => {
    // The stored chain starts with the summary, but the compaction happened after the /compact that asked for it.
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[2]).toMatchObject({ role: 'assistant', historical: true, steps: [{ kind: 'compaction' }] });
    expect(JSON.stringify(messages)).not.toContain('This session is being continued');
  });

  it('drops the local-command echo and shows the command the owner typed', () => {
    const texts = messages.flatMap((message) =>
      message.steps.flatMap((step) => (step.kind === 'text' ? [step.text] : [])),
    );

    expect(texts).toEqual([
      'Red',
      '/compact',
      'What was the exact word I first asked you to reply with? Answer with just that word.',
      'pineapple-7',
    ]);
    expect(JSON.stringify(messages)).not.toContain('local-command');
  });

  it('keeps the turn that followed the compaction, answered from the summary', () => {
    expect(messages.at(-1)?.steps).toEqual([{ kind: 'text', text: 'pineapple-7' }]);
  });

  it('puts the marker where it happened by the stored times, past the messages the summary was kept ahead of', () => {
    const times = messages.map((message) => message.createdAt);

    expect(times[2]).toBe(at('2026-10-18T09:39:49.631Z'));
    expect(times.slice(0, 2).every((time) => time < (times[2] ?? 0))).toBe(true);
    expect(times.slice(3).every((time) => time > (times[2] ?? 0))).toBe(true);
  });

  it('leaves the marker where the chain put it when the times give no reason to move it', () => {
    const [summary, ...rest] = recorded.postCompact;
    const untimed = [summary, ...rest].map((entry) => bent(entry, { timestamp: undefined }));

    expect(toMessages(untimed).map((message) => message.steps[0]?.kind)).toEqual([
      'compaction', 'text', 'text', 'text', 'text',
    ]);
  });
});

/** One stored entry with some of its fields replaced: the real shape, bent. */
const bent = (entry: Record<string, unknown> | undefined, over: Record<string, unknown>): Record<string, unknown> => ({
  ...entry,
  ...over,
});

describe('toMessages: lossy is fine, wrong is not', () => {
  const [prompt, answer] = recorded.preCompact as [Record<string, unknown>, Record<string, unknown>];
  const call = recorded.preCompact[4];
  const result = recorded.preCompact[5];

  it('leaves out subagent traffic: entries that name a parent tool call', () => {
    const messages = toMessages([prompt, bent(answer, { parent_tool_use_id: 'toolu_parent' }), answer]);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('leaves out an entry written by a subagent, even one that does not name a parent tool call', () => {
    expect(toMessages([prompt, bent(answer, { parent_agent_id: 'agent-1' })])).toHaveLength(1);
  });

  it('skips entries it does not recognise or cannot read, and does not throw on them', () => {
    const messages = toMessages([
      null,
      42,
      'text',
      { type: 'progress', uuid: 'u1' },
      { type: 'user' },
      { type: 'assistant', message: 7 },
      bent(prompt, { message: { role: 'user', content: 12 } }),
      prompt,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.steps).toEqual([{ kind: 'text', text: 'Reply with exactly: pineapple-7' }]);
  });

  it('leaves out injected and non-human user messages, and the interruption marker', () => {
    const typed = (content: unknown, over: Record<string, unknown> = {}) =>
      bent(prompt, { message: { role: 'user', content }, ...over });

    const messages = toMessages([
      typed([{ type: 'text', text: 'hook context' }], { is_meta: true }),
      typed([{ type: 'text', text: 'from a peer' }], { origin: { kind: 'peer', from: 'someone' } }),
      typed([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      typed('<local-command-stdout>whatever</local-command-stdout>', { isCompletedLocalCommand: true }),
      typed([{ type: 'text', text: 'my own words' }], { origin: { kind: 'human' } }),
    ]);

    expect(messages.map((message) => message.steps)).toEqual([[{ kind: 'text', text: 'my own words' }]]);
  });

  it('leaves out a synthetic assistant message (Claude Code\'s own notices), not the model\'s words', () => {
    const synthetic = bent(answer, {
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
    });

    expect(toMessages([prompt, synthetic])).toHaveLength(1);
  });

  it('drops a tool result whose call it never saw, rather than attach it to the nearest message', () => {
    const messages = toMessages([prompt, answer, result]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.steps).toEqual([{ kind: 'text', text: 'pineapple-7' }]);
  });

  it('keeps a call whose result is missing (a turn still running, or cut short) as a call alone', () => {
    const messages = toMessages([prompt, call]);

    expect(messages[1]?.steps).toEqual([expect.objectContaining({ kind: 'tool-call', tool: 'Bash' })]);
  });

  it('puts a result straight after its own call even when the calls ran in parallel', () => {
    const second = recorded.preCompact[6];
    const secondResult = recorded.preCompact[7];
    const messages: ChatMessage[] = toMessages([prompt, call, second, secondResult, result]);

    expect(messages[1]?.steps.map((step) => ('callId' in step ? `${step.kind}:${step.callId}` : step.kind))).toEqual([
      'tool-call:toolu_01LCmyk4EqPnXqxoA1t9GWQ3',
      'tool-result:toolu_01LCmyk4EqPnXqxoA1t9GWQ3',
      'tool-call:toolu_01Psob69gdoDzQf4tw1yXnbD',
      'tool-result:toolu_01Psob69gdoDzQf4tw1yXnbD',
    ]);
  });

  it('gives a message with no readable time the time of the one before it, never NaN', () => {
    const messages = toMessages([prompt, bent(answer, { timestamp: 'not a date' })]);

    expect(messages[1]?.createdAt).toBe(at('2026-10-18T09:39:25.491Z'));
  });
});
