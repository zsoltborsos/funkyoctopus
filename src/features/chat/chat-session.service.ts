import { token } from '@core/container/container.ts';
import { CLAUDE_LIVE_ELSEWHERE } from '@shared/transport/errors.ts';
import type { ChatOrchestrator, ChatTurnOptions } from './chat-orchestrator.client.ts';
import { CLI_CLIENT_PREFIX, type ChatImageAttachment, type ChatSessionInfo, type ChatStep } from '@shared/transport/protocol.ts';
import {
  isChatEventItem,
  isCrewAuditItem,
  type ChatChunk,
  type ChatTimelineItem,
} from '@shared/transport/protocol.ts';
import type { ChatMessage, ChatUsage } from './chat.types.ts';
import type {
  ChatAttentionNotifications,
  TurnAttentionTicket,
} from './chat-attention-notifications.service.ts';
import { crewResultDetails } from './crew-card.ts';
import { insertTimelineEvent, reduceChatChunk } from './chat-message.reducer.ts';
import {
  dropUnboundProvisional,
  liveCrewEventFromChunk,
  liveCrewEventFromCustom,
  reduceLiveCrew,
  shouldCountUnread,
  type LiveCrewAgent,
  type PendingControlCalls,
} from './crew-live.ts';

/** The tiny transport surface the observation stream re-subscription needs. */
export interface ConnectionStateSource {
  getState(): string;
  subscribe(listener: () => void): () => void;
}

/** A message typed while a turn was streaming, waiting for its own turn. */
export interface QueuedMessage {
  id: string;
  /** Already-trimmed message text. */
  text: string;
  /** Model/effort captured when the message was typed, not when it is sent. */
  opts?: ChatTurnOptions;
  /** Images attached when the message was typed; travel with it. */
  images?: ChatImageAttachment[];
}

export type ChatLiveActivity =
  /** `failed` when this window's turn ended in an error rather than an answer. */
  | { kind: 'turn-ended'; at: number; failed?: true }
  | { kind: 'crew'; at: number; status: 'completed' | 'needs_input' | 'error'; agentName: string };

type TurnCompletion = {
  resolve: (message: ChatMessage) => void;
  reject: (error: Error) => void;
};

export interface ChatSessionSnapshot {
  messages: ChatTimelineItem[];
  busy: boolean;
  /** Context-window occupancy reported by pi at the end of the last turn. */
  usage: ChatUsage | null;
  /** History for the current root — the rows the History dropdown renders. */
  sessions: ChatSessionInfo[];
  /**
   * The open chat as the sidecar describes it (title, working folder), for the
   * CHAT bar. Null until the first `refresh`, and whenever a switch has not been
   * confirmed yet.
   */
  activeSession: ChatSessionInfo | null;
  /** Session file of the open chat, so its history row can be marked. */
  activeSessionPath: string | null;
  /** Live session-scoped crew agents (Phase 5); never reconstructed from
   *  stored transcripts. */
  activeCrew: LiveCrewAgent[];
  /** Unread displayable crew updates arriving while the panel is not viewed. */
  crewUnread: number;
  /** Messages typed while a turn was streaming; sent one per turn, in order,
   *  when the turn ends. */
  queued: QueuedMessage[];
  /** One-line notice while another client's turn runs on the shared session. */
  turnNotice: string | null;
  /**
   * Queued messages the engine's refusal handed back (it will not drive a conversation another
   * Claude Code holds): they wait here for the composer to take them, as STOP's do at once.
   */
  returned: QueuedMessage[];
  /**
   * The engine refused this chat's last send because another Claude Code holds
   * the conversation (`claude_live_elsewhere`): it waits on the owner, so the
   * tab shows attention until a turn starts or the chat changes.
   */
  refused: boolean;
}

const EMPTY: ChatSessionSnapshot = {
  messages: [],
  busy: false,
  usage: null,
  sessions: [],
  activeSession: null,
  activeSessionPath: null,
  activeCrew: [],
  crewUnread: 0,
  queued: [],
  turnNotice: null,
  returned: [],
  refused: false,
};

/** Shown while another client's (or pi-crew's own) turn holds the shared session. */
const TURN_NOTICE = 'another client is running a turn';
/** Shown while this tab's `/compact` runs: the sidecar call has no way to stop it. */
const COMPACT_NOTICE = 'compacting the conversation… (it cannot be stopped from here)';

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `m${seq}`;
};

async function notifyVault(target: string): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') {
    new Notification('Funky Octopus needs approval', { body: `Vault escalation: ${target}` });
  }
}

/**
 * The live chat conversation, owned by the container rather than by the panel.
 *
 * The cockpit shows one feature view at a time, so `ChatPanel` unmounts whenever
 * you visit Helmraiser or Settings. Holding the transcript in component state made
 * that unmount destroy the conversation while the sidecar's pi session — and so
 * the agent's own memory of it — kept going: the UI went blank against an agent
 * that still remembered everything. Keeping it here outlives the view switch.
 *
 * The transcript itself is durable: the sidecar's pi `SessionManager`
 * writes it, and this service holds the browser's *projection* of it. A reload
 * re-reads it from the sidecar rather than starting over.
 */
export class ChatSession {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  /** Live semantic events for tab-scoped consumers such as the away digest. */
  private readonly activityListeners = new Set<(activity: ChatLiveActivity) => void>();
  private cancelStream: (() => void) | null = null;
  /** Observation stream for custom events arriving after a turn ends. */
  private cancelObserve: (() => void) | null = null;
  /** Whether the chat panel is currently viewing the conversation. */
  private crewViewed = false;
  /**
   * Live crew control calls awaiting their results, keyed by callId — so a
   * result can be paired with its call. Session-local: never persisted and
   * cleared on every lifecycle exit (turn end/error/cancel, chat switch).
   */
  private readonly pendingControl: PendingControlCalls = new Map();
  /** Root the history list is scoped to; null means "every root". */
  private root: string | null = null;
  /**
   * This tab's identity on the shared session: every mutating call carries it,
   * and observation events with this origin are its own and ignored.
   */
  private readonly clientId: string;
  /** Serialize async transcript reloads in observation-event order. */
  private observationWork: Promise<void> = Promise.resolve();
  /** True from an optimistic local send until its stream ends or errors. */
  private localTurnInFlight = false;
  /** This tab's `/compact` is running: it holds the chat as a turn does, but cannot be cancelled. */
  private compacting = false;
  /**
   * Origins (other clients, or `'agent'` for pi-crew's own runs) whose turn is
   * open on the shared session. Busy is a local send in flight OR this set
   * non-empty; the queue drains only when neither holds.
   */
  private readonly foreignTurns = new Set<string | null>();
  /** A foreign turn ended while a local send was still waiting/running. */
  private foreignTranscriptReloadPending = false;
  /** Rejects the one caller awaiting this tab's current turn, if there is one. */
  private awaitedTurnReject: ((error: Error) => void) | null = null;
  /** Advances as soon as a foreign turn-ended event reaches this tab. */
  private foreignTurnEndedEpoch = 0;
  /**
   * The temporary live assistant message for the currently observed agent
   * turn (pi-crew's own run), if one is open and has produced visible output.
   * Projection state only: never persisted, never on the wire — the durable
   * transcript always replaces it at turn end, session switch or reconnect.
   */
  private agentMessageId: string | null = null;
  /** Invalidates an in-flight replay baseline when the observed session changes. */
  private observationGeneration = 0;
  /** Foreign ends whose transcript reconciliation is deferred behind a local send. */
  private readonly pendingTurnNotifications: TurnAttentionTicket[] = [];
  /** True once the chat's tab closed; a flow pinned to it must not send. */
  closed = false;

  /** Stops following the transport's reconnects; `dispose` calls it. */
  private readonly stopFollowingTransport: () => void;

  constructor(
    private readonly orchestrator: ChatOrchestrator,
    transport?: ConnectionStateSource,
    /** Injected for deterministic tests; production draws a random id. */
    clientId: string = crypto.randomUUID(),
    private readonly attention?: ChatAttentionNotifications,
    /**
     * The tabs' answer to "another chat holds this conversation": focus that
     * chat's tab, true when there is one here. Without it (or when it says no),
     * opening fails with where the conversation is open.
     */
    private readonly focusHolder?: (chatId: string) => boolean,
  ) {
    this.clientId = clientId;
    // Subscribe for the open chat, and re-subscribe whenever the transport
    // reconnects: the readback reconciles anything missed while disconnected by
    // stable id.
    this.stopFollowingTransport =
      transport?.subscribe(() => {
        if (transport.getState() !== 'open') return;
        this.subscribeToEvents();
        this.forgetForeignTurns();
        this.resync();
      }) ?? (() => undefined);
    this.subscribeToEvents();
  }

  /**
   * The chat's tab closed: stop its streams and stop following the transport,
   * so nothing more lands in a session no tab shows.
   */
  dispose(): void {
    this.closed = true;
    this.stopFollowingTransport();
    this.observationGeneration += 1;
    this.cancelObserve?.();
    this.cancelObserve = null;
    this.cancelStream?.();
    this.cancelStream = null;
  }

  getSnapshot = (): ChatSessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeActivity = (listener: (activity: ChatLiveActivity) => void): (() => void) => {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  };

  /**
   * Send a message, or queue it if a turn is already streaming.
   *
   * Queueing rather than dropping is the point: the composer has already cleared
   * the draft by the time this runs, so a silent return loses what was typed.
   */
  send(raw: string, opts?: ChatTurnOptions, images: ChatImageAttachment[] = []): void {
    const text = raw.trim();
    if (!text) return;
    if (this.snapshot.busy) {
      // `opts` is spread conditionally: under exactOptionalPropertyTypes an
      // explicit `opts: undefined` is not an omitted optional property.
      const message: QueuedMessage = {
        id: nextId(),
        text,
        ...(opts ? { opts } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      this.set({ ...this.snapshot, queued: [...this.snapshot.queued, message] });
      return;
    }
    this.startTurn(text, opts, images);
  }

  /**
   * Send one visible turn and resolve only with that turn's completed assistant
   * message. Unlike composer sends this never queues: callers must disable while
   * the shared chat is occupied, so an older or later reply cannot be mistaken
   * for this one.
   */
  sendAndWait(raw: string, opts?: ChatTurnOptions): Promise<ChatMessage> {
    const text = raw.trim();
    if (!text) return Promise.reject(new Error('chat message is empty'));
    if (this.snapshot.busy) return Promise.reject(new Error('chat turn in progress'));
    return new Promise<ChatMessage>((resolve, reject) => {
      const completion: TurnCompletion = {
        resolve: (message) => {
          this.awaitedTurnReject = null;
          resolve(message);
        },
        reject: (error) => {
          this.awaitedTurnReject = null;
          reject(error);
        },
      };
      this.awaitedTurnReject = completion.reject;
      this.startTurn(text, opts, [], completion);
    });
  }

  /** Start a turn for already-trimmed text. Shared by `send` and queue drain. */
  private startTurn(
    text: string,
    opts?: ChatTurnOptions,
    images: ChatImageAttachment[] = [],
    completion?: TurnCompletion,
  ): void {
    const foreignTurnEndedAtStart = this.foreignTurnEndedEpoch;
    this.localTurnInFlight = true;
    const userId = nextId();
    const assistantId = nextId();
    const now = Date.now();
    const userSteps: ChatStep[] = [
      { kind: 'text', text },
      ...images.map((img): ChatStep => ({ kind: 'image', ...img })),
    ];
    this.set({
      ...this.snapshot,
      busy: true,
      refused: false,
      messages: [
        ...this.snapshot.messages,
        { id: userId, role: 'user', steps: userSteps, createdAt: now },
        { id: assistantId, role: 'assistant', steps: [], streaming: true, createdAt: now },
      ],
    });

    const patch = (fn: (m: ChatMessage) => ChatMessage): void => {
      this.set({
        ...this.snapshot,
        messages: this.snapshot.messages.map((item) =>
          item.id === assistantId && !isChatEventItem(item) && !isCrewAuditItem(item)
            ? fn(item)
            : item,
        ),
      });
    };
    const finish = (): void => {
      this.cancelStream = null;
    };

    this.cancelStream = this.orchestrator.send(
      text,
      {
        onChunk: (chunk) => {
          if (chunk.kind === 'custom-message') {
            this.ingestCustomEvent(chunk, true);
            return;
          }
          if (chunk.kind === 'approval-request') void notifyVault(chunk.target);
          if (chunk.kind === 'usage') {
            this.set({
              ...this.snapshot,
              usage: {
                tokens: chunk.tokens,
                contextWindow: chunk.contextWindow,
                percent: chunk.percent,
              },
            });
            return;
          }
          // Live crew activity from the turn's tool chunks (spawn call/result,
          // control calls + results); the tool step still lands in the
          // assistant message.
          const live = liveCrewEventFromChunk(chunk, Date.now(), this.pendingControl);
          if (live) {
            this.set({
              ...this.snapshot,
              activeCrew: reduceLiveCrew(this.snapshot.activeCrew, live),
            });
          }
          patch((message) => reduceChatChunk(message, chunk));
        },
        onDone: () => {
          this.localTurnInFlight = false;
          this.emitActivity({ kind: 'turn-ended', at: Date.now() });
          patch((m) => ({ ...m, streaming: false }));
          const completed = this.snapshot.messages.find(
            (item): item is ChatMessage =>
              item.id === assistantId && !isChatEventItem(item) && !isCrewAuditItem(item),
          );
          if (completed) completion?.resolve(completed);
          else completion?.reject(new Error('completed assistant reply is missing'));
          // The parent turn ended: unbound provisional rows that never got a
          // result die with it; bound rows survive (async subagent work).
          this.pendingControl.clear();
          const reloadPending = this.foreignTranscriptReloadPending;
          const foreignOpen = this.foreignTurns.size > 0;
          this.set({
            ...this.snapshot,
            busy: reloadPending || foreignOpen,
            turnNotice: foreignOpen ? TURN_NOTICE : null,
            activeCrew: dropUnboundProvisional(this.snapshot.activeCrew),
          });
          finish();
          if (reloadPending) void this.reloadAfterForeignTurn();
          else if (!foreignOpen) this.drainQueue();
          // A turn is something the cockpit did to the session: its first
          // message titles it and its mtime moved. Best effort; the bar simply
          // keeps the previous title if this fails.
          void this.refresh().catch(() => undefined);
        },
        onError: (message, code) => {
          this.localTurnInFlight = false;
          if (code === 'turn_in_progress') {
            // Another client's turn won the shared session: drop this
            // attempt's optimistic pair. Composer sends stay queued at the
            // front, but a caller awaiting this exact turn must fail without
            // leaving a detached instruction that could run later. If the
            // foreign end was already observed, reconcile now; otherwise its
            // future turn-ended event will do so.
            const foreignTurnAlreadyEnded =
              this.foreignTurnEndedEpoch !== foreignTurnEndedAtStart;
            const reloadPending = this.foreignTranscriptReloadPending;
            this.set({
              ...this.snapshot,
              messages: this.snapshot.messages.filter(
                (item) => item.id !== userId && item.id !== assistantId,
              ),
              queued: completion
                ? this.snapshot.queued
                : [
                    {
                      id: nextId(),
                      text,
                      ...(opts ? { opts } : {}),
                      ...(images.length > 0 ? { images } : {}),
                    },
                    ...this.snapshot.queued,
                  ],
              busy: true,
              turnNotice: foreignTurnAlreadyEnded ? null : TURN_NOTICE,
            });
            completion?.reject(new Error(message));
            finish();
            if (reloadPending) void this.reloadAfterForeignTurn();
            return;
          }
          patch((m) => ({ ...m, streaming: false, error: message }));
          // A turn that failed has still ended: its tab and the away digest must see it.
          this.emitActivity({ kind: 'turn-ended', at: Date.now(), failed: true });
          completion?.reject(new Error(message));
          this.pendingControl.clear();
          const reloadPending = this.foreignTranscriptReloadPending;
          const foreignOpen = this.foreignTurns.size > 0;
          // The engine will not drive a conversation another Claude Code holds: the next message
          // would fork it, and the owner has not chosen that. What was queued goes back to them.
          const handBack = code === CLAUDE_LIVE_ELSEWHERE && this.snapshot.queued.length > 0;
          this.set({
            ...this.snapshot,
            busy: reloadPending || foreignOpen,
            turnNotice: foreignOpen ? TURN_NOTICE : null,
            activeCrew: dropUnboundProvisional(this.snapshot.activeCrew),
            refused: code === CLAUDE_LIVE_ELSEWHERE,
            ...(handBack ? { queued: [], returned: [...this.snapshot.returned, ...this.snapshot.queued] } : {}),
          });
          finish();
          if (reloadPending) void this.reloadAfterForeignTurn();
          else if (!foreignOpen) this.drainQueue();
        },
      },
      opts,
      images,
      this.clientId,
    );
  }

  /** Start the oldest queued message, if any, now that the turn has ended. */
  private drainQueue(): void {
    const [next, ...rest] = this.snapshot.queued;
    if (!next) return;
    this.set({ ...this.snapshot, queued: rest });
    this.startTurn(next.text, next.opts, next.images);
  }

  /** The queued messages an engine refusal handed back, for the composer; each is given once. */
  takeReturned(): QueuedMessage[] {
    const returned = this.snapshot.returned;
    if (returned.length === 0) return [];
    this.set({ ...this.snapshot, returned: [] });
    return returned;
  }

  /** Drop one queued message and return it, so the panel can restore its text. */
  unqueue(id: string): QueuedMessage | null {
    const found = this.snapshot.queued.find((m) => m.id === id);
    if (!found) return null;
    this.set({ ...this.snapshot, queued: this.snapshot.queued.filter((m) => m.id !== id) });
    return found;
  }

  /**
   * Stop the in-flight turn and hand back everything that was queued behind it.
   *
   * Stopping must neither silently fire a queued message nor silently drop one,
   * so the cleared entries are returned for the composer to restore.
   */
  cancel(): QueuedMessage[] {
    // A compaction has no stream to cancel; it ends on its own.
    if (this.compacting) return [];
    this.cancelStream?.();
    this.cancelStream = null;
    this.awaitedTurnReject?.(new Error('chat turn cancelled'));
    this.awaitedTurnReject = null;
    this.localTurnInFlight = false;
    this.foreignTranscriptReloadPending = false;
    this.pendingControl.clear();
    this.pendingTurnNotifications.splice(0);
    const queued = this.snapshot.queued;
    this.set({
      ...this.snapshot,
      queued: [],
      busy: false,
      activeCrew: dropUnboundProvisional(this.snapshot.activeCrew),
      messages: this.snapshot.messages.map((item) =>
        !isChatEventItem(item) && !isCrewAuditItem(item) && item.streaming
          ? { ...item, streaming: false, stopped: true }
          : item,
      ),
    });
    return queued;
  }

  /**
   * FO's own `/compact` (pi): the chat is busy until the sidecar is done, as for
   * a turn, and then shows the compacted conversation. Refused while a turn
   * runs; a failure (nothing to compact yet, say) is the caller's to show.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.snapshot.busy) throw new Error('a turn is running — compact when it ends');
    this.compacting = true;
    this.localTurnInFlight = true;
    this.set({ ...this.snapshot, busy: true, turnNotice: COMPACT_NOTICE });
    let failure: Error | null = null;
    try {
      await this.orchestrator.compact(instructions, this.clientId);
    } catch (error) {
      failure = error instanceof Error ? error : new Error('the compaction failed');
    }
    this.compacting = false;
    this.localTurnInFlight = false;
    // The context the meter showed is gone; the next turn reports it again.
    if (failure === null) this.set({ ...this.snapshot, usage: null });
    this.emitActivity({ kind: 'turn-ended', at: Date.now(), ...(failure !== null ? { failed: true as const } : {}) });
    // Reloads the transcript (now with the compaction), settles busy, and sends what queued meanwhile.
    await this.reloadAfterForeignTurn();
    void this.refresh().catch(() => undefined);
    if (failure !== null) throw failure;
  }

  /** FO's own `/rename` (pi): the title shows in the tab and the CHAT bar at once. */
  async rename(name: string): Promise<void> {
    const info = await this.orchestrator.rename(name);
    if (info && info.path === this.snapshot.activeSessionPath) this.set({ ...this.snapshot, activeSession: info });
    void this.refresh().catch(() => undefined);
  }

  /**
   * Replace the transcript with a stored one.
   *
   * Any in-flight turn is cancelled first: switching chats mid-stream must not
   * let the outgoing turn's chunks land in the incoming transcript. This is the
   * one real hazard in the history surface. The observation stream re-subscribes
   * so the new session's readback reconciles missed items by stable id.
   */
  private load(messages: ChatTimelineItem[], activeSessionPath: string | null): void {
    this.cancelStream?.();
    this.cancelStream = null;
    this.awaitedTurnReject?.(new Error('chat changed before the turn completed'));
    this.awaitedTurnReject = null;
    this.localTurnInFlight = false;
    this.foreignTranscriptReloadPending = false;
    // A switch starts the new session's turn tracking from scratch: an end
    // for the previous session's turn may never come.
    this.foreignTurns.clear();
    this.pendingControl.clear();
    this.pendingTurnNotifications.splice(0);
    this.subscribeToEvents();
    // A live agent-turn partial belongs to the previous conversation view; the
    // supplied messages are the whole truth.
    this.agentMessageId = null;
    // Reopen/load/root/new-chat clears live crew and unread: stored transcripts
    // never reconstruct active rows. The queue is cleared with them — this is
    // the one place queued text is dropped, and only as part of an explicit
    // conversation switch that already cancels the in-flight turn: a message
    // queued for one conversation must never fire into another.
    this.set({
      ...this.snapshot,
      messages,
      busy: false,
      queued: [],
      usage: null,
      activeSessionPath,
      // Stale once the path moved; `refresh` re-reads it.
      activeSession:
        this.snapshot.activeSession?.path === activeSessionPath ? this.snapshot.activeSession : null,
      activeCrew: [],
      crewUnread: 0,
      turnNotice: null,
      refused: false,
    });
  }

  /**
   * (Re)subscribe the observation stream for the open chat. Each subscription
   * is cancelled before the next is opened, so a swap never leaks a stale one.
   */
  private subscribeToEvents(): void {
    this.cancelObserve?.();
    this.cancelObserve = null;
    const generation = ++this.observationGeneration;
    if (!this.attention) {
      this.openObservation(generation, null);
      return;
    }

    // chat.observe begins with persisted custom-message readback. Capture its
    // stable ids before opening the stream: those ids are history regardless of
    // timestamp, while an event created between this read and subscription is
    // absent from the baseline and correctly counts as live. If the baseline
    // fails, suppress observe-origin crew attention for this subscription — a
    // missed popup is safer than re-notifying unknown history.
    void this.orchestrator.transcript().then(
      (timeline) => {
        const baseline = new Set(
          timeline.filter(isChatEventItem).map((event) => event.id),
        );
        // The same read tells a tab that has just loaded what the chat it joins already holds.
        if (generation === this.observationGeneration) this.showJoinedConversation(timeline);
        this.openObservation(generation, baseline);
      },
      () => this.openObservation(generation, undefined),
    );
  }

  /**
   * A tab that loads while the sidecar's chat is already running holds none of
   * it, and nothing else would read it until a turn ended or the chat switched.
   * Anything the tab shows or starts meanwhile wins: a turn it starts shows at once.
   */
  private showJoinedConversation(timeline: ChatTimelineItem[]): void {
    if (timeline.length === 0 || this.snapshot.messages.length > 0) return;
    this.set({ ...this.snapshot, messages: timeline });
  }

  /** Open one observation generation with its persisted custom-event baseline. */
  private openObservation(
    generation: number,
    baseline: ReadonlySet<string> | null | undefined,
  ): void {
    if (generation !== this.observationGeneration) return;
    this.cancelObserve = this.orchestrator.observe(
      {
        onChunk: (chunk) => {
          if (chunk.kind === 'custom-message') {
            const liveForAttention =
              baseline !== null && baseline !== undefined && !baseline.has(chunk.id);
            this.ingestCustomEvent(chunk, liveForAttention);
            return;
          }
          if (chunk.kind === 'approval-request') {
            this.followApproval(chunk);
            return;
          }
          if (chunk.kind === 'approval-resolved') {
            this.settleApproval(chunk.requestId, chunk.approved);
            return;
          }
          if (
            chunk.kind !== 'session-changed' &&
            chunk.kind !== 'turn-started' &&
            chunk.kind !== 'turn-ended' &&
            chunk.kind !== 'agent-chunk'
          ) return;
          if (chunk.kind === 'turn-started') this.attention?.turnStarted(this.orchestrator.chatId, chunk.origin);
          const ticket =
            chunk.kind === 'turn-ended'
              ? this.attention?.beginTurnEnded(this.orchestrator.chatId, chunk.origin)
              : undefined;
          if (chunk.origin === this.clientId) {
            if (chunk.kind === 'turn-ended') this.finishTurnNotification(ticket ?? null);
            return;
          }
          if (chunk.kind === 'turn-ended') {
            this.foreignTurnEndedEpoch += 1;
            this.emitActivity({ kind: 'turn-ended', at: Date.now() });
          }
          this.observationWork = this.observationWork
            .then(() => this.followSharedSession(chunk, ticket))
            .catch(() => undefined);
        },
        onEnd: () => {
          if (generation === this.observationGeneration) this.cancelObserve = null;
        },
      },
      this.clientId,
    );
  }

  /** Apply another client's session/turn lifecycle to this tab. */
  private async followSharedSession(
    chunk: Extract<
      ChatChunk,
      { kind: 'session-changed' | 'turn-started' | 'turn-ended' | 'agent-chunk' }
    >,
    ticket?: TurnAttentionTicket | null,
  ): Promise<void> {
    if (chunk.kind === 'turn-started') {
      this.foreignTurns.add(chunk.origin);
      this.set({ ...this.snapshot, busy: true, turnNotice: TURN_NOTICE });
      return;
    }

    if (chunk.kind === 'turn-ended') {
      // Only this origin's turn ended; another may still hold the session.
      this.foreignTurns.delete(chunk.origin);
      if (this.localTurnInFlight && ticket) this.pendingTurnNotifications.push(ticket);
      await this.foreignTurnGone();
      if (!this.localTurnInFlight) this.finishTurnNotification(ticket ?? null);
      return;
    }

    if (chunk.kind === 'agent-chunk') {
      this.followAgentChunk(chunk);
      return;
    }

    const messages = await this.orchestrator.transcript();
    if (chunk.kind === 'session-changed') {
      this.load(messages, chunk.session?.path ?? null);
      this.set({
        ...this.snapshot,
        activeSession: chunk.session,
        activeSessionPath: chunk.session?.path ?? null,
      });
    }
  }

  /**
   * An approval the chat's engine broadcast to every view of it (T2.1): another
   * client's turn, or a run the engine started itself, is waiting on the owner,
   * and this tab can answer it. This tab's own turn shows its request from its
   * turn stream, and a request already on screen is never shown twice.
   */
  private followApproval(chunk: Extract<ChatChunk, { kind: 'approval-request' }>): void {
    if (chunk.origin === this.clientId) return;
    const shown = this.snapshot.messages.some(
      (item) =>
        !isChatEventItem(item) &&
        !isCrewAuditItem(item) &&
        item.steps.some((step) => step.kind === 'approval-request' && step.requestId === chunk.requestId),
    );
    if (shown) return;
    // The step is the request itself; who asked is not part of it.
    const request: ChatChunk = {
      kind: 'approval-request',
      requestId: chunk.requestId,
      callId: chunk.callId,
      tool: chunk.tool,
      target: chunk.target,
      ...(chunk.args !== undefined ? { args: chunk.args } : {}),
    };
    // The window that sent the turn notifies from its own stream; when no browser
    // window sent it (the CLI, an agent run, an unclaimed sender), every window does.
    const sentByAWindow =
      chunk.origin !== null &&
      chunk.origin !== undefined &&
      chunk.origin !== 'agent' &&
      !chunk.origin.startsWith(CLI_CLIENT_PREFIX);
    if (!sentByAWindow) void notifyVault(chunk.target);
    // A run the engine started itself is already streaming into its own message.
    if (chunk.origin === 'agent' && this.agentMessageId) {
      const existing = this.agentMessageId;
      this.set({
        ...this.snapshot,
        messages: this.snapshot.messages.map((item) =>
          !isChatEventItem(item) && !isCrewAuditItem(item) && item.id === existing ? reduceChatChunk(item, request) : item,
        ),
      });
      return;
    }
    // The transcript reload at that turn's end replaces this placeholder.
    const message: ChatMessage = { id: nextId(), role: 'assistant', steps: [], createdAt: Date.now() };
    this.set({ ...this.snapshot, messages: [...this.snapshot.messages, reduceChatChunk(message, request)] });
  }

  /**
   * Render one live chunk of the open agent turn (pi-crew's own run) into a
   * single temporary streaming assistant message appended after the
   * transcript, using the same reducer a local turn streams with. Only chunks
   * of a turn this tab actually saw open are rendered; the partial is
   * projection state that the end-of-turn transcript reload replaces.
   */
  private followAgentChunk(envelope: Extract<ChatChunk, { kind: 'agent-chunk' }>): void {
    if (!this.foreignTurns.has('agent')) return;
    const inner = envelope.chunk;
    if (inner.kind === 'usage') {
      // Context occupancy, like a local send reports it — no message needed.
      this.set({
        ...this.snapshot,
        usage: {
          tokens: inner.tokens,
          contextWindow: inner.contextWindow,
          percent: inner.percent,
        },
      });
      return;
    }
    const existing = this.agentMessageId;
    if (existing) {
      this.set({
        ...this.snapshot,
        messages: this.snapshot.messages.map((item) =>
          !isChatEventItem(item) && !isCrewAuditItem(item) && item.id === existing
            ? reduceChatChunk(item, inner)
            : item,
        ),
      });
      return;
    }
    const id = nextId();
    const message: ChatMessage = {
      id,
      role: 'assistant',
      steps: [],
      createdAt: Date.now(),
      streaming: true,
    };
    this.agentMessageId = id;
    this.set({
      ...this.snapshot,
      messages: [...this.snapshot.messages, reduceChatChunk(message, inner)],
    });
  }

  /** Remove the temporary agent message, when one is still on the timeline. */
  private dropAgentMessage(): void {
    if (!this.agentMessageId) return;
    this.set({
      ...this.snapshot,
      messages: this.snapshot.messages.filter((item) => item.id !== this.agentMessageId),
    });
    this.agentMessageId = null;
  }

  /** A foreign turn is over: reconcile now, or once the local send settles. */
  private async foreignTurnGone(): Promise<void> {
    if (this.localTurnInFlight) {
      // A client send can be waiting for a pi-crew-triggered run. Do not erase
      // that send's optimistic messages or make the composer look idle; reload
      // the durable timeline only after the local stream itself settles.
      this.foreignTranscriptReloadPending = true;
      // But the agent turn itself is over: its temporary live message must not
      // keep streaming on screen until the local send finishes. The deferred
      // reload restores the durable truth.
      this.dropAgentMessage();
      this.set({
        ...this.snapshot,
        busy: true,
        turnNotice: this.foreignTurns.size > 0 ? TURN_NOTICE : null,
      });
      return;
    }
    await this.reloadAfterForeignTurn();
  }

  /**
   * A reconnect can miss a foreign turn's end, which would hold busy forever:
   * forget the open foreign turns (and a send left waiting on one) and
   * reconcile as if they had ended. A turn still running re-announces itself
   * by rejecting the drained send, and its end arrives on the new stream.
   * Serialized behind observation work already queued from the old stream.
   */
  private forgetForeignTurns(): void {
    this.observationWork = this.observationWork
      .then(async () => {
        const stuck = !this.localTurnInFlight && this.snapshot.busy;
        if (this.foreignTurns.size === 0 && !stuck) return;
        this.foreignTurns.clear();
        // A partial from the disconnected stream must not stay visible while
        // truth is being reloaded.
        this.dropAgentMessage();
        await this.foreignTurnGone();
      })
      .catch(() => undefined);
  }

  /**
   * After a reconnect, a restarted sidecar's included (T2.3): show the
   * conversation the sidecar's chat holds now, and which one it is. A tab with
   * a turn of its own still open is left to that turn, which reloads at its end.
   * Serialized behind `forgetForeignTurns`, which settles a foreign turn the
   * old line never saw end.
   */
  private resync(): void {
    this.observationWork = this.observationWork
      .then(async () => {
        if (this.closed || this.localTurnInFlight || this.snapshot.busy) return;
        const [messages, current] = await Promise.all([
          this.orchestrator.transcript(),
          this.orchestrator.currentChat(),
        ]);
        if (this.closed || this.localTurnInFlight || this.snapshot.busy) return;
        this.agentMessageId = null;
        this.set({ ...this.snapshot, messages, activeSession: current, activeSessionPath: current?.path ?? null });
      })
      .catch(() => undefined);
  }

  /**
   * Reload after a foreign turn; release the local queue only when nothing at
   * all is busy (no local send, no foreign turn still open).
   */
  private async reloadAfterForeignTurn(): Promise<void> {
    this.foreignTranscriptReloadPending = false;
    let messages: ChatTimelineItem[] | null = null;
    try {
      messages = await this.orchestrator.transcript();
    } catch {
      // Transcript reconciliation is best effort; never strand queued input.
    }
    if (this.localTurnInFlight) {
      this.foreignTranscriptReloadPending = true;
      return;
    }
    const foreignOpen = this.foreignTurns.size > 0;
    if (messages) {
      this.agentMessageId = null; // the transcript replaces the partial
    } else if (this.agentMessageId && !this.foreignTurns.has('agent')) {
      // The reload failed, but the agent turn is closed: its stale partial
      // must not outlive it with busy already false.
      this.dropAgentMessage();
    }
    this.set({
      ...this.snapshot,
      ...(messages ? { messages } : {}),
      busy: foreignOpen,
      turnNotice: foreignOpen ? TURN_NOTICE : null,
    });
    for (const ticket of this.pendingTurnNotifications.splice(0)) {
      this.finishTurnNotification(ticket);
    }
    if (!foreignOpen) this.drainQueue();
  }

  /**
   * One ingestion path for custom messages, shared by the send stream and the
   * observation stream. Deduplicates by stable id against the timeline first;
   * only a newly inserted canonical event may update live crew state or unread.
   */
  private ingestCustomEvent(chunk: ChatChunk, liveForAttention: boolean): void {
    if (chunk.kind !== 'custom-message') return;
    const next = insertTimelineEvent(this.snapshot.messages, chunk);
    if (next === this.snapshot.messages) return; // duplicate — nothing to update
    const patch: Partial<ChatSessionSnapshot> = { messages: next };
    const live = liveCrewEventFromCustom(chunk);
    if (live) {
      const before = this.snapshot.activeCrew;
      if (live.kind === 'crew-result') {
        const terminal =
          live.status === 'completed' || live.status === 'needs_input' || live.status === 'error'
            ? live.status
            : null;
        if (terminal) {
          const details = crewResultDetails(chunk.details);
          const known = before.find((row) => row.agentId === live.agentId);
          this.emitActivity({
            kind: 'crew',
            at: live.at,
            status: terminal,
            agentName: details?.agentName ?? known?.agentName ?? 'Crew agent',
          });
        }
      } else if (live.kind === 'crew-status') {
        const previous = new Map(
          before.flatMap((row) =>
            row.agentId ? [[row.agentId, row] as const] : [],
          ),
        );
        for (const agent of live.agents) {
          if (
            (agent.status === 'completed' || agent.status === 'needs_input') &&
            previous.get(agent.id)?.status !== agent.status
          ) {
            this.emitActivity({
              kind: 'crew',
              at: live.at,
              status: agent.status,
              agentName: previous.get(agent.id)?.agentName ?? 'Crew agent',
            });
          }
        }
      }
      const after = reduceLiveCrew(before, live);
      patch.activeCrew = after;
      this.attention?.crewChanged(this.orchestrator.chatId, chunk, before, after, liveForAttention);
    }
    if (shouldCountUnread(chunk) && !this.crewViewed) {
      patch.crewUnread = this.snapshot.crewUnread + 1;
    }
    this.set({ ...this.snapshot, ...patch });
  }

  private finishTurnNotification(ticket: TurnAttentionTicket | null): void {
    this.attention?.finishTurnEnded(
      ticket,
      this.snapshot.messages,
      this.snapshot.activeSession?.title ?? null,
    );
  }

  /** Mark whether the chat panel is currently viewing the conversation. */
  setCrewViewed(viewed: boolean): void {
    this.crewViewed = viewed;
  }

  /** Reset the crew unread counter (the panel surfaced the updates). */
  markCrewSeen(): void {
    this.set({ ...this.snapshot, crewUnread: 0 });
  }

  /**
   * Scope the history to a folder the tab has adopted from the chat the sidecar is
   * already running (a reload, another client's switch), as picking it would have:
   * `null` is Global, which spans every folder. Nothing is re-rooted on the sidecar.
   */
  async followRoot(path: string | null): Promise<void> {
    if (path === this.root) return;
    this.root = path;
    const sessions = await this.orchestrator.listChats(path);
    // Only the history: which chat is open is what the sidecar just told this tab, and is not asked again.
    if (this.root === path) this.set({ ...this.snapshot, sessions });
  }

  /** Adopt a project root: resume its most recent chat and rescope history. */
  async setRoot(path: string | null): Promise<void> {
    this.root = path;
    const messages = await this.orchestrator.setRoot(path, this.clientId);
    this.load(messages, null);
    await this.refresh();
  }

  /** Start a fresh conversation at the current root. */
  async newChat(): Promise<void> {
    const info = await this.orchestrator.newChat(this.clientId);
    this.load([], info?.path ?? null);
    await this.refresh();
  }

  /**
   * Reopen a stored conversation and continue it. A conversation another chat
   * already has open is not opened twice: this chat stays where it is and the
   * holder's tab is focused instead (false); only when no tab here holds it
   * (a slot this window has not heard of yet) does the rejection say which
   * chat has it and how to free it. True when it opened here.
   */
  async openChat(path: string): Promise<boolean> {
    const result = await this.orchestrator.openChat(path, this.clientId);
    if ('heldBy' in result) {
      if (this.focusHolder?.(result.heldBy)) return false;
      throw new Error(
        `this conversation is open in chat ${result.heldBy} — close it there (fo chat close ${result.heldBy}) to open it here`,
      );
    }
    const messages = result.items;
    const current = await this.orchestrator.currentChat();
    if (current) this.root = current.cwd;
    this.load(messages, path);
    await this.refresh();
    return true;
  }

  /**
   * Re-read the history list and which chat is open.
   *
   * Called on mount and after any action that changes either. Deliberately not
   * polled: the list only moves as a result of something the cockpit itself did.
   */
  async refresh(): Promise<void> {
    const root = this.root;
    const [listed, current] = await Promise.all([
      this.orchestrator.listChats(root),
      this.orchestrator.currentChat(),
    ]);
    // A history read for a folder the tab has since left is not its history any more.
    const sessions = root === this.root ? listed : this.snapshot.sessions;
    this.set({
      ...this.snapshot,
      sessions,
      activeSession: current,
      activeSessionPath: current?.path ?? null,
    });
  }

  async resolveApproval(requestId: string, approved: boolean): Promise<void> {
    const resolved = await this.orchestrator.resolveApproval(requestId, approved);
    if (!resolved) return;
    this.settleApproval(requestId, approved);
  }

  /** Mark an approval card answered: here, or (broadcast) in another window or `fo vault`. */
  private settleApproval(requestId: string, approved: boolean): void {
    const shown = this.snapshot.messages.some(
      (item) =>
        !isChatEventItem(item) &&
        !isCrewAuditItem(item) &&
        item.steps.some((step) => step.kind === 'approval-request' && step.requestId === requestId),
    );
    if (!shown) return;
    this.set({
      ...this.snapshot,
      messages: this.snapshot.messages.map((item) =>
        isChatEventItem(item) || isCrewAuditItem(item)
          ? item
          : {
              ...item,
              steps: item.steps.map((step) =>
                step.kind === 'approval-request' && step.requestId === requestId
                  ? { ...step, status: approved ? 'approved' : 'denied' }
                  : step,
              ),
            },
      ),
    });
  }

  private emitActivity(activity: ChatLiveActivity): void {
    this.activityListeners.forEach((listener) => listener(activity));
  }

  private set(snapshot: ChatSessionSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export const CHAT_SESSION = token<ChatSession>('ChatSession');
