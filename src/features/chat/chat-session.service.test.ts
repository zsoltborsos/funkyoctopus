import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CLI_CLIENT_PREFIX,
  type ChatChunk,
  type ChatMessage,
  type ChatSessionInfo,
  type ChatTimelineItem,
} from '@shared/transport/protocol.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PreferencesService } from '@features/settings/preferences.service.ts';
import type { ChatOrchestrator } from './chat-orchestrator.client.ts';
import { ChatAttentionNotifications } from './chat-attention-notifications.service.ts';
import { ChatSession } from './chat-session.service.ts';

interface FakeTransport {
  subscribe: Mock<(listener: () => void) => () => void>;
  getState: Mock<() => string>;
  listeners: Set<() => void>;
  setState: (state: string) => void;
}

function fakeTransport(initial = 'closed'): FakeTransport {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => state),
    listeners,
    setState: (next: string) => {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface FakeOrchestrator {
  send: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  setRoot: Mock<ChatOrchestrator['setRoot']>;
  newChat: Mock<ChatOrchestrator['newChat']>;
  openChat: Mock<ChatOrchestrator['openChat']>;
  transcript: Mock<ChatOrchestrator['transcript']>;
  listChats: Mock<ChatOrchestrator['listChats']>;
  currentChat: Mock<ChatOrchestrator['currentChat']>;
  resolveApproval: Mock<ChatOrchestrator['resolveApproval']>;
  sendHandlers: Array<{
    onChunk: (chunk: ChatChunk) => void;
    onDone: () => void;
    onError: (message: string, code?: string) => void;
  }>;
  observeHandlers: Array<{ onChunk: (chunk: ChatChunk) => void }>;
}

function fakeOrchestrator(): FakeOrchestrator {
  const orchestration: FakeOrchestrator = {
    send: vi.fn(),
    observe: vi.fn(),
    setRoot: vi.fn<ChatOrchestrator['setRoot']>(() => Promise.resolve([] as ChatTimelineItem[])),
    newChat: vi.fn<ChatOrchestrator['newChat']>(() => Promise.resolve(null)),
    openChat: vi.fn<ChatOrchestrator['openChat']>(() => Promise.resolve({ items: [] as ChatTimelineItem[] })),
    transcript: vi.fn<ChatOrchestrator['transcript']>(() => Promise.resolve([] as ChatTimelineItem[])),
    listChats: vi.fn<ChatOrchestrator['listChats']>(() => Promise.resolve([])),
    currentChat: vi.fn<ChatOrchestrator['currentChat']>(() => Promise.resolve(null)),
    resolveApproval: vi.fn<ChatOrchestrator['resolveApproval']>(() => Promise.resolve(true)),
    sendHandlers: [],
    observeHandlers: [],
  };
  orchestration.send.mockImplementation(
    (
      _text: string,
      handlers: {
        onChunk: (c: ChatChunk) => void;
        onDone: () => void;
        onError: (m: string, code?: string) => void;
      },
    ) => {
      orchestration.sendHandlers.push(handlers);
      return () => {};
    },
  );
  orchestration.observe.mockImplementation((handlers: { onChunk: (c: ChatChunk) => void }) => {
    orchestration.observeHandlers.push(handlers);
    return () => {};
  });
  return orchestration;
}

const customEvent = (id: string, timestamp: number): ChatChunk => ({
  kind: 'custom-message',
  id,
  customType: 'crew-result',
  display: true,
  content: 'result body',
  details: { agentId: 'scout-1' },
  timestamp,
});

function messageList(snapshot: { messages: ChatTimelineItem[] }): ChatMessage[] {
  return snapshot.messages.filter((m): m is ChatMessage => 'role' in m);
}

describe('ChatSession custom message handling', () => {
  it('keeps a custom-message chunk out of the streaming assistant message', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('ask');
    const { onChunk } = orchestrator.sendHandlers[0]!;

    onChunk(customEvent('e1', 10));

    const snapshot = session.getSnapshot();
    const messages = messageList(snapshot);
    const assistant = messages.find((m) => m.role === 'assistant');
    // The assistant message holds no trace of the event; the event is its own
    // timeline item.
    expect(assistant?.steps).toEqual([]);
    expect(snapshot.messages.some((item) => 'kind' in item && item.id === 'e1')).toBe(true);
  });

  it('reconciles observation chunks by stable id (duplicate suppressed)', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const { onChunk } = orchestrator.observeHandlers[0]!;

    onChunk(customEvent('e1', 10));
    onChunk(customEvent('e1', 10));
    onChunk(customEvent('e2', 20));

    const events = session
      .getSnapshot()
      .messages.filter((item): item is Extract<ChatChunk, { kind: 'custom-message' }> =>
        'kind' in item,
      );
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('re-subscribes observation after opening a stored chat', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    expect(orchestrator.observe).toHaveBeenCalledTimes(1);

    await session.openChat('/sessions/stored.jsonl');

    expect(orchestrator.observe).toHaveBeenCalledTimes(2);
  });

  it('re-subscribes observation when the transport reconnects', () => {
    const transport = fakeTransport('closed');
    const orchestrator = fakeOrchestrator();
    new ChatSession(orchestrator as unknown as ChatOrchestrator, transport);
    expect(orchestrator.observe).toHaveBeenCalledTimes(1);

    transport.setState('open');
    expect(orchestrator.observe).toHaveBeenCalledTimes(2);
  });
});

describe('ChatSession approvals from any view of the chat', () => {
  const ask = (requestId: string, origin: string | null): ChatChunk => ({
    kind: 'approval-request',
    requestId,
    callId: requestId,
    tool: 'bash',
    target: '/srv/prod',
    origin,
  });
  const approvalSteps = (session: ChatSession) =>
    messageList(session.getSnapshot()).flatMap((message) =>
      message.steps.filter((step) => step.kind === 'approval-request'),
    );

  it('shows an approval another client’s turn is waiting on, and answers it from this tab', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-2');

    orchestrator.observeHandlers[0]!.onChunk(ask('r1', 'tab-1'));
    expect(approvalSteps(session)).toEqual([expect.objectContaining({ requestId: 'r1', target: '/srv/prod' })]);

    await session.resolveApproval('r1', true);

    expect(orchestrator.resolveApproval).toHaveBeenCalledWith('r1', true);
    expect(approvalSteps(session)).toEqual([expect.objectContaining({ requestId: 'r1', status: 'approved' })]);
  });

  describe('desktop notification', () => {
    const shown: string[] = [];
    beforeEach(() => {
      shown.length = 0;
      vi.stubGlobal(
        'Notification',
        class {
          static permission = 'granted';
          static requestPermission = () => Promise.resolve('granted');
          constructor(title: string) {
            shown.push(title);
          }
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('leaves the notification to the window that sent the turn when another browser window asked', async () => {
      const orchestrator = fakeOrchestrator();
      const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-2');

      orchestrator.observeHandlers[0]!.onChunk(ask('r3', 'tab-1'));
      await Promise.resolve();

      expect(approvalSteps(session)).toHaveLength(1);
      expect(shown).toEqual([]);
    });

    it.each([
      ['the CLI', `${CLI_CLIENT_PREFIX}1234`],
      ['an agent run', 'agent'],
      ['an unclaimed sender', null],
    ])('notifies in every window when %s asked, since no window sent it', async (_who, origin) => {
      const orchestrator = fakeOrchestrator();
      new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-2');

      orchestrator.observeHandlers[0]!.onChunk(ask('r4', origin));
      await vi.waitFor(() => expect(shown).toEqual(['Funky Octopus needs approval']));
    });
  });

  it('settles a card answered in another window as soon as the answer is broadcast', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-2');
    session.send('deploy');
    const turn = orchestrator.sendHandlers[0]!;
    turn.onChunk({ kind: 'approval-request', requestId: 'r5', callId: 'r5', tool: 'bash', target: '/srv/prod' });
    orchestrator.observeHandlers[0]!.onChunk(ask('r6', 'tab-1'));

    // Neither card was answered here: another window (or `fo vault`) did.
    orchestrator.observeHandlers[0]!.onChunk({ kind: 'approval-resolved', requestId: 'r5', approved: false });
    orchestrator.observeHandlers[0]!.onChunk({ kind: 'approval-resolved', requestId: 'r6', approved: true });

    expect(approvalSteps(session)).toEqual([
      expect.objectContaining({ requestId: 'r5', status: 'denied' }),
      expect.objectContaining({ requestId: 'r6', status: 'approved' }),
    ]);
    expect(orchestrator.resolveApproval).not.toHaveBeenCalled();
    // An answer to a card this window never showed changes nothing.
    const before = session.getSnapshot();
    orchestrator.observeHandlers[0]!.onChunk({ kind: 'approval-resolved', requestId: 'r-unknown', approved: true });
    expect(session.getSnapshot()).toBe(before);
  });

  it('leaves its own turn’s approval to the turn stream, and never shows one twice', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    session.send('deploy');
    const turn = orchestrator.sendHandlers[0]!;

    // The broadcast copy of this tab's own request can arrive before or after the turn's.
    orchestrator.observeHandlers[0]!.onChunk(ask('r2', 'tab-1'));
    turn.onChunk({ kind: 'approval-request', requestId: 'r2', callId: 'r2', tool: 'bash', target: '/srv/prod' });
    orchestrator.observeHandlers[0]!.onChunk(ask('r2', 'tab-1'));
    // And another view's copy of a request already on screen is not added again.
    orchestrator.observeHandlers[0]!.onChunk(ask('r2', 'tab-9'));

    expect(approvalSteps(session).map((step) => step.requestId)).toEqual(['r2']);
  });
});

describe('ChatSession opening a chat another tab holds', () => {
  it('does not switch: it says where the chat is open', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.openChat.mockResolvedValue({ heldBy: 'c4' });
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const before = session.getSnapshot();

    await expect(session.openChat('/sessions/x_held.jsonl')).rejects.toThrow(
      'this conversation is open in chat c4 — close it there (fo chat close c4) to open it here',
    );

    expect(session.getSnapshot().messages).toBe(before.messages);
    expect(orchestrator.currentChat).not.toHaveBeenCalled();
  });
});

describe('ChatSession opening a chat another tab here holds', () => {
  it('asks the tabs to focus the holder instead of failing, and stays where it is', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.openChat.mockResolvedValue({ heldBy: 'c4' });
    const focused: string[] = [];
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1', undefined, (chatId) => {
      focused.push(chatId);
      return true;
    });
    const before = session.getSnapshot();

    await expect(session.openChat('/sessions/x_held.jsonl')).resolves.toBe(false);

    expect(focused).toEqual(['c4']);
    expect(session.getSnapshot().messages).toBe(before.messages);
  });

  it('still says where the chat is open when no tab here holds it', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.openChat.mockResolvedValue({ heldBy: 'c9' });
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1', undefined, () => false);

    await expect(session.openChat('/sessions/x_held.jsonl')).rejects.toThrow('this conversation is open in chat c9');
  });
});

describe('ChatSession refusal attention', () => {
  it('marks a pending claude_live_elsewhere refusal until the next turn starts or the chat changes', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    expect(session.getSnapshot().refused).toBe(false);

    session.send('one');
    orchestrator.sendHandlers.at(-1)?.onError('held by a Claude Code terminal', 'claude_live_elsewhere');
    expect(session.getSnapshot().refused).toBe(true);

    session.send('two');
    expect(session.getSnapshot().refused).toBe(false);
    orchestrator.sendHandlers.at(-1)?.onError('held by a Claude Code terminal', 'claude_live_elsewhere');
    expect(session.getSnapshot().refused).toBe(true);

    await session.newChat();
    expect(session.getSnapshot().refused).toBe(false);
  });

  it('is not raised by any other failure', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.send('one');
    orchestrator.sendHandlers.at(-1)?.onError('model unavailable');
    expect(session.getSnapshot().refused).toBe(false);
  });
});

describe('ChatSession turn activity', () => {
  it('reports a failed turn as ended, so the tab and the away digest see it', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const heard: unknown[] = [];
    session.subscribeActivity((activity) => heard.push(activity));

    session.send('one');
    orchestrator.sendHandlers.at(-1)?.onError('model unavailable');

    expect(heard).toEqual([{ kind: 'turn-ended', at: expect.any(Number) as number, failed: true }]);
  });

  it('reports nothing for a send another client’s turn turned away: that turn was never this one', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const heard: unknown[] = [];
    session.subscribeActivity((activity) => heard.push(activity));

    session.send('one');
    orchestrator.sendHandlers.at(-1)?.onError('busy', 'turn_in_progress');

    expect(heard).toEqual([]);
  });
});

describe('ChatSession dispose', () => {
  it('ends its observe stream and stops following the transport, for a tab that closed', () => {
    const orchestrator = fakeOrchestrator();
    const cancels: string[] = [];
    orchestrator.observe.mockImplementation((handlers: { onChunk: (c: ChatChunk) => void }) => {
      orchestrator.observeHandlers.push(handlers);
      return () => cancels.push('observe');
    });
    const transport = fakeTransport('open');
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, transport);
    session.send('still streaming');
    expect(session.closed).toBe(false);

    session.dispose();

    expect(session.closed).toBe(true);
    expect(cancels).toEqual(['observe']);
    expect(transport.listeners.size).toBe(0);
    transport.setState('open');
    expect(orchestrator.observe).toHaveBeenCalledTimes(1);
  });
});

describe('ChatSession shared-session following', () => {
  const info = {
    path: '/sessions/other.jsonl',
    engine: 'pi' as const,
    id: 'other',
    cwd: '/project',
    title: 'Other session',
    created: '2026-09-28T00:00:00Z',
    modified: '2026-09-28T00:00:00Z',
  };
  const transcript: ChatTimelineItem[] = [
    { id: 'remote-user', role: 'user', steps: [{ kind: 'text', text: 'remote' }], createdAt: 1 },
  ];

  it('reloads another origin session change without opening it', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');

    orchestrator.observeHandlers[0]!.onChunk({
      kind: 'session-changed',
      origin: 'cli-1',
      session: info,
    });

    await vi.waitFor(() => expect(session.getSnapshot().messages).toEqual(transcript));
    expect(session.getSnapshot().activeSession).toEqual(info);
    expect(orchestrator.openChat).not.toHaveBeenCalled();
    expect(orchestrator.setRoot).not.toHaveBeenCalled();
  });

  it('marks a foreign turn busy, then reloads and clears the notice when it ends', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(true));
    expect(session.getSnapshot().turnNotice).toBe('another client is running a turn');

    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().messages).toEqual(transcript);
    expect(session.getSnapshot().turnNotice).toBeNull();
  });

  it('ignores observation events originated by this tab', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');

    orchestrator.observeHandlers[0]!.onChunk({ kind: 'turn-started', origin: 'tab-1' });
    orchestrator.observeHandlers[0]!.onChunk({ kind: 'session-changed', origin: 'tab-1', session: info });
    await Promise.resolve();

    expect(session.getSnapshot().busy).toBe(false);
    expect(orchestrator.transcript).not.toHaveBeenCalled();
  });

  it('keeps a send rejected as turn_in_progress queued', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');

    session.send('keep this');
    orchestrator.sendHandlers[0]!.onError('a turn is already running', 'turn_in_progress');

    expect(session.getSnapshot().queued.map((item) => item.text)).toEqual(['keep this']);
    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnNotice).toBe('another client is running a turn');
  });

  it('does not replace a local send waiting behind a pi-crew-triggered turn', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    session.send('waiting local turn');
    session.send('queued behind local');
    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    await vi.waitFor(() =>
      expect(session.getSnapshot().turnNotice).toBe('another client is running a turn'),
    );
    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });

    await vi.waitFor(() => expect(session.getSnapshot().turnNotice).toBeNull());
    expect(orchestrator.transcript).not.toHaveBeenCalled();
    expect(session.getSnapshot().busy).toBe(true);
    expect(
      messageList(session.getSnapshot()).some((item) =>
        item.steps.some((step) => step.kind === 'text' && step.text === 'waiting local turn'),
      ),
    ).toBe(true);
    expect(session.getSnapshot().queued.map((item) => item.text)).toEqual([
      'queued behind local',
    ]);
    expect(orchestrator.send).toHaveBeenCalledTimes(1);

    orchestrator.sendHandlers[0]!.onDone();
    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledTimes(2));
    expect(orchestrator.transcript).toHaveBeenCalledOnce();
    expect(orchestrator.send.mock.calls[1]?.[0]).toBe('queued behind local');
  });

  it('retries retained text when turn-ended was processed before turn_in_progress', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    session.send('race loser');
    observer.onChunk({ kind: 'turn-started', origin: 'cli-1' });
    await vi.waitFor(() =>
      expect(session.getSnapshot().turnNotice).toBe('another client is running a turn'),
    );
    observer.onChunk({ kind: 'turn-ended', origin: 'cli-1' });
    await vi.waitFor(() => expect(session.getSnapshot().turnNotice).toBeNull());
    expect(orchestrator.transcript).not.toHaveBeenCalled();

    orchestrator.sendHandlers[0]!.onError(
      'a turn is already running',
      'turn_in_progress',
    );

    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledTimes(2));
    expect(orchestrator.transcript).toHaveBeenCalledOnce();
    expect(orchestrator.send.mock.calls[1]?.[0]).toBe('race loser');
    expect(session.getSnapshot().queued).toEqual([]);
    expect(session.getSnapshot().turnNotice).toBeNull();
  });

  /** Let the serialized observation work (and its transcript reloads) settle. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('stays busy through agent start, own start, agent end until the local send ends', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    // The local send crossed pi-crew's run start on the wire, so the sidecar
    // parks it behind that run: observers see the agent start, this tab's
    // start, then the agent end while the local turn is still in flight.
    session.send('local turn');
    session.send('typed meanwhile');
    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk({ kind: 'turn-started', origin: 'tab-1' });
    await settle();
    expect(session.getSnapshot().turnNotice).toBe('another client is running a turn');
    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await settle();

    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnNotice).toBeNull();
    expect(orchestrator.send).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().queued.map((item) => item.text)).toEqual(['typed meanwhile']);

    orchestrator.sendHandlers[0]!.onDone();
    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledTimes(2));
    expect(orchestrator.send.mock.calls[1]?.[0]).toBe('typed meanwhile');
  });

  it('stays busy until every overlapping foreign turn has ended', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    // A third client's send waits behind a pi-crew run: both are foreign here.
    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk({ kind: 'turn-started', origin: 'cli-1' });
    await settle();
    session.send('typed while others run');
    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await settle();

    // The finished run is reloaded, but cli-1's turn still holds the chat.
    expect(orchestrator.transcript).toHaveBeenCalledOnce();
    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnNotice).toBe('another client is running a turn');
    expect(orchestrator.send).not.toHaveBeenCalled();

    observer.onChunk({ kind: 'turn-ended', origin: 'cli-1' });
    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledOnce());
    expect(orchestrator.transcript).toHaveBeenCalledTimes(2);
    expect(orchestrator.send.mock.calls[0]?.[0]).toBe('typed while others run');
    expect(session.getSnapshot().turnNotice).toBeNull();
  });

  it('drains the queue when the only foreign turn ends with no local turn', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'cli-1' });
    await settle();
    session.send('typed during cli turn');
    expect(orchestrator.send).not.toHaveBeenCalled();

    observer.onChunk({ kind: 'turn-ended', origin: 'cli-1' });
    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledOnce());
    expect(orchestrator.send.mock.calls[0]?.[0]).toBe('typed during cli turn');
    expect(orchestrator.transcript).toHaveBeenCalledOnce();
  });

  it('never lets its own turn events change busy or drain the queue', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    session.send('mine');
    session.send('after mine');
    observer.onChunk({ kind: 'turn-started', origin: 'tab-1' });
    observer.onChunk({ kind: 'turn-ended', origin: 'tab-1' });
    await settle();

    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnNotice).toBeNull();
    expect(orchestrator.send).toHaveBeenCalledOnce();
    expect(orchestrator.transcript).not.toHaveBeenCalled();

    orchestrator.sendHandlers[0]!.onDone();
    expect(orchestrator.send).toHaveBeenCalledTimes(2);
    expect(orchestrator.send.mock.calls[1]?.[0]).toBe('after mine');
  });

  it('forgets a foreign turn whose end was missed across a reconnect', async () => {
    const transport = fakeTransport('open');
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(transcript);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, transport, 'tab-1');

    orchestrator.observeHandlers[0]!.onChunk({ kind: 'turn-started', origin: 'cli-1' });
    await settle();
    session.send('typed before the drop');
    expect(session.getSnapshot().busy).toBe(true);

    // The socket drops; cli-1's turn-ended is lost with it.
    transport.setState('closed');
    transport.setState('open');
    expect(orchestrator.observe).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(orchestrator.send).toHaveBeenCalledOnce());
    expect(orchestrator.transcript).toHaveBeenCalledOnce();
    expect(orchestrator.send.mock.calls[0]?.[0]).toBe('typed before the drop');
    expect(session.getSnapshot().messages.slice(0, 1)).toEqual(transcript);
  });
});

describe('ChatSession live agent-turn rendering', () => {
  /** A wrapped observation chunk of one piece of the agent's own run. */
  const agentChunk = (chunk: ChatChunk): ChatChunk => ({
    kind: 'agent-chunk',
    origin: 'agent',
    chunk,
  });
  /** Let the serialized observation work (and its transcript reloads) settle. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const preExisting: ChatTimelineItem[] = [
    { id: 'old-user', role: 'user', steps: [{ kind: 'text', text: 'earlier' }], createdAt: 1 },
  ];
  const finalTimeline: ChatTimelineItem[] = [
    ...preExisting,
    { id: 'agent-user', role: 'user', steps: [{ kind: 'text', text: 'crew done' }], createdAt: 5 },
    { id: 'agent-assistant', role: 'assistant', steps: [{ kind: 'text', text: 'report' }], createdAt: 6 },
  ];

  it('renders agent chunks into one live streaming assistant message after the transcript', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.openChat.mockResolvedValue({ items: preExisting });
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    await session.openChat('/sessions/one.jsonl');
    const observer = orchestrator.observeHandlers[1]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    await settle();
    observer.onChunk(agentChunk({ kind: 'text', delta: 'report ' }));
    observer.onChunk(agentChunk({ kind: 'text', delta: 'body' }));
    observer.onChunk(
      agentChunk({
        kind: 'tool-call',
        callId: 'c1',
        tool: 'read',
        summary: 'read: probe.txt',
        args: { path: 'probe.txt' },
      }),
    );
    await settle();

    const messages = messageList(session.getSnapshot());
    expect(messages).toHaveLength(2);
    const live = messages[1]!;
    expect(live.id).not.toBe('old-user');
    expect(live.streaming).toBe(true);
    expect(live.steps).toEqual([
      { kind: 'text', text: 'report body' },
      { kind: 'tool-call', callId: 'c1', tool: 'read', summary: 'read: probe.txt', args: { path: 'probe.txt' } },
    ]);

    // Usage updates the chip, never a blank assistant message.
    const before = session.getSnapshot().messages;
    observer.onChunk(agentChunk({ kind: 'usage', tokens: 99, contextWindow: 200_000, percent: 0.5 }));
    await settle();
    expect(session.getSnapshot().messages).toBe(before);
    expect(session.getSnapshot().usage).toEqual({ tokens: 99, contextWindow: 200_000, percent: 0.5 });
  });

  it('turn-ended plus reload leaves exactly the reloaded timeline, no partial duplicate', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(finalTimeline);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk(agentChunk({ kind: 'text', delta: 'partial' }));
    await settle();
    expect(messageList(session.getSnapshot()).some((m) => m.streaming)).toBe(true);

    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await vi.waitFor(() => expect(session.getSnapshot().messages).toEqual(finalTimeline));
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().turnNotice).toBeNull();
  });

  it('a session switch mid-turn drops the partial agent message', async () => {
    const orchestrator = fakeOrchestrator();
    const switched: ChatTimelineItem[] = [
      { id: 'switched-user', role: 'user', steps: [{ kind: 'text', text: 'other chat' }], createdAt: 9 },
    ];
    orchestrator.openChat.mockResolvedValue({ items: switched });
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk(agentChunk({ kind: 'text', delta: 'partial' }));
    await settle();
    expect(messageList(session.getSnapshot()).some((m) => m.streaming)).toBe(true);

    await session.openChat('/sessions/other.jsonl');
    expect(session.getSnapshot().messages).toEqual(switched);
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
  });

  it('a reconnect mid-turn drops the partial and reconciles the transcript', async () => {
    const transport = fakeTransport('open');
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(finalTimeline);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, transport, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk(agentChunk({ kind: 'text', delta: 'partial' }));
    await settle();
    expect(messageList(session.getSnapshot()).some((m) => m.streaming)).toBe(true);

    transport.setState('closed');
    transport.setState('open');

    await vi.waitFor(() => expect(session.getSnapshot().messages).toEqual(finalTimeline));
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
  });

  it('removes the agent partial at turn end even while a local send is in flight', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(finalTimeline);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    // A local send is waiting behind the agent run; the partial is visible.
    session.send('waiting local turn');
    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk(agentChunk({ kind: 'text', delta: 'partial' }));
    await settle();
    expect(messageList(session.getSnapshot()).some((m) => m.streaming)).toBe(true);

    // The agent turn ends while the long local turn keeps running: the
    // partial must not stay on screen until the local send settles.
    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await settle();
    // The agent partial is gone; the only streaming message left is the local
    // send's own assistant message.
    const stillStreaming = messageList(session.getSnapshot()).filter((m) => m.streaming);
    expect(stillStreaming).toHaveLength(1);
    expect(stillStreaming[0]!.steps).toEqual([]);
    expect(
      messageList(session.getSnapshot()).some((m) =>
        m.steps.some((step) => step.kind === 'text' && step.text === 'partial'),
      ),
    ).toBe(false);
    expect(orchestrator.transcript).not.toHaveBeenCalled();
    expect(session.getSnapshot().busy).toBe(true);

    orchestrator.sendHandlers[0]!.onDone();
    await vi.waitFor(() => expect(orchestrator.transcript).toHaveBeenCalledOnce());
    expect(session.getSnapshot().messages).toEqual(finalTimeline);
  });

  it('drops the agent partial when the post-turn transcript reload fails', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockRejectedValue(new Error('transcript down'));
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'agent' });
    observer.onChunk(agentChunk({ kind: 'text', delta: 'partial' }));
    await settle();
    expect(messageList(session.getSnapshot()).some((m) => m.streaming)).toBe(true);

    observer.onChunk({ kind: 'turn-ended', origin: 'agent' });
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
    expect(orchestrator.send).not.toHaveBeenCalled();
  });

  it('a foreign client turn still shows no live message and reloads only at its end', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockResolvedValue(finalTimeline);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator, undefined, 'tab-1');
    const observer = orchestrator.observeHandlers[0]!;

    observer.onChunk({ kind: 'turn-started', origin: 'cli-1' });
    await settle();
    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnNotice).toBe('another client is running a turn');
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
    expect(orchestrator.transcript).not.toHaveBeenCalled();

    // A stray agent-chunk envelope without an open agent turn is ignored.
    observer.onChunk(agentChunk({ kind: 'text', delta: 'ghost' }));
    await settle();
    expect(messageList(session.getSnapshot()).filter((m) => m.streaming)).toEqual([]);
    expect(orchestrator.transcript).not.toHaveBeenCalled();

    observer.onChunk({ kind: 'turn-ended', origin: 'cli-1' });
    await vi.waitFor(() => expect(orchestrator.transcript).toHaveBeenCalledOnce());
    expect(session.getSnapshot().messages).toEqual(finalTimeline);
  });
});

describe('ChatSession live crew', () => {
  const spawnCall = (callId = 'c1'): Extract<ChatChunk, { kind: 'tool-call' }> => ({
    kind: 'tool-call',
    callId,
    tool: 'crew_spawn',
    summary: `crew_spawn: scout`,
    args: { subagent: 'scout', task: { goal: 'read probe' } },
  });
  const spawnResult = (
    callId = 'c1',
    details: unknown = { id: 'scout-1' },
  ): Extract<ChatChunk, { kind: 'tool-result' }> => ({
    kind: 'tool-result',
    callId,
    ok: true,
    output: "Subagent 'scout' spawned as scout-1.",
    details,
  });
  const crewResultEvent = (
    id: string,
    agentId: string,
    status: string,
    ts: number,
  ): Extract<ChatChunk, { kind: 'custom-message' }> => ({
    kind: 'custom-message',
    id,
    customType: 'crew-result',
    display: true,
    content: `${status} body`,
    details: { agentId, status, body: `${status} body` },
    timestamp: ts,
  });

  it('pairs 1.0.34 control results with their calls through the send stream', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;

    onChunk(spawnCall());
    onChunk(spawnResult());
    expect(session.getSnapshot().activeCrew[0]?.agentId).toBe('scout-1');

    // needs_input keeps the row; a successful crew_respond returns it to running.
    orchestrator.observeHandlers[0]!.onChunk(crewResultEvent('e1', 'scout-1', 'needs_input', 5));
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('needs_input');
    onChunk({ kind: 'tool-call', callId: 'r1', tool: 'crew_respond', summary: 'x', args: { subagent_id: 'scout-1' } });
    onChunk({ kind: 'tool-result', callId: 'r1', ok: true, output: '{"subagent_id":"scout-1"}' });
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('running');

    // A failed crew_done leaves the row; a successful one removes it.
    onChunk({ kind: 'tool-call', callId: 'd1', tool: 'crew_done', summary: 'x', args: { subagent_id: 'scout-1' } });
    onChunk({ kind: 'tool-result', callId: 'd1', ok: false, error: 'not closed' });
    expect(session.getSnapshot().activeCrew).toHaveLength(1);
    onChunk({ kind: 'tool-call', callId: 'd2', tool: 'crew_done', summary: 'x', args: { subagent_id: 'scout-1' } });
    onChunk({ kind: 'tool-result', callId: 'd2', ok: true, output: '{"subagent_id":"scout-1"}' });
    expect(session.getSnapshot().activeCrew).toEqual([]);
    onDone();
  });

  it('drops a row the owner closed in a turn the cockpit did not stream', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;
    onChunk(spawnCall());
    onChunk(spawnResult());
    onDone();

    // pi-crew's result triggers an owner turn of its own; its crew_done never
    // reaches the browser, only the owner's crew-status snapshot does.
    const observed = orchestrator.observeHandlers[0]!;
    observed.onChunk(crewResultEvent('e1', 'scout-1', 'completed', 5));
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('completed');
    observed.onChunk({
      kind: 'custom-message',
      id: 's1',
      customType: 'crew-status',
      display: false,
      content: '{"type":"crew_status","agents":[]}',
      details: { crewContextId: 'x' },
      timestamp: 6,
    });
    expect(session.getSnapshot().activeCrew).toEqual([]);
  });

  it('clears orphaned pending control calls on turn end, error and cancel', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    let handlers = orchestrator.sendHandlers[0]!;

    // A control call whose result never arrives, then turn end: the next
    // turn's unrelated result must not be misread as that control result.
    handlers.onChunk({ kind: 'tool-call', callId: 'x1', tool: 'crew_done', summary: 'x', args: { subagent_id: 'scout-1' } });
    handlers.onDone();
    session.send('again');
    handlers = orchestrator.sendHandlers[1]!;
    handlers.onChunk({ kind: 'tool-result', callId: 'other', ok: true, output: 'plain' });
    // Nothing crashed and no live row was invented.
    expect(session.getSnapshot().activeCrew).toEqual([]);

    // Same after cancel.
    handlers.onChunk({ kind: 'tool-call', callId: 'x2', tool: 'crew_abort', summary: 'x', args: { subagent_id: 'scout-1' } });
    session.cancel();
    session.send('third');
    handlers = orchestrator.sendHandlers[2]!;
    handlers.onChunk({ kind: 'tool-result', callId: 'x2', ok: true, output: '{"aborted_ids":["scout-1"]}' });
    expect(session.getSnapshot().activeCrew).toEqual([]);
  });

  it('tracks a live spawn through the send stream: provisional → bound id → terminal removal', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;

    onChunk(spawnCall());
    expect(session.getSnapshot().activeCrew).toEqual([
      { key: 'c1', callId: 'c1', agentName: 'scout', task: 'read probe', status: 'running', startedAt: expect.any(Number) },
    ]);

    onChunk(spawnResult());
    expect(session.getSnapshot().activeCrew[0]?.agentId).toBe('scout-1');

    // waiting transition via the observation path
    orchestrator.observeHandlers[0]!.onChunk(crewResultEvent('e1', 'scout-1', 'waiting', 5));
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('waiting');

    // terminal removes the row
    orchestrator.observeHandlers[0]!.onChunk(crewResultEvent('e2', 'scout-1', 'done', 6));
    expect(session.getSnapshot().activeCrew).toEqual([]);
    onDone();
  });

  it('removes the provisional row on a spawn error and ignores malformed chunks', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;

    onChunk(spawnCall());
    onChunk({ ...spawnResult(), ok: false, error: 'boom' });
    expect(session.getSnapshot().activeCrew).toEqual([]);

    onChunk(spawnCall());
    onChunk({ kind: 'tool-call', callId: 'c9', tool: 'read', summary: 'x', args: { path: 'f' } });
    expect(session.getSnapshot().activeCrew).toHaveLength(1);
    onDone();
  });

  it('updates live state exactly once when send and observe carry the same custom event', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;
    onChunk(spawnCall());
    onChunk(spawnResult());

    // The same waiting event arrives via both streams: one transition only.
    orchestrator.observeHandlers[0]!.onChunk(crewResultEvent('e1', 'scout-1', 'waiting', 5));
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('waiting');
    onChunk(crewResultEvent('e1', 'scout-1', 'waiting', 5));
    expect(session.getSnapshot().activeCrew[0]?.status).toBe('waiting');
    expect(session.getSnapshot().messages.filter((m) => 'kind' in m)).toHaveLength(1);
    onDone();
  });

  it('counts unread exactly once per newly inserted displayable waiting/terminal event while not viewed', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const { onChunk } = orchestrator.observeHandlers[0]!;
    // Default: not viewed (panel unmounted).
    onChunk(crewResultEvent('e1', 's1', 'waiting', 1));
    onChunk(crewResultEvent('e2', 's1', 'done', 2));
    expect(session.getSnapshot().crewUnread).toBe(2);
    // running, malformed, hidden never count
    onChunk(crewResultEvent('e3', 's1', 'running', 3));
    onChunk({ ...crewResultEvent('e4', 's1', 'done', 4), details: { status: 'wat' } });
    onChunk({ ...crewResultEvent('e5', 's1', 'done', 5), display: false });
    expect(session.getSnapshot().crewUnread).toBe(2);
    session.markCrewSeen();
    expect(session.getSnapshot().crewUnread).toBe(0);
    // viewed events never count
    session.setCrewViewed(true);
    onChunk(crewResultEvent('e6', 's1', 'done', 6));
    expect(session.getSnapshot().crewUnread).toBe(0);
  });

  it('clears live crew and unread on load (open/new/root) and never reconstructs historical rows', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(false);
    session.send('go');
    const { onChunk, onDone } = orchestrator.sendHandlers[0]!;
    onChunk(spawnCall());
    onChunk(spawnResult());
    onChunk(crewResultEvent('e1', 'scout-1', 'waiting', 5));
    expect(session.getSnapshot().activeCrew).toHaveLength(1);
    expect(session.getSnapshot().crewUnread).toBe(1);

    orchestrator.openChat.mockResolvedValueOnce({
      items: [
        {
          kind: 'crew-tool-audit',
          id: 'pre:c1',
          timestamp: 10,
          historical: true,
          call: { callId: 'c1', tool: 'crew_spawn', args: { subagent: 'scout' } },
          result: { ok: true, output: '...', details: { id: 'scout-1' } },
        },
      ] as ChatTimelineItem[],
    });
    await session.openChat('/sessions/h.jsonl');

    // Historical audit items never reconstruct active rows; unread cleared.
    expect(session.getSnapshot().activeCrew).toEqual([]);
    expect(session.getSnapshot().crewUnread).toBe(0);
    onDone();
  });
});

describe('ChatSession unbound provisional cleanup', () => {
  const sendCrew = (session: ChatSession, orchestrator: FakeOrchestrator) => {
    session.send('go');
    return orchestrator.sendHandlers[0]!;
  };

  it('removes an unbound provisional on a successful result without a resolvable id', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    const { onChunk, onDone } = sendCrew(session, orchestrator);
    onChunk({ kind: 'tool-call', callId: 'c1', tool: 'crew_spawn', summary: 'x', args: { subagent: 'scout' } });
    onChunk({ kind: 'tool-result', callId: 'c1', ok: true, output: 'no id here', details: undefined });
    expect(session.getSnapshot().activeCrew).toEqual([]);
    onDone();
  });

  it('removes an unbound provisional that never got a result at turn end, error and cancel', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    const { onChunk, onDone } = sendCrew(session, orchestrator);
    onChunk({ kind: 'tool-call', callId: 'c1', tool: 'crew_spawn', summary: 'x', args: { subagent: 'scout' } });
    expect(session.getSnapshot().activeCrew).toHaveLength(1);
    onDone();
    expect(session.getSnapshot().activeCrew).toEqual([]);

    const again = sendCrew(session, orchestrator);
    again.onChunk({ kind: 'tool-call', callId: 'c2', tool: 'crew_spawn', summary: 'x', args: { subagent: 'worker' } });
    again.onError('turn failed');
    expect(session.getSnapshot().activeCrew).toEqual([]);

    const third = sendCrew(session, orchestrator);
    third.onChunk({ kind: 'tool-call', callId: 'c3', tool: 'crew_spawn', summary: 'x', args: { subagent: 'worker' } });
    session.cancel();
    expect(session.getSnapshot().activeCrew).toEqual([]);
  });

  it('keeps bound rows alive across parent turn completion and cancel, and other agents unaffected', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.setCrewViewed(true);
    const { onChunk, onDone } = sendCrew(session, orchestrator);
    onChunk({ kind: 'tool-call', callId: 'c1', tool: 'crew_spawn', summary: 'x', args: { subagent: 'scout' } });
    onChunk({ kind: 'tool-result', callId: 'c1', ok: true, output: "...spawned as scout-1.", details: { id: 'scout-1' } });
    // A second unbound provisional row (no result) dies with the turn.
    onChunk({ kind: 'tool-call', callId: 'c2', tool: 'crew_spawn', summary: 'x', args: { subagent: 'worker' } });
    onDone();

    const rows = session.getSnapshot().activeCrew;
    expect(rows.map((r) => r.callId)).toEqual(['c1']);
    expect(rows[0]?.agentId).toBe('scout-1');

    session.cancel();
    expect(session.getSnapshot().activeCrew.map((r) => r.callId)).toEqual(['c1']);
  });
});

describe('ChatSession send queue', () => {
  /** Text passed to the Nth orchestrator.send call. */
  const sentText = (orchestrator: FakeOrchestrator, n: number): unknown =>
    orchestrator.send.mock.calls[n]?.[0];
  /** Options passed to the Nth orchestrator.send call. */
  const sentOpts = (orchestrator: FakeOrchestrator, n: number): unknown =>
    orchestrator.send.mock.calls[n]?.[2];

  it('queues a message sent while a turn is streaming instead of dropping it', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first', { model: 'a' });
    const before = session.getSnapshot().messages.length;
    session.send('second', { model: 'b' });

    const snapshot = session.getSnapshot();
    expect(orchestrator.send).toHaveBeenCalledTimes(1);
    expect(snapshot.messages).toHaveLength(before);
    expect(snapshot.queued).toHaveLength(1);
    expect(snapshot.queued[0]?.text).toBe('second');
    expect(snapshot.queued[0]?.opts).toEqual({ model: 'b' });
    expect(snapshot.busy).toBe(true);
  });

  it('ignores empty and whitespace-only messages while busy', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.send('');
    session.send('   ');

    expect(session.getSnapshot().queued).toEqual([]);
    expect(orchestrator.send).toHaveBeenCalledTimes(1);
  });

  it('drains one queued message per turn, in order, with its own captured options', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first', { model: 'first-model' });
    session.send('second', { model: 'second-model' });
    session.send('third', { model: 'third-model' });
    expect(session.getSnapshot().queued.map((q) => q.text)).toEqual(['second', 'third']);

    const beforeDrain = messageList(session.getSnapshot()).length;
    orchestrator.sendHandlers[0]!.onDone();

    expect(orchestrator.send).toHaveBeenCalledTimes(2);
    expect(sentText(orchestrator, 1)).toBe('second');
    expect(sentOpts(orchestrator, 1)).toEqual({ model: 'second-model' });
    let snapshot = session.getSnapshot();
    expect(snapshot.queued.map((q) => q.text)).toEqual(['third']);
    expect(snapshot.busy).toBe(true);
    const messages = messageList(snapshot);
    expect(messages).toHaveLength(beforeDrain + 2);
    expect(messages[beforeDrain]?.steps).toEqual([{ kind: 'text', text: 'second' }]);
    expect(messages[beforeDrain]?.role).toBe('user');
    expect(messages[beforeDrain + 1]?.streaming).toBe(true);

    orchestrator.sendHandlers[1]!.onDone();
    expect(orchestrator.send).toHaveBeenCalledTimes(3);
    expect(sentText(orchestrator, 2)).toBe('third');
    expect(session.getSnapshot().queued).toEqual([]);

    orchestrator.sendHandlers[2]!.onDone();
    snapshot = session.getSnapshot();
    expect(snapshot.queued).toEqual([]);
    expect(snapshot.busy).toBe(false);
    expect(orchestrator.send).toHaveBeenCalledTimes(3);
  });

  it('drains the queue after a failed turn too', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.send('second');
    orchestrator.sendHandlers[0]!.onError('boom');

    expect(orchestrator.send).toHaveBeenCalledTimes(2);
    expect(sentText(orchestrator, 1)).toBe('second');
    const snapshot = session.getSnapshot();
    expect(snapshot.queued).toEqual([]);
    expect(snapshot.busy).toBe(true);
  });

  it('does not queue an awaited turn when another client wins the send race', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    const completion = session.sendAndWait('draft from this chat', { model: 'selected' });
    orchestrator.sendHandlers[0]!.onError('another turn is running', 'turn_in_progress');

    await expect(completion).rejects.toThrow('another turn is running');
    expect(session.getSnapshot().queued).toEqual([]);
    expect(orchestrator.send).toHaveBeenCalledOnce();
  });

  it('cancel returns the queued messages in order and empties the queue', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.send('second', { model: 'b' });
    session.send('third');

    const restored = session.cancel();
    expect(restored.map((q) => q.text)).toEqual(['second', 'third']);
    expect(restored[0]?.opts).toEqual({ model: 'b' });
    const snapshot = session.getSnapshot();
    expect(snapshot.queued).toEqual([]);
    expect(snapshot.busy).toBe(false);
    expect(orchestrator.send).toHaveBeenCalledTimes(1);
  });

  it('cancel returns an empty list when nothing was queued', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    expect(session.cancel()).toEqual([]);
  });

  it('cancel marks the streaming assistant message stopped, not merely finished', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.cancel();
    const assistant = session.getSnapshot().messages.at(-1);
    expect(assistant).toMatchObject({ role: 'assistant', streaming: false, stopped: true });
  });

  it('unqueue removes exactly one entry and returns it; unknown ids change nothing', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.send('second');
    session.send('third');
    const target = session.getSnapshot().queued[0]!;

    const removed = session.unqueue(target.id);
    expect(removed).toEqual(target);
    expect(session.getSnapshot().queued.map((q) => q.text)).toEqual(['third']);

    expect(session.unqueue('no-such-id')).toBeNull();
    expect(session.getSnapshot().queued.map((q) => q.text)).toEqual(['third']);
  });

  it('clears the queue when the conversation is switched, without sending it', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    session.send('first');
    session.send('second');
    await session.openChat('/sessions/other.jsonl');

    expect(session.getSnapshot().queued).toEqual([]);
    expect(orchestrator.send).toHaveBeenCalledTimes(1);

    session.send('again');
    session.send('queued-again');
    await session.newChat();

    expect(session.getSnapshot().queued).toEqual([]);
    expect(orchestrator.send).toHaveBeenCalledTimes(2);
  });
});

describe('ChatSession active session info', () => {
  const info: ChatSessionInfo = {
    path: '/s/a.jsonl',
    engine: 'pi',
    id: 'a',
    cwd: '/w/proj',
    title: 'a chat',
    created: '2026-08-19T00:00:00Z',
    modified: '2026-08-19T00:00:00Z',
    messageCount: 1,
  };

  it.each([
    { cwd: '/another/project' },
    { cwd: '/moved/project', movedFrom: '/old/project' },
  ])('open scopes history to the confirmed effective cwd: $cwd', async (folder) => {
    const orchestrator = fakeOrchestrator();
    const opened = { ...info, ...folder };
    const messages: ChatTimelineItem[] = [
      { id: 'original', role: 'user', steps: [{ kind: 'text', text: 'queued here' }], createdAt: 0 },
    ];
    orchestrator.openChat.mockResolvedValue({ items: messages });
    orchestrator.currentChat.mockResolvedValue(opened);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    await session.openChat(info.path);
    expect(orchestrator.openChat).toHaveBeenCalledWith(info.path, expect.any(String));
    expect(orchestrator.listChats).toHaveBeenCalledWith(folder.cwd);
    expect(session.getSnapshot()).toMatchObject({
      activeSessionPath: info.path, activeSession: opened, messages,
    });
    expect(orchestrator.setRoot).not.toHaveBeenCalled();
    expect(orchestrator.newChat).not.toHaveBeenCalled();
    expect(orchestrator.send).not.toHaveBeenCalled();
  });

  it('failed open preserves the current root, transcript and identity', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.currentChat.mockResolvedValue(info);
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    await session.setRoot(info.cwd);
    const before = session.getSnapshot();
    orchestrator.currentChat.mockClear();
    orchestrator.listChats.mockClear();
    orchestrator.setRoot.mockClear();
    orchestrator.openChat.mockRejectedValue(new Error('gone'));
    await expect(session.openChat('/s/gone.jsonl')).rejects.toThrow('gone');
    expect(session.getSnapshot()).toBe(before);
    expect(orchestrator.currentChat).not.toHaveBeenCalled();
    expect(orchestrator.listChats).not.toHaveBeenCalled();
    expect(orchestrator.setRoot).not.toHaveBeenCalled();
    expect(orchestrator.newChat).not.toHaveBeenCalled();
    expect(orchestrator.send).not.toHaveBeenCalled();
    await session.refresh();
    expect(orchestrator.listChats).toHaveBeenCalledWith(info.cwd);
  });

  it('refresh adopts what the sidecar reports; openChat refreshes; a turn end re-reads the title', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.currentChat.mockImplementation(() => Promise.resolve(info));
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    expect(session.getSnapshot().activeSession).toBeNull();

    await session.refresh();
    expect(session.getSnapshot().activeSession).toEqual(info);
    expect(session.getSnapshot().activeSessionPath).toBe('/s/a.jsonl');

    // Switching to another path drops the stale info until the sidecar confirms.
    orchestrator.currentChat.mockImplementation(() => Promise.resolve({ ...info, path: '/s/b.jsonl', title: 'b' }));
    await session.openChat('/s/b.jsonl');
    expect(session.getSnapshot().activeSession?.title).toBe('b');

    // The first message titles a chat: the turn end re-reads it.
    orchestrator.currentChat.mockClear();
    session.send('hello');
    orchestrator.sendHandlers.at(-1)?.onDone();
    await Promise.resolve();
    expect(orchestrator.currentChat).toHaveBeenCalledTimes(1);
  });
});

describe('ChatSession: a tab joining a chat that is already running', () => {
  const stored: ChatMessage[] = [
    { id: 'u1', role: 'user', historical: true, steps: [{ kind: 'text', text: 'hello' }], createdAt: 1 },
    { id: 'a1', role: 'assistant', historical: true, steps: [{ kind: 'text', text: 'hi' }], createdAt: 2 },
  ];
  /** A tab as the app builds it: with the attention service, whose baseline read this rides on. */
  const tab = (orchestrator: FakeOrchestrator) =>
    new ChatSession(
      orchestrator as unknown as ChatOrchestrator,
      undefined,
      'tab-1',
      new ChatAttentionNotifications(new PreferencesService(new MemoryStorageAdapter())),
    );

  it('shows the chat\'s stored conversation as soon as it loads, since a reload starts with none', async () => {
    const orchestrator = fakeOrchestrator();
    orchestrator.transcript.mockImplementation(() => Promise.resolve(stored));

    const session = tab(orchestrator);

    await vi.waitFor(() => expect(session.getSnapshot().messages).toEqual(stored));
    expect(session.getSnapshot().busy).toBe(false);
    // The read that did it is the one already made for the notification baseline.
    expect(orchestrator.transcript).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for a chat with nothing stored yet, without touching the snapshot', async () => {
    const orchestrator = fakeOrchestrator();
    const session = tab(orchestrator);
    const before = session.getSnapshot();
    await vi.waitFor(() => expect(orchestrator.observe).toHaveBeenCalled());

    expect(session.getSnapshot()).toBe(before);
  });

  it('does not replace a conversation the tab started while the read was out', async () => {
    const orchestrator = fakeOrchestrator();
    let answer: (items: ChatTimelineItem[]) => void = () => undefined;
    orchestrator.transcript.mockImplementation(
      () => new Promise<ChatTimelineItem[]>((resolve) => { answer = resolve; }),
    );
    const session = tab(orchestrator);

    session.send('typed meanwhile');
    answer(stored);
    await vi.waitFor(() => expect(orchestrator.observe).toHaveBeenCalled());

    expect(messageList(session.getSnapshot()).map((message) => message.steps)).toEqual([
      [{ kind: 'text', text: 'typed meanwhile' }],
      [],
    ]);
  });

  it('does not bring back a conversation from before a switch: a read for an older chat is dropped', async () => {
    const orchestrator = fakeOrchestrator();
    let answer: (items: ChatTimelineItem[]) => void = () => undefined;
    orchestrator.transcript.mockImplementationOnce(
      () => new Promise<ChatTimelineItem[]>((resolve) => { answer = resolve; }),
    );
    const session = tab(orchestrator);

    await session.newChat();
    answer(stored);
    await vi.waitFor(() => expect(orchestrator.observe).toHaveBeenCalled());

    expect(session.getSnapshot().messages).toEqual([]);
  });
});

describe('ChatSession.refresh: the history of the folder asked for', () => {
  it('does not let a read for the folder the tab was in overwrite the history of the one it has moved to', async () => {
    const orchestrator = fakeOrchestrator();
    const answers: Array<(rows: never[]) => void> = [];
    orchestrator.listChats.mockImplementation(
      () => new Promise((resolve) => { answers.push(resolve); }),
    );
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const stale = session.refresh();
    const current = { path: 'c:1', id: '1', cwd: '/p', title: 'mine', created: '', modified: '' };
    const moved = session.followRoot('/p');

    // The newer scope answers first, then the older read arrives with every folder's chats.
    answers[1]?.([current] as never[]);
    await moved;
    answers[0]?.([{ ...current, path: 'c:2', title: 'elsewhere' }] as never[]);
    await stale;

    expect(session.getSnapshot().sessions.map((row) => row.title)).toEqual(['mine']);
  });
});

describe('ChatSession.followRoot', () => {
  it('scopes the history to the folder the tab has adopted, without re-rooting the sidecar', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);

    const listed: ChatSessionInfo[] = [
      { path: 'claude-code:1', engine: 'claude-code', id: '1', cwd: '/home/you/project', title: 'a', created: '', modified: '' },
    ];
    orchestrator.listChats.mockImplementation(() => Promise.resolve(listed));

    await session.followRoot('/home/you/project');

    expect(orchestrator.listChats).toHaveBeenLastCalledWith('/home/you/project');
    expect(session.getSnapshot().sessions).toEqual(listed);
    expect(orchestrator.setRoot).not.toHaveBeenCalled();
    expect(orchestrator.openChat).not.toHaveBeenCalled();
    // Which chat is open is not asked again: the sidecar has just said.
    expect(orchestrator.currentChat).not.toHaveBeenCalled();
  });

  it('goes back to every folder for Global, and asks for nothing when the scope is already that', async () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    await session.followRoot('/home/you/project');
    orchestrator.listChats.mockClear();

    await session.followRoot('/home/you/project');
    expect(orchestrator.listChats).not.toHaveBeenCalled();
    await session.followRoot(null);

    expect(orchestrator.listChats).toHaveBeenCalledTimes(1);
    expect(orchestrator.listChats).toHaveBeenCalledWith(null);
  });

  it('keeps the history of the folder it ended up in when two moves overlap and the older answers last', async () => {
    const orchestrator = fakeOrchestrator();
    const answers = new Map<string | null, (rows: ChatSessionInfo[]) => void>();
    orchestrator.listChats.mockImplementation(
      (root: string | null) => new Promise((resolve) => { answers.set(root, resolve); }),
    );
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    const row = (title: string): ChatSessionInfo => ({ path: title, engine: 'pi', id: title, cwd: '/x', title, created: '', modified: '' });

    const first = session.followRoot('/a');
    const second = session.followRoot('/b');
    answers.get('/b')?.([row('b')]);
    await second;
    answers.get('/a')?.([row('a')]);
    await first;

    expect(session.getSnapshot().sessions.map((entry) => entry.title)).toEqual(['b']);
  });
});

describe('ChatSession: the engine refuses to drive a conversation another Claude Code holds', () => {
  const refuse = (orchestrator: FakeOrchestrator, message = 'stopped here'): void => {
    orchestrator.sendHandlers.at(-1)?.onError(message, 'claude_live_elsewhere');
  };

  it('hands the queued messages back for the composer instead of sending them, so the owner decides', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.send('first');
    session.send('second');
    session.send('third');

    refuse(orchestrator);

    // Sending 'second' now would fork the conversation without anyone having chosen to.
    expect(orchestrator.send).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().queued).toEqual([]);
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().returned.map((message) => message.text)).toEqual(['second', 'third']);
    expect(messageList(session.getSnapshot()).at(-1)?.error).toBe('stopped here');
  });

  it('keeps them until something takes them, and gives each only once', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.send('first');
    session.send('second');
    refuse(orchestrator);

    // Nobody is mounted to take them yet: they wait.
    expect(session.getSnapshot().returned).toHaveLength(1);
    expect(session.takeReturned().map((message) => message.text)).toEqual(['second']);
    expect(session.getSnapshot().returned).toEqual([]);
    expect(session.takeReturned()).toEqual([]);
  });

  it('is only for this refusal: any other failure still sends the next queued message', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.send('first');
    session.send('second');

    orchestrator.sendHandlers.at(-1)?.onError('boom', 'claude_turn_error');

    expect(orchestrator.send).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().returned).toEqual([]);
  });

  it('has nothing to hand back when nothing was queued', () => {
    const orchestrator = fakeOrchestrator();
    const session = new ChatSession(orchestrator as unknown as ChatOrchestrator);
    session.send('first');

    refuse(orchestrator);

    expect(session.getSnapshot().returned).toEqual([]);
  });
});

describe('ChatSession compact (T2.4b)', () => {
  it('holds the chat busy while it runs, cannot be cancelled, queues meanwhile, and reloads the transcript after', async () => {
    const orchestrator = fakeOrchestrator();
    let finish: () => void = () => undefined;
    const compact = vi.fn(() => new Promise<{ compacted: true }>((resolve) => (finish = () => resolve({ compacted: true }))));
    const after: ChatTimelineItem[] = [{ kind: 'compaction', id: 'k1', trigger: 'manual', preTokens: 9000 } as unknown as ChatTimelineItem];
    orchestrator.transcript.mockImplementation(() => Promise.resolve(after));
    const session = new ChatSession({ ...orchestrator, compact } as unknown as ChatOrchestrator, undefined, 'tab-1');

    const done = session.compact('keep notes');
    expect(compact).toHaveBeenCalledWith('keep notes', 'tab-1');
    expect(session.getSnapshot()).toMatchObject({ busy: true, turnNotice: expect.stringMatching(/compacting/u) as unknown });
    // Esc/STOP: nothing to stop, and nothing is cleared.
    expect(session.cancel()).toEqual([]);
    expect(session.getSnapshot().busy).toBe(true);
    session.send('after it');
    expect(session.getSnapshot().queued.map((q) => q.text)).toEqual(['after it']);
    await expect(session.compact()).rejects.toThrow(/a turn is running/u);

    finish();
    await done;
    expect(orchestrator.send).toHaveBeenCalledWith('after it', expect.anything(), undefined, [], 'tab-1');
    expect(session.getSnapshot().messages[0]).toBe(after[0]);
  });

  it('hands a failure back and frees the chat', async () => {
    const orchestrator = fakeOrchestrator();
    const compact = vi.fn(() => Promise.reject(new Error('Nothing to compact (session too small)')));
    const session = new ChatSession({ ...orchestrator, compact } as unknown as ChatOrchestrator);
    await expect(session.compact()).rejects.toThrow('Nothing to compact');
    expect(session.getSnapshot()).toMatchObject({ busy: false, turnNotice: null });
  });
});
