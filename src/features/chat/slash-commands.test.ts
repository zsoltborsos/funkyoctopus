import { describe, expect, it } from 'vitest';
import type { ChatCommand } from '@shared/transport/protocol.ts';
import { actionFor, filterCommands, slashQuery } from './slash-commands.ts';

const text = (name: string, aliases?: string[]): ChatCommand => ({
  name,
  description: '',
  source: 'claude-builtin',
  kind: 'text',
  ...(aliases ? { aliases } : {}),
});
const COMPACT: ChatCommand = { name: 'compact', description: '', source: 'builtin', kind: 'action' };
const RENAME: ChatCommand = { name: 'rename', description: '', aliases: ['name'], source: 'builtin', kind: 'action' };

describe('slashQuery', () => {
  it('is what follows the / while a command is being named', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/rev')).toBe('rev');
    expect(slashQuery('/skill:td')).toBe('skill:td');
  });

  it('is null once arguments start, over more than one line, or without a leading /', () => {
    expect(slashQuery('/review ')).toBeNull();
    expect(slashQuery('/a\nb')).toBeNull();
    expect(slashQuery('see /review')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });
});

describe('filterCommands', () => {
  const commands = [text('context'), text('review'), text('pr-comments'), text('config', ['settings'])];

  it('lists everything for an empty query', () => {
    expect(filterCommands(commands, '')).toEqual(commands);
  });

  it('puts names that start with the query first, then ones that hold it, any case, aliases included', () => {
    expect(filterCommands(commands, 'CO').map((c) => c.name)).toEqual(['context', 'config', 'pr-comments']);
    expect(filterCommands(commands, 'sett').map((c) => c.name)).toEqual(['config']);
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });
});

describe('actionFor', () => {
  const commands = [COMPACT, RENAME, text('context')];

  it('finds FO’s own action by name or alias, with its arguments', () => {
    expect(actionFor('/compact', commands)).toEqual({ command: COMPACT, args: '' });
    expect(actionFor('/compact keep the API notes\nand tests', commands)).toEqual({
      command: COMPACT,
      args: 'keep the API notes\nand tests',
    });
    expect(actionFor('  /name Palette  ', commands)).toEqual({ command: RENAME, args: 'Palette' });
  });

  it('leaves a text command, or anything else, to be sent', () => {
    expect(actionFor('/context', commands)).toBeNull();
    expect(actionFor('/compactx', commands)).toBeNull();
    expect(actionFor('please /compact', commands)).toBeNull();
  });
});
