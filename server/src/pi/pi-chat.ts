import {
  SessionManager,
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type ExtensionError,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { config } from '../config.ts';
import { setBackend } from '../health.ts';
import { AsyncQueue } from '../util/async-queue.ts';
import type { ModelCatalog } from './model-catalog.ts';
import {
  RawSessionHost,
  RuntimeSessionHost,
  unreachableSessionReplacementFactory,
  type SessionHost,
  type TeardownReason,
} from './session-host.ts';
import { crewAbortOwned, crewActiveFor, crewless } from './crew.ts';
import type { SessionRef } from '../chat-engine.ts';
import type {
  ChatChunk,
  ChatCommandsResult,
  ChatImageAttachment,
  ChatSessionInfo,
  ChatTimelineItem,
} from '../../../src/shared/transport/protocol.ts';
import { piCommands } from './commands.ts';
import { resolvePiModel } from './default-model.ts';
import { projectPathIndex, type ProjectPaths } from '../projects/registry.ts';
import { remapCwd } from '../projects/remap.ts';
import {
  CHAT_CLOSED,
  FOLDER_NOT_FOUND,
  TURN_IN_PROGRESS,
  WireCallError,
} from '../../../src/shared/transport/errors.ts';
import { ApprovalBroker } from '../security/approval-broker.ts';
import { VaultGuard } from '../security/vault.ts';
import { listRecentSessions } from './session-index.ts';
import { guardedSessionPath } from './session-file.ts';
import { describeManager, toActiveCustomEvents, toSessionInfo, toTimeline } from './session-transcript.ts';
import { resultDetails, resultDiff, resultText, toolSummary } from './tool-result.ts';
import {
  createCustomIdState,
  customMessageChunkFromLive,
  resolveCustomEntryId,
  type CustomIdState,
  type CustomMessageLike,
} from './custom-message.ts';

/**
 * The shared, hermetic seams `openChat` and `listChats` resolve per call: the
 * Leeboard project-path index (machine/disk-move mapping for recorded cwds)
 * and the bounded recent-session listing global history renders from.
 */
export interface PiChatHistorySources {
  projectPaths: () => Promise<ProjectPaths[]>;
  recentSessions: () => Promise<ChatSessionInfo[]>;
}

/**
 * One global-history row remapped against the index: a vanished cwd that the
 * registry can still place moves to its current location and reports where it
 * came from; one that cannot be placed is flagged gone. Existing cwds pass
 * through untouched.
 */
export async function remapGlobalRow(row: ChatSessionInfo, index: ProjectPaths[]): Promise<ChatSessionInfo> {
  const mapped = await remapCwd(row.cwd, index);
  if (!mapped) return { ...row, folderGone: true };
  if (mapped.movedFrom === undefined) return row;
  return { ...row, cwd: mapped.cwd, movedFrom: row.cwd };
}

/**
 * One historical row listed under a project's old paths, projected onto the
 * project's current tree. Remap can only miss here for a vanished registered
 * root, whose best remaining root is the project's current one.
 */
async function remapHistoryRow(
  row: ChatSessionInfo,
  project: ProjectPaths,
): Promise<ChatSessionInfo> {
  const mapped = await remapCwd(row.cwd, [project]);
  if (!mapped || mapped.movedFrom === undefined) {
    return mapped ? row : { ...row, cwd: project.path, movedFrom: row.cwd };
  }
  return { ...row, cwd: mapped.cwd, movedFrom: row.cwd };
}

/** Production wiring for {@link PiChatHistorySources}; tests pass their own. */
function productionHistorySources(): PiChatHistorySources {
  return {
    projectPaths: () => projectPathIndex(),
    recentSessions: () => listRecentSessions(),
  };
}

/** pi's effort level, derived so we don't import a type it doesn't re-export. */
type ThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0];
/**
 * The test seam that stands in for `createSession`. `manager` is the
 * SessionManager PiChat would build the session on (create, continue or open);
 * a factory that ignores it never touches a session store.
 */
type SessionFactory = (root: string, manager: () => Promise<SessionManager>) => Promise<AgentSession>;

/**
 * How a PiChat sits in a chat slot (T2.1). The defaults are the single-slot
 * sidecar as it was: the configured root, the root's latest conversation,
 * pi-crew loaded, nothing held elsewhere.
 */
export interface PiChatSlotOptions {
  /** The first root; the config's global root by default. */
  root?: string;
  /** Start on a new conversation instead of continuing the root's latest. */
  fresh?: boolean;
  /**
   * Whether the next session loads the pi-crew extension (always, by
   * default). pi-crew 1.0.34 binds one session per process, so at most one
   * slot may (decision 13): the others build without it, not merely with its
   * tools off. Asked at each build, since crew moves when its slot closes.
   */
  crew?: () => boolean;
  /**
   * Take a session for this slot in one step; false when another slot holds or
   * claimed it. Continuing a root's latest claims its pick, skipping refusals.
   */
  claim?: (ref: SessionRef) => boolean;
  /** Running pi-crew subagents a session owns; pi-crew's process runtime by default. */
  crewActive?: (sessionId: string) => number;
  /** Abort every pi-crew subagent a session owns; pi-crew's process runtime by default. */
  crewAbort?: (sessionId: string) => void;
}

/**
 * The guard surface PiChat installs on every session before its first turn.
 *
 * Production binds VaultGuard; the promotion live canary binds its own
 * deny-all guard so no tool ever executes. Structural on purpose: a guard
 * factory must not be forced to construct a VaultGuard it does not need.
 */
export interface ToolGuard {
  guard(
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined>;
}

type GuardFactory = () => Promise<ToolGuard>;

function toolChunk(event: AgentSessionEvent): ChatChunk | null {
  if (event.type === 'tool_execution_start') {
    return {
      kind: 'tool-call',
      callId: event.toolCallId,
      tool: event.toolName,
      summary: toolSummary(event.toolName, event.args),
      args: event.args,
    };
  }
  if (event.type === 'tool_execution_end') {
    const output = resultText(event.result);
    const diff = resultDiff(event.result);
    const details = resultDetails(event.result);
    const chunk: ChatChunk = {
      kind: 'tool-result',
      callId: event.toolCallId,
      ok: !event.isError,
    };
    if (event.isError) {
      chunk.error = output ?? 'Tool execution failed';
    } else if (output) {
      chunk.output = output;
    }
    if (diff) chunk.diff = diff;
    if (details !== undefined) chunk.details = details;
    return chunk;
  }
  return null;
}

/**
 * One shared mapping path from a pi session event to a wire chunk, used by a
 * client's own `chat.send` stream and — wrapped — by the observation stream for
 * runs pi-crew triggered itself. `toolChunk` covers tool calls/results; text
 * and thinking deltas, and the closing usage report, are mapped here so the
 * two consumers never diverge.
 */
function turnChunk(session: AgentSession, event: AgentSessionEvent): ChatChunk | null {
  const tool = toolChunk(event);
  if (tool) return tool;
  if (event.type === 'message_update') {
    const inner = event.assistantMessageEvent;
    if (inner.type === 'text_delta') return { kind: 'text', delta: inner.delta };
    if (inner.type === 'thinking_delta') return { kind: 'thinking', delta: inner.delta };
    return null;
  }
  if (event.type === 'agent_end') {
    const usage = session.getContextUsage();
    if (!usage) return null;
    return {
      kind: 'usage',
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    };
  }
  return null;
}

/** Resolves when the session's active run ends, or as soon as `signal` aborts. */
function idleOrAborted(session: AgentSession, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    session.waitForIdle().then(done, done);
  });
}

/**
 * pi's image-content part, derived from the SDK's own `PromptOptions` so no
 * type is duplicated and `@earendil-works/pi-ai` is not imported by name (it is
 * nested under pi-coding-agent, not a dependency of ours).
 */
type PiImageContent = NonNullable<PromptOptions['images']>[number];

/**
 * The human part of a pi provider error. pi appends `; stack=…` (the whole
 * Node stack) to `errorMessage`; the transcript wants the reason, not the
 * trace, and never more than a short paragraph of it.
 */
export function providerErrorText(raw: string | undefined): string {
  const text = (raw ?? '').split('; stack=')[0]?.trim() ?? '';
  if (!text) return 'provider error';
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

/** Optional per-turn model + effort override, carried from the composer. */
export interface ChatTurnOptions {
  provider?: string;
  model?: string;
  effort?: string;
  /**
   * Images pasted or dropped into the composer. Deliberately not part of
   * `applyTurnOptions`: they belong to the one dispatched turn, not to session
   * state that outlives it.
   */
  images?: ChatImageAttachment[];
}

/**
 * The chat-orchestrator seam's server half: embeds one pi AgentSession routed to
 * the configured model and turns its push-based event stream into an async
 * iterable of chat chunks.
 *
 * pi is the default chat engine, and the one that never meters against
 * Anthropic. Claude Code, driven through the Agent SDK on the owner's own
 * sign-in, is the other (`ClaudeCodeChat`, chosen at start; CURRENT_STATE
 * decision 12). The embedded session exposes pi's default tools and drives each
 * tool loop until the agent ends.
 */
export class PiChat {
  readonly kind = 'pi' as const;
  private readonly slot: PiChatSlotOptions;
  /**
   * The live session and its lifecycle owner. Production sessions are wrapped
   * in pi's public AgentSessionRuntime (bound once, headless rpc) so extension
   * session lifecycle fires; injected test sessions get a raw disposal host.
   * Teardown always goes through the host — never a raw `session.dispose()`.
   */
  private host: Promise<SessionHost> | null = null;
  /** The built host `host` resolved to, for reads that must not await or build. */
  private live: SessionHost | null = null;
  /**
   * A stored session `arm` brought back after a restart, read (never built)
   * until the next turn builds it or the slot moves on. Its manager is what
   * that build takes up, so the session keeps its file and its context.
   */
  private armed: SessionManager | null = null;
  /** Set by dispose(): the slot is gone, and nothing builds again. */
  private disposed = false;
  private root = config.primaryWorkspaceRoot;
  /** Listeners of the identity hook, and the identity last reported to them. */
  private readonly identityListeners = new Set<(ref: SessionRef | null) => void>();
  private identity: string | null = null;
  /**
   * Sessions this slot switched away from, which may still own running pi-crew
   * subagents (they keep running, as in pi's TUI; decision 13). Forgotten once
   * they own none, or when the slot returns to one.
   */
  private readonly left = new Set<string>();
  /**
   * The shared history seams `openChat` and `listChats` resolve per call.
   * Production wiring resolves lazily per call, so a cockpit wired without a
   * reachable Leeboard still constructs and sends turns.
   */
  private readonly sources: PiChatHistorySources;
  private readonly approvals = new ApprovalBroker();

  /**
   * Observers of the open session's role-custom messages (the observation
   * stream). One subscription is armed per live host; the browser re-subscribes
   * on chat load and reconnect, so a swap never leaks a stale subscription.
   */
  private readonly observeSubscribers = new Set<(chunk: ChatChunk) => void>();
  /** Ends each open observation stream; dispose() calls them all. */
  private readonly observeClosers = new Set<() => void>();

  /** Push an observation chunk to every subscriber, never into a send stream. */
  private broadcast(chunk: ChatChunk): void {
    for (const push of this.observeSubscribers) push(chunk);
  }

  /**
   * Announce a completed new/open/re-root to every observation subscriber:
   * identity of the now-live session, described from its manager (null when
   * the session is in-memory or nothing built). Awaited so the event precedes
   * the mutating call's own reply.
   */
  private async broadcastSessionChanged(origin: string | null): Promise<void> {
    const session = await this.liveSession();
    const info = session ? describeManager(session.sessionManager) : null;
    this.broadcast({ kind: 'session-changed', origin, session: info });
  }

  /**
   * Whether one client turn (`chat.send`) is currently in flight on the live
   * session. Set synchronously at the start of an accepted `send`, cleared in
   * its outer `finally`. Runs pi-crew triggered are not client turns.
   */
  private clientTurnInFlight = false;
  /** The client whose turn is in flight (null when unclaimed). */
  private turnOrigin: string | null = null;
  /** The stream of the client turn in flight, so closing the slot can fail it. */
  private turnQueue: AsyncQueue<ChatChunk> | null = null;

  /**
   * Live sessions running a run no `chat.send` started (pi-crew's
   * `triggerTurn` deliveries). Membership is captured at `agent_start` and
   * drives the matching `turn-ended` broadcast, so a client send that began
   * waiting mid-run cannot swallow the external run's end.
   */
  private readonly triggeredRuns = new WeakSet<AgentSession>();

  /**
   * Per-session custom-message id reconciliation state, keyed by the live
   * AgentSession (GC-safe; no explicit cleanup needed). Shared by the chat.send
   * mapping and the observation stream so the same event object always resolves
   * to the same canonical entry id.
   */
  private readonly customIdStates = new WeakMap<AgentSession, CustomIdState>();

  /**
   * How the *next* session is built. Swapping this is how `newChat`, `openChat`
   * and `setRoot` differ; `createSession` stays the only place a session is
   * actually constructed.
   *
   * Continuing the root's latest conversation (one no other slot holds) is the
   * default rather than `create`, so a sidecar restart picks the root's
   * conversation back up instead of silently starting a new one — and it
   * creates a session when there is none, covering both cases. A slot created
   * fresh starts with `create`.
   */
  private buildManager: () => SessionManager | Promise<SessionManager>;

  /**
   * @param catalog shared model runtime — builds the session and resolves models
   *                for mid-conversation switching.
   * @param sessionDir optional session store override — default behavior stays
   *                pi's normal per-cwd store, and an isolated directory is the
   *                one hook the runtime suite needs to keep real sessions out
   *                of the user's global history.
   */
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly sessionFactory?: SessionFactory,
    private readonly guardFactory?: GuardFactory,
    private readonly sessionDir?: string,
    /**
     * Explicit initial provider/model for session construction. Defaults to
     * the sidecar config; the promotion canary pins its exact model here so
     * env config overrides can never redirect the live run.
     */
    private readonly initialModel?: { provider: string; model: string },
    /**
     * Hermetic overrides for the shared seams `openChat` and `listChats` read:
     * production resolves the Leeboard project-path index and the bounded
     * recent-session listing; tests stand in fakes so no test touches the
     * owner's `~/.pi` store.
     */
    historySources?: PiChatHistorySources,
    slot: PiChatSlotOptions = {},
  ) {
    this.sources = historySources ?? productionHistorySources();
    this.slot = slot;
    // Every approval also reaches every view of the slot, tagged with whose
    // turn asked, so any of them can answer (the turn's own stream gets it too).
    this.approvals.onRequest((chunk) => {
      if (chunk.kind !== 'approval-request') return;
      this.broadcast({ ...chunk, origin: this.clientTurnInFlight ? this.turnOrigin : 'agent' });
    });
    // An answer, from whichever view gave it, settles the card in every view.
    this.approvals.onResolved((chunk) => this.broadcast(chunk));
    if (slot.root !== undefined) this.root = slot.root;
    this.buildManager = slot.fresh
      ? () => SessionManager.create(this.root, this.sessionDir)
      : () => this.recentUnheld(this.root);
  }

  /**
   * The root's most recent conversation that no other slot holds, as pi's
   * `continueRecent` picks it; a new one when there is none. One slot per pi
   * session: two writing one JSONL would interleave it (pi has no lock).
   */
  private async recentUnheld(root: string): Promise<SessionManager> {
    // Each pick is claimed the moment it is made (synchronously), so a slot
    // opening or continuing the same session meanwhile is refused, not doubled.
    const claim = this.slot.claim ?? (() => true);
    const recent = SessionManager.continueRecent(root, this.sessionDir);
    const refused = recent.getSessionId();
    if (claim({ engine: 'pi', id: refused })) return recent;
    const rows = await SessionManager.list(root, this.sessionDir);
    const free = rows
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .find((row) => row.id !== refused && claim({ engine: 'pi', id: row.id }));
    return free ? SessionManager.open(free.path, this.sessionDir) : SessionManager.create(root, this.sessionDir);
  }

  /** Whether this slot's sessions load pi-crew (from its next session, when crew was just handed over). */
  get crew(): boolean {
    return this.slot.crew?.() ?? true;
  }

  /** Calls `listener` with the held session each time it changes; returns the unsubscribe. */
  onIdentity(listener: (ref: SessionRef | null) => void): () => void {
    this.identityListeners.add(listener);
    return () => this.identityListeners.delete(listener);
  }

  /** Tell the identity listeners about the live session, if it is not the one they last heard. */
  private reportIdentity(): void {
    const id = (this.live?.session.sessionManager ?? this.armed)?.getSessionId() ?? null;
    if (id === this.identity) return;
    this.identity = id;
    if (id !== null) this.left.delete(id);
    const ref = id === null ? null : { engine: 'pi' as const, id };
    for (const listener of this.identityListeners) listener(ref);
  }

  /** The live (or armed) session's identity, read without building one. */
  info(): ChatSessionInfo | null {
    const manager = this.live?.session.sessionManager ?? this.armed;
    return manager ? describeManager(manager) : null;
  }

  /** The slot's working folder, null at the configured global root. */
  folder(): string | null {
    return this.root === config.primaryWorkspaceRoot ? null : this.root;
  }

  /**
   * Restore after a restart: arm a stored session so the next turn continues
   * it, building nothing now (limit 2). Its folder is the slot's, which an
   * open had already remapped if the project moved. False, with nothing
   * changed, when the file is gone or holds another session.
   */
  async arm(session: { id: string; path: string }): Promise<boolean> {
    // Only a session file inside pi's store: a path read back from slots.json is re-checked, not trusted.
    const store = this.sessionDir ?? join(getAgentDir(), 'sessions');
    const path = await guardedSessionPath(session.path, store).catch(() => null);
    if (path === null || this.disposed || this.host) return false;
    // The slot's folder is the session's, remapped already if an open had moved it.
    let cwd: string | undefined;
    let manager: SessionManager;
    try {
      manager = SessionManager.open(path, this.sessionDir);
      if (manager.getSessionId() !== session.id) return false;
      if (manager.getCwd() !== this.root) {
        cwd = this.root;
        manager = SessionManager.open(path, this.sessionDir, cwd);
      }
    } catch {
      return false;
    }
    this.armed = manager;
    // Reopened when the session builds, not kept from boot: whatever was written to the file
    // since (the pi TUI continuing it, say) is in the context the next turn runs on. A file
    // that no longer holds the session gives a fresh one.
    this.buildManager = () => {
      const current = SessionManager.open(path, this.sessionDir, cwd);
      return current.getSessionId() === session.id ? current : SessionManager.create(this.root, this.sessionDir);
    };
    this.reportIdentity();
    return true;
  }

  /** A client turn is in flight, or a run nobody sent (a pi-crew delivery) is streaming. */
  busy(): boolean {
    return this.clientTurnInFlight || (this.live?.session.isStreaming ?? false);
  }

  /** pi runs in-process: there is never a child process to count. */
  running(): boolean {
    return false;
  }

  /** No child process, so none is ever idle. */
  idleSince(): number | null {
    return null;
  }

  /** No child process to close. */
  closeIdle(): boolean {
    return false;
  }

  /**
   * pi-crew subagents still running in sessions this slot switched away from.
   * Read from pi-crew's runtime by session id (see `crew.ts`); a slot without
   * pi-crew has none.
   */
  subagentsLeftRunning(): number {
    if (!this.crew) return 0;
    const activeFor = this.slot.crewActive ?? crewActiveFor;
    let count = 0;
    for (const id of this.left) {
      const active = activeFor(id);
      if (active === 0) this.left.delete(id);
      count += active;
    }
    return count;
  }

  /**
   * End the slot: its live session is torn down as `quit` (pi-crew aborts its
   * subagents, as quitting pi's TUI does), its observation streams end, and
   * nothing builds again. Idempotent.
   *
   * With no live session to quit (a rebuild that failed, a close mid-open),
   * pi-crew's quit handler never runs, so the subagents of the sessions this
   * slot left behind are aborted here, each by its owner.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.armed = null;
    // A turn still running ends with a reason, not as if it had finished.
    this.turnQueue?.fail(new WireCallError('this chat was closed while the turn ran', CHAT_CLOSED));
    for (const close of this.observeClosers) close();
    const quit = await this.disposeLiveSession('quit');
    if (!quit && this.crew) {
      const abort = this.slot.crewAbort ?? crewAbortOwned;
      for (const id of this.left) abort(id);
    }
    this.left.clear();
  }

  private async getSession(): Promise<AgentSession> {
    if (this.disposed) throw new Error('this chat slot is closed');
    if (!this.host) {
      const created = this.sessionFactory
        ? this.sessionFactory(this.root, async () => this.buildManager()).then(
            (session) => new RawSessionHost(session),
          )
        : this.createSession();
      const pending: Promise<SessionHost> = created.then(async (host) => {
        try {
          await this.installVault(host.session);
        } catch (error) {
          // The session exists but is unusable (the Vault guard never
          // installed): tear it down so nothing leaks, then propagate. The
          // rejected host is not cached, so the next turn builds fresh. As
          // `new`, never `quit`: quit makes pi-crew abort every subagent.
          await this.disposeHost(host, 'new');
          throw error;
        }
        this.armObservation(host.session);
        // A swap while this built has already taken it over and will tear it down.
        if (this.host === pending) {
          this.live = host;
          this.armed = null;
          this.reportIdentity();
        }
        return host;
      });
      this.host = pending;
      pending.catch(() => {
        setBackend('pi', 'down');
        // Never cache a rejected session: a failure here is usually transient
        // (auth not ready, provider unreachable) and the next turn must be free
        // to build a fresh one rather than replaying the same rejection.
        if (this.host === pending) this.host = null;
      });
    }
    return (await this.host).session;
  }

  /**
   * Tear down a live host, streaming-safe, exactly once.
   *
   * A streaming session is aborted first so its in-flight work settles before
   * session_shutdown is emitted and the session is invalidated. `host.dispose()`
   * always runs even when abort rejects, and the abort failure is reported
   * (bounded console.error, consistent with extension-error reporting) rather
   * than masking the disposal. A dispose rejection propagates to the caller.
   */
  private async disposeHost(
    host: SessionHost,
    reason: TeardownReason,
    targetSessionFile?: string,
  ): Promise<void> {
    if (this.live === host) {
      this.live = null;
      this.reportIdentity();
    }
    let abortError: unknown = null;
    if (host.session.isStreaming) {
      try {
        await host.session.abort();
      } catch (error) {
        abortError = error;
      }
    }
    try {
      await host.dispose(reason, targetSessionFile);
    } finally {
      if (abortError !== null) {
        console.error(
          `[pi] abort before session disposal failed: ${
            abortError instanceof Error
              ? abortError.message
              : typeof abortError === 'string'
                ? abortError
                : (JSON.stringify(abortError) ?? 'unknown abort error')
          }`,
        );
      }
    }
  }

  /**
   * Build the session ahead of the first turn. Session setup (model runtime,
   * agent construction, vault load) is otherwise paid by whoever sends the
   * first message; doing it at startup and on every re-root keeps that cost off
   * the critical path — and publishes pi's liveness to the health map early.
   */
  prewarm(): void {
    void this.getSession().catch(() => undefined);
  }

  /**
   * Bounded surfacing of extension-runner errors (the bindExtensions onError).
   * One truncated console.error line in the repo's plain-console style; never
   * throws or re-enters. No UI or command context is bound.
   */
  private readonly reportExtensionError = (error: ExtensionError): void => {
    console.error(
      `[pi] extension error in ${error.extensionPath} on ${error.event}: ${error.error.slice(0, 500)}`,
    );
  };

  private async createSession(): Promise<SessionHost> {
    const runtime = await this.catalog.getRuntime();
    const agentDir = getAgentDir();
    // cwd-bound services for the AgentSessionRuntime, constructed exactly as
    // createAgentSession itself would: SettingsManager for the root, then a
    // DefaultResourceLoader reloaded against it. The shared ModelRuntime is
    // never mutated or refreshed on this path — provider registration and
    // model refresh stay out of FunkyOctopus's production construction.
    const settingsManager = SettingsManager.create(this.root, agentDir);
    // The initial-model seam is consulted here, at construction — before any
    // per-turn options — so a pinned canary cannot inherit env config or pi
    // settings. Otherwise the env wins, then pi's own default model settings.
    const { provider, model: modelId } =
      this.initialModel ?? resolvePiModel({ provider: config.piProvider, model: config.piModel }, settingsManager);
    const model = runtime.getModel(provider, modelId);
    if (!model) {
      throw new Error(`pi model not found: ${provider}/${modelId}`);
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.root,
      agentDir,
      settingsManager,
      // pi-crew in at most one slot (decision 13): the others drop it (and its
      // skill and prompts) before their extension runner exists, so its
      // session_start never runs there.
      ...(this.crew ? {} : crewless()),
    });
    await resourceLoader.reload();
    const services: AgentSessionServices = {
      cwd: this.root,
      agentDir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader,
      diagnostics: [],
    };
    const { session } = await createAgentSession({
      model,
      modelRuntime: runtime,
      cwd: this.root,
      settingsManager,
      resourceLoader,
      // Disk-backed: pi's SessionManager is the transcript store,
      // so the conversation outlives the browser tab. The manager still comes
      // from PiChat's own buildManager, so
      // create/continue/open semantics stay here.
      sessionManager: await this.buildManager(),
    });
    // Production lifecycle owner: the runtime's dispose() emits session_shutdown
    // before invalidating the session. Its replacement factory is unreachable —
    // PiChat owns replacement.
    const runtimeHost = new AgentSessionRuntime(
      session,
      services,
      unreachableSessionReplacementFactory(),
    );
    // Bind the extension runner exactly once per production session: SDK
    // sessions otherwise never fire session_start/session_shutdown, and pi-crew
    // cannot deliver asynchronous crew results without the active binding.
    const host = await RuntimeSessionHost.create(runtimeHost, this.reportExtensionError);
    setBackend('pi', 'up');
    return host;
  }

  /**
   * Shared live mapping of a role-custom `message_end` into the generic chunk,
   * pushed in a microtask so readback sees the persisted entry.
   *
   * pi appends the `custom_message` entry right after `_emit` (the listener
   * runs before persistence), so `getEntries()` only resolves the canonical
   * entry id after this listener returns. The microtask runs before any later
   * event in the same run is processed, so arrival order is preserved.
   */
  private customIdState(session: AgentSession): CustomIdState {
    let state = this.customIdStates.get(session);
    if (!state) {
      // Seed with every custom_message entry already persisted: a resumed or
      // reopened session's history must never be claimable by a new live event
      // that is semantically identical to an old one. Entries appended after
      // arming are not pre-claimed.
      state = createCustomIdState(
        session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === 'custom_message')
          .map((entry) => entry.id),
      );
      this.customIdStates.set(session, state);
    }
    return state;
  }

  private mapCustomMessage(
    session: AgentSession,
    event: AgentSessionEvent,
    push: (chunk: ChatChunk) => void,
  ): void {
    if (event.type !== 'message_end' || event.message.role !== 'custom') return;
    const message = event.message as unknown as CustomMessageLike;
    queueMicrotask(() => {
      // pi appends the custom_message entry before this microtask, so the
      // semantic readback is authoritative. No match means the event has no
      // canonical persisted identity: emitting a fabricated id here would
      // duplicate against canonical readback, so the chunk is skipped and the
      // reopen/observation readback recovers it (lossy is fine, wrong is not).
      const id = resolveCustomEntryId(
        session.sessionManager.getEntries(),
        this.customIdState(session),
        message,
      );
      if (!id) {
        console.warn(
          `[pi] custom message without a persisted entry skipped (${message.customType})`,
        );
        return;
      }
      push(customMessageChunkFromLive(message, id));
    });
  }

  /**
   * Attach the role-custom observation listener to a newly built host. The
   * subscription lives as long as the session does; session disposal clears it.
   */
  private armObservation(session: AgentSession): void {
    // Create the reconciliation state exactly once, seeded from the persisted
    // history, before any live event listener can observe a new event.
    this.customIdState(session);
    session.subscribe((event) => {
      this.mapCustomMessage(session, event, (chunk) => this.broadcast(chunk));
      // Turn lifecycle for runs nobody's `chat.send` started: pi-crew
      // delivers results with triggerTurn and starts an owner turn itself.
      // Membership is captured at start (a client send may begin waiting
      // while the run is going) and the end matches on that, not on the
      // current flag.
      if (event.type === 'agent_start') {
        if (!this.clientTurnInFlight) {
          this.triggeredRuns.add(session);
          this.broadcast({ kind: 'turn-started', origin: 'agent' });
        }
      } else if (this.triggeredRuns.has(session)) {
        // While the triggered run is open, its output streams live to
        // observers, wrapped so it can never be confused with a client send's
        // own request stream. Custom messages keep broadcasting on their own
        // (above); the start event always precedes this output and `turn-ended`
        // follows it.
        if (event.type === 'agent_settled') {
          this.triggeredRuns.delete(session);
          this.broadcast({ kind: 'turn-ended', origin: 'agent' });
        } else {
          const mapped = turnChunk(session, event);
          if (mapped) {
            this.broadcast({ kind: 'agent-chunk', origin: 'agent', chunk: mapped });
          }
        }
      }
    });
  }

  /**
   * Observation-only, session-scoped stream of custom events.
   *
   * Yields the open session's persisted custom events (readback, so a reconnect
   * or re-subscribe reconciles anything missed by stable id), then live
   * role-custom messages arriving after `chat.send`'s request stream closed.
   * No polling, no control operations. The browser re-subscribes on chat load
   * and on transport reconnect; cleanup never constructs work.
   */
  async *observe(
    signal: AbortSignal,
    // Accepted so every client can identify itself on the same seam; the
    // broadcast fan-out is deliberately not filtered — every subscriber
    // follows the shared session, and self-originated events are ignored
    // browser-side.
    _clientId: string | null = null,
  ): AsyncIterable<ChatChunk> {
    const queue = new AsyncQueue<ChatChunk>();
    const push = (chunk: ChatChunk): void => {
      queue.push(chunk);
    };
    this.observeSubscribers.add(push);
    const onAbort = (): void => {
      queue.close();
    };
    this.observeClosers.add(onAbort);
    if (this.disposed) queue.close();
    // Register before any await, and cover an already-aborted signal: the
    // generator body may not have started when the caller aborts, and an abort
    // listener added after the fact never fires.
    if (signal.aborted) {
      queue.close();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // Readback of the open session's persisted custom events — a non-
      // constructing peek, so subscribing with no chat never builds one.
      const session = await this.liveSession().catch(() => null);
      if (session) {
        // Branch-scoped readback: only the active root→leaf path — abandoned
        // branch customs must not reintroduce after a branch-scoped open.
        for (const event of toActiveCustomEvents(
          session.sessionManager.getEntries(),
          session.sessionManager.getLeafId(),
        )) {
          queue.push(event);
        }
      }
      yield* queue;
    } finally {
      this.observeSubscribers.delete(push);
      this.observeClosers.delete(onAbort);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Point future turns at a different session, disposing the outgoing one.
   *
   * Disposal ends the *live* session, not the conversation: its file stays on
   * disk and remains listable, which is what makes re-rooting non-destructive.
   * The outgoing host is torn down through its own dispose() (session_shutdown
   * precedes invalidation for production hosts); a host that never built has
   * nothing to tear down and must not fail the swap.
   */
  private async swapSession(
    build: () => SessionManager | Promise<SessionManager>,
    reason: TeardownReason,
    targetSessionFile?: string,
  ): Promise<void> {
    this.buildManager = build;
    const previous = this.host;
    this.host = null;
    if (this.armed) {
      this.armed = null;
      this.reportIdentity();
    }
    // The session being left may own subagents that keep running (decision 13).
    const leaving = this.live?.session.sessionManager.getSessionId();
    if (this.crew && leaving !== undefined) this.left.add(leaving);
    if (previous) {
      const host = await previous.catch(() => null);
      if (host) await this.disposeHost(host, reason, targetSessionFile);
    }
  }

  /**
   * Re-root future turns, resuming that root's most recent conversation.
   *
   * Returns the resumed transcript so the caller can re-render: selecting a
   * project used to end the current chat as a side effect, and now instead
   * switches to the one belonging to where you just moved.
   */
  async setRoot(path: string | null, origin: string | null = null): Promise<ChatTimelineItem[]> {
    const next = path ?? config.primaryWorkspaceRoot;
    const swapped = next !== this.root;
    if (swapped) {
      this.root = next;
      // The session is picked when it builds, so no target file is known here.
      await this.swapSession(() => this.recentUnheld(this.root), 'resume');
    }
    const items = await this.transcriptAfterSwap();
    // Every browser tab re-applies its project on mount; only a real switch is
    // announced, or each mount would reload the other clients and cancel
    // their running turns.
    if (swapped) await this.broadcastSessionChanged(origin);
    return items;
  }

  /** Start a fresh conversation at the current root. */
  async newChat(origin: string | null = null): Promise<ChatSessionInfo | null> {
    // `create`, not `continueRecent`: this is the one path that must guarantee
    // an empty context rather than resuming whatever was there.
    await this.swapSession(() => SessionManager.create(this.root, this.sessionDir), 'new');
    const session = await this.getSession();
    const info = describeManager(session.sessionManager);
    this.broadcast({ kind: 'session-changed', origin, session: info });
    return info;
  }

  /**
   * Reopen a stored conversation and continue it. Adopts the session's own cwd
   * as the root, so opening a chat from another project is coherent rather
   * than continuing it against the wrong tree.
   *
   * The stored cwd is remapped through the Leeboard project-path registry
   * first: a chat recorded before the machine moved must reopen rooted at the
   * project's current location — the session file itself is read from where it
   * lies, and new entries keep appending to that same JSONL file.
   */
  async openChat(path: string, origin: string | null = null): Promise<ChatTimelineItem[]> {
    const manager = SessionManager.open(path, this.sessionDir);
    const recorded = manager.getCwd();
    // One registry read per open; the mapping decision is pure after that.
    const mapped = recorded
      ? await remapCwd(recorded, await this.sources.projectPaths())
      : { cwd: recorded };
    if (!mapped) {
      // Before any live-session mutation: nothing is disposed or re-rooted on a
      // chat whose recorded folder is gone for good.
      throw new WireCallError(`folder no longer exists: ${recorded}`, FOLDER_NOT_FOUND);
    }
    // Adopt the mapped cwd as the root (a stored chat from another project is
    // coherent, not continued against the wrong tree); the stored file itself
    // is reopened with pi's cwd override when the map moved it. Reopening
    // eagerly keeps the same file — and the same JSONL identity — while
    // pointing pi's tools (which consult `sessionManager.getCwd()` for their
    // operations, notably bash) at the mapped folder, agreeing with `this.root`.
    const moved = mapped.cwd !== recorded;
    if (this.root !== mapped.cwd) this.root = mapped.cwd;
    const next = moved ? SessionManager.open(path, this.sessionDir, mapped.cwd) : manager;
    await this.swapSession(() => next, 'resume', path);
    const items = await this.transcriptAfterSwap();
    await this.broadcastSessionChanged(origin);
    return items;
  }

  /** Chats for one root, or every chat across all roots when `root` is null. */
  async listChats(root: string | null): Promise<ChatSessionInfo[]> {
    const index = await this.sources.projectPaths();
    // Global mode deliberately does not use `SessionManager.listAll()`: it reads
    // every line of every session file on the machine. `listRecentSessions`
    // stats first and parses only the newest few heads.
    if (!root) {
      const recent = await this.sources.recentSessions();
      return Promise.all(recent.map((row) => remapGlobalRow(row, index)));
    }
    const current = await SessionManager.list(root, this.sessionDir);
    const rows = current.map(toSessionInfo);
    const project = index.find((entry) => entry.path === root);
    if (!project || project.oldPaths.length === 0) {
      return rows.sort((a, b) => b.modified.localeCompare(a.modified));
    }
    // This root is a registered project: its chats recorded under the machine's
    // old layout belong in the same list, mapped onto the current tree.
    const oldListings = await Promise.all(
      project.oldPaths.map((oldPath) => SessionManager.list(oldPath, this.sessionDir)),
    );
    const moved = await Promise.all(
      oldListings.flatMap((sessions) => sessions.map(toSessionInfo)).map((row) =>
        remapHistoryRow(row, project),
      ),
    );
    return [...rows, ...moved].sort((a, b) => b.modified.localeCompare(a.modified));
  }

  /**
   * Identity of the live session, so the cockpit can mark the open row. Waits
   * for a build in flight but never starts one.
   */
  async current(): Promise<ChatSessionInfo | null> {
    const session = await this.liveSession();
    const manager = session?.sessionManager ?? this.armed;
    return manager ? describeManager(manager) : null;
  }

  /**
   * The live AgentSession, or null when none exists or construction failed.
   *
   * A non-constructing peek, like `info`, `current` and `sessionId`: it must
   * never build a session, because teardown calls it — cleanup must not create
   * work — and a slot listing must not build one per slot. It
   * resolves the existing pending host, or null when nothing was built yet or
   * the build rejected. The handle is a live pi object — the shell must never
   * mutate it; `send`/`setRoot`/`newChat` remain the only writers.
   */
  async liveSession(): Promise<AgentSession | null> {
    const pending = this.host;
    if (!pending) return null;
    return (await pending.catch(() => null))?.session ?? null;
  }

  /**
   * Explicit teardown of the live session, exactly once per built host.
   *
   * Idempotent and non-constructing: a session that was never built has nothing
   * to tear down (returns false), and a second call finds no host (false). The
   * production host is pi's AgentSessionRuntime, whose dispose() emits
   * session_shutdown before invalidating the session. Returns whether a host
   * was actually disposed.
   */
  async disposeLiveSession(reason: TeardownReason = 'quit'): Promise<boolean> {
    const previous = this.host;
    this.host = null;
    if (!previous) return false;
    const host = await previous.catch(() => null);
    if (!host) return false;
    await this.disposeHost(host, reason);
    return true;
  }

  /** The live session's id; `null` before a session exists. */
  async sessionId(): Promise<string | null> {
    const session = await this.liveSession();
    return session?.sessionManager.getSessionId() ?? null;
  }

  /**
   * The live session's stored conversation, projected for rendering: the
   * compaction-aware message projection merged with every raw custom event,
   * so durable crew events survive compaction. The constructing path used by
   * the swap seams — it builds the session when none is live.
   */
  private async transcriptAfterSwap(): Promise<ChatTimelineItem[]> {
    const session = await this.getSession().catch(() => null);
    return this.projectTranscript(session?.sessionManager ?? null);
  }

  /** Project an already resolved (or null) session's manager; null renders empty. */
  private projectTranscript(manager: SessionManager | null): ChatTimelineItem[] {
    return manager
      ? toTimeline(
          manager.buildContextEntries(),
          manager.getEntries(),
          // Branch-scope the raw durable projection: production must not infer
          // the current leaf from append order.
          manager.getLeafId(),
        )
      : [];
  }

  /**
   * The live (or armed) session's timeline without building, swapping or
   * disposing a session: the shared-session readback other clients reload
   * from. Empty when nothing is live or armed.
   */
  async transcript(): Promise<ChatTimelineItem[]> {
    const session = await this.liveSession();
    return this.projectTranscript(session?.sessionManager ?? this.armed);
  }

  private async installVault(session: AgentSession): Promise<AgentSession> {
    const guard = this.guardFactory
      ? await this.guardFactory()
      : await VaultGuard.create(
          (request, signal) => this.approvals.request(request, signal),
          config.vaultPath,
          this.root,
        );
    const previous = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const decision = await guard.guard(
        context.toolCall.id,
        context.toolCall.name,
        context.args,
        signal,
      );
      return decision ?? previous?.(context, signal);
    };
    return session;
  }

  /** Resume or deny a pending Vault escalation. */
  resolveApproval(requestId: string, approved: boolean): boolean {
    return this.approvals.resolve(requestId, approved);
  }

  /**
   * The `/` palette's list: FO's built-ins, then what `prompt()` dispatches
   * itself, read from the session. Builds the session when none is live, as a
   * turn would (pi runs in-process; nothing is sent).
   */
  async commands(): Promise<ChatCommandsResult> {
    return { commands: piCommands(await this.getSession()), state: 'live' };
  }

  /**
   * Compact the conversation now (`/compact`), steered by `instructions` when
   * given. It holds the slot as a turn does, so other views show it busy and
   * sends are refused meanwhile. Refused while a run streams: pi's compaction
   * aborts the run in progress first.
   */
  async compact(instructions: string | undefined, origin: string | null = null): Promise<void> {
    if (this.clientTurnInFlight || this.live?.session.isStreaming) {
      throw new WireCallError('a turn is already running', TURN_IN_PROGRESS);
    }
    this.clientTurnInFlight = true;
    this.turnOrigin = origin;
    this.broadcast({ kind: 'turn-started', origin });
    try {
      const session = await this.getSession();
      if (session.isStreaming) throw new WireCallError('a turn is already running', TURN_IN_PROGRESS);
      await session.compact(instructions);
    } finally {
      this.clientTurnInFlight = false;
      this.broadcast({ kind: 'turn-ended', origin });
    }
  }

  /** Name the conversation (pi's `/name`): its title from now on, here and in pi's own lists. */
  async rename(name: string): Promise<ChatSessionInfo | null> {
    const session = await this.getSession();
    session.setSessionName(name);
    return describeManager(session.sessionManager);
  }

  /**
   * Apply a per-turn model + effort to the live session before prompting.
   * Model first (a switch re-clamps the effort ladder), then effort. Both are
   * no-ops when already current, so an unchanged selection costs nothing and the
   * conversation history is untouched either way.
   */
  private async applyTurnOptions(session: AgentSession, opts: ChatTurnOptions): Promise<void> {
    if (opts.provider && opts.model) {
      const current = session.model;
      if (!current || current.provider !== opts.provider || current.id !== opts.model) {
        const model = await this.catalog.resolve(opts.provider, opts.model);
        if (model) {
          await session.setModel(model);
        }
      }
    }
    if (opts.effort) {
      const levels = session.getAvailableThinkingLevels();
      const effort = opts.effort as ThinkingLevel;
      if (levels.includes(effort) && session.thinkingLevel !== effort) {
        session.setThinkingLevel(effort);
      }
    }
  }

  /** Stream one assistant turn for `text`, honouring cancellation via `signal`. */
  async *send(
    text: string,
    signal: AbortSignal,
    opts: ChatTurnOptions = {},
    origin: string | null = null,
  ): AsyncIterable<ChatChunk> {
    // One client turn at a time on the shared session: a second `chat.send`
    // fails fast instead of replacing the running turn's approval channel or
    // switching its model mid-flight. A run pi-crew triggered is not a client
    // turn — sends wait for it below, as ever.
    if (this.clientTurnInFlight) {
      throw new WireCallError('a turn is already running', TURN_IN_PROGRESS);
    }
    // A pre-aborted signal must never dispatch a prompt: every dispatched turn
    // is paid for, and an aborted canary must not spend its one-turn budget.
    // Checked at entry and between every awaited setup stage; the abort
    // listener's own registration is re-checked too (an abort listener added
    // after the fact never fires).
    if (signal.aborted) return;
    // Set synchronously, before any await, so no second send can slip in
    // behind the session build. Cleared in the outer finally.
    this.clientTurnInFlight = true;
    this.turnOrigin = origin;
    this.broadcast({ kind: 'turn-started', origin });
    const startedAt = Date.now();
    const queue = new AsyncQueue<ChatChunk>();
    this.turnQueue = queue;
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let emitterInstalled = false;
    try {
      const session = await this.getSession();
      if (signal.aborted) return;
      const sessionReadyAt = Date.now();

      // An extension can start a run on its own — pi-crew delivers results
      // with triggerTurn — and pi rejects an unqualified prompt while any run
      // is active. This turn waits for that run instead of failing; the run's
      // events are not this turn's, so nothing is subscribed until it ends.
      // Turn options and the approval channel now bind to a run that is going
      // to be *this* turn's: applying them before the wait would retune or
      // re-route a run another client (or pi-crew) already started. A model
      // switch awaits, and a run can start inside it, so the wait repeats until
      // the options are in place on an idle session; from there to the prompt
      // dispatch below nothing awaits.
      do {
        while (session.isStreaming) {
          await idleOrAborted(session, signal);
          if (signal.aborted) return;
        }
        await this.applyTurnOptions(session, opts);
        if (signal.aborted) return;
      } while (session.isStreaming);
      this.approvals.setEmitter((chunk) => queue.push(chunk));
      emitterInstalled = true;
      const promptReadyAt = Date.now();

      let firstTokenAt: number | null = null;
      // Whether this prompt started a run. One it does not start never sends
      // `agent_end`: an extension command pi handled itself, or input an
      // extension's input handler took.
      let ran = false;
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'agent_start') ran = true;
        const mapped = turnChunk(session, event);
        if (mapped) {
          queue.push(mapped);
          if (mapped.kind === 'text' || mapped.kind === 'thinking') {
            firstTokenAt ??= Date.now();
          }
        }
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant' &&
          event.message.stopReason === 'error'
        ) {
          // pi reports a provider failure here and then ends the request stream
          // normally, so without this the browser saw an empty assistant
          // message that simply stopped. `aborted` is deliberately not an
          // error: the user asked for it. Failing the queue ends it, so the
          // agent_end close() below is a no-op and cannot mask this.
          queue.fail(new Error(providerErrorText(event.message.errorMessage)));
        } else if (event.type === 'message_end' && event.message.role === 'custom') {
          // Phase 2 live source: role-custom message_end (never entry_appended,
          // never message_start — mapping only the end event avoids double
          // emission). The chunk is appended at its arrival position without
          // touching the streaming assistant message; the observation stream may
          // carry the same event, and the browser dedups by stable id.
          this.mapCustomMessage(session, event, (chunk) => queue.push(chunk));
        } else if (event.type === 'agent_end') {
          // The mapped usage chunk (from the shared `turnChunk` above) is
          // already on the queue; this branch only logs the timing split and
          // closes the stream.
          // One line per turn splitting our own overhead from the provider's, so
          // "chat feels slow" can be attributed instead of guessed at.
          console.info(
            `[chat] session=${sessionReadyAt - startedAt}ms ` +
              `prep=${promptReadyAt - sessionReadyAt}ms ` +
              `ttft=${firstTokenAt ? firstTokenAt - promptReadyAt : -1}ms ` +
              `turn=${Date.now() - startedAt}ms`,
          );
          queue.close();
        }
      });

      onAbort = (): void => {
        void session.abort();
        queue.close();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // The signal may be aborted between the awaited setup and this
      // registration; re-check now that the listener is in place. The final
      // check and the prompt dispatch below are synchronous with no await
      // between them, so an abort cannot interleave in that window.
      if (signal.aborted) return;

      // `text`, not a rewritten prompt. What the user typed is what gets stored
      // and what the session is titled from. Composer images ride as
      // pi's own image content; with none, the call stays one-argument.
      const images: PiImageContent[] = (opts.images ?? []).map((image) => ({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      }));
      const dispatched =
        images.length > 0 ? session.prompt(text, { images }) : session.prompt(text);
      // `prompt()` resolves once the run it started has settled, so `agent_end`
      // has closed the turn by then. When it started none (a handled extension
      // command), nothing else would close it and the slot would stay busy: the
      // turn ends here. A run the command set going without awaiting it is
      // already streaming (pi marks it before its `agent_start`); its
      // `agent_end` closes the turn as usual.
      dispatched.then(
        () => {
          if (!ran && !session.isStreaming) queue.close();
        },
        (err: unknown) => queue.fail(err),
      );

      yield* queue;
    } finally {
      // Only this turn's own emitter is cleared: a send rejected by the guard
      // (or aborted while waiting) never installed one, so it must not clear
      // the running turn's channel.
      if (emitterInstalled) this.approvals.setEmitter(null);
      unsubscribe?.();
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.clientTurnInFlight = false;
      if (this.turnQueue === queue) this.turnQueue = null;
      this.broadcast({ kind: 'turn-ended', origin });
    }
  }
}
