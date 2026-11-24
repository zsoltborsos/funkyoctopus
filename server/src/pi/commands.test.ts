import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { PI_BUILTINS, piCommands } from './commands.ts';

/** The three reads `piCommands` makes, scripted. */
function listing({
  extensions = [] as { invocationName: string; description?: string }[],
  templates = [] as { name: string; description: string; argumentHint?: string }[],
  skills = [] as { name: string; description: string }[],
} = {}) {
  return {
    extensionRunner: { getRegisteredCommands: () => extensions },
    promptTemplates: templates,
    resourceLoader: { getSkills: () => ({ skills, diagnostics: [] }) },
  } as unknown as Pick<AgentSession, 'extensionRunner' | 'promptTemplates' | 'resourceLoader'>;
}

describe('piCommands', () => {
  it('lists FO built-ins first, then extension commands, templates and skills', () => {
    const commands = piCommands(
      listing({
        extensions: [{ invocationName: 'todos', description: 'Show todos' }, { invocationName: 'bare' }],
        templates: [{ name: 'review', description: 'Review a diff', argumentHint: '<ref>' }],
        skills: [{ name: 'tdd', description: 'Test first' }],
      }),
    );
    expect(commands).toEqual([
      ...PI_BUILTINS,
      { name: 'todos', description: 'Show todos', source: 'extension', kind: 'text' },
      { name: 'bare', description: '', source: 'extension', kind: 'text' },
      { name: 'review', description: 'Review a diff', argumentHint: '<ref>', source: 'template', kind: 'text' },
      { name: 'skill:tdd', description: 'Test first', source: 'skill', kind: 'text' },
    ]);
  });

  it('offers compact and rename as actions, rename also under pi’s own name', () => {
    expect(PI_BUILTINS.map(({ name, kind, aliases }) => ({ name, kind, aliases }))).toEqual([
      { name: 'compact', kind: 'action', aliases: undefined },
      { name: 'rename', kind: 'action', aliases: ['name'] },
    ]);
  });

  it('keeps one row per name: a built-in wins, then the first source that has it', () => {
    const commands = piCommands(
      listing({
        extensions: [{ invocationName: 'compact', description: 'an extension’s compact' }],
        templates: [
          { name: 'name', description: 'a template called name' },
          { name: 'review', description: 'first' },
          { name: 'review', description: 'second' },
        ],
      }),
    );
    expect(commands.map((command) => `${command.source}:${command.name}`)).toEqual([
      'builtin:compact',
      'builtin:rename',
      'template:review',
    ]);
    expect(commands.find((command) => command.name === 'review')?.description).toBe('first');
  });
});
