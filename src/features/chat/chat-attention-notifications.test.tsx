import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import type { ChatChunk, ChatTimelineItem } from '@shared/transport/protocol.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { DEFAULT_PREFERENCES } from '@features/settings/preferences.types.ts';
import { SettingsPanel } from '@features/settings/SettingsPanel.tsx';
import type { ChatOrchestrator } from './chat-orchestrator.client.ts';
import { ChatSession } from './chat-session.service.ts';
import { ChatAttentionNotifications } from './chat-attention-notifications.service.ts';

interface CapturedNotification {
  title: string;
  body: string | undefined;
  onclick: (() => void) | null;
}

function notifications(
  permission: NotificationPermission = 'granted',
  requestResult: NotificationPermission = permission,
) {
  const captured: CapturedNotification[] = [];
  const requestPermission = vi.fn(() => Promise.resolve(requestResult));
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      captured.push({ title, body: options?.body, onclick: null });
      const record = captured.at(-1)!;
      Object.defineProperty(this, 'onclick', {
        get: () => record.onclick,
        set: (value: (() => void) | null) => {
          record.onclick = value;
        },
      });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { captured, requestPermission, FakeNotification };
}

function hidden(value = true): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value ? 'hidden' : 'visible');
}

interface FakeOrchestrator {
  send: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  transcript: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  currentChat: ReturnType<typeof vi.fn>;
  sendHandlers: Array<{ onChunk: (chunk: ChatChunk) => void; onDone: () => void }>;
  observers: Array<{ onChunk: (chunk: ChatChunk) => void }>;
}

function orchestrator(transcript: ChatTimelineItem[] = []): FakeOrchestrator {
  const fake: FakeOrchestrator = {
    send: vi.fn(),
    observe: vi.fn(),
    transcript: vi.fn(() => Promise.resolve(transcript)),
    listChats: vi.fn(() => Promise.resolve([])),
    currentChat: vi.fn(() => Promise.resolve(null)),
    sendHandlers: [],
    observers: [],
  };
  fake.send.mockImplementation(
    (_text: string, handlers: { onChunk: (chunk: ChatChunk) => void; onDone: () => void }) => {
      fake.sendHandlers.push(handlers);
      return () => undefined;
    },
  );
  fake.observe.mockImplementation((handlers: { onChunk: (chunk: ChatChunk) => void }) => {
    fake.observers.push(handlers);
    return () => undefined;
  });
  return fake;
}

function harness(transcript: ChatTimelineItem[] = []) {
  const prefs = new PreferencesService(new MemoryStorageAdapter());
  prefs.update({ notifyChat: true });
  const attention = new ChatAttentionNotifications(prefs);
  const fake = orchestrator(transcript);
  const session = new ChatSession(fake as unknown as ChatOrchestrator, undefined, 'this-tab', attention);
  const observer = async (index = 0) => {
    await vi.waitFor(() => expect(fake.observers[index]).toBeDefined());
    return fake.observers[index]!;
  };
  return { prefs, attention, fake, session, observer };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function crewResult(id: string, status: string, agentId = 'agent-1'): ChatChunk {
  return {
    kind: 'custom-message',
    id,
    customType: 'crew-result',
    display: true,
    content: status,
    details: { agentId, agentName: 'Scout', status },
    timestamp: Date.now() + 1,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat attention preferences', () => {
  it('defaults off, persists independently of Helmraiser', () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.preferences', { notifyHelmraiser: true });
    const prefs = new PreferencesService(storage);
    expect(prefs.get()).toMatchObject({ notifyChat: false, notifyHelmraiser: true });

    prefs.update({ notifyChat: true });
    const revived = new PreferencesService(storage);
    expect(revived.get()).toMatchObject({ notifyChat: true, notifyHelmraiser: true });
    expect(DEFAULT_PREFERENCES.notifyChat).toBe(false);
  });

  it('requests permission on enable, disables immediately, and stays off on denial', async () => {
    const { requestPermission } = notifications('default', 'granted');
    const service = new PreferencesService(new MemoryStorageAdapter());
    const container = new Container();
    container.registerInstance(PREFERENCES, service);
    render(<ContainerProvider container={container}><SettingsPanel /></ContainerProvider>);
    const toggle = screen.getByRole('switch', { name: 'Notify me when chat work finishes' });

    await userEvent.click(toggle);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(service.get().notifyChat).toBe(true);
    await userEvent.click(toggle);
    expect(service.get().notifyChat).toBe(false);

    vi.stubGlobal('Notification', class DeniedNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission = vi.fn(() =>
        Promise.resolve<NotificationPermission>('denied'),
      );
    });
    await userEvent.click(toggle);
    expect(service.get().notifyChat).toBe(false);
  });
});

describe('turn-finished attention', () => {
  it('notifies once for this tab turn-ended, using only assistant text as fallback', async () => {
    hidden();
    const note = notifications();
    const { fake, session, observer } = harness();
    const observed = await observer();
    session.send('question');
    fake.sendHandlers[0]!.onChunk({ kind: 'thinking', delta: 'secret' });
    fake.sendHandlers[0]!.onChunk({ kind: 'tool-result', callId: 'x', ok: true, output: 'tool' });
    fake.sendHandlers[0]!.onChunk({ kind: 'text', delta: 'A'.repeat(100) });
    fake.sendHandlers[0]!.onDone();

    observed.onChunk({ kind: 'turn-started', origin: 'this-tab' });
    observed.onChunk({ kind: 'turn-ended', origin: 'this-tab' });
    observed.onChunk({ kind: 'turn-ended', origin: 'this-tab' });

    expect(note.captured).toEqual([
      { title: 'FO: turn finished', body: 'A'.repeat(80), onclick: expect.any(Function) },
    ]);
  });

  it('reconciles another client and pi-crew turns before delivery and uses the session title', async () => {
    hidden();
    const note = notifications();
    const timeline: ChatTimelineItem[] = [
      { id: 'a', role: 'assistant', steps: [{ kind: 'text', text: 'foreign answer' }], createdAt: 2 },
    ];
    const { fake, session, observer } = harness(timeline);
    const observed = await observer();
    fake.currentChat.mockResolvedValue({
      path: '/one.jsonl', id: 'one', cwd: '/work', title: 'Shared session', created: '', modified: '',
    });
    await session.refresh();

    for (const origin of ['other-client', 'agent']) {
      observed.onChunk({ kind: 'turn-started', origin });
      observed.onChunk({ kind: 'turn-ended', origin });
      await settle();
    }

    expect(note.captured.map((item) => [item.title, item.body])).toEqual([
      ['FO: turn finished', 'Shared session'],
      ['FO: turn finished', 'Shared session'],
    ]);
    expect(fake.transcript).toHaveBeenCalledTimes(3);
  });

  it('does nothing without permission or the Notification API', async () => {
    hidden();
    const denied = notifications('denied');
    const first = harness();
    const firstObserver = await first.observer();
    firstObserver.onChunk({ kind: 'turn-started', origin: 'this-tab' });
    firstObserver.onChunk({ kind: 'turn-ended', origin: 'this-tab' });
    expect(denied.captured).toEqual([]);

    vi.unstubAllGlobals();
    const second = harness();
    const secondObserver = await second.observer();
    secondObserver.onChunk({ kind: 'turn-started', origin: 'this-tab' });
    secondObserver.onChunk({ kind: 'turn-ended', origin: 'this-tab' });
  });

  it('requires hidden, enabled and granted conditions at both arrival and delayed delivery', async () => {
    hidden(false);
    const note = notifications();
    const { prefs, fake, observer } = harness();
    const observed = await observer();
    observed.onChunk({ kind: 'turn-started', origin: 'other' });
    observed.onChunk({ kind: 'turn-ended', origin: 'other' });
    hidden();
    await settle();
    expect(note.captured).toEqual([]);

    observed.onChunk({ kind: 'turn-started', origin: 'other' });
    observed.onChunk({ kind: 'turn-ended', origin: 'other' });
    prefs.update({ notifyChat: false });
    await settle();
    expect(note.captured).toEqual([]);
    expect(fake.transcript).toHaveBeenCalledTimes(3);
  });
});

describe('crew attention', () => {
  it('notifies completed, needs_input and error once, retaining the removed error row label', async () => {
    hidden();
    const note = notifications();
    const { fake, session, observer } = harness();
    const observed = await observer();
    session.send('spawn');
    const send = fake.sendHandlers[0]!;
    send.onChunk({ kind: 'tool-call', callId: 'spawn', tool: 'crew_spawn', summary: '', args: { agent: 'Scout' } });
    send.onChunk({ kind: 'tool-result', callId: 'spawn', ok: true, details: { id: 'agent-1' } });

    observed.onChunk(crewResult('complete', 'completed'));
    observed.onChunk(crewResult('complete', 'completed'));
    observed.onChunk(crewResult('input', 'needs_input'));
    observed.onChunk(crewResult('error', 'error'));

    expect(note.captured.map((item) => [item.title, item.body])).toEqual([
      ['FO: crew agent completed', 'Scout'],
      ['FO: crew agent needs_input', 'Scout'],
      ['FO: crew agent error', 'Scout'],
    ]);
    expect(session.getSnapshot().activeCrew).toEqual([]);
  });

  it('suppresses future-dated reconnect readback but not the next genuinely live event', async () => {
    hidden();
    const note = notifications();
    const prefs = new PreferencesService(new MemoryStorageAdapter());
    prefs.update({ notifyChat: true });
    const attention = new ChatAttentionNotifications(prefs);
    const fake = orchestrator();
    const listeners = new Set<() => void>();
    let state = 'closed';
    const transport = {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    new ChatSession(fake as unknown as ChatOrchestrator, transport, 'this-tab', attention);
    await vi.waitFor(() => expect(fake.observers[0]).toBeDefined());
    const replay = crewResult('stored', 'completed');
    if (replay.kind === 'custom-message') replay.timestamp = Date.now() + 60_000;
    fake.transcript.mockResolvedValue([replay as ChatTimelineItem]);
    state = 'open';
    listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(fake.observers[1]).toBeDefined());
    const reconnected = fake.observers[1]!;
    reconnected.onChunk(replay);
    reconnected.onChunk(crewResult('new-live', 'completed', 'agent-2'));

    expect(note.captured.map((item) => item.body)).toEqual(['Scout']);
  });

  it('does not re-notify an unchanged crew-status snapshot or duplicate readback', async () => {
    hidden();
    const note = notifications();
    const { fake, session, observer } = harness();
    const observed = await observer();
    session.send('spawn');
    const send = fake.sendHandlers[0]!;
    send.onChunk({ kind: 'tool-call', callId: 'spawn', tool: 'crew_spawn', summary: '', args: { agent: 'Scout' } });
    send.onChunk({ kind: 'tool-result', callId: 'spawn', ok: true, details: { id: 'agent-1' } });
    const status = (id: string, timestamp: number): ChatChunk => ({
      kind: 'custom-message', id, customType: 'crew-status', display: false,
      content: '{"type":"crew_status","agents":[{"id":"agent-1","status":"completed"}]}',
      details: {}, timestamp,
    });

    observed.onChunk(status('live-1', Date.now() + 1));
    observed.onChunk(status('live-2', Date.now() + 2));
    observed.onChunk(crewResult('historical', 'completed'));
    expect(note.captured).toHaveLength(1);
  });
});

describe('notification click', () => {
  it('focuses, opens chat and scrolls the mounted or next-mounted transcript to latest', async () => {
    hidden();
    const note = notifications();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { attention, observer } = harness();
    const observed = await observer();
    const openChat = vi.fn();
    const firstScroll = vi.fn();
    attention.start(openChat);
    const detach = attention.attachScroller(firstScroll);

    observed.onChunk({ kind: 'turn-started', origin: 'other' });
    observed.onChunk({ kind: 'turn-ended', origin: 'other' });
    await settle();
    note.captured[0]!.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalledOnce();
    expect(firstScroll).toHaveBeenCalledOnce();

    detach();
    observed.onChunk(crewResult('later', 'completed'));
    note.captured.at(-1)!.onclick?.();
    const remountedScroll = vi.fn();
    attention.attachScroller(remountedScroll);
    expect(remountedScroll).toHaveBeenCalledOnce();
  });
});

describe('notifications across tabs', () => {
  function tabHarness() {
    const prefs = new PreferencesService(new MemoryStorageAdapter());
    prefs.update({ notifyChat: true });
    const attention = new ChatAttentionNotifications(prefs);
    const tab = (chatId: string) => {
      const fake = orchestrator();
      const session = new ChatSession(
        { ...fake, chatId } as unknown as ChatOrchestrator,
        undefined,
        `window-${chatId}`,
        attention,
      );
      const observer = async () => {
        await vi.waitFor(() => expect(fake.observers[0]).toBeDefined());
        return fake.observers[0]!;
      };
      return { session, observer };
    };
    return { attention, tab };
  }

  it('notifies a turn ending in each tab, even when the same client ran both', async () => {
    hidden();
    const note = notifications();
    const { tab } = tabHarness();
    const a = await tab('a').observer();
    const b = await tab('b').observer();

    a.onChunk({ kind: 'turn-started', origin: 'cli:1' });
    b.onChunk({ kind: 'turn-started', origin: 'cli:1' });
    a.onChunk({ kind: 'turn-ended', origin: 'cli:1' });
    b.onChunk({ kind: 'turn-ended', origin: 'cli:1' });
    await settle();

    expect(note.captured.map((n) => n.title)).toEqual(['FO: turn finished', 'FO: turn finished']);
  });

  it('a click shows the tab the turn ended in, and scrolls that tab’s transcript once it mounts', async () => {
    hidden();
    const note = notifications();
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { attention, tab } = tabHarness();
    const b = await tab('b').observer();
    const opened: string[] = [];
    attention.start((chatId) => {
      opened.push(chatId);
      return true; // another tab was shown: its panel mounts next
    });
    const shownScroll = vi.fn();
    attention.attachScroller(shownScroll);

    b.onChunk({ kind: 'turn-started', origin: 'cli:1' });
    b.onChunk({ kind: 'turn-ended', origin: 'cli:1' });
    await settle();
    note.captured[0]!.onclick?.();

    expect(opened).toEqual(['b']);
    expect(shownScroll).not.toHaveBeenCalled();
    const bScroll = vi.fn();
    attention.attachScroller(bScroll);
    expect(bScroll).toHaveBeenCalledOnce();
  });
});
