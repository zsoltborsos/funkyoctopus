import { describe, expect, it } from 'vitest';
import type { ChatTab } from '@features/chat/chat-sessions.service.ts';
import type { ChatSearchHit } from '@shared/transport/protocol.ts';
import {
  emphasise,
  filterEntries,
  storedEntries,
  storedHeading,
  storedQuery,
  switcherEntries,
} from './quick-switcher.ts';

const tab = (chatId: string, title: string, over: Partial<ChatTab> = {}): ChatTab => ({
  chatId,
  kind: 'pi',
  title,
  busy: false,
  attention: false,
  unread: false,
  crew: false,
  crewPending: false,
  subagentsLeftRunning: 0,
  closable: chatId !== 'main',
  ...over,
});

const entries = switcherEntries(
  'settings',
  [tab('main', 'Main chat'), tab('b', 'Fix the parser', { kind: 'claude-code' })],
  'b',
  (chatId) => (chatId === 'b' ? 'funkyoctopus' : 'Global'),
);
const names = (list: typeof entries): string[] =>
  list.map((entry) => (entry.kind === 'view' ? entry.label : entry.tab.title));

describe('switcher entries', () => {
  it('lists the four views, then the tabs, marking the current view and tab', () => {
    expect(names(entries)).toEqual([
      'Chat',
      'Helmraiser',
      'Prompts',
      'Settings',
      'Main chat',
      'Fix the parser',
    ]);
    expect(entries.filter((entry) => entry.current).map((entry) => entry.id)).toEqual([
      'view-settings',
      'tab-b',
    ]);
  });
});

describe('filtering', () => {
  it('shows everything for an empty or blank query', () => {
    expect(filterEntries(entries, '')).toHaveLength(6);
    expect(filterEntries(entries, '   ')).toHaveLength(6);
  });

  it('matches a view by its label and a tab by title, folder or engine, ignoring case', () => {
    expect(names(filterEntries(entries, 'HELM'))).toEqual(['Helmraiser']);
    expect(names(filterEntries(entries, 'parser'))).toEqual(['Fix the parser']);
    expect(names(filterEntries(entries, 'funky'))).toEqual(['Fix the parser']);
    expect(names(filterEntries(entries, 'global'))).toEqual(['Main chat']);
    expect(names(filterEntries(entries, 'claude'))).toEqual(['Fix the parser']);
  });

  it('wants every word, in any order', () => {
    expect(names(filterEntries(entries, 'parser fix'))).toEqual(['Fix the parser']);
    expect(filterEntries(entries, 'parser helmraiser')).toEqual([]);
  });
});

describe('stored-chat search', () => {
  const hit = (over: Partial<ChatSearchHit>): ChatSearchHit => ({
    path: '/home/example/.pi/agent/sessions/--work--/2026-10-01T10-00-00-000Z_abc.jsonl',
    engine: 'pi',
    id: 'abc',
    cwd: '/work/parser',
    title: 'Fix the parser',
    created: '2026-10-01T10:00:00.000Z',
    modified: '2026-10-01T10:30:00.000Z',
    snippet: 'the parser drops a token',
    ...over,
  });

  it('searches only for a trimmed query of three characters or more', () => {
    expect(storedQuery('')).toBeNull();
    expect(storedQuery('de')).toBeNull();
    expect(storedQuery('  de  ')).toBeNull();
    expect(storedQuery('dee')).toBe('dee');
    expect(storedQuery('  deepseek  ')).toBe('deepseek');
    expect(storedQuery('a b')).toBe('a b');
  });

  it('makes one entry per hit, keyed by engine and session id so a path with spaces is a safe element id', () => {
    const first = hit({});
    const second = hit({
      path: 'claude-code:9f1',
      engine: 'claude-code',
      id: '9f1',
      title: 'Spaces in /my dir/x',
    });
    expect(storedEntries([first, second])).toEqual([
      { kind: 'stored', id: 'stored-pi-abc', hit: first },
      { kind: 'stored', id: 'stored-claude-code-9f1', hit: second },
    ]);
  });

  it('counts the matches in the heading, and says how many are shown when the list is cut', () => {
    expect(storedHeading(87, 87)).toBe('Stored chats · 87');
    expect(storedHeading(1, 1)).toBe('Stored chats · 1');
    expect(storedHeading(87, 30)).toBe('Stored chats · showing 30 of 87');
  });

  it('splits a snippet into plain and matching parts, ignoring case, for every word of the query', () => {
    expect(emphasise('Use DeepSeek for the parser', 'deepseek parser')).toEqual([
      { text: 'Use ', match: false },
      { text: 'DeepSeek', match: true },
      { text: ' for the ', match: false },
      { text: 'parser', match: true },
    ]);
  });

  it('keeps a snippet whole when nothing in it matches, and treats regex characters as text', () => {
    expect(emphasise('nothing here', 'zzz')).toEqual([{ text: 'nothing here', match: false }]);
    expect(emphasise('a (b) and a.c', '(b) a.c')).toEqual([
      { text: 'a ', match: false },
      { text: '(b)', match: true },
      { text: ' and ', match: false },
      { text: 'a.c', match: true },
    ]);
    expect(emphasise('', 'abc')).toEqual([]);
  });
});
