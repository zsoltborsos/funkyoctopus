/**
 * The `/` palette's list from a Claude Code slot (T2.4b), and what a local
 * command prints reaching the turn. Over a scripted `claude`: nothing is
 * spawned, and no turn reaches a model.
 */
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { harness, send, textOf } from '../test/claude-chat-harness.ts';
import { turnFixture, type TurnFixture } from '../test/claude-fixtures.ts';

const command = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: '',
  argumentHint: '',
  ...over,
});

/** The recorded plain turn, its `system/init` naming terminal-only commands. */
function withTerminal(terminal: string[]): TurnFixture {
  const fixture = turnFixture('plain');
  return {
    ...fixture,
    messages: fixture.messages.map((m) =>
      m.type === 'system' && m.subtype === 'init' ? { ...m, terminal_slash_commands: terminal } : m,
    ),
  };
}

/** A local command's turn as the CLI plays one: `init`, what it printed, `result`, and no model call. */
function localCommand(printed: Record<string, unknown>[]): TurnFixture {
  const fixture = turnFixture('plain');
  const init = fixture.messages.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = fixture.messages.find((m) => m.type === 'result');
  if (!init || !result) throw new Error('the plain recording has no init or result');
  return { ...fixture, messages: [init, ...printed, result] };
}

const names = (listed: { commands: { name: string }[] }): string[] => listed.commands.map((c) => c.name);

describe('ClaudeCodeChat: the / commands', () => {
  it('with no process and nothing known, says so and starts nothing to ask', async () => {
    const { chat, fake } = harness([]);
    expect(await chat.commands()).toEqual({ commands: [], state: 'none' });
    expect(fake.queries).toHaveLength(0);
  });

  it('lists the live process’s commands once it runs, less the hidden ones', async () => {
    const { chat, fake } = harness(['plain']);
    fake.onStart = (query) => {
      query.commands = [
        command('context', { builtin: true }),
        command('clear', { builtin: true, aliases: ['reset', 'new'] }),
        command('usage', { builtin: true, aliases: ['cost', 'stats'] }),
        command('schedule', { builtin: true }),
        command('rename', { builtin: true }),
        command('deploy', { argumentHint: '<env>' }),
      ];
    };
    await send(chat, 'hello');

    const listed = await chat.commands();
    expect(listed.state).toBe('live');
    expect(names(listed)).toEqual(['context', 'rename', 'deploy']);
    expect(listed.commands.at(-1)).toEqual({ name: 'deploy', description: '', argumentHint: '<env>', source: 'claude-custom', kind: 'text' });
    expect(fake.queries[0]?.supportedCommandsAsked).toBe(1);
  });

  it('hides what the turn’s init names as terminal-only', async () => {
    const { chat, fake } = harness([withTerminal(['statusline', 'vim'])]);
    fake.onStart = (query) => {
      query.commands = [command('statusline', { builtin: true }), command('vim', { builtin: true }), command('context', { builtin: true })];
    };
    await send(chat, 'hello');
    expect(names(await chat.commands())).toEqual(['context']);
  });

  it('replaces the list when the process says its commands changed', async () => {
    const { chat, fake } = harness(['plain']);
    fake.onStart = (query) => {
      query.commands = [command('context', { builtin: true })];
    };
    await send(chat, 'hello');
    fake.queries[0]?.emit({
      type: 'system',
      subtype: 'commands_changed',
      commands: [command('context', { builtin: true }), command('skill-from-subdir')],
      uuid: 'u-1',
      session_id: 's-1',
    });
    await vi.waitFor(async () => expect(names(await chat.commands())).toEqual(['context', 'skill-from-subdir']));
  });

  it('keeps the last-known list when the process cannot list', async () => {
    const cache = { roots: [{ root: '/home/example/project', commands: [command('context', { builtin: true })], terminal: [] }] };
    const { chat, fake } = harness(['plain'], { commandCache: cache });
    fake.onStart = (query) => {
      query.commands = new Error('no answer');
    };
    await send(chat, 'hello');
    expect(await chat.commands()).toMatchObject({ state: 'last-known', commands: [{ name: 'context' }] });
  });

  it('shows what a local command printed as the turn’s text, and a notice banner; an info banner stays out', async () => {
    const { chat } = harness([
      localCommand([
        { type: 'system', subtype: 'local_command_output', content: 'Context: 12k of 200k tokens', uuid: 'u-2', session_id: 's-1' },
        { type: 'system', subtype: 'informational', content: 'Hook said hi', level: 'notice', uuid: 'u-3', session_id: 's-1' },
        { type: 'system', subtype: 'informational', content: 'verbose detail', level: 'info', uuid: 'u-4', session_id: 's-1' },
      ]),
    ]);
    const text = textOf(await send(chat, '/context'));
    expect(text).toContain('Context: 12k of 200k tokens');
    expect(text).toContain('Hook said hi');
    expect(text).not.toContain('verbose detail');
  });
});
