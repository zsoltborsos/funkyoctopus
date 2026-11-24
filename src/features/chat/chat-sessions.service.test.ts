import { describe, expect, it, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import type { ConnectionState } from '@core/transport/transport-client.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { CHAT_CAP_REACHED, WireCallError } from '@shared/transport/errors.ts';
import type {
  ChatChunk,
  ChatOpenResult,
  ChatSessionInfo,
  ChatSlotInfo,
  ChatSlotsEvent,
  ChatTimelineItem,
  EngineKind,
} from '@shared/transport/protocol.ts';
import { TabFolders } from './tab-folders.ts';
import type { ChatOrchestrator } from './chat-orchestrator.client.ts';
import { ChatSession } from './chat-session.service.ts';
import { ChatSessions, ReviewNavigation, type ChatSessionsTransport } from './chat-sessions.service.ts';

const slot = (chatId: string, kind: EngineKind = 'pi', patch: Partial<ChatSlotInfo> = {}): ChatSlotInfo => ({
  chatId,
  kind,
  createdAt: chatId === 'main' ? 0 : 1,
  lastUsedAt: 0,
  crew: false,
  crewPending: false,
  busy: false,
  attention: false,
  session: null,
  root: null,
  subagentsLeftRunning: 0,
  ...patch,
});

const info = (engine: EngineKind, id: string, title = id): ChatSessionInfo => ({
  path: engine === 'claude-code' ? `claude-code:${id}` : `/sessions/2026_${id}.jsonl`,
  engine,
  id,
  cwd: '/work/fo',
  title,
  created: '',
  modified: '',
});

interface FakeTab {
  observe: Array<{ onChunk: (chunk: ChatChunk) => void }>;
  observeCancelled: number;
  sends: Array<{ onChunk: (c: ChatChunk) => void; onDone: () => void; onError: (m: string, code?: string) => void }>;
  opened: string[];
  openResult: ChatOpenResult;
}

/** What each tab's chat reads from the sidecar, set by the test (a restart changes it). */
interface SidecarChats {
  transcripts: Map<string, ChatTimelineItem[]>;
  current: Map<string, ChatSessionInfo | null>;
}

function harness(
  storage = new MemoryStorageAdapter(),
  options: { folders?: TabFolders; sidecar?: SidecarChats } = {},
) {
  /** What `chat.open` answers in tabs created from now on. */
  const opens: { next: ChatOpenResult } = { next: { items: [] } };
  const streams: Array<{ onChunk: (chunk: unknown) => void; onEnd: () => void; cancelled: boolean }> = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  const listeners = new Set<() => void>();
  let state: ConnectionState = 'open';
  const transport: ChatSessionsTransport & { setState(next: ConnectionState): void } = {
    call: ((method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      try {
        return Promise.resolve(answers.get(method)?.(params));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }) as ChatSessionsTransport['call'],
    stream: ((_method: string, _params: unknown, handlers: { onChunk: (c: unknown) => void; onEnd: () => void }) => {
      const entry = { ...handlers, cancelled: false };
      streams.push(entry);
      return () => {
        entry.cancelled = true;
      };
    }),
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (next) => {
      state = next;
      listeners.forEach((listener) => listener());
    },
  };
  const tabs = new Map<string, FakeTab>();
  const retained: string[][] = [];
  const store = new ChatSessions(
    transport,
    (chatId, hooks) => {
      const tab: FakeTab = { observe: [], observeCancelled: 0, sends: [], opened: [], openResult: opens.next };
      tabs.set(chatId, tab);
      const orchestrator = {
        chatId,
        transcript: () => Promise.resolve(options.sidecar?.transcripts.get(chatId) ?? []),
        listChats: () => Promise.resolve([]),
        currentChat: () => Promise.resolve(options.sidecar?.current.get(chatId) ?? null),
        observe: (handlers: { onChunk: (chunk: ChatChunk) => void }) => {
          tab.observe.push(handlers);
          return () => {
            tab.observeCancelled += 1;
          };
        },
        send: (_text: string, handlers: FakeTab['sends'][number]) => {
          tab.sends.push(handlers);
          return () => undefined;
        },
        openChat: (path: string) => {
          tab.opened.push(path);
          return Promise.resolve(tab.openResult);
        },
      } as unknown as ChatOrchestrator;
      // A tab follows the transport's reconnects when the test has a sidecar for it to re-read.
      const follows = options.sidecar ? transport : undefined;
      const session = new ChatSession(orchestrator, follows, `window-${chatId}`, undefined, hooks.focusHolder);
      return { session, scope: new Container() };
    },
    storage,
    [{ retain: (ids) => void retained.push([...ids]) }, ...(options.folders ? [options.folders] : [])],
  );
  const slotsStream = () => {
    const open = streams.filter((stream) => !stream.cancelled);
    const last = open.at(-1);
    if (!last) throw new Error('no slots stream');
    return last;
  };
  const emit = (event: ChatSlotsEvent) => slotsStream().onChunk(event);
  const view = (chatId: string) => store.getSnapshot().tabs.find((tab) => tab.chatId === chatId);
  return { store, transport, streams, calls, answers, tabs, retained, emit, view, opens };
}

describe('ChatSessions: the tab list follows the sidecar', () => {
  it('shows main before the slots arrive, then exactly the slots, main first', () => {
    const { store, emit } = harness();
    expect(store.getSnapshot()).toMatchObject({ ready: false, activeChatId: 'main' });
    expect(store.session('main')).toBeInstanceOf(ChatSession);

    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'claude-code')] });

    expect(store.getSnapshot().ready).toBe(true);
    expect(store.getSnapshot().tabs.map((tab) => [tab.chatId, tab.kind, tab.closable])).toEqual([
      ['main', 'pi', false],
      ['b', 'claude-code', true],
    ]);
  });

  it('adds a tab another window or fo created, live, without switching to it', () => {
    const { store, emit, view } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });

    emit({ kind: 'slot-created', slot: slot('c'), origin: 'cli:42' });

    expect(view('c')).toMatchObject({ chatId: 'c', title: 'untitled chat' });
    expect(store.getSnapshot().activeChatId).toBe('main');
  });

  it('drops a tab another window or fo closed, ending its streams; the active one falls back to its left neighbour', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b'), slot('c')] });
    store.activate('c');

    emit({ kind: 'slot-closed', chatId: 'c', origin: 'other-window' });

    expect(view('c')).toBeUndefined();
    expect(tabs.get('c')?.observeCancelled).toBe(1);
    expect(store.getSnapshot().activeChatId).toBe('b');
  });

  it('keeps titles, busy, crew and left-running subagents from slot state', () => {
    const { emit, view } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    emit({
      kind: 'slot-state',
      slot: slot('main', 'pi', { busy: true, crew: true, subagentsLeftRunning: 2, session: info('pi', 'x', 'fix the bar') }),
    });

    expect(view('main')).toMatchObject({ title: 'fix the bar', busy: true, crew: true, subagentsLeftRunning: 2 });
  });

  it('a restarted sidecar’s snapshot drops the tabs it lost, and the per-tab picks with them', () => {
    const { store, transport, emit, view, tabs, retained } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    store.activate('b');

    transport.setState('closed');
    transport.setState('open');
    emit({ kind: 'slots', slots: [slot('main', 'claude-code')] });

    expect(view('b')).toBeUndefined();
    expect(tabs.get('b')?.observeCancelled).toBe(1);
    expect(store.getSnapshot().activeChatId).toBe('main');
    expect(view('main')?.kind).toBe('claude-code');
    expect(retained.at(-1)).toEqual(['main']);
  });

  it('re-subscribes after a reconnect, ending the old stream', () => {
    const { transport, streams } = harness();
    expect(streams).toHaveLength(1);
    transport.setState('closed');
    transport.setState('open');
    expect(streams).toHaveLength(2);
    expect(streams[0]?.cancelled).toBe(true);
  });

  it('says why when a sidecar older than this page sends slots it cannot read, and recovers on a good snapshot', () => {
    const folders = new TabFolders(new MemoryStorageAdapter());
    const { store, emit } = harness(new MemoryStorageAdapter(), { folders });
    // A pre-T2.3 sidecar: its slots carry no root.
    const old = { ...slot('main', 'pi', { session: info('pi', 'm1') }), root: undefined } as unknown as ChatSlotInfo;

    emit({ kind: 'slots', slots: [old] });

    expect(store.getSnapshot()).toMatchObject({ ready: false, failure: expect.stringMatching(/tab list could not be read .*restart it/) });

    emit({ kind: 'slots', slots: [slot('main')] });
    expect(store.getSnapshot()).toMatchObject({ ready: true, failure: null });
  });

  it('says why when the sidecar refuses the slot stream, but not when the connection just dropped', () => {
    const { store, transport, streams } = harness();
    const end = (index: number) => streams[index]?.onEnd as (error?: { message: string }) => void;

    transport.setState('closed');
    end(0)({ message: 'Transport not connected' });
    expect(store.getSnapshot().failure).toBeNull();

    transport.setState('open');
    end(1)({ message: 'unknown method chat.slotsObserve' });
    expect(store.getSnapshot().failure).toMatch(/refused the tab list \(unknown method chat.slotsObserve\)/);
  });
});

describe('ChatSessions: what a tab shows about its chat', () => {
  it('marks a background tab unread when its turn ends, and clears it when the tab is shown', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    const observe = tabs.get('b')?.observe.at(-1);

    observe?.onChunk({ kind: 'turn-started', origin: 'cli:1' });
    observe?.onChunk({ kind: 'turn-ended', origin: 'cli:1' });

    expect(view('b')?.unread).toBe(true);
    store.activate('b');
    expect(view('b')?.unread).toBe(false);
  });

  it('marks a background tab unread when its turn fails, too', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    store.activate('b');
    store.session('b').send('long job');
    store.activate('main');
    tabs.get('b')?.sends.at(-1)?.onError('provider error');

    expect(view('b')?.unread).toBe(true);
  });

  it('never marks the tab being shown unread', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    store.session('main').send('hello');
    tabs.get('main')?.sends.at(-1)?.onDone();

    expect(view('main')?.unread).toBe(false);
  });

  it('marks a background tab unread when its own turn, sent from this window, ends there', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    store.activate('b');
    store.session('b').send('long job');
    store.activate('main');
    tabs.get('b')?.sends.at(-1)?.onDone();

    expect(view('b')?.unread).toBe(true);
  });

  it('shows attention for an approval waiting, from the sidecar’s slot state', () => {
    const { emit, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    emit({ kind: 'slot-state', slot: slot('b', 'pi', { attention: true, busy: true }) });
    expect(view('b')?.attention).toBe(true);

    emit({ kind: 'slot-state', slot: slot('b', 'pi', { attention: false, busy: true }) });
    expect(view('b')?.attention).toBe(false);
  });

  it('shows attention for a claude_live_elsewhere refusal until the tab’s next turn', () => {
    const { store, emit, tabs, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('c', 'claude-code')] });
    store.session('c').send('continue');
    tabs.get('c')?.sends.at(-1)?.onError('a Claude Code terminal holds this conversation', 'claude_live_elsewhere');

    expect(view('c')?.attention).toBe(true);
    store.session('c').send('again');
    expect(view('c')?.attention).toBe(false);
  });

  it('does not tell React about every streamed chunk: the tab list changes only when a tab does', () => {
    const { store, emit, tabs } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    store.session('main').send('hello');
    const heard = vi.fn();
    store.subscribe(heard);

    tabs.get('main')?.sends.at(-1)?.onChunk({ kind: 'text', delta: 'a' });
    tabs.get('main')?.sends.at(-1)?.onChunk({ kind: 'text', delta: 'b' });

    expect(heard).not.toHaveBeenCalled();
  });
});

describe('ChatSessions: switching tabs', () => {
  it('jumps by position (9 is the last) and cycles both ways, wrapping', () => {
    const { store, emit } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b'), slot('c')] });

    store.jump(2);
    expect(store.getSnapshot().activeChatId).toBe('b');
    store.jump(9);
    expect(store.getSnapshot().activeChatId).toBe('c');
    expect(store.jump(7)).toBe(false);
    store.cycle(1);
    expect(store.getSnapshot().activeChatId).toBe('main');
    store.cycle(-1);
    expect(store.getSnapshot().activeChatId).toBe('c');
  });

  it('remembers the shown tab across a reload, falling back to main when that tab is gone', () => {
    const storage = new MemoryStorageAdapter();
    const first = harness(storage);
    first.emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    first.store.activate('b');

    const reloaded = harness(storage);
    reloaded.emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    expect(reloaded.store.getSnapshot().activeChatId).toBe('b');

    const restarted = harness(storage);
    restarted.emit({ kind: 'slots', slots: [slot('main')] });
    expect(restarted.store.getSnapshot().activeChatId).toBe('main');
  });

  it('opening a conversation another tab holds switches to that tab', async () => {
    const { store, emit, tabs } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    const main = tabs.get('main');
    if (main) main.openResult = { heldBy: 'b' };

    await store.session('main').openChat('/sessions/2026_x.jsonl');

    expect(store.getSnapshot().activeChatId).toBe('b');
  });

  it('still says where it is open when the holder has no tab here', async () => {
    const { store, emit, tabs } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    const main = tabs.get('main');
    if (main) main.openResult = { heldBy: 'zz' };

    await expect(store.session('main').openChat('/sessions/2026_x.jsonl')).rejects.toThrow('open in chat zz');
    expect(store.getSnapshot().activeChatId).toBe('main');
  });
});

describe('ChatSessions: creating and closing tabs', () => {
  it('opens a tab of the chosen engine in the given folder, and shows it', async () => {
    const { store, emit, answers, calls, view } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    answers.set('chat.create', (params) => slot('n1', params.kind as EngineKind));

    await expect(store.create('claude-code', '/work/fo')).resolves.toBe('n1');

    expect(calls.find((call) => call.method === 'chat.create')?.params).toMatchObject({
      kind: 'claude-code',
      root: '/work/fo',
    });
    expect(view('n1')?.kind).toBe('claude-code');
    expect(store.getSnapshot().activeChatId).toBe('n1');
    // Its own slot-created event, arriving after, adds nothing twice.
    emit({ kind: 'slot-created', slot: slot('n1', 'claude-code'), origin: 'me' });
    expect(store.getSnapshot().tabs.map((tab) => tab.chatId)).toEqual(['main', 'n1']);
  });

  it('passes the cap refusal on as the sidecar words it', async () => {
    const { store, emit, answers } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    answers.set('chat.create', () => {
      throw new WireCallError('at most 8 chats can be open at once — close one first', CHAT_CAP_REACHED);
    });

    await expect(store.create('pi', null)).rejects.toThrow('at most 8 chats can be open at once — close one first');
    expect(store.getSnapshot().tabs).toHaveLength(1);
  });

  it('closes a tab everywhere, forcing only when asked; main is never closed', async () => {
    const { store, emit, calls, view } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b'), slot('c')] });

    await store.close('b');
    await store.close('c', { force: true });

    expect(calls.filter((call) => call.method === 'chat.close').map((call) => call.params)).toEqual([
      expect.objectContaining({ chatId: 'b' }),
      expect.objectContaining({ chatId: 'c', force: true }),
    ]);
    expect(calls[0]?.params).not.toHaveProperty('force');
    expect(view('b')).toBeUndefined();
    await expect(store.close('main')).rejects.toThrow('the main chat cannot be closed');
    expect(calls.filter((call) => call.method === 'chat.close')).toHaveLength(2);
  });
});

describe('ChatSessions: Helmraiser review in its chat', () => {
  it('focuses the tab holding the origin conversation', async () => {
    const { store, emit, calls } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'pi', { session: info('pi', 'origin') })] });

    await store.reviewInOrigin('/sessions/2026_origin.jsonl');

    expect(store.getSnapshot().activeChatId).toBe('b');
    expect(calls.some((call) => call.method === 'chat.create')).toBe(false);
  });

  it('opens it in a new tab of its engine when no tab holds it', async () => {
    const { store, emit, answers, calls, tabs } = harness();
    emit({ kind: 'slots', slots: [slot('main')] });
    answers.set('chat.create', (params) => slot('n2', params.kind as EngineKind));

    await store.reviewInOrigin('claude-code:abc');

    expect(calls.find((call) => call.method === 'chat.create')?.params).toMatchObject({ kind: 'claude-code' });
    expect(tabs.get('n2')?.opened).toEqual(['claude-code:abc']);
    expect(store.getSnapshot().activeChatId).toBe('n2');
  });

  it('a holder it did not know of yet wins: the new tab closes again and the holder is shown', async () => {
    const { store, emit, answers, calls, view, opens } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    answers.set('chat.create', (params) => slot('n3', params.kind as EngineKind));
    opens.next = { heldBy: 'b' };

    await store.reviewInOrigin('/sessions/2026_raced.jsonl');

    expect(store.getSnapshot().activeChatId).toBe('b');
    expect(calls.find((call) => call.method === 'chat.close')?.params).toMatchObject({ chatId: 'n3' });
    expect(view('n3')).toBeUndefined();
  });
});

describe('ChatSessions: one review navigation at a time, for the whole window', () => {
  it('holds one lock across every tab, released once', () => {
    const { store, emit } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    const heard = vi.fn();
    store.reviewNavigation.subscribe(heard);

    const release = store.reviewNavigation.tryAcquire();
    expect(release).not.toBeNull();
    store.activate('b');
    expect(store.reviewNavigation.isPending()).toBe(true);
    expect(store.reviewNavigation.tryAcquire()).toBeNull();

    release?.();
    release?.();
    expect(store.reviewNavigation.isPending()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(new ReviewNavigation().tryAcquire()).not.toBeNull();
  });

  it('says which tab a review in its chat showed, for the prompt to land in', async () => {
    const { store, emit, answers } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'pi', { session: info('pi', 'origin') })] });
    await expect(store.reviewInOrigin('/sessions/2026_origin.jsonl')).resolves.toBe('b');

    answers.set('chat.create', (params) => slot('n4', params.kind as EngineKind));
    await expect(store.reviewInOrigin('claude-code:zz')).resolves.toBe('n4');
  });
});

describe('ChatSessions: activity for the away digest', () => {
  it('hears every tab’s turn endings', () => {
    const { store, emit, tabs } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b')] });
    const heard: string[] = [];
    store.subscribeActivity((activity) => heard.push(activity.kind));

    tabs.get('b')?.observe.at(-1)?.onChunk({ kind: 'turn-ended', origin: 'cli:1' });
    store.session('main').send('x');
    tabs.get('main')?.sends.at(-1)?.onDone();

    expect(heard).toEqual(['turn-ended', 'turn-ended']);
  });
});

describe('ChatSessions: tab folders follow the sidecar’s slots (T2.3)', () => {
  it('a tab created elsewhere shows its real folder at once', () => {
    const folders = new TabFolders(new MemoryStorageAdapter());
    const { emit } = harness(new MemoryStorageAdapter(), { folders });
    emit({ kind: 'slots', slots: [slot('main')] });
    emit({ kind: 'slot-created', slot: slot('f1', 'pi', { root: '/work/fo' }), origin: 'cli:7' });

    expect(folders.forTab('f1').get()).toMatchObject({ id: '/work/fo', path: '/work/fo', name: 'fo' });
  });

  it('a Global root holding no session says nothing: main keeps its stored folder (the first T2.3 boot)', () => {
    const old = { id: '/old', name: 'old', path: '/old', envTier: 'normal' as const };
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.chat.tab-folders', { main: old });
    const folders = new TabFolders(storage);
    const { emit } = harness(new MemoryStorageAdapter(), { folders });
    emit({ kind: 'slots', slots: [slot('main')] });
    expect(folders.forTab('main').get()).toEqual(old);

    // A Global root that holds a session is where the chat is: followed.
    emit({ kind: 'slot-state', slot: slot('main', 'pi', { session: info('pi', 'g1') }) });
    expect(folders.forTab('main').get()).toBeNull();
  });

  it('an older slot state never undoes a folder the browser just picked; the sidecar catching up, or a later move, is followed', () => {
    let now = 1_000;
    const folders = new TabFolders(new MemoryStorageAdapter(), () => now);
    const { emit } = harness(new MemoryStorageAdapter(), { folders });
    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'claude-code', { root: '/work/old' })] });

    folders.forTab('b').set({ id: '/work/new', name: 'new', path: '/work/new', envTier: 'normal' });
    // Sent before the sidecar took the move in (Claude's setRoot still reading latestIn).
    emit({ kind: 'slot-state', slot: slot('b', 'claude-code', { root: '/work/old', busy: true }) });
    expect(folders.forTab('b').get()?.path).toBe('/work/new');

    emit({ kind: 'slot-state', slot: slot('b', 'claude-code', { root: '/work/new' }) });
    emit({ kind: 'slot-state', slot: slot('b', 'claude-code', { root: '/work/third' }) });
    expect(folders.forTab('b').get()?.path).toBe('/work/third');

    // A pick the sidecar never confirms (it failed) stops holding after a while.
    folders.forTab('b').set({ id: '/work/fails', name: 'fails', path: '/work/fails', envTier: 'normal' });
    emit({ kind: 'slot-state', slot: slot('b', 'claude-code', { root: '/work/third', busy: true }) });
    expect(folders.forTab('b').get()?.path).toBe('/work/fails');
    now += 16_000;
    emit({ kind: 'slot-state', slot: slot('b', 'claude-code', { root: '/work/third' }) });
    expect(folders.forTab('b').get()?.path).toBe('/work/third');
  });

  it('follows a folder switch made in another window, and keeps a known project’s own entry when it already matches', () => {
    const folders = new TabFolders(new MemoryStorageAdapter());
    const known = { id: '/work/fo', name: 'FunkyOctopus', path: '/work/fo', envTier: 'normal' as const };
    folders.forTab('b').set(known);
    const { emit } = harness(new MemoryStorageAdapter(), { folders });
    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'pi', { root: '/work/fo' })] });
    expect(folders.forTab('b').get()).toBe(known);

    emit({ kind: 'slot-state', slot: slot('b', 'pi', { root: '/work/other' }) });
    expect(folders.forTab('b').get()?.path).toBe('/work/other');
  });
});

describe('ChatSessions: a sidecar restart re-syncs without a reload (T2.3)', () => {
  const said = (id: string, text: string, createdAt: number): ChatTimelineItem => ({
    id,
    role: 'user',
    steps: [{ kind: 'text', text }],
    createdAt,
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('tabs, folders, transcripts and held sessions come back from the restored slots', async () => {
    const sidecar: SidecarChats = { transcripts: new Map(), current: new Map() };
    const folders = new TabFolders(new MemoryStorageAdapter());
    const { store, transport, emit, view } = harness(new MemoryStorageAdapter(), { folders, sidecar });
    emit({
      kind: 'slots',
      slots: [slot('main', 'pi', { root: '/work/fo' }), slot('b', 'claude-code', { root: '/work/b' })],
    });
    store.activate('b');
    // What the tabs show before the restart: stale against what the sidecar will restore.
    const before = [said('m1', 'before', 1)];
    sidecar.transcripts.set('b', before);

    // The sidecar restarts: the line drops and comes back, with no page reload.
    transport.setState('closed');
    const restoredB = info('claude-code', 'k1', 'restored chat');
    const restoredMain = info('pi', 'p1', 'main chat');
    sidecar.transcripts.set('b', [...before, said('m2', 'answered before the restart', 2)]);
    sidecar.transcripts.set('main', [said('p', 'main’s own', 1)]);
    sidecar.current.set('b', restoredB);
    sidecar.current.set('main', restoredMain);
    transport.setState('open');
    emit({
      kind: 'slots',
      slots: [
        slot('main', 'pi', { root: '/work/fo', session: restoredMain }),
        slot('b', 'claude-code', { root: '/work/b', session: restoredB }),
        // A tab `fo` made before the restart, which this window never saw.
        slot('c', 'pi', { root: '/work/c', createdAt: 2 }),
      ],
    });
    await settle();

    expect(store.getSnapshot().tabs.map((tab) => tab.chatId)).toEqual(['main', 'b', 'c']);
    expect(store.getSnapshot().activeChatId).toBe('b');
    expect(view('b')?.title).toBe('restored chat');
    expect(folders.forTab('c').get()?.path).toBe('/work/c');
    expect(folders.forTab('b').get()?.path).toBe('/work/b');
    expect(store.session('b').getSnapshot().messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(store.session('b').getSnapshot().activeSession).toEqual(restoredB);
    expect(store.session('main').getSnapshot().messages.map((message) => message.id)).toEqual(['p']);
  });
});

describe('ChatSessions: tabs closed elsewhere (the draft guard)', () => {
  it('keeps the tabs that went away without this window closing them, with their titles, until dismissed', async () => {
    const { store, emit } = harness();
    emit({ kind: 'slots', slots: [slot('main'), slot('b', 'pi', { session: info('pi', 'b1', 'second') }), slot('c'), slot('d')] });

    emit({ kind: 'slot-closed', chatId: 'b', origin: 'other-window' });
    await store.close('c');
    // The sidecar's own event for this window's close names this window.
    const self = (store as unknown as { clientId: string }).clientId;
    emit({ kind: 'slot-closed', chatId: 'c', origin: self });
    // A restarted sidecar that did not bring a tab back.
    emit({ kind: 'slots', slots: [slot('main')] });

    expect(store.getSnapshot().closedElsewhere).toEqual([
      { chatId: 'b', title: 'second' },
      { chatId: 'd', title: 'untitled chat' },
    ]);
    store.dismissClosed('b');
    expect(store.getSnapshot().closedElsewhere).toEqual([{ chatId: 'd', title: 'untitled chat' }]);
  });
});
