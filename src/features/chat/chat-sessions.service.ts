import { token, type Container } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';
import {
  MAIN_CHAT,
  sessionRefOf,
  type ChatSlotInfo,
  type ChatSlotsEvent,
  type EngineKind,
} from '@shared/transport/protocol.ts';
import type { ChatLiveActivity, ChatSession } from './chat-session.service.ts';

/** What the store uses of the transport. */
export type ChatSessionsTransport = Pick<
  TransportClient,
  'call' | 'stream' | 'getState' | 'subscribe'
>;

/** One tab as the tab bar draws it. */
export interface ChatTab {
  chatId: string;
  kind: EngineKind;
  title: string;
  /** A turn is live: this window's, another window's, `fo`'s, or one the engine started. */
  busy: boolean;
  /**
   * Attention's one meaning: something waits on the owner — an approval, or a
   * `claude_live_elsewhere` refusal this window got.
   */
  attention: boolean;
  /** A turn ended here while another tab was shown. */
  unread: boolean;
  crew: boolean;
  crewPending: boolean;
  subagentsLeftRunning: number;
  /** Every tab but `main`. */
  closable: boolean;
}

export interface ChatSessionsSnapshot {
  /** `main` first, then in the order the tabs were made. Empty until the slots arrive. */
  tabs: ChatTab[];
  activeChatId: string;
  /** The sidecar's slot list has arrived. */
  ready: boolean;
  /** Why the slot list could not be read (a sidecar older than this page, say); null while it reads. */
  failure: string | null;
  /**
   * Tabs that went away without this window closing them (another window, `fo`,
   * a restart that did not bring them back), until dismissed: the draft guard
   * offers whatever this window still holds unsent for them, whenever Chat is shown.
   */
  closedElsewhere: { chatId: string; title: string }[];
}

/** One tab's services: its conversation, and the container scope its views resolve from. */
export interface ChatTabServices {
  session: ChatSession;
  scope: Container;
}

export interface ChatTabHooks {
  /** Show the tab of a chat that holds a conversation this tab tried to open; false when there is none here. */
  focusHolder: (chatId: string) => boolean;
  /** The tab's engine, once the sidecar has said (main's is not known before). */
  kind: () => EngineKind | null;
}

export type ChatTabFactory = (chatId: string, hooks: ChatTabHooks) => ChatTabServices;

/** The shown tab, per browser window (session storage), so a reload keeps it. */
const ACTIVE_KEY = 'funkyoctopus.chat.active-tab';

interface Tab {
  chatId: string;
  services: ChatTabServices;
  slot: ChatSlotInfo | null;
  unread: boolean;
  stop: () => void;
}

/**
 * The browser's chat tabs (T2.2, decision 13): one `ChatSession` per sidecar
 * chat slot, keyed by `chatId`, each with its own observe stream, so the queue,
 * stop, follow and reducer code is the single-chat code, once per tab.
 *
 * Tabs are server-owned and shared: the list follows `chat.slotsObserve`, so a
 * tab another window or `fo` creates or closes comes and goes live here. Which
 * tab this window shows is its own. Views resolve their chat services from the
 * shown tab's scope (`scope`), so the composer, Leeboard panel, CHAT bar, folder
 * selector and history all follow it.
 */
/**
 * One Helmraiser chat navigation at a time for the whole window (review in its
 * chat, open in chat, discuss): competing clicks are refused, never queued.
 */
export class ReviewNavigation {
  private pending = false;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isPending = (): boolean => this.pending;

  /** The release, or null when another navigation holds the lock. Releasing twice is harmless. */
  tryAcquire = (): (() => void) | null => {
    if (this.pending) return null;
    this.set(true);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.set(false);
    };
  };

  private set(pending: boolean): void {
    this.pending = pending;
    this.listeners.forEach((listener) => listener());
  }
}

export class ChatSessions {
  private readonly tabs = new Map<string, Tab>();
  private active: string = MAIN_CHAT;
  /** The tab a reload restores, held until the slots arrive and say whether it still exists. */
  private restoring: string | null;
  private ready = false;
  private failure: string | null = null;
  private snapshot: ChatSessionsSnapshot = {
    tabs: [],
    activeChatId: MAIN_CHAT,
    ready: false,
    failure: null,
    closedElsewhere: [],
  };
  private closedElsewhere: { chatId: string; title: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly activityListeners = new Set<(activity: ChatLiveActivity) => void>();
  private cancelSlots: (() => void) | null = null;
  /** This window's identity on create and close, so the slot events name it. */
  private readonly clientId = crypto.randomUUID();
  /** Held through a Helmraiser chat navigation, across tab switches and row unmounts. */
  readonly reviewNavigation = new ReviewNavigation();

  constructor(
    private readonly transport: ChatSessionsTransport,
    private readonly makeTab: ChatTabFactory,
    private readonly storage: StorageAdapter,
    /**
     * Per-tab browser state (model picks, folders), pruned to the tabs that
     * exist; a store that keeps folders also follows each slot's root.
     */
    private readonly pruned: ReadonlyArray<{
      retain(chatIds: readonly string[]): void;
      follow?(chatId: string, root: string | null, holdsSession: boolean): void;
    }> = [],
  ) {
    const stored = storage.get<string>(ACTIVE_KEY);
    this.restoring = stored && stored !== MAIN_CHAT ? stored : null;
    this.ensure(MAIN_CHAT);
    transport.subscribe(() => {
      if (transport.getState() === 'open') this.observeSlots();
    });
    this.observeSlots();
  }

  getSnapshot = (): ChatSessionsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Turn endings and crew results from every tab, for the away digest. */
  subscribeActivity = (listener: (activity: ChatLiveActivity) => void): (() => void) => {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  };

  /** Stop offering a closed tab's draft: it was taken, or the owner let it go. */
  dismissClosed(chatId: string): void {
    this.closedElsewhere = this.closedElsewhere.filter((tab) => tab.chatId !== chatId);
    this.changed();
  }

  session(chatId: string): ChatSession {
    const tab = this.tabs.get(chatId);
    if (!tab) throw new Error(`no tab for chat ${chatId}`);
    return tab.services.session;
  }

  /** The container scope a tab's views resolve from; `main`'s for a tab that is gone. */
  scope(chatId: string): Container {
    const tab = this.tabs.get(chatId) ?? this.tabs.get(MAIN_CHAT);
    if (!tab) throw new Error('the main tab is missing');
    return tab.services.scope;
  }

  /** Show a tab; false when there is no such tab here. */
  activate(chatId: string): boolean {
    const tab = this.tabs.get(chatId);
    if (!tab || (!tab.slot && chatId !== MAIN_CHAT)) return false;
    this.active = chatId;
    this.restoring = null;
    tab.unread = false;
    this.storage.set(ACTIVE_KEY, chatId);
    this.changed();
    return true;
  }

  /** Show the tab at a position, 1-based; 9 is always the last, as in browsers. */
  jump(position: number): boolean {
    const tabs = this.snapshot.tabs;
    const target = position === 9 ? tabs.at(-1) : tabs[position - 1];
    return target ? this.activate(target.chatId) : false;
  }

  /** Show the next (1) or previous (-1) tab, wrapping. */
  cycle(delta: 1 | -1): void {
    const tabs = this.snapshot.tabs;
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.chatId === this.active);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) this.activate(next.chatId);
  }

  /**
   * Open a tab on a new conversation of `kind` in `root` (null: the global
   * root), and show it. The sidecar's refusals — the cap among them — reach the
   * caller as it words them.
   */
  async create(
    kind: EngineKind,
    root: string | null,
    /** Runs before the new tab is shown: for the tab's own browser state (its folder). */
    prepare?: (chatId: string) => void,
  ): Promise<string> {
    const chatId = await this.add(kind, root);
    prepare?.(chatId);
    this.activate(chatId);
    return chatId;
  }

  /**
   * Close a tab everywhere. The sidecar refuses a live turn unless `force`
   * (the tab bar asks first); `main` is never closed.
   */
  async close(chatId: string, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (chatId === MAIN_CHAT) throw new Error('the main chat cannot be closed');
    await this.transport.call('chat.close', {
      chatId,
      clientId: this.clientId,
      ...(force ? { force: true } : {}),
    });
    this.remove(chatId);
  }

  /**
   * Show the tab holding a stored conversation, or open it in a new tab of its
   * engine. Serves Helmraiser's "review in its chat" (the conversation a run was
   * queued from) and the Ctrl+K stored-chat search (T2.5). A holder this
   * window had not heard of yet wins: the new tab closes again. Resolves with
   * the tab shown, so a review prompt lands there; throws the sidecar's
   * refusal.
   */
  async reviewInOrigin(path: string): Promise<string> {
    const ref = sessionRefOf(path);
    if (ref) {
      const holder = [...this.tabs.values()].find((tab) => {
        const held = tab.slot?.session ?? tab.services.session.getSnapshot().activeSession;
        return held?.engine === ref.engine && held.id === ref.id;
      });
      if (holder) {
        this.activate(holder.chatId);
        return holder.chatId;
      }
    }
    const chatId = await this.add(ref?.engine ?? 'pi', null);
    let opened: boolean;
    try {
      opened = await this.session(chatId).openChat(path);
    } catch (error) {
      await this.close(chatId).catch(() => undefined);
      throw error;
    }
    if (opened) {
      this.activate(chatId);
      return chatId;
    }
    // Another tab held it after all, and is shown now.
    await this.close(chatId).catch(() => undefined);
    return this.active;
  }

  private async add(kind: EngineKind, root: string | null): Promise<string> {
    const created = await this.transport.call('chat.create', {
      kind,
      root,
      clientId: this.clientId,
    });
    this.ensure(created.chatId).slot = created;
    this.changed();
    return created.chatId;
  }

  private observeSlots(): void {
    this.cancelSlots?.();
    this.cancelSlots = this.transport.stream(
      'chat.slotsObserve',
      {},
      {
        onChunk: (event) => {
          try {
            this.follow(event as ChatSlotsEvent);
          } catch (e) {
            this.fail(`the sidecar's tab list could not be read (${e instanceof Error ? e.message : String(e)})`);
          }
        },
        // A dropped connection ends the stream too; only a refusal on an open one is a failure.
        onEnd: (error) => {
          if (error && this.transport.getState() === 'open')
            this.fail(`the sidecar refused the tab list (${error.message})`);
        },
      },
    );
  }

  private fail(why: string): void {
    this.failure = `${why} — it may be older than this page; restart it, then reload`;
    this.changed();
  }

  private follow(event: ChatSlotsEvent): void {
    if (event.kind === 'slots') {
      const live = new Set(event.slots.map((slot) => slot.chatId));
      for (const chatId of [...this.tabs.keys()])
        if (!live.has(chatId) && chatId !== MAIN_CHAT) this.remove(chatId, true);
      for (const slot of event.slots) this.place(slot);
      this.ready = true;
      this.failure = null;
      for (const store of this.pruned) store.retain([...live]);
      const restoring = this.restoring;
      this.restoring = null;
      if (restoring && live.has(restoring)) this.activate(restoring);
    } else if (event.kind === 'slot-created' || event.kind === 'slot-state') {
      // A state for a tab already closed here is late, not a new tab.
      if (event.kind === 'slot-state' && !this.tabs.has(event.slot.chatId)) return;
      this.place(event.slot);
    } else {
      this.remove(event.chatId, event.origin !== this.clientId);
      return;
    }
    this.changed();
  }

  /** A slot as the sidecar has it now: its tab, and the folder that tab shows. */
  private place(slot: ChatSlotInfo): void {
    this.ensure(slot.chatId).slot = slot;
    for (const store of this.pruned) store.follow?.(slot.chatId, slot.root, slot.session !== null);
  }

  private ensure(chatId: string): Tab {
    const existing = this.tabs.get(chatId);
    if (existing) return existing;
    const services = this.makeTab(chatId, {
      focusHolder: (holder) => this.activate(holder),
      kind: () => this.tabs.get(chatId)?.slot?.kind ?? null,
    });
    const tab: Tab = { chatId, services, slot: null, unread: false, stop: () => undefined };
    const stopSnapshot = services.session.subscribe(() => this.changed());
    const stopActivity = services.session.subscribeActivity((activity) => {
      if (activity.kind === 'turn-ended' && chatId !== this.active && !tab.unread) {
        tab.unread = true;
        this.changed();
      }
      this.activityListeners.forEach((listener) => listener(activity));
    });
    tab.stop = () => {
      stopSnapshot();
      stopActivity();
    };
    this.tabs.set(chatId, tab);
    return tab;
  }

  /** A tab is gone: its streams end; if it was shown, its left neighbour is. */
  private remove(chatId: string, elsewhere = false): void {
    const tab = this.tabs.get(chatId);
    if (!tab || chatId === MAIN_CHAT) return;
    const title = this.snapshot.tabs.find((row) => row.chatId === chatId)?.title ?? 'untitled chat';
    if (this.active === chatId) {
      const order = this.snapshot.tabs.map((row) => row.chatId);
      const left = order[order.indexOf(chatId) - 1];
      this.active = left && this.tabs.has(left) ? left : MAIN_CHAT;
      this.storage.set(ACTIVE_KEY, this.active);
    }
    tab.stop();
    tab.services.session.dispose();
    this.tabs.delete(chatId);
    if (elsewhere) this.closedElsewhere = [...this.closedElsewhere.filter((row) => row.chatId !== chatId), { chatId, title }];
    this.changed();
  }

  /** Rebuild the tab list; tell listeners only when what a tab shows changed, not on every streamed chunk. */
  private changed(): void {
    const tabs = [...this.tabs.values()]
      .filter((tab): tab is Tab & { slot: ChatSlotInfo } => tab.slot !== null)
      .sort((a, b) =>
        a.chatId === MAIN_CHAT
          ? -1
          : b.chatId === MAIN_CHAT
            ? 1
            : a.slot.createdAt - b.slot.createdAt,
      )
      .map((tab): ChatTab => {
        const session = tab.services.session.getSnapshot();
        return {
          chatId: tab.chatId,
          kind: tab.slot.kind,
          // An empty conversation reads as the sidecar labels one.
          title: session.activeSession?.title || tab.slot.session?.title || 'untitled chat',
          busy: tab.slot.busy || session.busy,
          attention: tab.slot.attention || session.refused,
          unread: tab.unread,
          crew: tab.slot.crew,
          crewPending: tab.slot.crewPending,
          subagentsLeftRunning: tab.slot.subagentsLeftRunning,
          closable: tab.chatId !== MAIN_CHAT,
        };
      });
    const next: ChatSessionsSnapshot = {
      tabs,
      activeChatId: this.active,
      ready: this.ready,
      failure: this.failure,
      closedElsewhere: this.closedElsewhere,
    };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const CHAT_SESSIONS = token<ChatSessions>('ChatSessions');
