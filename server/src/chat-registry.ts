/**
 * The chat slots (tabs) the sidecar serves, each holding one engine for its
 * life (CURRENT_STATE decision 13).
 *
 * A slot is keyed by an id FunkyOctopus mints, because the engine session
 * inside it changes (new chat, open, folder switch, a Claude fork adopted at
 * its first init). `main` always exists and is never closed. The registry also
 * keeps the holder index, so no engine session is held by two slots, picks the
 * one pi slot that may load pi-crew, and counts running Claude processes for
 * their cap. Factories per engine are injected; `index.ts` wires them.
 */

import { randomUUID } from 'node:crypto';
import {
  CHAT_CAP_REACHED,
  CHAT_ENGINE_MISMATCH,
  CHAT_NOT_FOUND,
  CHAT_PERMANENT,
  SHUTTING_DOWN,
  TURN_IN_PROGRESS,
  WireCallError,
} from '../../src/shared/transport/errors.ts';
import { MAIN_CHAT, type ChatSlotInfo, type ChatTimelineItem } from '../../src/shared/transport/protocol.ts';
import type { ChatEngine, EngineKind, SessionRef } from './chat-engine.ts';
import type { SlotRecord } from './chat-slots-file.ts';

export type { ChatSlotInfo } from '../../src/shared/transport/protocol.ts';
import { messageOf } from './util/errors.ts';

/** The permanent slot: the single-tab browser's, and the CLI's default. */
export const MAIN = MAIN_CHAT;

/** What an engine factory is told about the slot it builds for. */
export interface SlotContext {
  chatId: string;
  /** Start on a new conversation (every created slot) rather than continue one (`main`). */
  fresh: boolean;
  /** The slot's first folder; null for the configured global root. */
  root: string | null;
  /**
   * The slot came back from `slots.json` after a restart. It builds and starts
   * nothing now (limit 2): what it held is armed afterwards (`armRestored`),
   * and `main` does not prewarm.
   */
  restored: boolean;
  /**
   * pi only: whether the slot's next session loads pi-crew. At most one pi slot
   * has crew; it moves when that slot closes, so it is asked at each build.
   */
  crew: () => boolean;
  /**
   * Take a session for this slot, in one synchronous step: false when another
   * slot holds or has claimed it. An engine choosing "the latest" claims its
   * pick at the moment it picks; the claim becomes the slot's hold when the
   * engine reports the session.
   */
  claim: (ref: SessionRef) => boolean;
  /** Give back a claim the engine did not take up. */
  release: (ref: SessionRef) => void;
  /** Claude only: whether another `claude` process may start under the cap (closing an idle one if that makes room). */
  mayStartClaude: () => boolean;
}

export type EngineFactory = (ctx: SlotContext) => ChatEngine;

/**
 * What the registry tells its listeners: a slot came or went (and which client
 * did it), or a slot's state changed (a turn started or ended, its session
 * switched, an approval began or was answered).
 */
export type SlotEvent =
  | { type: 'created' | 'closed'; chatId: string; kind: EngineKind; origin: string | null }
  | { type: 'changed'; chatId: string };

/** What `openFor` did: opened in the slot asked, or found another slot already holding it. */
export type OpenResult = { chatId: string; items: ChatTimelineItem[] } | { heldBy: string };

export interface ChatRegistryOptions {
  /** The engine behind `main` (FUNKYOCTOPUS_CHAT_ENGINE). */
  mainKind: EngineKind;
  factories: Record<EngineKind, EngineFactory>;
  /** Most slots at once, `main` included; 8 by default. */
  maxSlots?: number;
  /** Most running `claude` processes across slots; 4 by default. */
  maxClaudeRunning?: number;
  mintId?: () => string;
  now?: () => number;
  /**
   * The slots `slots.json` recorded, to bring back (T2.3). `main` keeps
   * `mainKind`; past `maxSlots` the rest are dropped. Sessions are armed by
   * `armRestored`, not here.
   */
  restored?: readonly SlotRecord[];
}

interface Slot {
  chatId: string;
  kind: EngineKind;
  engine: ChatEngine;
  createdAt: number;
  lastUsedAt: number;
  crew: boolean;
  crewPending: boolean;
  /** The session the engine last reported holding, when the index records it as this slot's. */
  held: SessionRef | null;
  /** Keys this slot claimed and has not reported holding yet. */
  claims: Set<string>;
  closed: boolean;
  stopIdentity: () => void;
  /** Approval requests the engine broadcast and nobody has answered yet. */
  approvals: Set<string>;
  /** Ends the registry's own watch of the engine's observe stream. */
  unwatch: AbortController;
}

const keyOf = (ref: SessionRef): string => `${ref.engine}:${ref.id}`;

/** What the chat and Leeboard seams use of the registry. */
export type ChatSlots = Pick<
  ChatRegistry,
  'engine' | 'list' | 'create' | 'close' | 'openFor' | 'resolveApproval' | 'onSlots'
>;

export class ChatRegistry {
  private readonly slots = new Map<string, Slot>();
  /** `{engine, id}` → the slot holding, or having claimed, that session. */
  private readonly holders = new Map<string, string>();
  private readonly slotListeners = new Set<(event: SlotEvent) => void>();
  /** Set once shutdown begins: no slot is created after it, or it would never be disposed. */
  private disposing = false;
  /** Restored slots and the sessions they held, until `armRestored` arms them. */
  private toArm: { chatId: string; session: NonNullable<SlotRecord['session']> }[] = [];

  constructor(private readonly options: ChatRegistryOptions) {
    const records = options.restored ?? [];
    const main = records.find((record) => record.chatId === MAIN);
    this.add(MAIN, options.mainKind, main?.root ?? null, false, main !== undefined);
    if (main?.session && main.kind !== options.mainKind) {
      console.warn(
        `[chats] main was a ${main.kind} chat and is ${options.mainKind} now (FUNKYOCTOPUS_CHAT_ENGINE): only its folder is restored`,
      );
    } else if (main?.session) {
      this.toArm.push({ chatId: MAIN, session: main.session });
    }
    const max = options.maxSlots ?? 8;
    const dropped: string[] = [];
    for (const record of records) {
      if (record.chatId === MAIN) continue;
      if (this.slots.size >= max) {
        dropped.push(record.chatId);
        continue;
      }
      this.add(record.chatId, record.kind, record.root, true, true);
      if (record.session) this.toArm.push({ chatId: record.chatId, session: record.session });
    }
    if (dropped.length > 0) {
      console.warn(`[chats] at most ${max} chats can be open: not restoring ${dropped.join(', ')}`);
    }
  }

  /**
   * Arm what the restored slots held, once, before the sidecar listens. Each
   * session is claimed first, so two records naming one session cannot both
   * hold it (one holder per engine session, limit 5's other half); the engine
   * then only arms it (limit 2). A session that is gone, or held already,
   * leaves its slot empty, with a warning.
   */
  async armRestored(): Promise<void> {
    const pending = this.toArm;
    this.toArm = [];
    for (const { chatId, session } of pending) {
      const slot = this.slots.get(chatId);
      if (!slot) continue;
      const ref = { engine: session.engine, id: session.id };
      if (ref.engine !== slot.kind) {
        console.warn(`[chats] ${chatId}: a ${ref.engine} session cannot be restored in a ${slot.kind} chat`);
        continue;
      }
      if (!this.claim(slot, ref)) {
        console.warn(`[chats] ${chatId}: ${ref.engine} session ${ref.id} is held by ${this.holder(ref) ?? '?'}; restored empty`);
        continue;
      }
      let armed = false;
      try {
        armed = await slot.engine.arm(session);
      } catch (error) {
        console.warn(`[chats] ${chatId}: arming ${ref.engine} session ${ref.id} failed: ${messageOf(error)}`);
      }
      if (!armed) {
        this.release(slot, ref);
        console.warn(`[chats] ${chatId}: ${ref.engine} session ${ref.id} is gone; restored empty`);
      }
    }
  }

  /** Every slot as `slots.json` records it: `main` first, then in the order they were made. */
  records(): SlotRecord[] {
    return [...this.slots.values()].map((slot) => {
      const info = slot.engine.info();
      return {
        chatId: slot.chatId,
        kind: slot.kind,
        root: slot.engine.folder(),
        session: info ? { engine: info.engine, id: info.id, path: info.path } : null,
      };
    });
  }

  /** The slot's engine, marking the slot used. `main` by default. */
  engine(chatId: string = MAIN): ChatEngine {
    const slot = this.slot(chatId);
    slot.lastUsedAt = this.now();
    return slot.engine;
  }

  /** Every slot, `main` first, read without building or starting anything. */
  list(): ChatSlotInfo[] {
    return [...this.slots.values()].map((slot) => ({
      chatId: slot.chatId,
      kind: slot.kind,
      createdAt: slot.createdAt,
      lastUsedAt: slot.lastUsedAt,
      crew: slot.crew,
      crewPending: slot.crewPending,
      attention: slot.approvals.size > 0,
      busy: slot.engine.busy(),
      session: slot.engine.info(),
      root: slot.engine.folder(),
      subagentsLeftRunning: slot.engine.subagentsLeftRunning(),
    }));
  }

  /** A new slot on a new conversation at `root` (null: the global root). Refused past the cap. */
  create(kind: EngineKind, root: string | null, origin: string | null = null): ChatSlotInfo {
    if (this.disposing) throw new WireCallError('the sidecar is shutting down', SHUTTING_DOWN);
    const max = this.options.maxSlots ?? 8;
    if (this.slots.size >= max) {
      throw new WireCallError(`at most ${max} chats can be open at once — close one first`, CHAT_CAP_REACHED);
    }
    const slot = this.add(this.mint(), kind, root, true, false);
    this.emit({ type: 'created', chatId: slot.chatId, kind, origin });
    const info = this.list().find((row) => row.chatId === slot.chatId);
    if (!info) throw new Error('a created slot is missing from the listing');
    return info;
  }

  /**
   * Close a slot everywhere: its engine is disposed (pi tears its session down
   * as `quit`) and what it held is free. Refused while a turn is live unless
   * forced; `main` is never closed. The slot is gone whether or not its
   * teardown succeeds; a failed teardown is logged.
   */
  async close(
    chatId: string,
    { force = false, origin = null }: { force?: boolean; origin?: string | null } = {},
  ): Promise<void> {
    if (chatId === MAIN) throw new WireCallError('the main chat cannot be closed', CHAT_PERMANENT);
    const slot = this.slot(chatId);
    if (!force && slot.engine.busy()) {
      throw new WireCallError('a turn is running in this chat — stop it first, or force the close', TURN_IN_PROGRESS);
    }
    this.slots.delete(chatId);
    slot.closed = true;
    slot.stopIdentity();
    slot.unwatch.abort();
    this.releaseAll(slot);
    if (slot.crew) this.promoteCrew();
    this.emit({ type: 'closed', chatId, kind: slot.kind, origin });
    try {
      await slot.engine.dispose();
    } catch (error) {
      console.error(`[chats] closing ${chatId} failed: ${messageOf(error)}`);
    }
  }

  /** The slot holding, or having claimed, `ref`; null when it is free. */
  holder(ref: SessionRef): string | null {
    return this.holders.get(keyOf(ref)) ?? null;
  }

  /**
   * Open a stored session in a slot, unless another slot holds it: then the
   * caller is told which, so it can focus that slot instead (one holder per
   * engine session, decision 13). The session is claimed before the open
   * starts, so a second open racing this one is pointed here; a failed open
   * gives it back.
   */
  async openFor(chatId: string, ref: SessionRef, path: string, origin: string | null = null): Promise<OpenResult> {
    const slot = this.slot(chatId);
    if (ref.engine !== slot.kind) {
      throw new WireCallError(`a ${ref.engine} session cannot be opened in a ${slot.kind} chat`, CHAT_ENGINE_MISMATCH);
    }
    if (!this.claim(slot, ref)) return { heldBy: this.holder(ref) ?? chatId };
    slot.lastUsedAt = this.now();
    try {
      return { chatId, items: await slot.engine.openChat(path, origin) };
    } catch (error) {
      this.release(slot, ref);
      throw error;
    }
  }

  /**
   * Answer a pending approval wherever it waits: request ids are unique per
   * tool call, so the slot whose engine is waiting on it is the one asked
   * (`fo vault approve` needs no chat id). False when no slot is waiting on it.
   */
  resolveApproval(requestId: string, approved: boolean): boolean {
    for (const slot of this.slots.values()) {
      if (!slot.engine.resolveApproval(requestId, approved)) continue;
      if (slot.approvals.delete(requestId)) this.emit({ type: 'changed', chatId: slot.chatId });
      return true;
    }
    return false;
  }

  /** Whether any slot runs this engine. */
  hasKind(kind: EngineKind): boolean {
    return [...this.slots.values()].some((slot) => slot.kind === kind);
  }

  /** Calls `listener` when a slot is created or closed; returns the unsubscribe. */
  onSlots(listener: (event: SlotEvent) => void): () => void {
    this.slotListeners.add(listener);
    return () => this.slotListeners.delete(listener);
  }

  /** Sidecar shutdown: every slot's engine is disposed, `main` included; failures are logged, never thrown. */
  async dispose(): Promise<void> {
    this.disposing = true;
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.holders.clear();
    for (const slot of slots) {
      slot.closed = true;
      slot.stopIdentity();
      slot.unwatch.abort();
    }
    const settled = await Promise.allSettled(slots.map((slot) => slot.engine.dispose()));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        console.error(`[chats] closing ${slots[index]?.chatId ?? '?'} failed: ${messageOf(outcome.reason)}`);
      }
    });
  }

  private add(chatId: string, kind: EngineKind, root: string | null, fresh: boolean, restored: boolean): Slot {
    const now = this.now();
    // pi-crew 1.0.34 binds one session per process: only one live pi slot has it.
    const crew = kind === 'pi' && ![...this.slots.values()].some((other) => other.crew);
    const slot: Slot = {
      chatId,
      kind,
      engine: undefined as unknown as ChatEngine,
      createdAt: now,
      lastUsedAt: now,
      crew,
      crewPending: false,
      held: null,
      claims: new Set(),
      closed: false,
      stopIdentity: () => undefined,
      approvals: new Set(),
      unwatch: new AbortController(),
    };
    slot.engine = this.options.factories[kind]({
      chatId,
      fresh,
      root,
      restored,
      crew: () => slot.crew,
      claim: (ref) => this.claim(slot, ref),
      release: (ref) => this.release(slot, ref),
      mayStartClaude: () => this.mayStartClaude(slot),
    });
    slot.stopIdentity = slot.engine.onIdentity((ref) => this.hold(slot, ref));
    // A factory may have built a session already.
    const info = slot.engine.info();
    if (info) this.hold(slot, { engine: kind, id: info.id });
    this.slots.set(chatId, slot);
    void this.watch(slot);
    return slot;
  }

  /**
   * Follow the slot's engine the way a browser tab does, for the slot state the
   * listing and `chat.slotsObserve` show: a turn starting or ending, a session
   * switch, an approval waiting. Ends when the slot closes.
   */
  private async watch(slot: Slot): Promise<void> {
    try {
      for await (const chunk of slot.engine.observe(slot.unwatch.signal, null)) {
        if (chunk.kind === 'approval-request') {
          slot.approvals.add(chunk.requestId);
        } else if (chunk.kind === 'turn-ended') {
          // An approval cannot outlive the turn that asked it.
          slot.approvals.clear();
        } else if (chunk.kind !== 'turn-started' && chunk.kind !== 'session-changed') {
          continue;
        }
        this.emit({ type: 'changed', chatId: slot.chatId });
      }
    } catch (error) {
      if (!slot.closed) console.error(`[chats] watching ${slot.chatId} stopped: ${messageOf(error)}`);
    }
  }

  private claim(slot: Slot, ref: SessionRef): boolean {
    if (slot.closed) return false;
    const key = keyOf(ref);
    const holder = this.holders.get(key);
    if (holder !== undefined && holder !== slot.chatId) return false;
    if (holder === undefined) {
      this.holders.set(key, slot.chatId);
      slot.claims.add(key);
    }
    return true;
  }

  private release(slot: Slot, ref: SessionRef): void {
    const key = keyOf(ref);
    if (!slot.claims.delete(key)) return;
    if (this.holders.get(key) === slot.chatId) this.holders.delete(key);
  }

  /**
   * The engine reports the session it now holds. Its earlier hold goes; with a
   * session, its other claims go too (they were picks it did not end up on),
   * while a null report (mid-swap) keeps the claim the swap is heading for. A
   * session another slot holds is never taken over: that is a bug upstream,
   * logged rather than hidden.
   */
  private hold(slot: Slot, ref: SessionRef | null): void {
    if (slot.closed) return;
    const key = ref ? keyOf(ref) : null;
    if (slot.held && keyOf(slot.held) !== key && this.holders.get(keyOf(slot.held)) === slot.chatId) {
      this.holders.delete(keyOf(slot.held));
    }
    slot.held = null;
    if (!ref || key === null) return;
    for (const claimed of slot.claims) {
      if (claimed !== key && this.holders.get(claimed) === slot.chatId) this.holders.delete(claimed);
    }
    slot.claims.clear();
    // A session built after crew was handed over loads it.
    slot.crewPending = false;
    const holder = this.holders.get(key);
    if (holder !== undefined && holder !== slot.chatId) {
      console.error(
        `[chats] ${slot.chatId} reports ${ref.engine} session ${ref.id}, already held by ${holder}; the index keeps ${holder}`,
      );
      return;
    }
    this.holders.set(key, slot.chatId);
    slot.held = ref;
  }

  private releaseAll(slot: Slot): void {
    for (const [key, holder] of this.holders) if (holder === slot.chatId) this.holders.delete(key);
    slot.claims.clear();
    slot.held = null;
  }

  /**
   * The crew slot closed: the oldest remaining pi slot takes crew. Its live
   * session, built without pi-crew, is not rebuilt under it; crew loads from
   * its next session. A pi `main` always keeps crew, so this only happens
   * under a Claude `main`.
   */
  private promoteCrew(): void {
    const next = [...this.slots.values()].find((slot) => slot.kind === 'pi');
    if (!next) return;
    next.crew = true;
    next.crewPending = next.held !== null;
  }

  /**
   * Under the cap, yes. At the cap, the least recently used *idle* Claude
   * process elsewhere is closed to make room (its session resumes on its next
   * send); only when none is idle is the start refused.
   */
  private mayStartClaude(asker: Slot): boolean {
    const claude = [...this.slots.values()].filter((slot) => slot.kind === 'claude-code');
    if (claude.filter((slot) => slot.engine.running()).length < (this.options.maxClaudeRunning ?? 4)) return true;
    const idle = claude
      .filter((slot) => slot !== asker)
      .map((slot) => ({ slot, since: slot.engine.idleSince() }))
      .filter((entry): entry is { slot: Slot; since: number } => entry.since !== null)
      .sort((a, b) => a.since - b.since);
    return idle.some(({ slot }) => slot.engine.closeIdle());
  }

  private slot(chatId: string): Slot {
    const slot = this.slots.get(chatId);
    if (!slot) throw new WireCallError(`no chat ${chatId}`, CHAT_NOT_FOUND);
    return slot;
  }

  private mint(): string {
    const mint = this.options.mintId ?? (() => randomUUID().slice(0, 8));
    let id = mint();
    while (id === MAIN || this.slots.has(id)) id = mint();
    return id;
  }

  private emit(event: SlotEvent): void {
    for (const listener of this.slotListeners) listener(event);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
