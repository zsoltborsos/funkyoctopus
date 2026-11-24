import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { PROMPT_LIBRARY, PromptLibraryService } from '@features/prompts/prompt-library.service.ts';
import { INPUT_HISTORY, InputHistoryService } from './input-history.ts';
import type {
  ChatChunk,
  ChatCommandsResult,
  ChatImageAttachment,
  ChatSessionInfo,
  ChatTimelineItem,
  ModelOption,
} from '@shared/transport/protocol.ts';
import {
  CHAT_ORCHESTRATOR,
  ChatOrchestrator,
  type ChatHandlers,
  type ChatTurnOptions,
} from './chat-orchestrator.client.ts';
import { CHAT_SESSION, ChatSession } from './chat-session.service.ts';
import {
  CHAT_ATTENTION_NOTIFICATIONS,
  ChatAttentionNotifications,
} from './chat-attention-notifications.service.ts';
import { MODELS, type ModelsClient } from './models.client.ts';
import { TAB_MODEL, TabModels } from './tab-models.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from './tab-folders.ts';
import { CHAT_SESSIONS, type ChatSessions } from './chat-sessions.service.ts';
import { LEEBOARD, type LeeboardClient } from './leeboard-panel/leeboard.client.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { AWAY_DIGEST, type AwayDigest } from './away-digest.ts';

/** Captures the turn options the composer sends, and streams a fixed reply. */
interface ChatSink {
  opts: ChatTurnOptions | null;
  approvals: Array<{ requestId: string; approved: boolean }>;
  /** Set when the composer cancelled the stream it started. */
  cancelled: boolean;
  opened: string[];
  /** Captured observation-stream handlers (driveable in tests). */
  observeHandlers: Array<{ onChunk: (chunk: ChatChunk) => void }>;
  /** Every text sent, in order, and each turn's handlers (driveable when hanging). */
  sends: string[];
  sendHandlers: ChatHandlers[];
  /** Images sent with each turn (parallel to `sends`). */
  images: ChatImageAttachment[][];
  /** FO's own `/compact` and `/rename` calls, in order. */
  compacts: (string | undefined)[];
  /** How often the composer asked for the tab's `/` commands. */
  commandsAsked: number;
  renames: string[];
}

/** Stored history the fake sidecar serves to `chat.list` / `chat.open`. */
interface ChatHistory {
  sessions?: ChatSessionInfo[];
  transcripts?: Record<string, ChatTimelineItem[]>;
  /** When set, `send` holds the stream open instead of completing the turn. */
  hang?: boolean;
  /** What `chat.current` reports; defaults to the session last opened, else null. */
  current?: ChatSessionInfo | null;
  /** When set, `openChat` rejects with this error instead of resolving. */
  openError?: string;
  /** What `chat.commands` answers; an empty live list by default. */
  commands?: ChatCommandsResult;
  /** When set, `chat.compact` rejects with this error. */
  compactError?: string;
}

function capturingOrchestrator(
  reply: string | ChatChunk[],
  sink: ChatSink,
  history: ChatHistory = {},
): ChatOrchestrator {
  return {
    resolveApproval(requestId: string, approved: boolean) {
      sink.approvals.push({ requestId, approved });
      return Promise.resolve(true);
    },
    discoverProjects: () =>
      Promise.resolve({
        globalRoot: '/home/you/Work',
        known: [],
        folders: [],
      }),
    listChats: () => Promise.resolve(history.sessions ?? []),
    currentChat: () =>
      Promise.resolve(
        history.current !== undefined
          ? history.current
          : (history.sessions?.find((x) => x.path === sink.opened.at(-1)) ?? null),
      ),
    newChat: () => Promise.resolve(null),
    openChat(path: string) {
      sink.opened.push(path);
      if (history.openError) return Promise.reject(new Error(history.openError));
      return Promise.resolve({ items: history.transcripts?.[path] ?? [] });
    },
    transcript: () => Promise.resolve(history.transcripts?.[sink.opened.at(-1) ?? ''] ?? []),
    commands: () => {
      sink.commandsAsked += 1;
      return Promise.resolve(history.commands ?? { commands: [], state: 'live' });
    },
    compact(instructions?: string) {
      sink.compacts.push(instructions);
      return history.compactError ? Promise.reject(new Error(history.compactError)) : Promise.resolve({ compacted: true });
    },
    rename(name: string) {
      sink.renames.push(name);
      const at = '2026-10-19T10:00:00.000Z';
      // The sidecar now describes the session by its name.
      history.current = { path: '/s/renamed.jsonl', engine: 'pi', id: 'renamed', cwd: '/w', title: name, created: at, modified: at };
      return Promise.resolve(history.current);
    },
    send(text: string, handlers: ChatHandlers, opts?: ChatTurnOptions, images?: ChatImageAttachment[]) {
      sink.opts = opts ?? null;
      sink.sends.push(text);
      sink.sendHandlers.push(handlers);
      sink.images.push(images ?? []);
      if (history.hang) {
        return () => {
          sink.cancelled = true;
        };
      }
      const chunks: ChatChunk[] =
        typeof reply === 'string' ? [{ kind: 'text', delta: reply }] : reply;
      for (const chunk of chunks) handlers.onChunk(chunk);
      handlers.onDone();
      return () => {
        sink.cancelled = true;
      };
    },
    // The observation stream: the service subscribes on construction and
    // re-subscribes on load/reconnect; capture the handlers for tests.
    observe(handlers: { onChunk: (chunk: ChatChunk) => void }) {
      sink.observeHandlers.push(handlers);
      return () => {};
    },
  } as unknown as ChatOrchestrator;
}

function renderChat(
  reply: string | ChatChunk[],
  models: ModelOption[] = [],
  toolStepsDefaultOpen = false,
  history: ChatHistory = {},
  leeboard: Partial<LeeboardClient> = {},
  listModels: () => Promise<ModelOption[]> = () => Promise.resolve(models),
) {
  const sink: ChatSink = {
    opts: null,
    approvals: [],
    cancelled: false,
    compacts: [],
    commandsAsked: 0,
    renames: [],
    opened: [],
    observeHandlers: [],
    sends: [],
    sendHandlers: [],
    images: [],
  };
  const container = new Container();
  container.registerInstance(CHAT_ORCHESTRATOR, capturingOrchestrator(reply, sink, history));
  const preferences = new PreferencesService(new MemoryStorageAdapter());
  preferences.update({ toolStepsDefaultOpen });
  const attention = new ChatAttentionNotifications(preferences);
  container.registerInstance(PREFERENCES, preferences);
  container.registerInstance(CHAT_ATTENTION_NOTIFICATIONS, attention);
  container.register(
    CHAT_SESSION,
    (c) => new ChatSession(c.resolve(CHAT_ORCHESTRATOR), undefined, 'test-tab', attention),
  );
  container.registerInstance(PROMPT_LIBRARY, new PromptLibraryService(new MemoryStorageAdapter()));
  container.registerInstance(INPUT_HISTORY, new InputHistoryService(new MemoryStorageAdapter()));
  container.registerInstance(TAB_MODEL, new TabModels(new MemoryStorageAdapter()).forTab('main', () => null));
  const folders = new TabFolders(new MemoryStorageAdapter());
  container.registerInstance(TAB_FOLDER, folders.forTab('main'));
  container.registerInstance(TAB_FOLDERS, folders);
  // The window's tabs, as far as the Leeboard panel listens: no turn ends here unless a test says so.
  container.registerInstance(CHAT_SESSIONS, { subscribeActivity: () => () => undefined } as unknown as ChatSessions);
  container.registerInstance(MODELS, {
    list: listModels,
  } as unknown as ModelsClient);
  container.registerInstance(AWAY_DIGEST, {
    getSnapshot: () => null,
    subscribe: () => () => undefined,
    dismiss: () => undefined,
  } as unknown as AwayDigest);
  // The Leeboard panel rides along with the chat surface. These tests are about
  // the chat column, so it is given an `lb` that is not installed — which is
  // also the state a cockpit runs in without Leeboard.
  container.registerInstance(LEEBOARD, {
    brief: () => Promise.resolve({ brief: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }),
    review: () => Promise.resolve({ review: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }),
    show: () => Promise.resolve({ entry: null }),
    open: () => Promise.resolve({ open: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }),
    asked: () => Promise.resolve({ asked: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }),
    holds: () => Promise.resolve({ holds: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }),
    chatId: 'main',
    ...leeboard,
  } as unknown as LeeboardClient);
  const panel = (
    <ContainerProvider container={container}>
      <ShellProvider>
        <ChatPanel />
      </ShellProvider>
    </ContainerProvider>
  );
  const { unmount } = render(panel);
  return { sink, unmount, remount: () => render(panel), session: container.resolve(CHAT_SESSION) };
}

describe('ChatPanel', () => {
  it("Leeboard's take it leaves the prompt unsent in this composer, focused and read from its first line (T3 L5)", async () => {
    const handoff = {
      id: 'handoff-take-l5-ab12',
      kind: 'handoff' as const,
      scope: 'project:funkyoctopus',
      status: 'active',
      title: 'Take L5',
      harness: 'pi',
      created: '',
      updated: '',
      to: 'project:funkyoctopus',
    };
    const { sink } = renderChat('unused', [], false, {}, {
      brief: () =>
        Promise.resolve({
          brief: { project: 'funkyoctopus', unregisteredRepo: null, holds: [], grants: [], rules: [], references: [], inbox: [handoff], repoState: [] },
        }),
      open: () => Promise.resolve({ open: [] }),
      asked: () => Promise.resolve({ asked: [] }),
      show: () => Promise.resolve({ entry: { ...handoff, body: 'Route the inbox.' } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Inbox' }));
    await userEvent.click(await screen.findByRole('button', { name: 'take it' }));
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    await vi.waitFor(() => expect(composer.value).toContain('Leeboard handoff handoff-take-l5-ab12 from pi'));
    expect(composer.value).toContain('Route the inbox.');
    expect(composer).toHaveFocus();
    expect(composer.selectionStart).toBe(0);
    expect(sink.sends).toEqual([]);
  });

  it('shows the catalog global root in the global footer', async () => {
    renderChat('unused');
    expect(await screen.findByText('GLOBAL · /home/you/Work · TOOLS ON')).toBeInTheDocument();
  });

  it('shows the user message and the streamed assistant reply', async () => {
    const user = userEvent.setup();
    renderChat('pong');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByText('ping')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
  });

  it('keeps the conversation when the panel unmounts and comes back', async () => {
    const user = userEvent.setup();
    const { unmount, remount } = renderChat('pong');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    // Leaving Chat for another cockpit view unmounts the panel; the transcript
    // lives in the container, not in the component, so returning restores it.
    unmount();
    expect(screen.queryByText('ping')).not.toBeInTheDocument();
    remount();

    expect(await screen.findByText('ping')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
  });

  it('Up recalls sent messages shell-style; Down past the newest restores the draft', async () => {
    const user = userEvent.setup();
    renderChat('pong');
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

    await user.type(box, 'first{Enter}');
    await user.type(box, 'second{Enter}');
    expect(box).toHaveValue('');

    await user.type(box, 'half a');
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('second');
    expect(box.selectionStart).toBe('second'.length);
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('first');
    // Nothing older: the composer is left alone.
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('first');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(box).toHaveValue('half a');
    // At rest Down does nothing, and Enter sends the recalled text like any other.
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveValue('half a');
  });

  it('recall leaves a multi-line draft alone unless the caret is on its edge; Esc cancels', async () => {
    const user = userEvent.setup();
    renderChat('pong');
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

    await user.type(box, 'sent{Enter}');
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    // Caret on the last line: Up moves within the draft, no recall.
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('line one\nline two');
    // On the first line (jsdom has no layout, so the browser's caret move is
    // stood in for): Up recalls, Esc brings the draft back unharmed.
    box.setSelectionRange(0, 0);
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('sent');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('line one\nline two');
  });

  it('clears the transcript when a new chat is started', async () => {
    const user = userEvent.setup();
    renderChat('pong');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(screen.getByText('ping')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '＋ new chat' }));

    expect(screen.queryByText('ping')).not.toBeInTheDocument();
    expect(screen.queryByText('pong')).not.toBeInTheDocument();
  });

  it('renders a stored conversation when a history row is opened', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, {
      sessions: [
        {
          path: '/sessions/a.jsonl', engine: 'pi',
          id: 'a',
          cwd: '/workspace',
          title: 'the earlier chat',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 2,
        },
      ],
      transcripts: {
        '/sessions/a.jsonl': [
          { id: 'e1', role: 'user', steps: [{ kind: 'text', text: 'restored question' }], createdAt: 1 },
          { id: 'e2', role: 'assistant', steps: [{ kind: 'text', text: 'restored answer' }], createdAt: 2 },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('the earlier chat'));

    expect(sink.opened).toEqual(['/sessions/a.jsonl']);
    expect(await screen.findByText('restored question')).toBeInTheDocument();
    expect(screen.getByText('restored answer')).toBeInTheDocument();
    // The CHAT bar names the open chat and where it runs (T1.4).
    expect(await screen.findByLabelText('Session title')).toHaveTextContent('the earlier chat');
    expect(screen.getByLabelText('Working folder')).toHaveTextContent('workspace');
  });

  it('shows the current chat title and folder in the CHAT bar from the sidecar, and a placeholder before one exists', async () => {
    const { unmount } = renderChat('pong', [], false, { current: null });
    // No conversation yet: the tab still names itself and where it runs (the global root here).
    expect(await screen.findByLabelText('Session title')).toHaveTextContent('untitled chat');
    expect(screen.getByLabelText('Working folder')).toHaveTextContent('you/Work');
    unmount();

    renderChat('pong', [], false, {
      current: {
        path: '/sessions/live.jsonl', engine: 'pi',
        id: 'live',
        cwd: '/home/me/dev/funkyoctopus',
        title: 'fix the header',
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 3,
      },
    });
    expect(await screen.findByLabelText('Session title')).toHaveTextContent('fix the header');
    expect(screen.getByLabelText('Working folder')).toHaveTextContent('dev/funkyoctopus');
  });

  it('offers no "finish session" in the CHAT bar: the close ritual retired in T3 L3', async () => {
    renderChat('pong', [], false, {
      current: {
        path: '/sessions/live.jsonl', engine: 'pi',
        id: 'live',
        cwd: '/home/me/dev/funkyoctopus',
        title: 'fix the header',
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 3,
      },
    });
    expect(await screen.findByLabelText('Session title')).toHaveTextContent('fix the header');
    expect(screen.queryByRole('button', { name: /finish session/ })).toBeNull();
    // The Leeboard panel sits where the rail was.
    expect(screen.getByRole('navigation', { name: 'Leeboard' })).toBeInTheDocument();
  });

  it('cancels an in-flight turn rather than letting it bleed into the opened chat', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, {
      hang: true,
      sessions: [
        {
          path: '/sessions/b.jsonl', engine: 'pi',
          id: 'b',
          cwd: '/workspace',
          title: 'somewhere else',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
        },
      ],
    });

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'slow one');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(screen.getByRole('button', { name: 'STOP' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('somewhere else'));

    expect(sink.cancelled).toBe(true);
    expect(screen.queryByText('slow one')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'SEND' })).toBeInTheDocument();
  });

  it('surfaces a failed history open in the notice line and keeps the transcript', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, {
      sessions: [
        {
          path: '/sessions/gone.jsonl', engine: 'pi',
          id: 'gone',
          cwd: '/dead/folder',
          title: 'from a vanished folder',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          folderGone: true,
        },
      ],
      openError: 'folder no longer exists: /dead/folder',
    });

    await screen.findByRole('button', { name: '＋ new chat' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'live turn');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(await screen.findByText('pong')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('from a vanished folder'));

    // The rejection reaches the existing notice line verbatim, and the current
    // transcript is untouched.
    expect(await screen.findByText('folder no longer exists: /dead/folder')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
    expect(screen.queryByText('restored')).not.toBeInTheDocument();
  });

  it('reports the context window used once the turn reports usage', async () => {
    const user = userEvent.setup();
    renderChat([
      { kind: 'text', delta: 'done' },
      { kind: 'usage', tokens: 12_400, contextWindow: 200_000, percent: 6.2 },
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByTitle('Context window used by this conversation')).toHaveTextContent(
      'ctx 12k/200k · 6%',
    );
  });

  it('scales a million-token window and keeps sub-1% occupancy visible', async () => {
    const user = userEvent.setup();
    renderChat([
      { kind: 'text', delta: 'done' },
      { kind: 'usage', tokens: 6078, contextWindow: 1_000_000, percent: 0.6078 },
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByTitle('Context window used by this conversation')).toHaveTextContent(
      'ctx 6.1k/1.0M · <1%',
    );
  });

  it('collapses tool output by default and expands it on request', async () => {
    const user = userEvent.setup();
    renderChat([
      {
        kind: 'tool-call',
        callId: 'tool-1',
        tool: 'web_search',
        summary: 'web_search: TypeScript website',
        args: { query: 'TypeScript website' },
      },
      { kind: 'tool-result', callId: 'tool-1', ok: true, output: 'typescriptlang.org' },
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'verify');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    const row = screen.getByRole('button', { name: /web_search: TypeScript website/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('typescriptlang.org')).not.toBeInTheDocument();
    await user.click(row);
    expect(screen.getByText('typescriptlang.org')).toBeInTheDocument();
  });

  it('renders added and removed diff lines when expanded by preference', async () => {
    const user = userEvent.setup();
    renderChat(
      [
        {
          kind: 'tool-call',
          callId: 'tool-1',
          tool: 'edit',
          summary: 'edit: App.tsx',
        },
        { kind: 'tool-result', callId: 'tool-1', ok: true, diff: '-old line\n+new line' },
      ],
      [],
      true,
    );

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'edit');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByRole('button', { name: /edit: App.tsx/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('File diff')).toHaveTextContent('-old line');
    expect(screen.getByLabelText('File diff')).toHaveTextContent('+new line');
  });

  it('shows the only approval surface inline, notifies, and resolves approve or deny', async () => {
    const notification = vi.fn();
    class MockNotification {
      static readonly permission = 'granted';
      static requestPermission = vi.fn(() => Promise.resolve('granted'));
      constructor(title: string, options?: NotificationOptions) {
        notification(title, options);
      }
    }
    vi.stubGlobal('Notification', MockNotification);
    const user = userEvent.setup();
    const chunks: ChatChunk[] = [
      {
        kind: 'approval-request',
        requestId: 'approval-1',
        callId: 'call-1',
        tool: 'bash',
        target: '/srv/prod',
      },
      { kind: 'text', delta: 'turn continues' },
    ];
    const approved = renderChat(chunks);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'deploy');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(screen.getByText('turn continues')).toBeInTheDocument();
    expect(notification).toHaveBeenCalledWith('Funky Octopus needs approval', {
      body: 'Vault escalation: /srv/prod',
    });
    await user.click(screen.getByRole('button', { name: 'APPROVE' }));
    expect(approved.sink.approvals).toEqual([{ requestId: 'approval-1', approved: true }]);
    expect(await screen.findByText('approved')).toBeInTheDocument();

    const denied = renderChat(chunks);
    const messageBoxes = screen.getAllByRole('textbox', { name: 'Message' });
    await user.type(messageBoxes.at(-1)!, 'do not deploy');
    const sendButtons = screen.getAllByRole('button', { name: 'SEND' });
    await user.click(sendButtons.at(-1)!);
    const denyButtons = screen.getAllByRole('button', { name: 'DENY' });
    await user.click(denyButtons.at(-1)!);
    expect(denied.sink.approvals).toEqual([{ requestId: 'approval-1', approved: false }]);
    vi.unstubAllGlobals();
  });

  it('forwards the picked model and effort with the turn', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('ok', [
      {
        provider: 'opencode-go',
        id: 'glm-5.2',
        name: 'GLM 5.2',
        thinkingLevels: ['low', 'high'],
        input: ['text', 'image'],
      },
    ]);

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await user.click(await screen.findByText('GLM 5.2'));

    await user.click(screen.getByRole('button', { name: 'Select effort' }));
    await user.click(screen.getByText('high'));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(sink.opts).toEqual({ provider: 'opencode-go', model: 'glm-5.2', effort: 'high' });
  });

  it('announces who spoke without relying on alignment', async () => {
    const user = userEvent.setup();
    renderChat('pong');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    // Rows are full-width, so position no longer carries the role. It has to be
    // readable from the accessible name and from the visible role label.
    expect(screen.getByRole('article', { name: 'Message from you' })).toHaveTextContent('ping');
    expect(screen.getByRole('article', { name: 'Message from pi' })).toHaveTextContent('pong');
  });

  it('names pi\'s default model, as the sidecar marked it, in the empty chat', async () => {
    const marked: ModelOption = {
      provider: 'alpha',
      id: 'glm-5.2',
      name: 'GLM 5.2',
      thinkingLevels: [],
      input: ['text'],
      isDefault: true,
    };
    const other: ModelOption = { provider: 'alpha', id: 'other', name: 'Other', thinkingLevels: [], input: ['text'] };
    renderChat('pong', [other, marked]);

    expect(await screen.findByText('speak to the runtime — pi is driving glm-5.2')).toBeInTheDocument();
  });

  it('names no model, and says none is configured, when the sidecar marked no default', async () => {
    const unmarked: ModelOption = { provider: 'alpha', id: 'glm-5.2', name: 'GLM 5.2', thinkingLevels: [], input: ['text'] };
    renderChat('pong', [unmarked]);

    expect(
      await screen.findByText('speak to the runtime — no pi model configured; set one in pi or FUNKYOCTOPUS_MODEL'),
    ).toBeInTheDocument();
  });

  it('says nothing of a model until the list has loaded', async () => {
    renderChat('pong');

    expect(screen.getByText('speak to the runtime')).toBeInTheDocument();
    expect(screen.queryByText(/no pi model configured/)).not.toBeInTheDocument();
    // The list loads (empty here), which is when "none configured" becomes true to say.
    expect(await screen.findByText(/no pi model configured/)).toBeInTheDocument();
  });

  it('says nothing of a model when the list could not be read', async () => {
    renderChat('pong', [], false, {}, {}, () => Promise.reject(new Error('sidecar down')));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('speak to the runtime')).toBeInTheDocument();
    expect(screen.queryByText(/no pi model configured/)).not.toBeInTheDocument();
  });

  it('names Claude, not pi, when the engine serves Claude Code\'s models', async () => {
    const user = userEvent.setup();
    const claude: ModelOption[] = [
      { provider: 'claude-code', id: 'haiku', name: 'Haiku', thinkingLevels: [], input: ['text', 'image'] },
    ];
    renderChat('pong', claude);

    // Nothing picked: Claude Code's own default, not pi's default model.
    expect(await screen.findByText('speak to the runtime — Claude is driving default')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByRole('article', { name: 'Message from Claude' })).toHaveTextContent('CLAUDE · DEFAULT');
    expect(screen.queryByRole('article', { name: 'Message from pi' })).toBeNull();
  });

  it('breaks a long unbroken token instead of widening the row', async () => {
    const user = userEvent.setup();
    renderChat('ok');

    const token = `/very/long/path/${'x'.repeat(400)}`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: token },
    });
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    // jsdom does no layout, so the guarantee is asserted where it is expressed:
    // the body wraps anywhere, and the row it sits in may shrink below its
    // content's intrinsic width.
    const body = screen.getByText(token);
    expect(body.className).toContain('wrap-anywhere');
    const row = screen.getByRole('article', { name: 'Message from you' });
    expect(row.className).toContain('min-w-0');
  });
});

describe('ChatPanel custom timeline events', () => {
  it('renders a custom-message event as a crew card alongside the assistant reply', async () => {
    const user = userEvent.setup();
    renderChat([
      {
        kind: 'custom-message',
        id: 'event-1',
        customType: 'crew-result',
        display: true,
        content: 'result body',
        details: { status: 'done', agentName: 'scout', body: 'result body' },
        timestamp: Date.now() + 60_000,
      },
      { kind: 'text', delta: 'the real answer' },
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    // The event renders as its own card; the assistant prose is untouched.
    expect(screen.getByLabelText('Crew result: done')).toBeInTheDocument();
    expect(screen.getByText('result body')).toBeInTheDocument();
    expect(await screen.findByText('the real answer')).toBeInTheDocument();
  });
});

describe('ChatPanel crew cards', () => {
  const crewEvent = (overrides: Record<string, unknown> = {}): ChatTimelineItem => ({
    kind: 'custom-message',
    id: 'crew-1',
    customType: 'crew-result',
    display: true,
    content: 'content',
    details: { status: 'done', agentName: 'scout' },
    timestamp: 2,
    ...overrides,
  });

  it('renders a crew card as its own timeline item between messages', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, {
      sessions: [
        {
          path: '/sessions/c.jsonl', engine: 'pi',
          id: 'c',
          cwd: '/workspace',
          title: 'crew chat',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 3,
        },
      ],
      transcripts: {
        '/sessions/c.jsonl': [
          { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'before' }], createdAt: 1 },
          crewEvent(),
          { id: 'a1', role: 'assistant', steps: [{ kind: 'text', text: 'after' }], createdAt: 3 },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('crew chat'));

    // The card sits at its arrival position between the two bubbles, distinct
    // from both (it never merges into assistant prose).
    expect(screen.getByLabelText('Crew result: done')).toBeInTheDocument();
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });

  it('shows the empty state when the only timeline items are display:false events', async () => {
    const { sink } = renderChat('pong');
    await vi.waitFor(() => expect(sink.observeHandlers[0]).toBeDefined());
    act(() =>
      sink.observeHandlers[0]!.onChunk({
        kind: 'custom-message',
        id: 'quiet-1',
        customType: 'extension-hello',
        display: false,
        content: 'nothing to see',
        details: {},
        timestamp: Date.now(),
      }),
    );
    expect(screen.getByText(/speak to the runtime/)).toBeInTheDocument();
    expect(screen.queryByText('nothing to see')).not.toBeInTheDocument();
  });

  it('keeps display:false events out of the DOM while messages still render', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, {
      sessions: [
        {
          path: '/sessions/d.jsonl', engine: 'pi',
          id: 'd',
          cwd: '/workspace',
          title: 'hidden crew',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 2,
        },
      ],
      transcripts: {
        '/sessions/d.jsonl': [
          crewEvent({ id: 'hidden-1', display: false }),
          { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'visible' }], createdAt: 1 },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('hidden crew'));

    expect(screen.queryByLabelText(/Crew result|Custom message/)).not.toBeInTheDocument();
    expect(screen.getByText('visible')).toBeInTheDocument();
  });

  it('renders an unknown display:true type as a generic card in a live turn', async () => {
    const user = userEvent.setup();
    const custom: ChatChunk = {
      kind: 'custom-message',
      id: 'live-1',
      customType: 'custom-thing',
      display: true,
      content: 'a live event',
      details: { n: 1 },
      timestamp: Date.now() + 60_000,
    };
    renderChat([custom, { kind: 'text', delta: 'prose' }]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByLabelText('Custom message: custom-thing')).toBeInTheDocument();
    expect(screen.getByText('a live event')).toBeInTheDocument();
    expect(screen.getByText('prose')).toBeInTheDocument();
  });

  it('leaves an ordinary chat with no custom events free of cards', async () => {
    const user = userEvent.setup();
    renderChat('plain answer');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(screen.getByText('plain answer')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Crew result|Crew warning|Custom message/)).not.toBeInTheDocument();
  });
});

describe('ChatPanel crew audit cards', () => {
  const spawnTranscript = (): ChatTimelineItem[] => [
    { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'spawn it' }], createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 10,
      historical: true,
      steps: [
        {
          kind: 'tool-call',
          callId: 'c1',
          tool: 'crew_spawn',
          summary: 'crew_spawn: scout',
          args: { subagent: 'scout', task: { goal: 'read probe' } },
        },
        {
          kind: 'tool-result',
          callId: 'c1',
          ok: true,
          output: "Subagent 'scout' spawned as scout-1.",
          details: { id: 'scout-1' },
        },
        { kind: 'text', text: 'delegated' },
      ],
    },
  ];

  const session = (path: string, title: string): ChatSessionInfo => ({
    path,
    engine: 'pi',
    id: path,
    cwd: '/workspace',
    title,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: 2,
  });

  async function openTranscript(title: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText(title));
  }

  it('renders an audit card at the tool position, replacing the generic tool step', async () => {
    renderChat('pong', [], false, {
      sessions: [session('/sessions/a.jsonl', 'audit chat')],
      transcripts: { '/sessions/a.jsonl': spawnTranscript() },
    });
    await openTranscript('audit chat');

    expect(screen.getByLabelText('Crew spawn: scout')).toBeInTheDocument();
    // The generic ToolStep representation (summary, raw output) is gone.
    expect(screen.queryByText('crew_spawn: scout')).not.toBeInTheDocument();
    expect(screen.queryByText(/Subagent 'scout' spawned as/)).not.toBeInTheDocument();
    // Chronology: the audit sits inside the turn, the prose still renders.
    expect(screen.getByText('delegated')).toBeInTheDocument();
  });

  it('marks a reopened spawn with no result as interrupted', async () => {
    renderChat('pong', [], false, {
      sessions: [session('/sessions/i.jsonl', 'interrupted chat')],
      transcripts: { '/sessions/i.jsonl': spawnTranscript() },
    });
    await openTranscript('interrupted chat');

    expect(screen.getByLabelText('Crew spawn: scout').textContent).toContain('interrupted');
  });

  it('suppresses only genuine crew-result redelivery and collapses consecutive warnings', async () => {
    const transcript: ChatTimelineItem[] = [
      { kind: 'custom-message', id: 'r1', customType: 'crew-result', display: true, content: 'same body', details: { agentId: 'scout-1', status: 'done', body: 'same body' }, timestamp: 100 },
      { kind: 'custom-message', id: 'r2', customType: 'crew-result', display: true, content: 'same body', details: { agentId: 'scout-1', status: 'done', body: 'same body' }, timestamp: 200 },
      { kind: 'custom-message', id: 'w1', customType: 'crew-list-warning', display: true, content: '⚠ active', details: null, timestamp: 300 },
      { kind: 'custom-message', id: 'w2', customType: 'crew-list-warning', display: true, content: '⚠ active', details: null, timestamp: 400 },
    ];
    renderChat('pong', [], false, {
      sessions: [session('/sessions/d.jsonl', 'dedup chat')],
      transcripts: { '/sessions/d.jsonl': transcript },
    });
    await openTranscript('dedup chat');

    expect(screen.getAllByLabelText('Crew result: done')).toHaveLength(1);
    expect(screen.getAllByLabelText('Crew warning')).toHaveLength(1);
  });

  it('keeps a non-recognized tool result error via the generic renderer', async () => {
    const transcript: ChatTimelineItem[] = [
      { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'run' }], createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        steps: [
          { kind: 'tool-call', callId: 'c1', tool: 'bash', summary: 'bash: false', args: { command: 'false' } },
          { kind: 'tool-result', callId: 'c1', ok: false, error: 'command failed with exit code 1' },
        ],
      },
    ];
    renderChat('pong', [], true, {
      sessions: [session('/sessions/e.jsonl', 'error chat')],
      transcripts: { '/sessions/e.jsonl': transcript },
    });
    await openTranscript('error chat');

    expect(screen.getByText('command failed with exit code 1')).toBeInTheDocument();
  });
});

describe('ChatPanel crew audit provenance', () => {
  it('renders a historical crew-tool-audit item at its position as unknown/interrupted', async () => {
    const user = userEvent.setup();
    const transcript: ChatTimelineItem[] = [
      { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'before' }], createdAt: 1 },
      {
        kind: 'crew-tool-audit',
        id: 'pre-a:c1',
        timestamp: 10,
        historical: true,
        call: { callId: 'c1', tool: 'crew_spawn', args: { subagent: 'scout' } },
        result: { ok: true, output: "Subagent 'scout' spawned as scout-1.", details: { id: 'scout-1' } },
      },
      { id: 'u2', role: 'user', steps: [{ kind: 'text', text: 'after' }], createdAt: 20 },
    ];
    renderChat('pong', [], false, {
      sessions: [{ path: '/sessions/h.jsonl', engine: 'pi', id: 'h', cwd: '/workspace', title: 'hist crew', created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 3 }],
      transcripts: { '/sessions/h.jsonl': transcript },
    });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('hist crew'));

    const card = screen.getByLabelText('Crew spawn: scout');
    expect(card.textContent).toContain('unknown/interrupted');
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });

  it('keeps a live pending spawn free of any interrupted label', async () => {
    const user = userEvent.setup();
    renderChat([
      {
        kind: 'tool-call',
        callId: 'c1',
        tool: 'crew_spawn',
        summary: 'crew_spawn: scout',
        args: { subagent: 'scout' },
      },
      {
        kind: 'tool-result',
        callId: 'c1',
        ok: true,
        output: "Subagent 'scout' spawned as scout-1.",
        details: { id: 'scout-1' },
      },
      { kind: 'text', delta: 'delegated' },
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    const card = screen.getByLabelText('Crew spawn: scout');
    expect(card.textContent).toContain('scout-1');
    expect(card.textContent).not.toContain('interrupted');
    expect(screen.getByText('delegated')).toBeInTheDocument();
  });
});

describe('ChatPanel raw audit generic fallback', () => {
  const session = (path: string, title: string): ChatSessionInfo => ({
    path,
    engine: 'pi',
    id: path,
    cwd: '/workspace',
    title,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: 2,
  });

  const malformedAudit = (callId: string, tool: string, result: Record<string, unknown>): ChatTimelineItem => ({
    kind: 'crew-tool-audit',
    id: `pre:${callId}`,
    timestamp: 10,
    historical: true,
    call: { callId, tool, args: {} },
    result: { ok: true, ...result },
  });

  it('falls back to the generic tool representation for a malformed compacted crew_spawn with an error', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], true, {
      sessions: [session('/sessions/m1.jsonl', 'malformed spawn')],
      transcripts: {
        '/sessions/m1.jsonl': [
          { id: 'u1', role: 'user', steps: [{ kind: 'text', text: 'go' }], createdAt: 1 },
          malformedAudit('c1', 'crew_spawn', { ok: false, error: 'brief is required' }),
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('malformed spawn'));

    // The generic ToolStep shows the failure — never the specialized audit card.
    expect(screen.queryByLabelText('Crew spawn: scout')).not.toBeInTheDocument();
    expect(screen.getByText('brief is required')).toBeInTheDocument();
    expect(screen.getByText('crew_spawn')).toBeInTheDocument();
  });

  it('falls back to the generic tool representation for malformed crew_respond/done with output', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], true, {
      sessions: [session('/sessions/m2.jsonl', 'malformed controls')],
      transcripts: {
        '/sessions/m2.jsonl': [
          malformedAudit('c2', 'crew_respond', { output: 'Message sent to subagent.' }),
          malformedAudit('c3', 'crew_done', { output: 'Subagent closed.' }),
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('malformed controls'));

    expect(screen.queryByLabelText(/Crew respond|Crew done/)).not.toBeInTheDocument();
    expect(screen.getByText('Message sent to subagent.')).toBeInTheDocument();
    expect(screen.getByText('Subagent closed.')).toBeInTheDocument();
  });
});

/** Crew chunks for a live spawn turn: call, result, and a result event. */
const crewChunks = (status: string, eventId = 'e1'): ChatChunk[] => [

    {
      kind: 'tool-call',
      callId: 'c1',
      tool: 'crew_spawn',
      summary: 'crew_spawn: scout',
      args: { subagent: 'scout', task: { goal: 'read probe' } },
    },
    {
      kind: 'tool-result',
      callId: 'c1',
      ok: true,
      output: "Subagent 'scout' spawned as scout-1.",
      details: { id: 'scout-1' },
    },
    {
      kind: 'custom-message',
      id: eventId,
      customType: 'crew-result',
      display: true,
      content: `${status} body`,
      details: { agentId: 'scout-1', status, body: `${status} body` },
      timestamp: Date.now() + 60_000,
    },
];

describe('ChatPanel live crew strip', () => {
  it('renders the live strip above the composer and updates unread while viewing stays zero', async () => {
    const user = userEvent.setup();
    // A waiting result keeps the row active (a terminal one would remove it).
    const { session } = renderChat(crewChunks('waiting'));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    // The strip is immediately above the composer textarea.
    const strip = screen.getByRole('region', { name: 'Active crew' });
    const textarea = screen.getByRole('textbox', { name: 'Message' });
    expect(strip.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(session.getSnapshot().crewUnread).toBe(0); // viewed + seen on mount
  });

  it('leaves the strip hidden for an ordinary chat with no crew activity', async () => {
    const user = userEvent.setup();
    renderChat('plain answer');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(screen.queryByRole('region', { name: 'Active crew' })).not.toBeInTheDocument();
  });
});

describe('ChatPanel crew view lifecycle', () => {
  const offViewDone = (id: string): ChatChunk => ({
    kind: 'custom-message',
    id,
    customType: 'crew-result',
    display: true,
    content: 'done body',
    details: { agentId: 'scout-9', status: 'done', body: 'done body' },
    timestamp: Date.now() + 60_000,
  });

  it('mounts viewed, unmounts not viewed, and never clears unread on mount', async () => {
    const user = userEvent.setup();
    const { session, sink, unmount, remount } = renderChat('pong');
    await vi.waitFor(() => expect(sink.observeHandlers[0]).toBeDefined());

    // Off-view accumulation while the panel is unmounted.
    unmount();
    act(() => {
      sink.observeHandlers[0]!.onChunk(offViewDone('e9'));
    });
    expect(session.getSnapshot().crewUnread).toBe(1);

    // Mount must NOT clear: the badge stays visible and the snapshot nonzero.
    remount();
    expect(session.getSnapshot().crewUnread).toBe(1);
    expect(screen.getByLabelText('Unread crew updates')).toBeInTheDocument();

    // Focusing the composer is the explicit clear action.
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    expect(session.getSnapshot().crewUnread).toBe(0);
    // With no active agents the strip hides once cleared.
    expect(screen.queryByRole('region', { name: 'Active crew' })).not.toBeInTheDocument();

    // While mounted, new crew events do not increment — wrapped so the mounted
    // panel (and its Leeboard panel) re-render inside act.
    act(() => {
      sink.observeHandlers[0]!.onChunk(offViewDone('e10'));
    });
    expect(session.getSnapshot().crewUnread).toBe(0);
  });

  it('mounts viewed and unmounts not viewed; unread accumulates off-view', async () => {
    const user = userEvent.setup();
    const { session, sink, unmount } = renderChat('pong');

    // Mount → viewed: the turn's terminal result counts no unread.
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'SEND' }));
    expect(session.getSnapshot().crewUnread).toBe(0);

    // Unmount → not viewed: a fresh terminal event counts one.
    unmount();
    act(() => {
      sink.observeHandlers[0]!.onChunk(offViewDone('e11'));
    });
    expect(session.getSnapshot().crewUnread).toBe(1);
  });
});

describe('ChatPanel transcript scrolling', () => {
  /** jsdom has no layout: give the transcript a fixed geometry to scroll in. */
  const layOut = (el: HTMLElement, scrollHeight: number, clientHeight: number): void => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  };
  const crewEvent = (id: string): ChatChunk => ({
    kind: 'custom-message',
    id,
    customType: 'crew-result',
    display: true,
    content: `result ${id}`,
    details: { status: 'done', agentName: 'scout', body: `result ${id}` },
    timestamp: Date.now(),
  });

  it('pins the transcript to the end as the reply streams in', async () => {
    const user = userEvent.setup();
    renderChat('pong');
    const transcript = screen.getByLabelText('Transcript');
    layOut(transcript, 2000, 400);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ping');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    expect(transcript.scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('stops following once the reader scrolls up, and offers a jump back', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong');
    const transcript = screen.getByLabelText('Transcript');
    layOut(transcript, 2000, 400);
    transcript.scrollTop = 1600;
    fireEvent.scroll(transcript);

    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    const jump = await screen.findByRole('button', { name: 'Jump to latest' });

    // New content arrives (observation stream): the view stays where it was.
    act(() => sink.observeHandlers[0]!.onChunk(crewEvent('e1')));
    expect(await screen.findByText('result e1')).toBeInTheDocument();
    expect(transcript.scrollTop).toBe(100);

    await user.click(jump);
    expect(transcript.scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    // Following again: the next arrival is brought into view.
    layOut(transcript, 2400, 400);
    act(() => sink.observeHandlers[0]!.onChunk(crewEvent('e2')));
    expect(await screen.findByText('result e2')).toBeInTheDocument();
    expect(transcript.scrollTop).toBe(2400);
  });

  it('stops following on an upward wheel before the scroll event reports it', async () => {
    const { sink } = renderChat('pong');
    const transcript = screen.getByLabelText('Transcript');
    layOut(transcript, 2000, 400);
    transcript.scrollTop = 1600;

    // Wheeling down while pinned changes nothing.
    fireEvent.wheel(transcript, { deltaY: 120 });
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    // The wheel-up lands; the browser has not yet dispatched `scroll` when the
    // next chunk arrives — the view must not be re-pinned.
    fireEvent.wheel(transcript, { deltaY: -120 });
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
    act(() => sink.observeHandlers[0]!.onChunk(crewEvent('e1')));
    expect(await screen.findByText('result e1')).toBeInTheDocument();
    expect(transcript.scrollTop).toBe(1600);
  });

  it('resumes following when the reader scrolls back to the end by hand', async () => {
    renderChat('pong');
    const transcript = screen.getByLabelText('Transcript');
    layOut(transcript, 2000, 400);
    transcript.scrollTop = 1600;
    fireEvent.scroll(transcript);

    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

    transcript.scrollTop = 1590; // within the threshold of the end
    fireEvent.scroll(transcript);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('lands at the end when a stored chat is reopened', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, {
      sessions: [
        {
          path: '/sessions/a.jsonl', engine: 'pi',
          id: 'a',
          cwd: '/workspace',
          title: 'the earlier chat',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 2,
        },
      ],
      transcripts: {
        '/sessions/a.jsonl': [
          { id: 'e1', role: 'user', steps: [{ kind: 'text', text: 'restored question' }], createdAt: 1 },
          { id: 'e2', role: 'assistant', steps: [{ kind: 'text', text: 'restored answer' }], createdAt: 2 },
        ],
      },
    });
    const transcript = screen.getByLabelText('Transcript');
    layOut(transcript, 2000, 400);
    transcript.scrollTop = 1600;
    fireEvent.scroll(transcript);
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('the earlier chat'));
    expect(await screen.findByText('restored answer')).toBeInTheDocument();

    expect(transcript.scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });
});

describe('ChatPanel composer while a turn streams', () => {
  const composer = () => screen.getByRole('textbox', { name: 'Message' });

  it('queues a message typed mid-turn, keeps it visible, and sends it when the turn ends', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });

    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'STOP' })).toBeInTheDocument();

    await user.type(composer(), 'second');
    await user.keyboard('{Enter}');

    // Not dropped, not sent yet: held in a visible queue, composer free again.
    expect(sink.sends).toEqual(['first']);
    expect(composer()).toHaveValue('');
    const queue = screen.getByRole('list', { name: 'Queued messages' });
    expect(queue).toHaveTextContent('queued 1');
    expect(queue).toHaveTextContent('second');

    // The turn ends: the queued message goes out as the next turn.
    act(() => sink.sendHandlers[0]!.onDone());
    expect(sink.sends).toEqual(['first', 'second']);
    expect(screen.queryByRole('list', { name: 'Queued messages' })).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'STOP' })).toBeInTheDocument();
  });

  it('STOP returns queued messages to the composer rather than sending or dropping them', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });

    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'second');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'third');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('list', { name: 'Queued messages' })).toHaveTextContent('queued 2');

    await user.click(screen.getByRole('button', { name: 'STOP' }));

    expect(sink.cancelled).toBe(true);
    expect(sink.sends).toEqual(['first']);
    expect(composer()).toHaveValue('second\n\nthird');
    expect(screen.queryByRole('list', { name: 'Queued messages' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SEND' })).toBeInTheDocument();
  });

  it('returns queued messages to the composer when the engine refuses to drive a conversation another Claude Code holds', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });
    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'second');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'third');
    await user.keyboard('{Enter}');

    act(() => sink.sendHandlers[0]!.onError('this conversation is now also open in Claude Code', 'claude_live_elsewhere'));

    // As STOP does: nothing is sent behind the owner's back, and what they wrote is theirs again.
    expect(sink.sends).toEqual(['first']);
    expect(composer()).toHaveValue('second\n\nthird');
    expect(screen.queryByRole('list', { name: 'Queued messages' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SEND' })).toBeInTheDocument();
  });

  it('✕ on a queued message returns just that one to the composer', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });

    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'second');
    await user.keyboard('{Enter}');
    await user.type(composer(), 'thi');

    await user.click(screen.getByRole('button', { name: 'Return queued message 1 to the composer' }));

    expect(composer()).toHaveValue('second\n\nthi');
    expect(screen.queryByRole('list', { name: 'Queued messages' })).not.toBeInTheDocument();
    expect(sink.sends).toEqual(['first']);
  });

  it('Esc stops the turn; Ctrl+N and Alt+N start a new chat', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });

    await user.type(composer(), 'slow one');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'STOP' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(sink.cancelled).toBe(true);
    expect(await screen.findByRole('button', { name: 'SEND' })).toBeInTheDocument();
    expect(screen.getByText('slow one')).toBeInTheDocument();

    await user.keyboard('{Alt>}n{/Alt}');
    expect(await screen.findByText(/speak to the runtime/)).toBeInTheDocument();
    expect(screen.queryByText('slow one')).not.toBeInTheDocument();

    await user.type(composer(), 'again');
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}n{/Control}');
    expect(await screen.findByText(/speak to the runtime/)).toBeInTheDocument();
    expect(screen.queryByText('again')).not.toBeInTheDocument();
  });

  it('tells the reader what Enter does while a turn streams', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, { hang: true });
    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    expect(composer()).toHaveAttribute('placeholder', expect.stringContaining('Enter queues'));
  });
});

describe('ChatPanel composer attachments', () => {
  const composer = () => screen.getByRole('textbox', { name: 'Message' });
  const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
  const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));
  const png = (name = 'shot.png') => new File([PNG_BYTES], name, { type: 'image/png' });
  const clipboard = (files: File[], text = '') => ({
    clipboardData: { files, getData: () => text, types: files.length ? ['Files'] : ['text/plain'] },
  });

  it('pasted image shows in the composer and reaches the turn as image content', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong');

    fireEvent.paste(composer(), clipboard([png()]));
    const chip = await screen.findByRole('img', { name: 'shot.png' });
    expect(chip).toHaveAttribute('src', `data:image/png;base64,${PNG_B64}`);
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeInTheDocument();

    // An image alone is held, not sent: pi needs a line of text to answer.
    await user.keyboard('{Enter}');
    expect(sink.sends).toEqual([]);
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeInTheDocument();

    await user.type(composer(), 'what is this?');
    await user.keyboard('{Enter}');
    expect(sink.sends).toEqual(['what is this?']);
    expect(sink.images).toEqual([[{ mimeType: 'image/png', data: PNG_B64 }]]);
    // Composer cleared; the transcript shows the image in the user's turn.
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'attached image' })).toHaveAttribute(
      'src',
      `data:image/png;base64,${PNG_B64}`,
    );
  });

  it('pasted file paths become chips and travel inside the message text', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong');

    fireEvent.paste(composer(), clipboard([], '/home/z/a.ts\n~/b.md\n'));
    const list = screen.getByRole('list', { name: 'Attachments' });
    expect(list).toHaveTextContent('/home/z/a.ts');
    expect(list).toHaveTextContent('~/b.md');
    expect(composer()).toHaveValue('');

    // Prose that merely mentions a path is pasted as text, not chipped.
    await user.click(composer());
    await user.paste('see /home/z/c.ts too');
    expect(composer()).toHaveValue('see /home/z/c.ts too');

    await user.keyboard('{Enter}');
    expect(sink.sends).toEqual(['see /home/z/c.ts too\n\n/home/z/a.ts\n~/b.md']);
    expect(sink.images).toEqual([[]]);
  });

  it('dropped images attach; ✕ removes one; non-image drops explain themselves', async () => {
    renderChat('pong');
    const form = composer().closest('form')!;

    fireEvent.drop(form, { dataTransfer: { files: [png('a.png'), png('b.png')], types: ['Files'], getData: () => '' } });
    expect(await screen.findByRole('img', { name: 'a.png' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'b.png' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment a.png' }));
    expect(screen.queryByRole('img', { name: 'a.png' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'b.png' })).toBeInTheDocument();

    const txt = new File(['x'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(form, { dataTransfer: { files: [txt], types: ['Files'], getData: () => '' } });
    expect(await screen.findByText(/only images can be dropped/)).toBeInTheDocument();
  });

  it('warns when an image is attached while the live route takes text only', async () => {
    const user = userEvent.setup();
    const textOnly: ModelOption = {
      provider: 'alpha',
      id: 'small-text',
      name: 'Small Text',
      thinkingLevels: [],
      input: ['text'],
      isDefault: true,
    };
    const seesImages: ModelOption = {
      provider: 'openai-codex',
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 mini',
      thinkingLevels: [],
      input: ['text', 'image'],
    };
    renderChat('pong', [textOnly, seesImages]);
    fireEvent.paste(composer(), clipboard([png()]));
    await screen.findByRole('img', { name: 'shot.png' });

    // The default route is the model the sidecar marked; this fixture makes it text only.
    expect(await screen.findByRole('alert')).toHaveTextContent('small-text takes text only');

    await user.click(screen.getByRole('button', { name: 'Select model' }));
    await user.click(await screen.findByText('GPT-5.4 mini'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a queued message keeps its image, and STOP returns the image to the composer', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { hang: true });

    await user.type(composer(), 'first');
    await user.keyboard('{Enter}');
    fireEvent.paste(composer(), clipboard([png()]));
    await screen.findByRole('img', { name: 'shot.png' });
    await user.type(composer(), 'second, with a picture');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('list', { name: 'Queued messages' })).toHaveTextContent('second, with a picture');
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'STOP' }));
    expect(sink.sends).toEqual(['first']);
    expect(composer()).toHaveValue('second, with a picture');
    expect(screen.getByRole('img', { name: 'image 1' })).toHaveAttribute(
      'src',
      `data:image/png;base64,${PNG_B64}`,
    );
  });
});

describe('ChatPanel slash palette (T2.4b)', () => {
  const PI_COMMANDS: ChatCommandsResult = {
    state: 'live',
    commands: [
      { name: 'compact', description: 'Summarise the conversation', argumentHint: '[instructions]', source: 'builtin', kind: 'action' },
      { name: 'rename', description: 'Name this conversation', argumentHint: '<name>', aliases: ['name'], source: 'builtin', kind: 'action' },
      { name: 'review', description: 'Review a diff', argumentHint: '<ref>', source: 'template', kind: 'text' },
      { name: 'skill:tdd', description: 'Test first', source: 'skill', kind: 'text' },
    ],
  };
  const options = (): string[] =>
    screen.queryAllByRole('option').map((option) => option.textContent ?? '');
  const selected = (): string | null =>
    screen.queryAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')?.textContent ?? null;
  const composerBox = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

  it('asks for the tab’s commands only once a / is typed (listing builds a pi session)', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), 'hello');
    expect(sink.commandsAsked).toBe(0);
    await user.clear(composerBox());
    await user.type(composerBox(), '/');
    expect(await screen.findByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    expect(sink.commandsAsked).toBe(1);
  });

  it('opens on a leading / with the tab’s commands — name, hint, description, source — and filters by what follows', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), '/');

    expect(await screen.findByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    expect(options()).toEqual([
      '/compact[instructions]Summarise the conversationfunkyoctopus',
      '/rename<name>Name this conversationfunkyoctopus',
      '/review<ref>Review a difftemplate',
      '/skill:tddTest firstskill',
    ]);
    await user.type(composerBox(), 're');
    expect(options().map((text) => text.split(/[<[]/u)[0])).toEqual(['/rename', '/review']);
    // An alias counts: pi's own name for rename.
    await user.clear(composerBox());
    await user.type(composerBox(), '/nam');
    expect(options()[0]).toMatch(/^\/rename/u);
  });

  it('walks with Up/Down (wrapping) and completes a text command with Enter or Tab, sending nothing', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), '/');
    await screen.findByRole('listbox', { name: 'Commands' });
    expect(selected()).toMatch(/^\/compact/u);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toMatch(/^\/skill:tdd/u);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(selected()).toMatch(/^\/review/u);
    await user.keyboard('{Enter}');

    expect(composerBox()).toHaveValue('/review ');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    expect(sink.sends).toEqual([]);
    // Arguments, then Enter sends it as text, as usual.
    await user.type(composerBox(), 'HEAD~1{Enter}');
    expect(sink.sends).toEqual(['/review HEAD~1']);

    await user.type(composerBox(), '/sk');
    await user.keyboard('{Tab}');
    expect(composerBox()).toHaveValue('/skill:tdd ');
    expect(composerBox()).toHaveFocus();
  });

  it('runs compact at once when picked, and with instructions when typed out', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), '/comp');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Enter}');
    expect(sink.compacts).toEqual([undefined]);
    expect(composerBox()).toHaveValue('');

    await user.type(composerBox(), '/compact keep the API notes{Enter}');
    expect(sink.compacts).toEqual([undefined, 'keep the API notes']);
    expect(sink.sends).toEqual([]);
  });

  it('shows why a compaction failed', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, { commands: PI_COMMANDS, compactError: 'Nothing to compact (session too small)' });
    await user.type(composerBox(), '/compact{Enter}');
    expect(await screen.findByText('Nothing to compact (session too small)')).toBeInTheDocument();
  });

  it('asks for the name inline when rename is picked, and the CHAT bar takes it', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), '/ren');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Enter}');

    const name = await screen.findByRole('textbox', { name: 'Chat name' });
    expect(name).toHaveFocus();
    await user.type(name, 'Slash palette{Enter}');
    expect(sink.renames).toEqual(['Slash palette']);
    expect(await screen.findByLabelText('Session title')).toHaveTextContent('Slash palette');
    expect(screen.queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument();

    // Typed out with a name, it renames straight away; Esc in the ask cancels it.
    await user.type(composerBox(), '/name Second{Enter}');
    expect(sink.renames).toEqual(['Slash palette', 'Second']);
    await user.type(composerBox(), '/rename{Enter}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument();
    expect(sink.renames).toHaveLength(2);
  });

  it('closes on Esc without stopping a streaming turn; the next Esc stops it', async () => {
    const user = userEvent.setup();
    const { sink } = renderChat('pong', [], false, { commands: PI_COMMANDS, hang: true });
    await user.type(composerBox(), 'go{Enter}');
    await user.type(composerBox(), '/');
    await screen.findByRole('listbox', { name: 'Commands' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    expect(sink.cancelled).toBe(false);
    expect(composerBox()).toHaveValue('/');

    await user.keyboard('{Escape}');
    expect(sink.cancelled).toBe(true);
  });

  it('leaves Up/Down to input history while closed, a recalled /command included', async () => {
    const user = userEvent.setup();
    renderChat('pong', [], false, { commands: PI_COMMANDS });
    await user.type(composerBox(), 'first{Enter}');
    await user.type(composerBox(), '/rev');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Enter}{Enter}');
    expect(composerBox()).toHaveValue('');

    await user.keyboard('{ArrowUp}');
    expect(composerBox()).toHaveValue('/review');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    await user.keyboard('{ArrowUp}');
    expect(composerBox()).toHaveValue('first');
  });

  it('says so plainly when a Claude tab has no list yet, and marks a last-known one', async () => {
    const user = userEvent.setup();
    const { unmount } = renderChat('pong', [], false, { commands: { commands: [], state: 'none' } });
    await user.type(composerBox(), '/');
    expect(await screen.findByRole('status')).toHaveTextContent(/lists its commands once this tab’s process runs/u);
    unmount();

    renderChat('pong', [], false, {
      commands: { state: 'last-known', commands: [{ name: 'context', description: 'Show context', source: 'claude-builtin', kind: 'text' }] },
    });
    await user.type(composerBox(), '/');
    expect(await screen.findByText(/last known list/u)).toBeInTheDocument();
    expect(options()).toEqual(['/contextShow contextclaude code']);
  });
});
