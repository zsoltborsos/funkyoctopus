import { describe, expect, it } from 'vitest';
import { useEffect, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import type { ConnectionState, StreamHandlers } from '@core/transport/transport-client.ts';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { CHAT_CAP_REACHED, WireCallError } from '@shared/transport/errors.ts';
import type {
  ChatSessionInfo,
  ChatSlotInfo,
  ChatSlotsEvent,
  ChatTimelineItem,
  EngineKind,
  ModelOption,
} from '@shared/transport/protocol.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { PROMPT_LIBRARY, PromptLibraryService } from '@features/prompts/prompt-library.service.ts';
import { ActiveChatScope } from './ActiveChatScope.tsx';
import { AWAY_DIGEST, type AwayDigest } from './away-digest.ts';
import { CHAT_ATTENTION_NOTIFICATIONS, ChatAttentionNotifications } from './chat-attention-notifications.service.ts';
import { CHAT_ORCHESTRATOR, ChatOrchestrator } from './chat-orchestrator.client.ts';
import { CHAT_SESSION, ChatSession } from './chat-session.service.ts';
import { CHAT_SESSIONS, ChatSessions } from './chat-sessions.service.ts';
import { ChatView } from './ChatView.tsx';
import { INPUT_HISTORY, InputHistoryService } from './input-history.ts';
import { MODELS, ModelsClient } from './models.client.ts';
import { LEEBOARD, LeeboardClient } from './leeboard-panel/leeboard.client.ts';
import { TAB_MODEL, TabModels } from './tab-models.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from './tab-folders.ts';

const MODEL_LIST: ModelOption[] = [
  { provider: 'opencode-go', id: 'flash', name: 'Flash', input: ['text'], thinkingLevels: [] },
  { provider: 'opencode-go', id: 'big', name: 'Big', input: ['text'], thinkingLevels: [] },
  { provider: 'claude-code', id: 'opus', name: 'Opus', input: ['text'], thinkingLevels: [] },
] as ModelOption[];

const slot = (chatId: string, kind: EngineKind = 'pi', patch: Partial<ChatSlotInfo> = {}): ChatSlotInfo => ({
  chatId,
  kind,
  createdAt: chatId === 'main' ? 0 : chatId.charCodeAt(0),
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

const said = (id: string, text: string): ChatTimelineItem => ({
  id,
  role: 'user',
  steps: [{ kind: 'text', text }],
  createdAt: 0,
});

interface Stream {
  method: string;
  params: Record<string, unknown>;
  handlers: StreamHandlers;
  cancelled: boolean;
}

/** A sidecar in memory: answers the chat wire per slot, and records what it was asked. */
class FakeSidecar {
  slots: ChatSlotInfo[] = [slot('main'), slot('b', 'pi', { session: info('b-session', 'second tab') })];
  transcripts: Record<string, ChatTimelineItem[]> = {
    main: [said('m1', 'hello from main')],
    b: [said('b1', 'hello from b')],
  };
  history: Record<string, ChatSessionInfo[]> = {};
  overrides: Record<string, (params: Record<string, unknown>) => unknown> = {};
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly streams: Stream[] = [];
  private state: ConnectionState = 'open';
  private readonly listeners = new Set<() => void>();

  getState = (): ConnectionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  call = (method: string, raw?: unknown): Promise<unknown> => {
    const params = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params });
    const chatId = params.chatId as string;
    try {
      const override = this.overrides[method];
      if (override) return Promise.resolve(override(params));
      switch (method) {
        case 'projects.discover':
          return Promise.resolve({ globalRoot: '/work', known: [], folders: [] });
        case 'chat.list':
          return Promise.resolve(this.history[chatId] ?? []);
        case 'chat.current':
          return Promise.resolve(null);
        case 'chat.transcript':
          return Promise.resolve(this.transcripts[chatId] ?? []);
        case 'chat.open':
          return Promise.resolve({ items: [] });
        case 'chat.slots':
          return Promise.resolve(this.slots);
        case 'models.list':
          return Promise.resolve(MODEL_LIST);
        case 'chat.create': {
          const created = slot(`n${this.slots.length}`, params.kind as EngineKind);
          this.slots = [...this.slots, created];
          return Promise.resolve(created);
        }
        case 'chat.close':
          this.slots = this.slots.filter((row) => row.chatId !== chatId);
          return Promise.resolve({ closed: true });
        case 'vault.resolve':
          return Promise.resolve(true);
        // Each slot's brief names its own project, so a panel showing another tab's is visible.
        case 'leeboard.brief':
          return Promise.resolve({ brief: leeboardBrief(chatId === 'main' ? null : `project-${chatId}`) });
        case 'leeboard.review':
          return Promise.resolve({ review: { new: [], changed: [], closed: [] } });
        case 'leeboard.open':
          return Promise.resolve({ open: [] });
        case 'leeboard.holds':
          return Promise.resolve({ holds: [] });
        case 'leeboard.asked':
          return Promise.resolve({ asked: [] });
        default:
          return Promise.resolve(null);
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  stream = (method: string, params: unknown, handlers: StreamHandlers): (() => void) => {
    const entry: Stream = { method, params: params as Record<string, unknown>, handlers, cancelled: false };
    this.streams.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  live(method: string, chatId?: string): Stream {
    const found = this.streams
      .filter((s) => s.method === method && !s.cancelled && (chatId === undefined || s.params.chatId === chatId))
      .at(-1);
    if (!found) throw new Error(`no live ${method} stream${chatId ? ` for ${chatId}` : ''}`);
    return found;
  }

  /** Another window or `fo` opened a tab. */
  created(row: ChatSlotInfo, origin: string | null = 'cli:7'): void {
    this.slots = [...this.slots, row];
    this.slotsEvent({ kind: 'slot-created', slot: row, origin });
  }

  /** A tab's observe stream, once its session has opened it (after reading the transcript). */
  observing(chatId: string): Promise<Stream> {
    return waitFor(() => this.live('chat.observe', chatId));
  }

  slotsEvent(event: ChatSlotsEvent): void {
    act(() => this.live('chat.slotsObserve').handlers.onChunk(event));
  }
}

function info(id: string, title: string): ChatSessionInfo {
  return { path: `/sessions/2026_${id}.jsonl`, engine: 'pi', id, cwd: '/work/fo', title, created: '', modified: '' };
}

const leeboardBrief = (project: string | null) => ({
  project,
  unregisteredRepo: null,
  holds: [],
  grants: [],
  rules: [],
  references: [],
  inbox: [],
  repoState: [],
});

/** Shows or hides the chat view inside the shell, as switching to Jobs or Prompts does. */
let showChat: (shown: boolean) => void = () => undefined;
function Toggle({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    showChat = setShown;
  }, []);
  return shown ? children : null;
}

function setup(sidecar = new FakeSidecar(), storage = new MemoryStorageAdapter()) {
  const root = new Container();
  const preferences = new PreferencesService(storage);
  const attention = new ChatAttentionNotifications(preferences);
  root.registerInstance(PREFERENCES, preferences);
  root.registerInstance(PROMPT_LIBRARY, new PromptLibraryService(new MemoryStorageAdapter()));
  root.registerInstance(INPUT_HISTORY, new InputHistoryService(new MemoryStorageAdapter()));
  root.registerInstance(CHAT_ATTENTION_NOTIFICATIONS, attention);
  root.registerInstance(AWAY_DIGEST, {
    getSnapshot: () => null,
    subscribe: () => () => undefined,
    dismiss: () => undefined,
  } as unknown as AwayDigest);
  const tabModels = new TabModels(storage);
  const tabFolders = new TabFolders(storage);
  root.registerInstance(TAB_FOLDERS, tabFolders);
  const transport = sidecar as never;
  // As bootstrap wires a tab: every chat service in the tab's own scope.
  const tabs = new ChatSessions(
    transport,
    (chatId, hooks) => {
      const scope = new Container(root);
      const orchestrator = new ChatOrchestrator(transport, chatId);
      const session = new ChatSession(orchestrator, transport, `window-${chatId}`, attention, hooks.focusHolder);
      scope.registerInstance(CHAT_ORCHESTRATOR, orchestrator);
      scope.registerInstance(CHAT_SESSION, session);
      scope.registerInstance(MODELS, new ModelsClient(transport, chatId));
      scope.registerInstance(LEEBOARD, new LeeboardClient(transport, chatId));
      scope.registerInstance(TAB_MODEL, tabModels.forTab(chatId, hooks.kind));
      scope.registerInstance(TAB_FOLDER, tabFolders.forTab(chatId));
      return { session, scope };
    },
    new MemoryStorageAdapter(),
    [tabModels, tabFolders],
  );
  root.registerInstance(CHAT_SESSIONS, tabs);
  const { unmount } = render(
    <ContainerProvider container={root}>
      <ActiveChatScope>
        <ShellProvider>
          <Toggle>
            <ChatView />
          </Toggle>
        </ShellProvider>
      </ActiveChatScope>
    </ContainerProvider>,
  );
  sidecar.slotsEvent({ kind: 'slots', slots: sidecar.slots });
  const tab = (name: RegExp) => screen.getByRole('tab', { name });
  return { sidecar, tabs, preferences, tab, storage, unmount, tabFolders };
}

const selected = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');

describe('ChatView: tabs over the chat', () => {
  it('lists the sidecar’s tabs, main first, each with its engine', async () => {
    const { tab } = setup();
    expect(screen.getAllByRole('tab').map((row) => row.getAttribute('aria-label'))).toEqual([
      'untitled chat — pi',
      'second tab — pi',
    ]);
    expect(selected()).toBe(tab(/^untitled chat/));
    expect(await screen.findByText('hello from main')).toBeInTheDocument();
  });

  it('keeps "＋ ▾" and says why when the tab list cannot be read (a sidecar older than this page)', () => {
    const sidecar = new FakeSidecar();
    // A pre-T2.3 sidecar: its slots carry no root.
    sidecar.slots = [{ ...slot('main', 'pi', { session: info('m1', 'main chat') }), root: undefined } as unknown as ChatSlotInfo];
    setup(sidecar);

    expect(screen.getByRole('button', { name: 'New tab' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/tabs unavailable: .*restart it, then reload/);

    sidecar.slotsEvent({ kind: 'slots', slots: [slot('main')] });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('shows a tab another window or fo created, and drops it when they close it — live', () => {
    const { sidecar } = setup();
    sidecar.created(slot('c', 'claude-code'));
    expect(screen.getByRole('tab', { name: 'untitled chat — Claude' })).toBeInTheDocument();
    expect(selected()?.getAttribute('aria-label')).toBe('untitled chat — pi');

    sidecar.slotsEvent({ kind: 'slot-closed', chatId: 'c', origin: 'cli:7' });
    expect(screen.queryByRole('tab', { name: /— Claude/ })).toBeNull();
  });

  it('switching tabs shows that tab’s conversation', async () => {
    const { tab } = setup();
    await screen.findByText('hello from main');
    await userEvent.click(tab(/^second tab/));

    expect(await screen.findByText('hello from b')).toBeInTheDocument();
    expect(screen.queryByText('hello from main')).toBeNull();
  });

  it('the Leeboard panel follows the shown tab: each tab asks for its own slot’s brief', async () => {
    const { sidecar, tab } = setup();
    const briefsFor = () => sidecar.calls.filter((c) => c.method === 'leeboard.brief').map((c) => c.params.chatId);
    await userEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(await screen.findByText('Global — no project')).toBeInTheDocument();
    expect(briefsFor()).toEqual(['main']);

    await userEvent.click(tab(/^second tab/));
    await waitFor(() => expect(briefsFor()).toEqual(['main', 'b']));
    await userEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(await screen.findByText('project project-b')).toBeInTheDocument();
    expect(screen.queryByText('Global — no project')).toBeNull();
  });

  it('marks a background tab unread when its turn ends, until it is shown', async () => {
    const { sidecar, tab } = setup();
    const observe = await sidecar.observing('b');
    act(() => {
      observe.handlers.onChunk({ kind: 'turn-started', origin: 'cli:1' });
      observe.handlers.onChunk({ kind: 'turn-ended', origin: 'cli:1' });
    });
    await waitFor(() => expect(tab(/^second tab/)).toHaveAccessibleName('second tab — pi, unread'));

    await userEvent.click(tab(/^second tab/));
    expect(tab(/^second tab/)).toHaveAccessibleName('second tab — pi');
  });

  it('shows attention for a waiting approval and for a claude_live_elsewhere refusal', async () => {
    const { sidecar, tab } = setup();
    sidecar.slotsEvent({ kind: 'slot-state', slot: slot('b', 'pi', { busy: true, attention: true, session: info('b-session', 'second tab') }) });
    expect(tab(/^second tab/)).toHaveAccessibleName('second tab — pi, turn running, needs you');

    sidecar.created(slot('c', 'claude-code'), null);
    await userEvent.click(tab(/— Claude/));
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'carry on{Enter}');
    act(() =>
      sidecar.live('chat.send', 'c').handlers.onEnd({
        message: 'a Claude Code terminal holds this conversation',
        code: 'claude_live_elsewhere',
      }),
    );
    expect(tab(/— Claude/)).toHaveAccessibleName('untitled chat — Claude, needs you');
  });

  it('settles an approval card the moment another window answers it', async () => {
    const { sidecar } = setup();
    const observe = await sidecar.observing('main');
    act(() =>
      observe.handlers.onChunk({
        kind: 'approval-request',
        requestId: 'r1',
        callId: 'c1',
        tool: 'bash',
        target: '/srv/prod',
        origin: 'other-window',
      }),
    );
    expect(await screen.findByRole('button', { name: 'APPROVE' })).toBeInTheDocument();

    act(() => observe.handlers.onChunk({ kind: 'approval-resolved', requestId: 'r1', approved: true }));
    expect(screen.queryByRole('button', { name: 'APPROVE' })).toBeNull();
    expect(screen.getByText('approved')).toBeInTheDocument();
    expect(sidecar.calls.some((call) => call.method === 'vault.resolve')).toBe(false);
  });

  it('opening a conversation another tab holds switches to that tab', async () => {
    const sidecar = new FakeSidecar();
    sidecar.history.main = [info('b-session', 'second tab')];
    sidecar.overrides['chat.open'] = () => ({ heldBy: 'b' });
    setup(sidecar);
    await userEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    await userEvent.click(await screen.findByRole('button', { name: /^second tab/ }));

    await waitFor(() => expect(selected()?.getAttribute('aria-label')).toBe('second tab — pi'));
    expect(screen.queryByText(/open in chat b/)).toBeNull();
  });
});

describe('ChatView: per-tab composer', () => {
  it('keeps each tab’s draft and attachments: a draft typed for one tab never sends from another', async () => {
    const { sidecar, tab } = setup();
    const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    await userEvent.type(composer(), 'meant for main');
    act(() => void fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true }));

    expect(composer().value).toBe('');
    await userEvent.type(composer(), '{Enter}');
    expect(sidecar.streams.some((stream) => stream.method === 'chat.send')).toBe(false);

    await userEvent.click(tab(/^untitled chat/));
    expect(composer().value).toBe('meant for main');
  });

  it('hands a background refusal’s queued messages back to their own tab’s composer only', async () => {
    const { sidecar, tab } = setup();
    sidecar.created(slot('c', 'claude-code'), null);
    await userEvent.click(tab(/— Claude/));
    const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    await userEvent.type(composer(), 'first{Enter}');
    await userEvent.type(composer(), 'queued for claude{Enter}');
    await userEvent.click(tab(/^untitled chat — pi/));
    await userEvent.type(composer(), 'typed for main');

    act(() =>
      sidecar.live('chat.send', 'c').handlers.onEnd({
        message: 'a Claude Code terminal holds this conversation',
        code: 'claude_live_elsewhere',
      }),
    );

    expect(composer().value).toBe('typed for main');
    await userEvent.click(tab(/— Claude/));
    await waitFor(() => expect(composer().value).toBe('queued for claude'));
  });
});

describe('ChatView: per-tab folder', () => {
  const FO = { id: '/work/fo', name: 'fo', path: '/work/fo', envTier: 'normal' as const };

  it('each tab shows its own folder; a new tab starts in the shown tab’s, and an empty tab still names itself', async () => {
    const { sidecar, tab, tabFolders } = setup();
    act(() => tabFolders.forTab('main').set(FO));
    expect(await screen.findByText('PROJECT · /work/fo · TOOLS ON')).toBeInTheDocument();

    await userEvent.click(tab(/^second tab/));
    expect(await screen.findByText('GLOBAL · /work · TOOLS ON')).toBeInTheDocument();

    // Before the catalog answers, an empty tab with a folder still names itself and that folder,
    // and a Global tab shows the global root already known rather than a placeholder.
    sidecar.overrides['projects.discover'] = () => new Promise(() => undefined);
    await userEvent.click(tab(/^untitled chat — pi/));
    await userEvent.click(tab(/^second tab/));
    expect(screen.getByText('GLOBAL · /work · TOOLS ON')).toBeInTheDocument();

    await userEvent.click(tab(/^untitled chat — pi/));
    await userEvent.click(screen.getByRole('button', { name: 'New tab' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /pi tab/ }));
    await waitFor(() => expect(selected()?.getAttribute('aria-label')).toBe('untitled chat — pi'));
    expect(selected()).not.toBe(screen.getAllByRole('tab')[0]);
    expect(await screen.findByText('PROJECT · /work/fo · TOOLS ON')).toBeInTheDocument();
    // The CHAT bar of a tab with no conversation yet: a title placeholder and its folder.
    expect(screen.getByLabelText('Session title')).toHaveTextContent('untitled chat');
    expect(screen.getByLabelText('Working folder')).toHaveTextContent('fo');
  });
});

describe('ChatView: per-tab model', () => {
  it('a pi tab’s picker lists only pi models, a Claude Code tab’s only Claude Code’s', async () => {
    const { sidecar, tab } = setup();
    sidecar.created(slot('c', 'claude-code'), null);

    await userEvent.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('button', { name: 'Big' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Opus' })).toBeNull();

    await userEvent.click(tab(/— Claude/));
    await userEvent.click(screen.getByRole('button', { name: 'Select model' }));
    expect(await screen.findByRole('button', { name: 'Opus' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Big' })).toBeNull();
  });

  it('keeps each tab’s pick, sends with it, and the pick survives a reload', async () => {
    const storage = new MemoryStorageAdapter();
    const { sidecar, tab, unmount } = setup(new FakeSidecar(), storage);
    const pick = async (name: string) => {
      await userEvent.click(screen.getByRole('button', { name: 'Select model' }));
      await userEvent.click(await screen.findByRole('button', { name }));
    };
    await pick('Big');
    await userEvent.click(tab(/^second tab/));
    await pick('Flash');
    await userEvent.click(tab(/^untitled chat/));

    expect(screen.getByRole('button', { name: 'Select model' })).toHaveTextContent('Big');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Enter}');
    expect(sidecar.live('chat.send', 'main').params).toMatchObject({ provider: 'opencode-go', model: 'big' });

    unmount();
    setup(new FakeSidecar(), storage);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select model' })).toHaveTextContent('Big'));
  });

  it('a kept pick the engine no longer lists falls back to its default instead of failing the send', async () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.chat.tab-models', {
      tabs: { main: { model: { provider: 'opencode-go', id: 'retired' }, effort: 'high' } },
      last: {},
    });
    const { sidecar } = setup(new FakeSidecar(), storage);
    await screen.findByRole('button', { name: 'Select model' });
    await waitFor(() => expect(sidecar.calls.some((call) => call.method === 'models.list')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select model' })).toHaveTextContent('default'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Enter}');

    expect(sidecar.live('chat.send', 'main').params).not.toHaveProperty('model');
    expect(sidecar.live('chat.send', 'main').params).not.toHaveProperty('effort');
  });

    it('sends the shown tab’s own model', async () => {
    const { sidecar, tab } = setup();
    await userEvent.click(tab(/^second tab/));
    await userEvent.click(screen.getByRole('button', { name: 'Select model' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Big' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Enter}');

    expect(sidecar.live('chat.send', 'b').params).toMatchObject({ chatId: 'b', provider: 'opencode-go', model: 'big' });
  });
});

describe('ChatView: new and closed tabs', () => {
  it('the ＋ menu opens a pi or a Claude Code tab in the shown folder, and shows it', async () => {
    const { sidecar, tabFolders } = setup();
    act(() => tabFolders.forTab('main').set({ id: '/work/fo', name: 'fo', path: '/work/fo', envTier: 'normal' }));
    await userEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const menu = screen.getByRole('menu', { name: 'New tab' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['πpi tab', '✻Claude tab']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Claude tab/ }));

    expect(sidecar.calls.find((call) => call.method === 'chat.create')?.params).toMatchObject({
      kind: 'claude-code',
      root: '/work/fo',
    });
    await waitFor(() => expect(selected()?.getAttribute('aria-label')).toBe('untitled chat — Claude'));
  });

  it('says so when the cap is reached', async () => {
    const sidecar = new FakeSidecar();
    sidecar.overrides['chat.create'] = () => {
      throw new WireCallError('at most 8 chats can be open at once — close one first', CHAT_CAP_REACHED);
    };
    setup(sidecar);
    await userEvent.click(screen.getByRole('button', { name: 'New tab' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /pi tab/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at most 8 chats can be open at once — close one first');
  });

  it('main has no close button', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Close untitled chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close second tab' })).toBeInTheDocument();
  });

  it('closes an idle tab at once, without forcing', async () => {
    const { sidecar } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));

    expect(sidecar.calls.filter((call) => call.method === 'chat.close').map((call) => call.params)).toEqual([
      expect.not.objectContaining({ force: true }),
    ]);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /second tab/ })).toBeNull());
  });

  it('asks before closing a tab whose turn is live, then force-closes; keeping it closes nothing', async () => {
    const { sidecar } = setup();
    sidecar.slotsEvent({ kind: 'slot-state', slot: slot('b', 'pi', { busy: true, session: info('b-session', 'second tab') }) });

    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    expect(screen.getByRole('alert')).toHaveTextContent('a turn is running in “second tab” — closing stops it.');
    await userEvent.click(screen.getByRole('button', { name: 'keep it' }));
    expect(sidecar.calls.some((call) => call.method === 'chat.close')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    await userEvent.click(screen.getByRole('button', { name: 'close anyway' }));
    expect(sidecar.calls.find((call) => call.method === 'chat.close')?.params).toMatchObject({ chatId: 'b', force: true });
  });

  it('asks after all when the sidecar says a turn started meanwhile', async () => {
    const sidecar = new FakeSidecar();
    sidecar.overrides['chat.close'] = (params) => {
      if (params.force) return { closed: true };
      throw new WireCallError('a turn is running in this chat — stop it first, or force the close', 'turn_in_progress');
    };
    setup(sidecar);
    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('closing stops it');
  });
});

describe('ChatView: the draft guard (T2.3)', () => {
  const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

  it('asks before closing a tab with an unsent draft; keeping it keeps the draft, closing anyway discards it', async () => {
    const { sidecar, tab } = setup();
    await userEvent.click(tab(/second tab/));
    await userEvent.type(composer(), 'half a thought');
    await userEvent.click(tab(/^untitled chat/));

    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    expect(screen.getByRole('alert')).toHaveTextContent('“second tab” has an unsent draft — closing discards it.');
    await userEvent.click(screen.getByRole('button', { name: 'keep it' }));
    expect(sidecar.calls.some((call) => call.method === 'chat.close')).toBe(false);
    await userEvent.click(tab(/second tab/));
    expect(composer().value).toBe('half a thought');

    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    await userEvent.click(screen.getByRole('button', { name: 'close anyway' }));
    // Idle: the draft is the only reason to ask, so nothing is forced.
    expect(sidecar.calls.find((call) => call.method === 'chat.close')?.params).toEqual(
      expect.not.objectContaining({ force: true }),
    );
    await waitFor(() => expect(screen.queryByRole('tab', { name: /second tab/ })).toBeNull());
  });

  it('a busy tab with a draft says both', async () => {
    const { sidecar, tab } = setup();
    await userEvent.click(tab(/second tab/));
    await userEvent.type(composer(), 'next question');
    sidecar.slotsEvent({ kind: 'slot-state', slot: slot('b', 'pi', { busy: true, session: info('b-session', 'second tab') }) });

    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    expect(screen.getByRole('alert')).toHaveTextContent('a turn is running in “second tab” and it has an unsent draft — closing stops it and discards the draft.');
  });

  it('closes an empty tab without asking', async () => {
    const { sidecar } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close second tab' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sidecar.calls.some((call) => call.method === 'chat.close')).toBe(true);
  });

  it('a tab closed elsewhere keeps its unsent draft and offers it in a notice that puts it in the shown tab', async () => {
    const { sidecar, tab } = setup();
    await userEvent.click(tab(/second tab/));
    await userEvent.type(composer(), 'do not lose me');
    await userEvent.click(tab(/^untitled chat/));
    await userEvent.type(composer(), 'mine');

    sidecar.slotsEvent({ kind: 'slot-closed', chatId: 'b', origin: 'another-window' });

    const notice = await screen.findByRole('status', { name: 'Unsent draft' });
    expect(notice).toHaveTextContent('“second tab” was closed elsewhere — its unsent draft is kept here.');
    await userEvent.click(within(notice).getByRole('button', { name: 'put it in this tab' }));
    expect(composer().value).toBe('mine\n\ndo not lose me');
    expect(screen.queryByRole('status', { name: 'Unsent draft' })).toBeNull();
  });

  it('a tab closed elsewhere while another view is shown still offers its draft when Chat is shown again', async () => {
    const { sidecar, tab } = setup();
    await userEvent.click(tab(/second tab/));
    await userEvent.type(composer(), 'written before switching to Jobs');
    await userEvent.click(tab(/^untitled chat/));
    act(() => showChat(false));

    act(() => sidecar.live('chat.slotsObserve').handlers.onChunk({ kind: 'slot-closed', chatId: 'b', origin: 'another-window' }));
    act(() => showChat(true));

    const notice = await screen.findByRole('status', { name: 'Unsent draft' });
    await userEvent.click(within(notice).getByRole('button', { name: 'put it in this tab' }));
    expect(composer().value).toBe('written before switching to Jobs');
  });

  it('the notice can be dismissed, and a tab closed elsewhere with nothing unsent shows none', async () => {
    const { sidecar, tab } = setup();
    sidecar.created(slot('c', 'pi', { session: info('c-session', 'third tab') }));
    await userEvent.click(tab(/second tab/));
    await userEvent.type(composer(), 'draft');
    await userEvent.click(tab(/^untitled chat/));

    sidecar.slotsEvent({ kind: 'slot-closed', chatId: 'c', origin: 'another-window' });
    expect(screen.queryByRole('status', { name: 'Unsent draft' })).toBeNull();

    sidecar.slotsEvent({ kind: 'slot-closed', chatId: 'b', origin: 'another-window' });
    const notice = await screen.findByRole('status', { name: 'Unsent draft' });
    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'Unsent draft' })).toBeNull();
  });
});

describe('ChatView: tab keys', () => {
  const press = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(window, init));

  it('Alt+digit shows that tab, Alt+PageUp/PageDown cycle, Alt+T opens a tab on the shown engine', async () => {
    const { sidecar } = setup();
    press({ key: '2', code: 'Digit2', altKey: true });
    expect(selected()?.getAttribute('aria-label')).toBe('second tab — pi');
    press({ key: 'PageDown', code: 'PageDown', altKey: true });
    expect(selected()?.getAttribute('aria-label')).toBe('untitled chat — pi');
    press({ key: 'PageUp', code: 'PageUp', altKey: true });
    expect(selected()?.getAttribute('aria-label')).toBe('second tab — pi');

    press({ key: 't', code: 'KeyT', altKey: true });
    await waitFor(() =>
      expect(sidecar.calls.find((call) => call.method === 'chat.create')?.params).toMatchObject({ kind: 'pi' }),
    );
  });

  it('leaves a position with no tab to the browser', () => {
    setup();
    const event = new KeyboardEvent('keydown', { key: '5', code: 'Digit5', altKey: true, cancelable: true });
    act(() => void window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+Tab and Alt+Right are left alone', () => {
    setup();
    for (const init of [
      { key: 'Tab', code: 'Tab', ctrlKey: true },
      { key: 'ArrowRight', code: 'ArrowRight', altKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
      act(() => void window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(selected()?.getAttribute('aria-label')).toBe('untitled chat — pi');
  });
});
