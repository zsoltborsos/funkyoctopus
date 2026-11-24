import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import type { ChatSearchHit, ChatSearchResult } from '@shared/transport/protocol.ts';
import { CHAT_SEARCH, type ChatSearchClient } from '@features/chat/chat-search.client.ts';
import {
  CHAT_SESSIONS,
  type ChatSessionsSnapshot,
  type ChatTab,
} from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import { QuickSwitcher } from './QuickSwitcher.tsx';
import { ShellProvider } from './ShellProvider.tsx';
import { useShell } from './useShell.ts';

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

/** The tab store as the switcher reads it: a snapshot, and `activate` showing a tab. */
class FakeTabs {
  snapshot: ChatSessionsSnapshot;
  readonly activated: string[] = [];
  /** Paths asked for through `reviewInOrigin`; each answer is the tab shown, or a refusal. */
  readonly reviewed: string[] = [];
  reviewAnswer: () => Promise<string> = () => Promise.resolve('main');
  private readonly listeners = new Set<() => void>();

  constructor(tabs: ChatTab[]) {
    this.snapshot = { tabs, activeChatId: 'main', ready: true, failure: null, closedElsewhere: [] };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ChatSessionsSnapshot => this.snapshot;
  activate = (chatId: string): boolean => {
    this.activated.push(chatId);
    this.publish({ activeChatId: chatId });
    return true;
  };
  reviewInOrigin = (path: string): Promise<string> => {
    this.reviewed.push(path);
    return this.reviewAnswer();
  };
  publish(change: Partial<ChatSessionsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
}

/** The sidecar's `chat.search` as the switcher asks it: each call waits for the test to answer it. */
class FakeSearch {
  readonly calls: {
    query: string;
    answer: (result: ChatSearchResult) => void;
    fail: (error: Error) => void;
  }[] = [];

  search = (query: string): Promise<ChatSearchResult> =>
    new Promise((answer, fail) => {
      this.calls.push({ query, answer, fail });
    });

  get queries(): string[] {
    return this.calls.map((call) => call.query);
  }
}

const hit = (over: Partial<ChatSearchHit> = {}): ChatSearchHit => ({
  path: '/home/example/.pi/agent/sessions/--work--/2026-10-01T10-00-00-000Z_s1.jsonl',
  engine: 'pi',
  id: 's1',
  cwd: '/work/personal/parser',
  title: 'Parser rewrite',
  created: '2026-10-01T10:00:00.000Z',
  modified: '2026-10-01T10:00:00.000Z',
  snippet: 'we chose a recursive descent parser',
  ...over,
});

/** What the shell shows right now, and a composer to hold focus. */
function Probe() {
  const { view, setView } = useShell();
  return (
    <>
      <div data-testid="shown">{view}</div>
      <button type="button" onClick={() => setView('settings')}>
        go to settings
      </button>
      <textarea aria-label="composer" />
    </>
  );
}

function setup(tabs: ChatTab[] = defaultTabs()) {
  const sessions = new FakeTabs(tabs);
  const search = new FakeSearch();
  const folders = new TabFolders(new MemoryStorageAdapter());
  folders
    .forTab('b')
    .set({ id: '/work/parser', name: 'parser-repo', path: '/work/parser', envTier: 'normal' });
  const container = new Container();
  container.registerInstance(CHAT_SESSIONS, sessions as never);
  container.registerInstance(TAB_FOLDERS, folders);
  container.registerInstance(CHAT_SEARCH, search as unknown as ChatSearchClient);
  render(
    <ContainerProvider container={container}>
      <ShellProvider>
        <Probe />
        <QuickSwitcher />
      </ShellProvider>
    </ContainerProvider>,
  );
  return { sessions, search, user: userEvent.setup() };
}

function defaultTabs(): ChatTab[] {
  return [
    tab('main', 'Main chat'),
    tab('b', 'Fix the parser', { kind: 'claude-code', busy: true }),
    tab('c', 'Review the diff', { attention: true }),
  ];
}

const CTRL_K = '{Control>}k{/Control}';
const shown = (): string | null => screen.getByTestId('shown').textContent;
const options = (): string[] => screen.getAllByRole('option').map((o) => o.textContent ?? '');
const dialog = () => screen.queryByRole('dialog');

afterEach(() => vi.restoreAllMocks());

describe('QuickSwitcher', () => {
  it('opens on Ctrl+K from the chat view, taking the key from the browser', async () => {
    const { user } = setup();
    const composer = screen.getByLabelText('composer');
    await user.click(composer);

    // `fireEvent` answers false when the default was prevented.
    expect(fireEvent.keyDown(composer, { key: 'k', code: 'KeyK', ctrlKey: true })).toBe(false);

    const box = screen.getByRole('dialog', { name: 'Switcher' });
    const filter = within(box).getByRole('combobox', { name: 'Jump to a view or chat tab' });
    expect(filter).toHaveFocus();
    expect(filter).toHaveAttribute('aria-controls', within(box).getByRole('listbox').id);
  });

  it('opens on Ctrl+K from another view', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'go to settings' }));
    expect(shown()).toBe('settings');

    await user.keyboard(CTRL_K);
    expect(dialog()).toBeInTheDocument();
    expect(shown()).toBe('settings');
  });

  it('lists the four views and the open tabs, marking the current ones, with tab facts', async () => {
    const { user } = setup();
    await user.keyboard(CTRL_K);

    const views = screen.getByRole('group', { name: 'Views' });
    expect(
      within(views)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['›_Chatcurrent', '⧉Helmraiser', '❯Prompts', '⚙Settings']);
    expect(within(views).getByRole('option', { current: true })).toHaveTextContent('Chat');

    const tabs = screen.getByRole('group', { name: 'Tabs' });
    expect(within(tabs).getAllByRole('option')).toHaveLength(3);
    const main = within(tabs).getByRole('option', { name: /^Main chat/ });
    expect(main).toHaveAttribute('aria-current', 'true');
    expect(main).toHaveTextContent('πMain chatGlobalcurrent');
    // Engine glyph, folder, and the busy / attention markers the tab bar draws.
    const busy = within(tabs).getByRole('option', { name: /^Fix the parser/ });
    expect(busy).toHaveAccessibleName('Fix the parser — Claude, turn running, parser-repo');
    expect(busy).toHaveTextContent('✻Fix the parserparser-repo');
    expect(within(tabs).getByRole('option', { name: /^Review the diff/ })).toHaveAccessibleName(
      'Review the diff — pi, needs you, Global',
    );
    expect(within(tabs).getByText('!')).toBeInTheDocument();
  });

  it('marks the current view when it is not chat', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'go to settings' }));
    await user.keyboard(CTRL_K);
    expect(screen.getByRole('option', { name: /Settings/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Chat' })).not.toHaveAttribute('aria-current');
  });

  it('filters by view label, tab title, folder and engine, and says when nothing matches', async () => {
    const { user } = setup();
    await user.keyboard(CTRL_K);
    const filter = screen.getByRole('combobox');

    await user.type(filter, 'HELM');
    expect(options()).toEqual(['⧉Helmraiser']);
    expect(screen.queryByRole('group', { name: 'Tabs' })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'parser');
    expect(options()).toEqual(['✻Fix the parserparser-repo']);
    expect(screen.queryByRole('group', { name: 'Views' })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'claude');
    expect(options()).toEqual(['✻Fix the parserparser-repo']);

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing matches “zzz”.');
    // Enter with nothing to jump to leaves it open.
    await user.keyboard('{Enter}');
    expect(dialog()).toBeInTheDocument();

    await user.clear(filter);
    expect(screen.getAllByRole('option')).toHaveLength(7);
  });

  it('walks the list with the arrows, wrapping, and Enter jumps to a view', async () => {
    const { user } = setup();
    await user.keyboard(CTRL_K);
    const filter = screen.getByRole('combobox');
    const selected = () => screen.getByRole('option', { selected: true });
    expect(selected()).toHaveTextContent('Chat');
    expect(filter).toHaveAttribute('aria-activedescendant', selected().id);

    await user.keyboard('{ArrowDown}');
    expect(selected()).toHaveTextContent('Helmraiser');
    expect(filter).toHaveAttribute('aria-activedescendant', selected().id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected()).toHaveTextContent('Review the diff');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(selected()).toHaveTextContent('Helmraiser');

    await user.keyboard('{Enter}');
    expect(shown()).toBe('jobs');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('jumps to a tab from another view: chat is shown, and that tab is the active one', async () => {
    const { user, sessions } = setup();
    await user.click(screen.getByRole('button', { name: 'go to settings' }));
    await user.keyboard(CTRL_K);
    await user.type(screen.getByRole('combobox'), 'parser');
    await user.keyboard('{Enter}');

    expect(sessions.activated).toEqual(['b']);
    expect(sessions.getSnapshot().activeChatId).toBe('b');
    expect(shown()).toBe('chat');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('marks the tab it jumped to as the current one', async () => {
    const { user, sessions } = setup();
    await user.keyboard(CTRL_K);
    await user.type(screen.getByRole('combobox'), 'review');
    await user.keyboard('{Enter}');
    expect(sessions.getSnapshot().activeChatId).toBe('c');

    await user.keyboard(CTRL_K);
    expect(
      screen.getByRole('option', { current: true, name: /^Review the diff/ }),
    ).toBeInTheDocument();
  });

  it('jumps on a click, and a hover moves the highlight', async () => {
    const { user, sessions } = setup();
    await user.keyboard(CTRL_K);
    await user.hover(screen.getByRole('option', { name: /Prompts/ }));
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Prompts');

    await user.click(screen.getByRole('option', { name: /^Fix the parser/ }));
    expect(sessions.activated).toEqual(['b']);
    expect(shown()).toBe('chat');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('closes on Esc and puts focus back where it was, without the chat view hearing the Esc', async () => {
    const { user } = setup();
    const composer = screen.getByLabelText('composer');
    await user.click(composer);
    await user.keyboard(CTRL_K);
    expect(screen.getByRole('combobox')).toHaveFocus();

    // The chat view stops a turn on a bare Esc it finds unhandled, on the window.
    const reached: boolean[] = [];
    const window_ = (e: KeyboardEvent) => reached.push(e.defaultPrevented);
    window.addEventListener('keydown', window_);
    await user.keyboard('{Escape}');
    window.removeEventListener('keydown', window_);

    expect(dialog()).not.toBeInTheDocument();
    expect(composer).toHaveFocus();
    expect(reached).toEqual([true]);
    expect(shown()).toBe('chat');
  });

  it('closes on a click outside, and on Ctrl+K again, restoring focus', async () => {
    const { user } = setup();
    const composer = screen.getByLabelText('composer');
    await user.click(composer);
    await user.keyboard(CTRL_K);

    // The backdrop sits before the panel; a press there is "outside".
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    expect(backdrop).not.toBeNull();
    await user.pointer({ keys: '[MouseLeft]', target: backdrop as Element });
    expect(dialog()).not.toBeInTheDocument();
    expect(composer).toHaveFocus();

    await user.keyboard(CTRL_K);
    expect(dialog()).toBeInTheDocument();
    await user.keyboard(CTRL_K);
    expect(dialog()).not.toBeInTheDocument();
    expect(composer).toHaveFocus();
  });

  it('after a jump within chat, focus goes back to the composer; after a jump to another view, to nowhere old', async () => {
    const { user } = setup();
    const composer = screen.getByLabelText('composer');
    await user.click(composer);
    await user.keyboard(CTRL_K);
    await user.type(screen.getByRole('combobox'), 'parser{Enter}');
    expect(composer).toHaveFocus();

    // The button that opened Settings must not keep a ring once Chat is picked.
    const toSettings = screen.getByRole('button', { name: 'go to settings' });
    await user.click(toSettings);
    await user.keyboard(CTRL_K);
    await user.type(screen.getByRole('combobox'), 'chat{Enter}');
    expect(shown()).toBe('chat');
    expect(toSettings).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('keeps focus on the filter when Tab is pressed', async () => {
    const { user } = setup();
    await user.keyboard(CTRL_K);
    await user.tab();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('follows the tab list while open', async () => {
    const { user, sessions } = setup([tab('main', 'Main chat')]);
    await user.keyboard(CTRL_K);
    expect(screen.getAllByRole('option')).toHaveLength(5);

    act(() => sessions.publish({ tabs: [...sessions.snapshot.tabs, tab('z', 'Late tab')] }));
    expect(screen.getByRole('option', { name: /^Late tab/ })).toBeInTheDocument();
  });
});

describe('QuickSwitcher stored chats', () => {
  const NOW = '2026-10-19T12:00:00.000Z';
  const hoursAgo = (hours: number): string =>
    new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = (): boolean =>
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
  const type = (value: string): boolean =>
    fireEvent.change(screen.getByRole('combobox'), { target: { value } });
  /** Let time pass, and the promises it settles. */
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  /** Make a change (an answer, a key), and let the promises it settles run. */
  const settle = (change: () => void) =>
    act(async () => {
      change();
      await vi.advanceTimersByTimeAsync(0);
    });

  it('asks the sidecar once typing pauses for 250 ms: never on open, never under three characters', async () => {
    const { search } = setup();
    open();
    await wait(1000);
    expect(search.queries).toEqual([]);

    type('de');
    await wait(1000);
    expect(search.queries).toEqual([]);

    type('  deepseek  ');
    await wait(249);
    expect(search.queries).toEqual([]);
    await wait(1);
    expect(search.queries).toEqual(['deepseek']);
  });

  it('says it is searching while the call is out, then lists the chats below the tabs: glyph, title, folder, age, snippet', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    expect(screen.getByRole('status')).toHaveTextContent('searching stored chats…');

    await settle(() => {
      search.calls[0]?.answer({
        hits: [
          hit({ modified: hoursAgo(3) }),
          hit({
            path: 'claude-code:c9',
            engine: 'claude-code',
            id: 'c9',
            cwd: '/work/lexer',
            title: 'Fix the lexer',
            modified: hoursAgo(50),
            snippet: 'the lexer skips a tab',
          }),
        ],
        total: 2,
        searched: 1301,
      });
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const stored = screen.getByRole('group', { name: 'Stored chats · 2' });
    expect(within(stored).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'πParser rewritepersonal/parser3hwe chose a recursive descent parser',
      '✻Fix the lexerwork/lexer2dthe lexer skips a tab',
    ]);
    // Below the tab that matched, not among the views.
    expect(screen.getByRole('group', { name: 'Tabs' }).nextElementSibling).toBe(stored);
  });

  const result = (...titles: string[]): ChatSearchResult => ({
    hits: titles.map((title) => hit({ id: title, path: `claude-code:${title}`, title })),
    total: titles.length,
    searched: 1301,
  });
  const storedTitles = (): string[] =>
    screen
      .queryAllByRole('option')
      .filter((o) => o.id.includes('stored-'))
      .map((o) => o.textContent ?? '');

  it('sends one call for fast typing: each key restarts the pause', async () => {
    const { search } = setup();
    open();
    type('dee');
    await wait(200);
    type('deep');
    await wait(200);
    type('deeps');
    await wait(249);
    expect(search.queries).toEqual([]);
    await wait(1);
    expect(search.queries).toEqual(['deeps']);
  });

  it('ignores the answer to an older query, whether the newer one is out or already answered', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    type('parser rewrite');
    await wait(250);
    expect(search.queries).toEqual(['parser', 'parser rewrite']);

    await settle(() => search.calls[0]?.answer(result('Old answer')));
    expect(storedTitles()).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('searching stored chats…');

    await settle(() => search.calls[1]?.answer(result('New answer')));
    expect(storedTitles()).toHaveLength(1);
    expect(storedTitles()[0]).toContain('New answer');

    await settle(() => search.calls[0]?.answer(result('Old answer')));
    expect(storedTitles()).toHaveLength(1);
    expect(storedTitles()[0]).toContain('New answer');
  });

  it('keeps the rows it has while a refined query is out, then swaps them for the new answer', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() => search.calls[0]?.answer(result('First rows')));

    type('parser rewrite');
    expect(storedTitles()[0]).toContain('First rows');
    expect(screen.getByRole('status')).toHaveTextContent('searching stored chats…');
    await wait(250);
    expect(storedTitles()[0]).toContain('First rows');
    expect(screen.getByRole('status')).toHaveTextContent('searching stored chats…');

    await settle(() => search.calls[1]?.answer(result('Second rows')));
    expect(storedTitles()).toHaveLength(1);
    expect(storedTitles()[0]).toContain('Second rows');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('drops the section when the query gets short again, sends nothing, and starts clean on the next one', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() => search.calls[0]?.answer(result('First rows')));
    expect(storedTitles()).toHaveLength(1);

    type('pa');
    expect(screen.queryByRole('group', { name: /^Stored chats/ })).not.toBeInTheDocument();
    await wait(1000);
    expect(search.queries).toEqual(['parser']);

    type('lexer');
    expect(storedTitles()).toEqual([]);
    expect(screen.queryByRole('status')).toHaveTextContent('Nothing matches “lexer”.');
  });

  it('says so when no stored chat matches, in place of the old line about nothing matching', async () => {
    const { search } = setup();
    open();
    type('zzz');
    await wait(250);
    await settle(() => search.calls[0]?.answer({ hits: [], total: 0, searched: 1301 }));

    expect(screen.getByRole('status')).toHaveTextContent('no stored chat matches');
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Stored chats/ })).not.toBeInTheDocument();
  });

  it('shows a failed search in place, drops the rows, and leaves the switcher usable', async () => {
    const { search, sessions } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() => search.calls[0]?.fail(new Error('the index could not be read')));

    expect(screen.getByRole('alert')).toHaveTextContent('the index could not be read');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(storedTitles()).toEqual([]);

    // The tab that matches the filter is still there to jump to.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(sessions.activated).toEqual(['b']);
    expect(dialog()).not.toBeInTheDocument();
  });

  it('clears the error when the query changes', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() => search.calls[0]?.fail(new Error('boom')));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    type('parser rewrite');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await wait(250);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('searching stored chats…');
  });

  /** Ctrl+K, a query that the tab "Fix the parser" and two stored chats answer. */
  async function withStoredChats(from: 'chat' | 'settings' = 'chat') {
    const env = setup();
    if (from === 'settings') {
      const toSettings = screen.getByRole('button', { name: 'go to settings' });
      fireEvent.click(toSettings);
      toSettings.focus();
    } else {
      screen.getByLabelText('composer').focus();
    }
    open();
    type('parser');
    await wait(250);
    await settle(() => env.search.calls[0]?.answer(result('Parser rewrite', 'Lexer notes')));
    return env;
  }
  const key = (name: string): boolean =>
    fireEvent.keyDown(screen.getByRole('combobox'), { key: name });
  const selected = (): HTMLElement => screen.getByRole('option', { selected: true });

  it('lets the arrows walk from the tabs into the stored chats and wrap round', async () => {
    await withStoredChats();
    const filter = screen.getByRole('combobox');
    expect(selected()).toHaveTextContent('Fix the parser');

    key('ArrowDown');
    expect(selected()).toHaveTextContent('Parser rewrite');
    expect(filter).toHaveAttribute('aria-activedescendant', selected().id);
    key('ArrowDown');
    expect(selected()).toHaveTextContent('Lexer notes');
    key('ArrowDown');
    expect(selected()).toHaveTextContent('Fix the parser');
    key('ArrowUp');
    expect(selected()).toHaveTextContent('Lexer notes');
  });

  it('opens the stored chat on Enter through reviewInOrigin, then shows chat and closes', async () => {
    const { sessions } = await withStoredChats('settings');
    let finish!: (chatId: string) => void;
    sessions.reviewAnswer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');

    expect(sessions.reviewed).toEqual(['claude-code:Lexer notes']);
    // Not before the sidecar has answered.
    expect(dialog()).toBeInTheDocument();
    expect(shown()).toBe('settings');

    await settle(() => finish('c2'));
    expect(dialog()).not.toBeInTheDocument();
    expect(shown()).toBe('chat');
    expect(sessions.activated).toEqual([]);
    // The button that opened Settings must not keep a ring once Chat is shown.
    expect(screen.getByRole('button', { name: 'go to settings' })).not.toHaveFocus();
  });

  it('opens the stored chat on a click, and focus goes back to the composer when the switcher opened over chat', async () => {
    const { sessions } = await withStoredChats();
    await settle(() => fireEvent.click(screen.getByRole('option', { name: /Parser rewrite/ })));

    expect(sessions.reviewed).toEqual(['claude-code:Parser rewrite']);
    expect(dialog()).not.toBeInTheDocument();
    expect(shown()).toBe('chat');
    expect(screen.getByLabelText('composer')).toHaveFocus();
  });

  it('keeps the switcher open and says why when the sidecar refuses, and lets the owner try again', async () => {
    const { sessions } = await withStoredChats('settings');
    sessions.reviewAnswer = () => Promise.reject(new Error('that session is outside the store'));
    key('ArrowDown');
    await settle(() => key('Enter'));

    expect(screen.getByRole('alert')).toHaveTextContent('that session is outside the store');
    expect(dialog()).toBeInTheDocument();
    expect(shown()).toBe('settings');

    sessions.reviewAnswer = () => Promise.resolve('c2');
    await settle(() => key('Enter'));
    expect(sessions.reviewed).toHaveLength(2);
    expect(dialog()).not.toBeInTheDocument();
    expect(shown()).toBe('chat');
  });

  it('clears a refusal when the query changes', async () => {
    const { sessions } = await withStoredChats();
    sessions.reviewAnswer = () => Promise.reject(new Error('refused'));
    key('ArrowDown');
    await settle(() => key('Enter'));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    type('parse');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens a chat once however often Enter is pressed while the sidecar is answering', async () => {
    const { sessions } = await withStoredChats();
    let finish!: (chatId: string) => void;
    sessions.reviewAnswer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    key('ArrowDown');
    key('Enter');
    key('Enter');
    expect(sessions.reviewed).toHaveLength(1);
    await settle(() => finish('c2'));
    expect(dialog()).not.toBeInTheDocument();
  });

  it('says how many are shown of how many matched when the sidecar cut the list', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() => search.calls[0]?.answer({ ...result('One', 'Two'), total: 87 }));

    expect(screen.getByRole('group', { name: 'Stored chats · showing 2 of 87' })).toBeInTheDocument();
  });

  it('reads a row dimmer when its folder is gone, and names the engine, folder and age', async () => {
    const { search } = setup();
    open();
    type('parser');
    await wait(250);
    await settle(() =>
      search.calls[0]?.answer({
        hits: [
          hit({ modified: hoursAgo(3) }),
          hit({
            path: 'claude-code:g1',
            engine: 'claude-code',
            id: 'g1',
            title: 'Old chat',
            cwd: '/dead/folder',
            folderGone: true,
            modified: hoursAgo(1),
          }),
        ],
        total: 2,
        searched: 10,
      }),
    );

    const live = screen.getByRole('option', { name: 'Parser rewrite — pi, personal/parser, 3h' });
    expect(live).not.toHaveClass('opacity-60');
    expect(live).toHaveAccessibleDescription('we chose a recursive descent parser');
    const gone = screen.getByRole('option', {
      name: 'Old chat — Claude, dead/folder, 1h, folder gone',
    });
    expect(gone).toHaveClass('opacity-60');
  });

  it('emphasises the query’s words in the snippet', async () => {
    const { search } = setup();
    open();
    type('Recursive PARSER');
    await wait(250);
    await settle(() => search.calls[0]?.answer(result('Parser rewrite')));

    const row = screen.getByRole('option', { name: /Parser rewrite/ });
    expect([...row.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'recursive',
      'parser',
    ]);
    expect(row).toHaveTextContent('we chose a recursive descent parser');
  });
});
