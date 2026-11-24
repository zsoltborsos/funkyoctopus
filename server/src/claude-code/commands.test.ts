import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HIDDEN_COMMANDS,
  SAVED_ROOTS_LIMIT,
  claudeCommands,
  lastKnownCommands,
  rememberCommands,
  type ClaudeCommandCache,
} from './commands.ts';

const row = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `${name} it`,
  argumentHint: '',
  ...over,
});

describe('claudeCommands', () => {
  it('offers each command as text, Claude Code’s own and the rest told apart, with hints and aliases', () => {
    expect(
      claudeCommands(
        [
          row('context', { builtin: true }),
          row('review', { argumentHint: '<pr>' }),
          row('config', { builtin: true, aliases: ['settings'] }),
        ],
        [],
      ),
    ).toEqual([
      { name: 'context', description: 'context it', source: 'claude-builtin', kind: 'text' },
      { name: 'review', description: 'review it', argumentHint: '<pr>', source: 'claude-custom', kind: 'text' },
      { name: 'config', description: 'config it', aliases: ['settings'], source: 'claude-builtin', kind: 'text' },
    ]);
  });

  it('hides every name on the documented list, and keeps rename', () => {
    const rows = [...CLAUDE_HIDDEN_COMMANDS, 'rename', 'compact'].map((name) => row(name, { builtin: true }));
    expect(claudeCommands(rows, []).map((command) => command.name)).toEqual(['rename', 'compact']);
    expect(CLAUDE_HIDDEN_COMMANDS).toEqual(
      expect.arrayContaining(['clear', 'new', 'reset', 'model', 'effort', 'usage', 'cost', 'stats', 'agents', 'schedule', 'ultrareview', 'batch', 'goal']),
    );
  });

  it('hides a row reachable by a hidden alias, the terminal-only ones, and the remote-workflow commands', () => {
    const rows = [
      row('wipe', { aliases: ['clear'] }),
      row('statusline', { builtin: true }),
      row('remote-workflow-run'),
      row('workflow-launch-x'),
      row('memory', { builtin: true }),
    ];
    expect(claudeCommands(rows, ['statusline']).map((command) => command.name)).toEqual(['memory']);
  });

  it('keeps one row per name: the one Claude Code marks as its own, which is the one /name runs', () => {
    const commands = claudeCommands(
      [row('review', { description: 'a plugin’s' }), row('review', { builtin: true, description: 'Claude Code’s' })],
      [],
    );
    expect(commands).toEqual([{ name: 'review', description: 'Claude Code’s', source: 'claude-builtin', kind: 'text' }]);
  });
});

describe('the last-known command lists', () => {
  it('serves a folder its own last list, else only Claude Code’s own from the latest folder, else nothing', () => {
    const cache: ClaudeCommandCache = { roots: [] };
    expect(lastKnownCommands(cache, '/a')).toBeNull();
    rememberCommands(cache, { root: '/a', commands: [row('context', { builtin: true }), row('deploy')], terminal: [] });
    expect(lastKnownCommands(cache, '/a')?.map((command) => command.name)).toEqual(['context', 'deploy']);
    expect(lastKnownCommands(cache, '/b')?.map((command) => command.name)).toEqual(['context']);
  });

  it('keeps the newest folder first, one entry per folder, at most the limit, and saves each change', () => {
    const saved: string[][] = [];
    const cache: ClaudeCommandCache = { roots: [], persist: (roots) => saved.push(roots.map((entry) => entry.root)) };
    for (let i = 0; i < SAVED_ROOTS_LIMIT + 2; i += 1) rememberCommands(cache, { root: `/r${i}`, commands: [], terminal: [] });
    rememberCommands(cache, { root: '/r5', commands: [row('x')], terminal: [] });
    expect(cache.roots).toHaveLength(SAVED_ROOTS_LIMIT);
    expect(cache.roots[0]?.root).toBe('/r5');
    expect(cache.roots.filter((entry) => entry.root === '/r5')).toHaveLength(1);
    expect(saved).toHaveLength(SAVED_ROOTS_LIMIT + 3);
  });
});
