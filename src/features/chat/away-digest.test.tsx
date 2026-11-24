import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { useShell } from '@core/shell/useShell.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PreferencesService } from '@features/settings/preferences.service.ts';
import type { ChatChunk, HelmraiserEvent } from '@shared/transport/protocol.ts';
import type { ChatHandlers, ChatOrchestrator } from './chat-orchestrator.client.ts';
import { ChatSession } from './chat-session.service.ts';
import type { WorkflowClient } from '@features/jobs/workflow.client.ts';
import type { SystemClient } from '@features/status/system.client.ts';
import {
  HelmraiserNotifications,
  type ConnectionSurface,
} from '@features/jobs/helmraiser-notifications.service.ts';
import { AWAY_DIGEST, AwayDigest } from './away-digest.ts';
import { AwayDigestCard } from './AwayDigestCard.tsx';
import { useAwayDigestLifecycle } from './useAwayDigest.ts';

class VisibilityPage extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

interface Harness {
  now: { value: number };
  page: VisibilityPage;
  digest: AwayDigest;
  chat: ChatSession;
  send: ChatHandlers[];
  chatObserver: (chunk: ChatChunk) => void;
  helmraiser: (event: HelmraiserEvent) => void;
  stop: () => void;
}

const helmraiserEvent = (event: HelmraiserEvent['event'], title = 'Release'): HelmraiserEvent => ({
  kind: 'helmraiser-event',
  event,
  runId: `run-${event}`,
  task: 'task.md',
  title,
});

async function harness(): Promise<Harness> {
  const now = { value: 1_000_000 };
  const send: ChatHandlers[] = [];
  let chatObserver = (_chunk: ChatChunk): void => undefined;
  const orchestrator = {
    send: (_text: string, handlers: ChatHandlers) => {
      send.push(handlers);
      return () => undefined;
    },
    observe: (handlers: { onChunk: (chunk: ChatChunk) => void }) => {
      chatObserver = handlers.onChunk;
      return () => undefined;
    },
    transcript: () => Promise.resolve([]),
    listChats: () => Promise.resolve([]),
    currentChat: () => Promise.resolve(null),
  } as unknown as ChatOrchestrator;
  const chat = new ChatSession(orchestrator, undefined, 'this-tab');

  let helmraiser = (_event: HelmraiserEvent): void => undefined;
  const workflow = {
    observe: (handlers: { onEvent: (event: HelmraiserEvent) => void }) => {
      helmraiser = handlers.onEvent;
      return () => {
        helmraiser = () => undefined;
      };
    },
  } as unknown as WorkflowClient;
  const system = {
    health: () =>
      Promise.resolve({
        ok: true as const,
        service: 'funkyoctopus-sidecar' as const,
        version: 'test',
        uptimeMs: 0,
        backends: {},
      }),
  } as unknown as SystemClient;
  const preferences = new PreferencesService(new MemoryStorageAdapter());
  const connection: ConnectionSurface = {
    getState: () => 'open',
    subscribe: () => () => undefined,
  };
  const notifications = new HelmraiserNotifications(workflow, system, preferences, connection);
  const stopNotifications = notifications.start(() => undefined);
  await vi.waitFor(() => {
    expect(helmraiser).not.toBe(undefined);
  });
  // Let the health promise open the production observation stream.
  await Promise.resolve();
  await Promise.resolve();

  const page = new VisibilityPage();
  const digest = new AwayDigest(chat, notifications, page, () => now.value);
  const stopDigest = digest.start();
  return {
    now,
    page,
    digest,
    chat,
    send,
    chatObserver: (chunk) => chatObserver(chunk),
    helmraiser: (event) => helmraiser(event),
    stop: () => {
      stopDigest();
      stopNotifications();
    },
  };
}

function hide(h: Harness): void {
  act(() => h.page.set('hidden'));
}

function showAfter(h: Harness, elapsed: number): void {
  h.now.value += elapsed;
  act(() => h.page.set('visible'));
}

function renderCard(h: Harness, onChat = vi.fn()) {
  const container = new Container();
  container.registerInstance(AWAY_DIGEST, h.digest);
  function View() {
    const { view } = useShell();
    useAwayDigestLifecycle();
    return (
      <>
        <output aria-label="view">{view}</output>
        <AwayDigestCard onChat={onChat} />
      </>
    );
  }
  return render(
    <ContainerProvider container={container}>
      <ShellProvider>
        <View />
      </ShellProvider>
    </ContainerProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('away digest live integration', () => {
  it('ignores visible events, an empty interval, and a 59,999 ms interval', async () => {
    const h = await harness();
    h.chatObserver({ kind: 'turn-ended', origin: 'cli' });
    expect(h.digest.getSnapshot()).toBeNull();

    hide(h);
    showAfter(h, 60_000);
    expect(h.digest.getSnapshot()).toBeNull();

    hide(h);
    h.helmraiser(helmraiserEvent('awaiting'));
    showAfter(h, 59_999);
    expect(h.digest.getSnapshot()).toBeNull();
    h.stop();
  });

  it('shows local, other-client and agent turn endings once at exactly 60 seconds', async () => {
    const h = await harness();
    hide(h);
    h.chat.send('local');
    act(() => h.send[0]?.onDone());
    // The observed echo from this tab is ignored by the production ChatSession.
    h.chatObserver({ kind: 'turn-ended', origin: 'this-tab' });
    h.chatObserver({ kind: 'turn-ended', origin: 'cli' });
    h.chatObserver({ kind: 'turn-ended', origin: 'agent' });
    showAfter(h, 60_000);

    const snapshot = h.digest.getSnapshot();
    expect(snapshot?.entries.map((entry) => entry.label)).toEqual([
      'A turn finished',
      'A turn finished',
      'A turn finished',
    ]);
    h.stop();
  });

  it('records a turn that failed, as attention', async () => {
    const h = await harness();
    hide(h);
    h.chat.send('local');
    act(() => h.send[0]?.onError('model unavailable'));
    showAfter(h, 60_000);

    expect(h.digest.getSnapshot()?.entries).toEqual([
      expect.objectContaining({ label: 'A turn failed', attention: true }),
    ]);
    h.stop();
  });

  it('records completed, needs-input and error crew results, but not duplicate delivery', async () => {
    const h = await harness();
    hide(h);
    const crew = (id: string, status: 'completed' | 'needs_input' | 'error', name: string): ChatChunk => ({
      kind: 'custom-message',
      id,
      customType: 'crew-result',
      display: true,
      content: name,
      details: { agentId: `agent-${id}`, agentName: name, status },
      timestamp: h.now.value,
    });
    const completed = crew('c1', 'completed', 'Reviewer');
    h.chatObserver(completed);
    h.chatObserver(completed);
    h.chatObserver(crew('c2', 'needs_input', 'Researcher'));
    h.chatObserver(crew('c3', 'error', 'Builder'));
    showAfter(h, 60_000);

    expect(h.digest.getSnapshot()?.entries.map((entry) => entry.label)).toEqual([
      'Builder failed',
      'Researcher needs input',
      'Reviewer completed',
    ]);
    h.stop();
  });

  it('records terminal crew snapshot transitions once, not unchanged snapshots', async () => {
    const h = await harness();
    // Bind a real live row through the production chunk path before hiding.
    h.chat.send('delegate');
    const turn = h.send[0];
    turn?.onChunk({
      kind: 'tool-call', callId: 'spawn', tool: 'crew_spawn', summary: 'spawn', args: { subagent: 'Scout' },
    });
    turn?.onChunk({
      kind: 'tool-result', callId: 'spawn', ok: true, details: { id: 'agent-1' },
    });
    hide(h);
    const status: ChatChunk = {
      kind: 'custom-message',
      id: 'status-1',
      customType: 'crew-status',
      display: false,
      content: JSON.stringify({ type: 'crew_status', agents: [{ id: 'agent-1', status: 'completed' }] }),
      details: {},
      timestamp: h.now.value,
    };
    h.chatObserver(status);
    h.chatObserver({ ...status, id: 'status-2' });
    showAfter(h, 60_000);
    expect(h.digest.getSnapshot()?.entries.map((entry) => entry.label)).toEqual(['Scout completed']);
    h.stop();
  });

  it('records current protocol Helmraiser events regardless of notification support or preference', async () => {
    vi.stubGlobal('Notification', undefined);
    const h = await harness();
    hide(h);
    h.helmraiser(helmraiserEvent('awaiting', 'Approve release'));
    h.helmraiser(helmraiserEvent('failed', 'Broken build'));
    h.helmraiser(helmraiserEvent('landed', 'Shipped'));
    showAfter(h, 180_000);
    expect(h.digest.getSnapshot()?.entries.map((entry) => entry.label)).toEqual([
      'Helmraiser landed · Shipped',
      'Helmraiser failed · Broken build',
      'Helmraiser needs approval · Approve release',
    ]);
    h.stop();
  });

  it('renders newest first, relative times, ten rows and the correct overflow', async () => {
    const h = await harness();
    hide(h);
    for (let i = 0; i < 13; i += 1) {
      h.now.value += 60_000;
      h.helmraiser(helmraiserEvent('landed', `Run ${i + 1}`));
    }
    showAfter(h, 60_000);
    renderCard(h);

    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Helmraiser landed · Run 13')).toBeInTheDocument();
    expect(screen.queryByText('Helmraiser landed · Run 3')).not.toBeInTheDocument();
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
    expect(screen.getByText('1m ago')).toBeInTheDocument();
    h.stop();
  });

  it('opens Jobs for Helmraiser and invokes the transcript jump for chat entries', async () => {
    const h = await harness();
    hide(h);
    h.chatObserver({ kind: 'turn-ended', origin: 'cli' });
    h.helmraiser(helmraiserEvent('failed', 'Tests'));
    showAfter(h, 60_000);
    const transcript = document.createElement('div');
    Object.defineProperties(transcript, {
      scrollHeight: { value: 900 },
      scrollTop: { value: 0, writable: true },
    });
    const jump = vi.fn(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
    renderCard(h, jump);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Helmraiser failed/ }));
    expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
    await user.click(screen.getByRole('button', { name: /A turn finished/ }));
    expect(jump).toHaveBeenCalledOnce();
    expect(transcript.scrollTop).toBe(900);
    h.stop();
  });

  it('dismisses and replaces the old digest when a new hidden period starts', async () => {
    const h = await harness();
    hide(h);
    h.helmraiser(helmraiserEvent('failed', 'Old run'));
    showAfter(h, 60_000);
    renderCard(h);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss while you were away' }));
    expect(screen.queryByLabelText('While you were away')).not.toBeInTheDocument();

    hide(h);
    expect(h.digest.getSnapshot()).toBeNull();
    h.helmraiser(helmraiserEvent('landed', 'New run'));
    showAfter(h, 60_000);
    expect(screen.queryByText('Old run')).not.toBeInTheDocument();
    expect(screen.getByText(/New run/)).toBeInTheDocument();
    h.stop();
  });

  it('a fresh service starts empty and capture cleanup does not duplicate events', async () => {
    const h = await harness();
    const firstStop = h.digest.start();
    firstStop();
    h.digest.start();
    hide(h);
    h.helmraiser(helmraiserEvent('failed'));
    showAfter(h, 60_000);
    expect(h.digest.getSnapshot()?.entries).toHaveLength(1);

    const fresh = new AwayDigest(h.chat, {} as HelmraiserNotifications, h.page, () => h.now.value);
    expect(fresh.getSnapshot()).toBeNull();
    h.stop();
  });

  it('stored transcript reconciliation does not manufacture digest entries', async () => {
    const h = await harness();
    hide(h);
    // A visibility event by itself, with no live event delivery, remains empty.
    fireEvent(document, new Event('unrelated'));
    showAfter(h, 60_000);
    expect(h.digest.getSnapshot()).toBeNull();
    h.stop();
  });
});
