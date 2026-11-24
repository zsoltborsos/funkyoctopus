import { sessionRefOf } from '../../../src/shared/transport/protocol.ts';
import type {
  ChatChunk,
  ChatCommandsResult,
  ChatSessionInfo,
  ChatTimelineItem,
  EngineKind,
  SessionRef,
} from '../../../src/shared/transport/protocol.ts';
import type { ChatEngine } from '../chat-engine.ts';
import type { SlotContext } from '../chat-registry.ts';
import { AsyncQueue } from '../util/async-queue.ts';

/**
 * An engine that does nothing but what the registry and the seams read, set by
 * hand: what it holds, whether it is busy or running, its pending approvals,
 * and what it broadcasts to observers.
 */
export class FakeEngine implements ChatEngine {
  busyNow = false;
  runningNow = false;
  left = 0;
  disposed = 0;
  /** When the engine's idle child process went quiet; null when it has none idle. */
  idleAt: number | null = null;
  closedIdle = 0;
  /** Rejects dispose(), as a teardown that fails would. */
  disposeError: Error | null = null;
  /** Holds openChat until released, as a real open awaits its reads and build. */
  gate: Promise<void> | null = null;
  openError: Error | null = null;
  readonly opened: string[] = [];
  /** Sessions `arm` was asked for, in order; `armResult` is its answer. */
  readonly armed: string[] = [];
  armResult = true;
  /** The slot's folder; the factory's root to begin with. */
  root: string | null;
  /** Approval requests this engine is waiting on; `resolveApproval` answers only these. */
  readonly pendingApprovals = new Set<string>();
  readonly resolved: { requestId: string; approved: boolean }[] = [];
  /** What a `send` yields. */
  sendChunks: ChatChunk[] = [{ kind: 'text', delta: 'ok' }];
  readonly sent: { text: string; origin: string | null }[] = [];
  private held: SessionRef | null = null;
  private readonly listeners = new Set<(ref: SessionRef | null) => void>();
  private readonly observers = new Set<AsyncQueue<ChatChunk>>();

  constructor(
    readonly kind: EngineKind,
    readonly ctx: SlotContext,
  ) {
    this.root = ctx.root;
  }

  hold(id: string | null): void {
    this.held = id === null ? null : { engine: this.kind, id };
    for (const listener of this.listeners) listener(this.held);
  }

  /** Push a chunk to every observer, as an engine's broadcast does. */
  broadcast(chunk: ChatChunk): void {
    for (const queue of this.observers) queue.push(chunk);
  }

  info(): ChatSessionInfo | null {
    if (!this.held) return null;
    const at = '2026-10-18T10:00:00.000Z';
    return { path: `/s/${this.held.id}`, engine: this.kind, id: this.held.id, cwd: '/w', title: 't', created: at, modified: at };
  }
  folder(): string | null {
    return this.root;
  }
  /** Arms the session as held, building nothing (what a restore asks). */
  arm(session: { id: string; path: string }): Promise<boolean> {
    this.armed.push(session.id);
    if (this.armResult) this.hold(session.id);
    return Promise.resolve(this.armResult);
  }
  busy(): boolean {
    return this.busyNow;
  }
  running(): boolean {
    return this.runningNow;
  }
  subagentsLeftRunning(): number {
    return this.left;
  }
  idleSince(): number | null {
    return this.runningNow ? this.idleAt : null;
  }
  closeIdle(): boolean {
    if (this.idleSince() === null) return false;
    this.runningNow = false;
    this.idleAt = null;
    this.closedIdle += 1;
    return true;
  }
  onIdentity(listener: (ref: SessionRef | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): Promise<void> {
    this.disposed += 1;
    this.hold(null);
    for (const queue of this.observers) queue.close();
    return this.disposeError ? Promise.reject(this.disposeError) : Promise.resolve();
  }
  async *send(text: string, _signal: AbortSignal, _opts?: unknown, origin: string | null = null): AsyncIterable<ChatChunk> {
    this.sent.push({ text, origin });
    await Promise.resolve();
    yield* this.sendChunks;
  }
  async *observe(signal: AbortSignal): AsyncIterable<ChatChunk> {
    const queue = new AsyncQueue<ChatChunk>();
    this.observers.add(queue);
    const stop = (): void => queue.close();
    if (signal.aborted) queue.close();
    else signal.addEventListener('abort', stop, { once: true });
    try {
      yield* queue;
    } finally {
      this.observers.delete(queue);
      signal.removeEventListener('abort', stop);
    }
  }
  setRoot(): Promise<ChatTimelineItem[]> {
    return Promise.resolve([]);
  }
  newChat(): Promise<ChatSessionInfo | null> {
    return Promise.resolve(null);
  }
  async openChat(path: string): Promise<ChatTimelineItem[]> {
    this.opened.push(path);
    // A real open lets go of the old session first, then builds the new one.
    this.hold(null);
    if (this.gate) await this.gate;
    if (this.openError) throw this.openError;
    this.hold(sessionRefOf(path)?.id ?? path.replace(/^\/s\//, ''));
    return [];
  }

  /** What a continue-recent does: pick the newest the registry lets it claim, build, then report it. */
  async continueLatest(ids: string[]): Promise<string | null> {
    const picked = ids.find((id) => this.ctx.claim({ engine: this.kind, id })) ?? null;
    if (this.gate) await this.gate;
    if (picked !== null) this.hold(picked);
    return picked;
  }
  listChats(): Promise<ChatSessionInfo[]> {
    return Promise.resolve([]);
  }
  current(): Promise<ChatSessionInfo | null> {
    return Promise.resolve(this.info());
  }
  transcript(): Promise<ChatTimelineItem[]> {
    return Promise.resolve([]);
  }
  resolveApproval(requestId: string, approved: boolean): boolean {
    if (!this.pendingApprovals.delete(requestId)) return false;
    this.resolved.push({ requestId, approved });
    return true;
  }
  /** What `commands()` answers. */
  commandList: ChatCommandsResult = { commands: [], state: 'live' };
  commands(): Promise<ChatCommandsResult> {
    return Promise.resolve(this.commandList);
  }
}
