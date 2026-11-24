import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type {
  AccountInfo,
  HookCallback,
  Options,
  Query,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.ts';
import {
  FUNKYOCTOPUS_NOTE,
  type ChatChunk,
  type ChatCommandsResult,
  type ChatEventItem,
  type ChatMessage,
  type ChatSessionInfo,
  type ChatTimelineItem,
  type ClaudeLiveSession,
  type ModelOption,
} from '../../../src/shared/transport/protocol.ts';
import {
  CHAT_CLOSED,
  CLAUDE_CAP_REACHED,
  CLAUDE_LIVE_ELSEWHERE,
  FOLDER_NOT_FOUND,
  TURN_IN_PROGRESS,
  WireCallError,
} from '../../../src/shared/transport/errors.ts';
import { AsyncQueue } from '../util/async-queue.ts';
import type { ChatTurnOptions, ToolGuard } from '../pi/pi-chat.ts';
import type { SessionRef } from '../chat-engine.ts';
import { toTitle } from '../pi/session-transcript.ts';
import { ApprovalBroker } from '../security/approval-broker.ts';
import { VaultGuard } from '../security/vault.ts';
import { claudeChildEnv } from './env.ts';
import { resolveClaudeBin } from './cli.ts';
import { messageOf } from '../util/errors.ts';
import { isRecord } from '../util/records.ts';
import { CLAUDE_NOT_LOGGED_IN, ChunkMapper, NOT_LOGGED_IN_MESSAGE } from './chunks.ts';
import { CLAUDE_PROVIDER, FALLBACK_MODELS, toModelOption, type ClaudeModelCache } from './models.ts';
import { claudeCommands, lastKnownCommands, rememberCommands, type ClaudeCommandCache } from './commands.ts';
import { sessionIdOf, sessionPath, toSessionInfo, type ClaudeSessionStore, type StoredSession } from './sessions.ts';
import { toMessages } from './session-transcript.ts';

/**
 * The slice of the SDK's `Query` the engine uses; the real one satisfies it.
 * `interrupt` takes `{ cancelQueued }` at runtime (SDK 0.3.302 forwards it as the
 * control request's `cancel_queued`), but its typings leave the parameter out.
 */
export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, 'setModel' | 'applyFlagSettings' | 'supportedModels' | 'supportedCommands' | 'accountInfo' | 'close'> & {
    interrupt(options?: { cancelQueued?: boolean }): Promise<SDKControlInterruptResponse | undefined>;
  };

/** The slice of the SDK's `query` the engine uses; the real function satisfies it. */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

export interface ClaudeCodeChatDeps {
  /** The Agent SDK's `query`; injected so tests never spawn `claude`. */
  query: ClaudeQueryFn;
  /** The configured `claude` (CLAUDE_BIN): a bare name searched on the environment's PATH, or a path. */
  bin: string;
  /** FunkyOctopus's version, reported to Claude Code as the client app. */
  version: string;
  /** Working folder of the first session; the config's global root by default. */
  root?: string;
  /** Environment the child env and the PATH search derive from; the sidecar's by default. */
  env?: NodeJS.ProcessEnv;
  resolveBin?: (bin: string, pathEnv: string) => Promise<string | null>;
  /** Builds the tool guard each session installs; the Vault, answering through this engine's approvals, by default. */
  guardFactory?: () => Promise<ToolGuard>;
  /** Vault rules file; the config's by default. */
  vaultPath?: string;
  /** How long the login check may take before the start is abandoned; 30 s by default. */
  accountTimeoutMs?: number;
  /** Claude Code's stored sessions and transcripts, and which sessions are running. */
  sessions: ClaudeSessionStore;
  /** Whether a folder exists; the filesystem by default. */
  folderExists?: (path: string) => Promise<boolean>;
  /** How long with no turn before the process is closed; 15 minutes by default. */
  idleMs?: number;
  /** Schedules the idle close and returns its cancel; `setTimeout` by default, injected so tests set the clock. */
  scheduleIdle?: (run: () => void, ms: number) => () => void;
  /** The clock the grace period after closing a process is measured on; `Date.now` by default. */
  now?: () => number;
  /**
   * Sessions whose process an engine closed, and when. One map shared by every
   * Claude slot, so slot B opening what slot A just closed does not fork it
   * (T2.1); the engine's own by default.
   */
  closed?: ClosedSessions;
  /**
   * Take a session for this slot in one step; false when another slot holds or
   * claimed it. Continuing a folder's latest claims its pick, skipping refusals.
   */
  claim?: (ref: SessionRef) => boolean;
  /** Give back a claimed pick the engine did not take up. */
  release?: (ref: SessionRef) => void;
  /**
   * Where the models a live process listed are kept: shared by every Claude
   * slot, so one slot's listing serves them all (and `models.list`). The
   * engine's own by default.
   */
  modelCache?: ClaudeModelCache;
  /**
   * Where the command lists live processes gave are kept, per folder: shared by
   * every Claude slot, so a slot with no process can still offer the last known
   * list. The engine's own by default.
   */
  commandCache?: ClaudeCommandCache;
  /** Asked before a process is started: false refuses the start (the running-process cap). */
  mayStart?: () => boolean;
  /** A slot created fresh: nothing is continued, its first send starts a new conversation. */
  fresh?: boolean;
}

/** Session id → when an engine closed that session's process. */
export type ClosedSessions = Map<string, number>;

/**
 * How long after the engine closes its own process that process may still be
 * listed by `claude agents` (it was gone within ~160 ms when measured). A row for
 * that session is not another Claude Code's until this has passed.
 */
const CLOSED_GRACE_MS = 5_000;


/** A process nobody has talked to for this long is closed; the next send resumes the session. */
const IDLE_MS = 15 * 60_000;

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then((entry) => entry.isDirectory(), () => false);

const afterTimeout = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** How many sessions the history dropdown lists for one folder, and across every folder. */
const LIST_LIMIT = 50;
const LIST_LIMIT_GLOBAL = 40;

/** How long the login check may take. The SDK's initialize step has no timeout of its own. */
const ACCOUNT_TIMEOUT_MS = 30_000;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/**
 * The model and effort a send asks of Claude Code. The picker may still hold a
 * pi model (the engine is chosen at start, the browser remembers its pick): a
 * model of another provider is not ours to apply, and neither is an effort
 * level Claude Code has no word for.
 */
function wanted(opts: ChatTurnOptions): { model?: string; effort?: Effort } {
  if (opts.provider !== undefined && opts.provider !== CLAUDE_PROVIDER) return {};
  const effort = EFFORTS.find((level) => level === opts.effort);
  return {
    ...(opts.model !== undefined && opts.model !== '' ? { model: opts.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/**
 * Claude Code's own ways to start a turn without a prompt from the owner: cron
 * jobs, wakeups, monitors and remote triggers. Disallowed for the chat engine
 * (decision 12, limit 2); the names are the ones `system/init.tools` lists.
 */
const UNATTENDED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'Monitor'];

/**
 * Whether the process is signed in at all, from what it reports before any
 * prompt. Every sign-in the CLI supports goes ahead (decision 12, limit 1): a
 * claude.ai login (`subscriptionType`), an API key (`apiKeySource`), a token
 * (`tokenSource`), or a cloud provider, whose auth is external and leaves the
 * other fields absent. Logged out, the CLI reports `tokenSource: 'none'`, no
 * key and no plan (measured); a sign-in that later fails ends the turn with the
 * same not-logged-in error.
 */
function accountRefusal(account: AccountInfo): WireCallError | null {
  const set = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== 'none';
  const signedIn =
    (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') ||
    set(account.subscriptionType) ||
    set(account.apiKeySource) ||
    set(account.tokenSource);
  return signedIn ? null : new WireCallError(NOT_LOGGED_IN_MESSAGE, CLAUDE_NOT_LOGGED_IN);
}

type UserContent = SDKUserMessage['message']['content'];
/** The image types the API takes; the seam only checks `image/*`, so a stray one is the API's to refuse. */
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * The prompt's content: the text alone, or, with composer images, base64 image
 * blocks ahead of the text (a lone image sends no empty text block).
 */
function promptContent(text: string, images: ChatTurnOptions['images']): UserContent {
  if (!images || images.length === 0) return text;
  return [
    ...images.map((image) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mimeType as ImageMediaType, data: image.data },
    })),
    ...(text !== '' ? [{ type: 'text' as const, text }] : []),
  ];
}

/**
 * How long Claude Code waits on a PreToolUse hook. An escalation waits on the
 * owner, so this is a human's patience, not a machine's: the hook's default
 * would deny a call the owner is still reading.
 */
const HOOK_TIMEOUT_SECONDS = 600;

/**
 * One prompt of the owner's and the turn it starts. The prompt carries `uuid`;
 * the CLI stamps it on the turn it starts for that prompt, which is how this
 * turn is told from one the CLI starts on its own.
 */
interface Turn {
  uuid: ReturnType<typeof randomUUID>;
  /** The client that sent the prompt, for what its turn announces to the others. */
  origin: string | null;
  queue: AsyncQueue<ChatChunk>;
  /** The request's abort signal: Esc, or the socket closing. */
  signal: AbortSignal;
  /** The owner stopped it: it is still draining, but nothing of it is shown or allowed. */
  stopped: boolean;
  /** Its `system/init` has arrived. */
  started: boolean;
  /** Its `result` has been consumed, or the session died: the CLI is done with it. */
  done: boolean;
  /** Resolves when `done` becomes true. */
  settled: Promise<void>;
  settle: () => void;
}

/**
 * Whose messages are arriving now, decided at each `system/init` (a turn's
 * first frame) and cleared by its `result`: `human` is the owner's live turn,
 * `stopped` one of the owner's that was stopped before it began, `foreign` a turn
 * the CLI started by itself (a finished background task, a cron).
 */
type Routing = 'idle' | 'human' | 'stopped' | 'foreign';

/** One live `claude` process: a streaming-input `query` that serves many turns. */
interface Session {
  query: ClaudeQuery;
  input: AsyncQueue<SDKUserMessage>;
  mapper: ChunkMapper;
  /** The owner's latest prompt; once `done`, no longer live. */
  turn: Turn | null;
  routing: Routing;
  /** Set while a `foreign` turn runs; a send waits it out. */
  foreign: { promise: Promise<void>; resolve: () => void } | null;
  /** The owner's turn whose messages are arriving now (`human` or `stopped` routing). */
  active: Turn | null;
  /**
   * Whether this CLI stamps the turns it starts for a prompt. Assumed, which is
   * what 2.1.302 does: an unstamped turn is then not the owner's. `absent` only on
   * evidence of an older CLI, which is then trusted by position.
   */
  stamping: 'assumed' | 'seen' | 'absent';
  /** The working folder the process was started in. */
  root: string;
  /** The SDK's session id, known from the first `system/init`. */
  id: string | null;
  /** The first prompt, as the title of a session that has no name. */
  title: string | null;
  created: number;
  modified: number;
  /** The model and effort the process is on, as last asked for. */
  model: string | undefined;
  effort: Effort | undefined;
  /** Why this process is a fork, told to the owner with the first prompt it serves. */
  notice: ChatEventItem | null;
  /** The commands this process lists, once `supportedCommands()` answered; `commands_changed` replaces them. */
  commands: SlashCommand[] | null;
  /** The commands its `system/init` names as terminal-only. */
  terminal: string[];
}

/**
 * The conversation the chat is on, whether or not a process is serving it: what
 * an opened session, a re-rooted folder's latest session, a reaped process or
 * one that died leaves behind for the next send to resume.
 */
interface Conversation {
  id: string;
  cwd: string;
  title: string;
  created: number;
  modified: number;
  /** Resume it as a copy: the original is running in another Claude Code. */
  fork?: true;
}

/** Whether a message is a turn's `system/init`. */
function isInit(message: Record<string, unknown>): boolean {
  return message.type === 'system' && message.subtype === 'init';
}

/** The owner's turn if it is the one running now and the owner has not stopped it. */
function liveTurn(session: Session | undefined): Turn | null {
  return session?.routing === 'human' && session.turn && !session.turn.stopped ? session.turn : null;
}

/** The prompt uuids a frame says it answers; null when the CLI stamped nothing on it. */
function stampsOf(message: Record<string, unknown>): string[] | null {
  const many = message.user_message_uuids;
  if (Array.isArray(many)) return many.filter((uuid): uuid is string => typeof uuid === 'string');
  return typeof message.user_message_uuid === 'string' ? [message.user_message_uuid] : null;
}

/** `promise`'s value, or null as soon as `signal` aborts (the promise is left to finish on its own). */
function orAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const abort = (): void => resolve(null);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** `promise`, or a rejection with `message` if it has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** What a send is told when its process ended, or its chat was replaced, before the prompt went out. */
const sessionEnded = (): WireCallError =>
  new WireCallError('the Claude Code session ended — send again', 'claude_exited');

/** What the owner is told when a prompt is over and no turn of it was ever shown. */
const noAnswerError = (): WireCallError =>
  new WireCallError('Claude Code ended this prompt without showing an answer — send it again', 'claude_no_answer');

/** Resolves when `promise` does, or as soon as `signal` aborts. */
function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void promise.then(done);
  });
}

/** What a turn is told when its chat is replaced under it (a new chat, another folder). */
const replaced = (): WireCallError => new WireCallError('chat was replaced', 'claude_replaced');

/** Where `claude agents` found a session running (or why it could not be asked). */
type Elsewhere = { name: string; cwd: string } | { unverified: string };

/**
 * The note that a session was opened as a fork instead of resumed (decision 12,
 * limit 5): resuming a session that is running elsewhere forks its transcript
 * tree, so the copy is the safe way to carry on.
 */
function forkNotice(elsewhere: Elsewhere): ChatEventItem {
  const content =
    'name' in elsewhere
      ? `opened as a fork: this session is live in Claude Code '${elsewhere.name}' (${elsewhere.cwd}); your terminal session is untouched`
      : `opened as a fork: could not check whether this session is live in another Claude Code (${elsewhere.unverified}); the original is untouched`;
  return {
    kind: 'custom-message',
    id: `funkyoctopus-fork-${randomUUID()}`,
    customType: FUNKYOCTOPUS_NOTE,
    display: true,
    content,
    details: null,
    timestamp: Date.now(),
  };
}

const denial = (reason: string): Awaited<ReturnType<HookCallback>> => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * The Vault as Claude Code's PreToolUse hook. Under `bypassPermissions` the SDK
 * never calls `canUseTool`, so this is the one place a call can still be
 * stopped: a `block` from the guard becomes a deny, anything else passes. It
 * listens to the hook's own signal and to the turn's, so Esc releases a call
 * waiting on an approval card.
 *
 * It fails closed. A hook that throws does not stop the tool (measured on
 * 2.1.302: the call ran), so any failure of the guard is itself a deny. A hook
 * that outlasts its timeout is denied by Claude Code itself (also measured).
 */
function vaultHook(guard: ToolGuard, liveTurn: () => Turn | null): HookCallback {
  return async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const turn = liveTurn();
    // Limit 2 of decision 12: only a turn the owner started may use tools. A turn the
    // CLI started by itself, or one the owner stopped, gets none.
    if (!turn) return denial('Vault blocked this call: no turn started by you is running');
    try {
      const decision = await guard.guard(
        toolUseID ?? input.tool_use_id,
        input.tool_name,
        input.tool_input,
        AbortSignal.any([signal, turn.signal]),
      );
      return decision ? denial(decision.reason) : {};
    } catch (error) {
      return denial(`Vault could not check this call — ${messageOf(error)}`);
    }
  };
}

/** A stored session as the conversation the chat continues. */
function conversationOf(row: StoredSession, cwd: string): Conversation {
  return {
    id: row.sessionId,
    cwd,
    title: toTitle([row.customTitle, row.summary, row.firstPrompt].find((label) => label !== undefined && label.trim() !== '') ?? ''),
    created: row.createdAt ?? row.lastModified,
    modified: row.lastModified,
  };
}

/**
 * The chat engine over Claude Code, driven through the Agent SDK on the owner's
 * own sign-in (CURRENT_STATE decision 12). One long-lived `claude` process per
 * session, started on the first send; each send pushes a user message into its
 * input stream and maps the SDK's message stream onto chunks until that turn's
 * `result`.
 */
export class ClaudeCodeChat {
  readonly kind = 'claude-code' as const;
  private root: string;
  /** The conversation the chat is on; null while a fresh one has not reported its id. */
  private convo: Conversation | null = null;
  /**
   * Nothing has chosen the conversation yet: the sidecar has just started. The
   * first time a browser applies its folder, that folder's latest session is
   * continued (as a restarted pi chat does); a new chat, an opened one, or a
   * started process ends the not-knowing.
   */
  private undecided = true;
  /** Why the conversation is a fork, kept with it so a reload still explains it. */
  private notes: ChatEventItem[] = [];
  /** Cancels the idle close scheduled for the live process, if one is. */
  private cancelIdle: (() => void) | null = null;
  /** When the live process last went quiet (its turn ended, or it started with none waiting). */
  private idleAt = 0;
  /** The live process, once started; `starting` is the build in flight. */
  private session: Session | null = null;
  private starting: Promise<Session> | null = null;
  /** Rejects the send(s) waiting on `starting`; set while a start is in flight. */
  private cancelStart: ((error: Error) => void) | null = null;
  /** Every process still starting, so a reset can kill one that never finishes (a stale start's included). */
  private readonly startingQueries = new Set<ClaudeQuery>();
  /** A new session id the other tabs have not been told of: sent when the turn that learned it ends. */
  private announce: { origin: string | null } | null = null;
  /** Sessions whose process the engine closed, and when: still listed for a moment, and not another's. */
  private readonly closed: ClosedSessions;
  /** Listeners of the identity hook, and the session id last reported to them. */
  private readonly identityListeners = new Set<(ref: SessionRef | null) => void>();
  private identity: string | null = null;
  /** Bumped by every reset: a start that finishes under an older one is discarded. */
  private epoch = 0;
  private clientTurnInFlight = false;
  /** The client whose turn is in flight (null when unclaimed). */
  private turnOrigin: string | null = null;
  private readonly approvals = new ApprovalBroker();
  private readonly observers = new Set<(chunk: ChatChunk) => void>();
  /** Ends each open observe stream; dispose() calls them all. */
  private readonly observeClosers = new Set<() => void>();
  private disposed = false;
  /** The models a live process listed; read once, from the first process of any slot sharing the cache. */
  private readonly modelCache: ClaudeModelCache;
  private modelsRequested = false;
  private readonly commandCache: ClaudeCommandCache;

  constructor(private readonly deps: ClaudeCodeChatDeps) {
    this.root = deps.root ?? config.primaryWorkspaceRoot;
    this.closed = deps.closed ?? new Map<string, number>();
    this.modelCache = deps.modelCache ?? { models: null };
    this.commandCache = deps.commandCache ?? { roots: [] };
    // Every approval also reaches every view of the slot, tagged with whose turn
    // asked, so any of them can answer (the turn's own stream gets it too).
    this.approvals.onRequest((chunk) => {
      if (chunk.kind === 'approval-request') this.broadcast({ ...chunk, origin: this.turnOrigin });
    });
    // An answer, from whichever view gave it, settles the card in every view.
    this.approvals.onResolved((chunk) => this.broadcast(chunk));
    this.undecided = deps.fresh !== true;
  }

  /**
   * The live process, started on demand. One start at a time is shared by the
   * sends waiting on it; a reset while it runs rejects those sends, kills the
   * process being started, and discards the session if the start finishes anyway.
   */
  private getSession(want: { model?: string; effort?: Effort }): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    if (this.starting) return this.starting;
    // Checked and claimed in one synchronous stretch (`starting` is set below), so two
    // slots starting at once cannot both slip under the cap.
    if (this.deps.mayStart?.() === false) {
      return Promise.reject(
        new WireCallError(
          'too many Claude Code sessions are running in FunkyOctopus — close a Claude tab, or wait for an idle one to be reaped',
          CLAUDE_CAP_REACHED,
        ),
      );
    }
    const epoch = this.epoch;
    let cancel: (error: Error) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = reject;
    });
    const started = this.startSession(want).then((session) => {
      if (epoch !== this.epoch) {
        this.closeSession(session);
        throw sessionEnded();
      }
      this.session = session;
      this.undecided = false;
      // A send that ended before this start did (Esc, a closed tab) has already had its turn's end:
      // nothing else would ever close this process. A send still waiting arms it at its own end.
      if (!this.clientTurnInFlight) this.armIdle();
      return session;
    });
    const starting: Promise<Session> = Promise.race([started, cancelled]).finally(() => {
      if (this.starting === starting) {
        this.starting = null;
        this.cancelStart = null;
      }
    });
    // A start nobody waits on any more (Esc, a reset) must not surface as unhandled.
    for (const promise of [started, cancelled, starting]) promise.catch(() => undefined);
    this.starting = starting;
    this.cancelStart = cancel;
    return starting;
  }

  private async startSession(want: { model?: string; effort?: Effort }): Promise<Session> {
    const epoch = this.epoch;
    // Everything this start decides is read now, before anything awaits: a reset meanwhile
    // discards the start, and every await below is followed by a check that it has not.
    const root = this.root;
    const convo = this.convo;
    const stale = (): boolean => epoch !== this.epoch;
    const env = this.deps.env ?? process.env;
    const resolve = this.deps.resolveBin ?? resolveClaudeBin;
    const bin = await resolve(this.deps.bin, env.PATH ?? '');
    if (stale()) throw sessionEnded();
    if (bin === null) {
      throw new WireCallError('Claude Code not found — install it, or set CLAUDE_BIN', 'claude_unavailable');
    }
    const guard = await (this.deps.guardFactory
      ? this.deps.guardFactory()
      : VaultGuard.create(
          (request, signal) => this.approvals.request(request, signal),
          this.deps.vaultPath ?? config.vaultPath,
          root,
        ));
    if (stale()) throw sessionEnded();
    // Resuming a conversation is the one start that can double-drive it: it may have gone live
    // elsewhere since it was armed (decision 12, limit 5), so it is asked again, fresh. A fork
    // never drives the original, so it needs no answer.
    let fork = convo?.fork === true;
    let notice: ChatEventItem | null = null;
    if (convo && !fork) {
      const elsewhere = await this.elsewhere(convo.id);
      if (stale()) throw sessionEnded();
      if (elsewhere) {
        fork = true;
        notice = forkNotice(elsewhere);
        // Until the fork's first init the chat has no session of its own: it must not report the original's.
        this.convo = { ...convo, fork: true };
        // The conversation is a fork from here on, whether or not this start gets as far as a process:
        // a reload shows why, and a retry that forks does not say it again.
        this.notes.push(notice);
      }
    }
    const input = new AsyncQueue<SDKUserMessage>();
    const live: { session?: Session } = {};
    const query = this.deps.query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: bin,
        // No cron and no background tasks: both let the CLI start a turn nobody asked for.
        env: { ...claudeChildEnv(env, this.deps.version), CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        disallowedTools: UNATTENDED_TOOLS,
        cwd: root,
        ...(convo ? { resume: convo.id } : {}),
        ...(fork ? { forkSession: true } : {}),
        // Claude Code's own prompt, not the SDK's minimal default.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // The owner's YOLO posture (decision 12); the Vault runs as a PreToolUse
        // hook because `canUseTool` is never asked under bypass.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(want.model !== undefined ? { model: want.model } : {}),
        ...(want.effort !== undefined ? { effort: want.effort } : {}),
        // Setting sources stay at their default: CLAUDE.md, skills and the
        // owner's hooks load, which is how Leeboard (`lb brief`) reaches the session.
        hooks: { PreToolUse: [{ hooks: [vaultHook(guard, () => liveTurn(live.session))], timeout: HOOK_TIMEOUT_SECONDS }] },
      },
    });
    this.startingQueries.add(query);
    // Who is logged in is known before any prompt is sent, so a refusal costs nothing.
    // The SDK's initialize step has no timeout of its own, hence the one here.
    const refusal = await within(
      query.accountInfo(),
      this.deps.accountTimeoutMs ?? ACCOUNT_TIMEOUT_MS,
      'the check did not answer in time',
    ).then(
      accountRefusal,
      (error: unknown) =>
        new WireCallError(`Could not confirm the Claude Code login — ${messageOf(error)}`, 'claude_account_unreadable'),
    );
    this.startingQueries.delete(query);
    if (stale()) {
      // A reset closed this process already (or will find nothing to close): it must not become a session.
      input.close();
      query.close();
      throw sessionEnded();
    }
    if (refusal) {
      input.close();
      query.close();
      throw refusal;
    }
    const session: Session = {
      query,
      input,
      mapper: new ChunkMapper(),
      turn: null,
      routing: 'idle',
      foreign: null,
      active: null,
      stamping: 'assumed',
      root,
      // A fork gets a new id from its first init; a resumed session keeps its own.
      id: convo && !fork ? convo.id : null,
      title: convo?.title ?? null,
      created: convo?.created ?? Date.now(),
      modified: convo?.modified ?? Date.now(),
      model: want.model,
      effort: want.effort,
      notice,
      commands: null,
      terminal: [],
    };
    live.session = session;
    void this.pump(session);
    this.readCommands(session);
    return session;
  }

  /**
   * Reads the process's messages for as long as it lives and routes them. Every
   * turn opens with a `system/init` that says whose it is; only the owner's own
   * live turn gets its chunks, and anything else is dropped (decision 12, limit 2).
   */
  private async pump(session: Session): Promise<void> {
    try {
      for await (const message of session.query) {
        if (!isRecord(message)) continue;
        if (isInit(message)) {
          if (typeof message.session_id === 'string') {
            session.id = message.session_id;
            this.adopt(session);
            this.readModels(session);
          }
          this.noteTerminalCommands(session, (message as Record<string, unknown>).terminal_slash_commands);
          this.startTurn(session, message);
        }
        if (message.type === 'system' && message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
          this.keepCommands(session, message.commands);
        }
        if (this.deliver(session, message)) return;
      }
      this.closeSession(session, new WireCallError('Claude Code stopped unexpectedly', 'claude_exited'));
    } catch (error) {
      this.closeSession(
        session,
        new WireCallError(`Claude Code stopped unexpectedly — ${messageOf(error)}`, 'claude_exited'),
      );
    }
  }

  /**
   * A turn begins. It is the owner's if the CLI stamped it with the live prompt's
   * uuid. The CLI is assumed to stamp (2.1.302 does), so an unstamped turn is one
   * it started by itself, or the tail of a prompt the owner stopped before it
   * began: both are interrupted at once and dropped, by a plain interrupt so a
   * prompt waiting behind them still runs. Only an init that reports its
   * capabilities without `msg_lifecycle_v1`, the protocol that echoes prompt
   * uuids, shows an older CLI, and that one is trusted by position instead.
   */
  private startTurn(session: Session, init: Record<string, unknown>): void {
    // An init inside a turn (a re-initialisation) starts nothing.
    if (session.routing !== 'idle') return;
    const stamps = stampsOf(init);
    if (stamps !== null) session.stamping = 'seen';
    else if (
      session.stamping === 'assumed' &&
      Array.isArray(init.capabilities) &&
      !init.capabilities.includes('msg_lifecycle_v1')
    ) {
      session.stamping = 'absent';
    }
    const turn = session.turn;
    const ours =
      turn !== null &&
      !turn.done &&
      (stamps !== null ? stamps.includes(turn.uuid) : session.stamping === 'absent' && !turn.started);
    if (ours) {
      turn.started = true;
      session.active = turn;
      if (!turn.stopped) {
        session.routing = 'human';
        return;
      }
      session.routing = 'stopped';
    } else {
      session.routing = 'foreign';
      let resolve = (): void => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      session.foreign = { promise, resolve };
    }
    void session.query.interrupt().catch(() => undefined);
  }

  /** Hands one frame to the turn it belongs to; true when it closed the session. */
  private deliver(session: Session, message: Record<string, unknown>): boolean {
    if (message.type === 'rate_limit_event') {
      session.mapper.map(message);
      return false;
    }
    if (message.type === 'command_lifecycle') {
      this.lifecycle(session, message);
      return false;
    }
    const active = session.active;
    if (message.type !== 'result') {
      if (session.routing !== 'human' || !active) return false;
      for (const chunk of session.mapper.map(message).chunks) active.queue.push(chunk);
      return false;
    }
    const stamps = stampsOf(message);
    // The owner's live prompt, if this result names it: it ends then, whatever turn is current.
    const named = session.turn && !session.turn.done && stamps?.includes(session.turn.uuid) ? session.turn : null;
    if (session.routing === 'human' && active) {
      // A result that names another prompt is not this turn's end.
      if (stamps !== null && !stamps.includes(active.uuid)) {
        if (named) this.noAnswer(named);
        return false;
      }
      const step = session.mapper.map(message);
      for (const chunk of step.chunks) active.queue.push(chunk);
      session.modified = Date.now();
      const error = step.end?.error;
      if (error instanceof WireCallError && error.code === CLAUDE_NOT_LOGGED_IN) {
        // A process started logged out would never see a later `/login`.
        this.closeSession(session, error);
        return true;
      }
      if (error) active.queue.fail(error);
      else active.queue.close();
      this.settle(active);
    } else if (session.routing === 'stopped' && active) {
      if (stamps === null || stamps.includes(active.uuid)) this.settle(active);
    } else if (session.routing === 'foreign') {
      session.foreign?.resolve();
      session.foreign = null;
    }
    session.routing = 'idle';
    session.active = null;
    if (named && !named.done) this.noAnswer(named);
    return false;
  }

  /**
   * The CLI's own word on a prompt (`msg_lifecycle_v1`). One it completed or
   * cancelled without ever starting a turn for it (its error path emits no
   * `init`) is over, though no result may follow.
   */
  private lifecycle(session: Session, frame: Record<string, unknown>): void {
    const turn = session.turn;
    if (!turn || turn.done || turn.started || frame.command_uuid !== turn.uuid) return;
    if (frame.state === 'completed' || frame.state === 'cancelled') this.noAnswer(turn);
  }

  /**
   * End a prompt whose turn the engine never saw: nothing of it was shown. The
   * owner is told, unless they stopped it themselves.
   */
  private noAnswer(turn: Turn): void {
    if (turn.stopped) turn.queue.close();
    else turn.queue.fail(noAnswerError());
    this.settle(turn);
  }

  private settle(turn: Turn): void {
    turn.done = true;
    turn.settle();
  }

  /**
   * The id a process reports at its init is the conversation's id from then on: a
   * fork gets a new one. Other clients are told when it changed from one they
   * were shown; a fresh session had none to contradict.
   */
  private adopt(session: Session): void {
    if (this.session !== session || session.id === null) return;
    const before = this.convo?.id ?? null;
    this.convo = {
      id: session.id,
      cwd: session.root,
      title: session.title ?? this.convo?.title ?? toTitle(''),
      created: session.created,
      modified: session.modified,
    };
    this.reportIdentity();
    // The other tabs hear of it when the turn ends: told mid-turn, they would show the chat idle while it streams.
    if (before !== null && before !== session.id) {
      this.announce = { origin: session.turn?.origin ?? null };
      if (!this.clientTurnInFlight) this.announceNewId();
    }
  }

  /** Tell the other tabs the session id changed, if it did and they have not been told. */
  private announceNewId(): void {
    const pending = this.announce;
    this.announce = null;
    const session = this.info();
    if (pending && session) this.broadcast({ kind: 'session-changed', origin: pending.origin, session });
  }

  /**
   * Whether Claude Code is running `id` somewhere other than this engine, read
   * fresh (a cached picture could be 10 s old). A read that fails is not a "no":
   * the answer is then unverified, and callers treat that like a yes.
   */
  private async elsewhere(id: string): Promise<Elsewhere | null> {
    const read = await this.deps.sessions
      .live({ fresh: true })
      .catch((error: unknown) => ({ live: [], error: messageOf(error) }));
    if (read.error !== undefined) return { unverified: read.error };
    // The engine's own live process is never asked about: opening its session only reloads it,
    // and a start happens when there is no process.
    const found = this.otherRows(id, read.live).at(-1);
    return found ? { name: found.name, cwd: found.cwd } : null;
  }

  /**
   * The rows `claude agents` lists for a session, oldest start first, without the
   * engine's own process if it has only just closed it (a closing process is
   * still listed for a moment). Exactly one row is forgiven: the engine held the
   * session alone, so any other row is another Claude Code, a terminal's included.
   */
  private otherRows(id: string, live: ClaudeLiveSession[]): ClaudeLiveSession[] {
    const rows = live.filter((row) => row.sessionId === id).sort((a, b) => a.startedAt - b.startedAt);
    return this.justClosed(id) ? rows.slice(1) : rows;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The engine closed this session's process a moment ago: a row still listed for it is that process's. */
  private justClosed(id: string): boolean {
    const at = this.closed.get(id);
    if (at === undefined) return false;
    if (this.now() - at < CLOSED_GRACE_MS) return true;
    this.closed.delete(id);
    return false;
  }

  /**
   * The Claude Code that has this process's session open besides it, if one has
   * (decision 12, limit 5, the other way round: the owner resumed in a terminal
   * a conversation this engine holds). Read from the cached listing; one that
   * cannot be read does not stop a send.
   *
   * The SDK does not expose its child's pid, so the engine's own row cannot be
   * picked out by it. The engine's process holds the session alone from its
   * start (it forks rather than resumes a session already running), so it is the
   * earliest start among the rows naming the session, and anything else is a
   * later start: another Claude Code, the last of which is named.
   */
  private async sharedWith(session: Session): Promise<{ name: string } | null> {
    if (session.id === null) return null;
    const read = await this.deps.sessions.live().catch(() => null);
    if (!read || read.error !== undefined) return null;
    // A process this one replaced just now may still be listed beside it: forgive that row first.
    const rows = this.otherRows(session.id, read.live);
    const other = rows.length > 1 ? rows.at(-1) : undefined;
    return other ? { name: other.name } : null;
  }

  /** Calls `listener` with the held session each time it changes; returns the unsubscribe. */
  onIdentity(listener: (ref: SessionRef | null) => void): () => void {
    this.identityListeners.add(listener);
    return () => this.identityListeners.delete(listener);
  }

  /** Tell the identity listeners which session is held, if it is not the one they last heard. */
  private reportIdentity(): void {
    const id = this.info()?.id ?? null;
    if (id === this.identity) return;
    this.identity = id;
    const ref = id === null ? null : { engine: 'claude-code' as const, id };
    for (const listener of this.identityListeners) listener(ref);
  }

  /** A client turn is live, or the process is still busy with one (a stopped turn draining, one the CLI started). */
  busy(): boolean {
    const session = this.session;
    return this.clientTurnInFlight || (session !== null && (session.routing !== 'idle' || session.foreign !== null));
  }

  /** A `claude` process of this engine's is up or starting: what the running-process cap counts. */
  running(): boolean {
    return this.session !== null || this.starting !== null;
  }

  /** Background tasks are off in FunkyOctopus (decision 12): nothing keeps running after a switch. */
  subagentsLeftRunning(): number {
    return 0;
  }

  /** The slot's working folder, null at the configured global root. */
  folder(): string | null {
    return this.root === config.primaryWorkspaceRoot ? null : this.root;
  }

  /**
   * Restore after a restart: arm a stored session for the next send, in the
   * folder it was recorded in. Nothing is spawned (limit 2), and nobody is
   * asked whether it is running elsewhere: the start asks, fresh, and forks
   * then if it is (limit 5), so a `claude agents` read that fails at boot does
   * not fork every restored tab. False, with nothing changed, when Claude Code
   * no longer has the session or its folder is gone.
   */
  async arm(session: { id: string; path: string }): Promise<boolean> {
    const row = await this.deps.sessions.info(session.id).catch(() => undefined);
    if (row?.cwd === undefined || !(await (this.deps.folderExists ?? isDirectory)(row.cwd))) return false;
    if (this.disposed || this.session || this.starting) return false;
    this.undecided = false;
    this.root = row.cwd;
    this.convo = conversationOf(row, row.cwd);
    this.notes = [];
    this.reportIdentity();
    return true;
  }

  /** The conversation's identity: the live process's once it has reported, else the one armed for the next send. */
  info(): ChatSessionInfo | null {
    const session = this.session;
    if (session && session.id !== null) {
      return {
        // Not a file: Claude Code owns its transcript, and the id is what names it.
        path: sessionPath(session.id),
        engine: 'claude-code',
        id: session.id,
        cwd: session.root,
        title: session.title ?? toTitle(''),
        created: new Date(session.created).toISOString(),
        modified: new Date(session.modified).toISOString(),
      };
    }
    const convo = this.convo;
    // A fork that has not started has no session of its own: the id armed is the original's, which is running elsewhere.
    if (!convo || convo.fork) return null;
    return {
      path: sessionPath(convo.id),
      engine: 'claude-code',
      id: convo.id,
      cwd: convo.cwd,
      title: convo.title,
      created: new Date(convo.created).toISOString(),
      modified: new Date(convo.modified).toISOString(),
    };
  }

  /**
   * The SDK lists models only through a live process, so the first one to come up
   * is asked once and the answer kept (and handed on to be saved). A list the cache
   * holds from the last run is only the last known one, so it does not stop the ask.
   * Failure leaves what the cache has (the saved list, else the aliases) in place.
   */
  private readModels(session: Session): void {
    const cache = this.modelCache;
    if (this.modelsRequested || (cache.models && !cache.stale)) return;
    this.modelsRequested = true;
    session.query.supportedModels().then(
      (models) => {
        cache.models = models.map(toModelOption);
        cache.stale = false;
        cache.persist?.(cache.models);
      },
      () => {
        this.modelsRequested = false;
      },
    );
  }

  /**
   * The process's commands, asked once as it starts (the SDK has them from its
   * initialize step, before any turn). A failure leaves the last-known list.
   */
  private readCommands(session: Session): void {
    session.query.supportedCommands().then(
      (commands) => this.keepCommands(session, commands),
      () => undefined,
    );
  }

  /** A process's list replaces what it had, and becomes its folder's last-known one. */
  private keepCommands(session: Session, commands: SlashCommand[]): void {
    session.commands = commands;
    rememberCommands(this.commandCache, { root: session.root, commands, terminal: session.terminal });
  }

  /** `system/init` names the terminal-only commands; kept with the list when they change. */
  private noteTerminalCommands(session: Session, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const terminal = raw.filter((name): name is string => typeof name === 'string');
    if (terminal.join('\n') === session.terminal.join('\n')) return;
    session.terminal = terminal;
    if (session.commands) rememberCommands(this.commandCache, { root: session.root, commands: session.commands, terminal });
  }

  /**
   * The `/` palette's list: the live process's, less what FO hides
   * (`commands.ts`). With no process, the last-known list, and nothing is
   * started to ask (decision 12).
   */
  commands(): Promise<ChatCommandsResult> {
    const session = this.session;
    if (session?.commands) {
      return Promise.resolve({ commands: claudeCommands(session.commands, session.terminal), state: 'live' });
    }
    const known = lastKnownCommands(this.commandCache, session?.root ?? this.root);
    return Promise.resolve(known ? { commands: known, state: 'last-known' } : { commands: [], state: 'none' });
  }

  /**
   * End a process: forget it (the next send starts a fresh one), shut its input
   * and kill it, and end the turn it was serving, with `error` when given.
   * Idempotent, so an exit following a deliberate close is a no-op.
   */
  private closeSession(session: Session, error?: Error): void {
    if (this.session === session) {
      this.session = null;
      this.cancelIdle?.();
      this.cancelIdle = null;
      if (session.id !== null) this.closed.set(session.id, this.now());
    }
    session.input.close();
    session.query.close();
    session.foreign?.resolve();
    session.foreign = null;
    const turn = session.turn;
    if (!turn) return;
    if (error) turn.queue.fail(error);
    else turn.queue.close();
    this.settle(turn);
  }

  /** Stream one assistant turn for `text`, honouring cancellation via `signal`. */
  async *send(
    text: string,
    signal: AbortSignal,
    opts: ChatTurnOptions = {},
    origin: string | null = null,
  ): AsyncIterable<ChatChunk> {
    // One client turn at a time, as on pi: a second send fails fast instead of
    // sharing the running turn's stream.
    if (this.clientTurnInFlight) {
      throw new WireCallError('a turn is already running', TURN_IN_PROGRESS);
    }
    // A dispatched turn is paid for (quota or API billing): an aborted request
    // never starts one.
    if (signal.aborted) return;
    this.clientTurnInFlight = true;
    this.turnOrigin = origin;
    // A turn is starting: the idle close is off until it ends.
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.broadcast({ kind: 'turn-started', origin });
    const queue = new AsyncQueue<ChatChunk>();
    let onAbort: (() => void) | undefined;
    let emitterInstalled = false;
    try {
      const want = wanted(opts);
      // A process that was there before this send was not asked about by a start of its own.
      const reused = this.session !== null;
      // Esc must end a send that is still waiting for the process to start.
      const session = await orAborted(this.getSession(want), signal);
      if (session === null) return;
      // A turn that was stopped, or one the CLI started by itself, is still
      // draining its last messages; they are not this turn's, so wait for its
      // `result` before pushing the next prompt. Esc on that wait abandons the
      // stale turn, which may never end (a prompt the CLI dropped), so the next
      // send is not stuck behind it: if it does start later it is dropped as foreign.
      for (;;) {
        const stale = session.foreign ? null : session.turn && !session.turn.done ? session.turn : null;
        const draining = session.foreign?.promise ?? stale?.settled;
        if (!draining) break;
        await untilAborted(draining, signal);
        if (signal.aborted) {
          if (stale) this.settle(stale);
          session.foreign?.resolve();
          session.foreign = null;
          return;
        }
      }
      // The owner may have resumed this conversation in a terminal since the last send: driving it
      // from here as well forks its transcript. Stop, and leave the conversation to be opened again.
      if (reused) {
        const other = await orAborted(this.sharedWith(session), signal);
        if (signal.aborted) return;
        if (other) {
          if (this.session === session) {
            this.closeSession(session);
            // The row that remains is the terminal's, not the process just closed.
            if (session.id !== null) this.closed.delete(session.id);
          }
          throw new WireCallError(
            `this conversation is now also open in Claude Code '${other.name}' — FunkyOctopus stopped here to avoid forking it; send again to continue as a fork`,
            CLAUDE_LIVE_ELSEWHERE,
          );
        }
      }
      // Model first, then effort, and only when they differ: history is untouched.
      if (want.model !== undefined && want.model !== session.model) {
        await session.query.setModel(want.model);
        session.model = want.model;
      }
      if (want.effort !== undefined && want.effort !== session.effort) {
        await session.query.applyFlagSettings({ effortLevel: want.effort });
        session.effort = want.effort;
      }
      if (signal.aborted) return;
      // Everything above awaited, and the process may have ended meanwhile (it
      // exited, or the chat was replaced): a prompt pushed into a dead session
      // would wait forever for an answer. No send outlives its session.
      if (this.session !== session) throw sessionEnded();

      let settle = (): void => undefined;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const turn: Turn = {
        uuid: randomUUID(),
        origin,
        queue,
        signal,
        stopped: false,
        started: false,
        done: false,
        settled,
        settle,
      };
      onAbort = (): void => {
        turn.stopped = true;
        // The process survives an interrupt and answers the next turn. `cancelQueued`
        // also cancels this prompt if the CLI has accepted it but not started it,
        // so it cannot run later with nobody watching; a prompt cancelled that way
        // never produces a `result`, so the receipt is what ends its turn.
        session.query.interrupt({ cancelQueued: true }).then(
          (receipt) => {
            if (receipt?.cancelled?.includes(turn.uuid)) this.settle(turn);
          },
          () => undefined,
        );
        queue.close();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // An abort that already happened never fires the listener just added.
      if (signal.aborted) return;
      this.approvals.setEmitter((chunk) => queue.push(chunk));
      emitterInstalled = true;
      // Nothing awaits between here and the push, so an abort cannot interleave.
      session.turn = turn;
      session.title ??= toTitle(text);
      // A start that forked tells the owner so ahead of the answer.
      if (session.notice) {
        queue.push(session.notice);
        session.notice = null;
      }
      session.input.push({
        type: 'user',
        uuid: turn.uuid,
        message: { role: 'user', content: promptContent(text, opts.images) },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
      });
      yield* queue;
    } finally {
      if (emitterInstalled) this.approvals.setEmitter(null);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.clientTurnInFlight = false;
      this.broadcast({ kind: 'turn-ended', origin });
      this.announceNewId();
      this.armIdle();
    }
  }

  /**
   * Close the live process after a quiet spell: it costs ~260 MB idle, and the
   * next send resumes the session in under a second. The timer restarts at every
   * turn's end and is cancelled at the next one's start; it never starts anything.
   */
  private armIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    const session = this.session;
    if (!session) return;
    this.idleAt = this.now();
    this.cancelIdle = (this.deps.scheduleIdle ?? afterTimeout)(() => this.reap(session), this.deps.idleMs ?? IDLE_MS);
  }

  /** The idle time is up: close the process unless something is still going on in it. */
  private reap(session: Session): void {
    this.cancelIdle = null;
    if (this.session !== session) return;
    if (!this.quiet(session)) {
      this.armIdle();
      return;
    }
    this.closeSession(session);
  }

  /**
   * Nothing is going on in the process: no turn in flight (an approval waiting
   * on the owner is part of one), no stopped turn still draining, none the CLI
   * started by itself.
   */
  private quiet(session: Session): boolean {
    return (
      !this.clientTurnInFlight &&
      session.routing === 'idle' &&
      session.foreign === null &&
      (session.turn === null || session.turn.done)
    );
  }

  /** Since when the live process has been quiet; null with no process, or one that is busy. */
  idleSince(): number | null {
    const session = this.session;
    return session && this.quiet(session) ? this.idleAt : null;
  }

  /**
   * Close the live process if it is quiet, to make room under the running cap:
   * the conversation stays the open one and the next send resumes it, and the
   * close is recorded in the (shared) just-closed map. False when not idle.
   */
  closeIdle(): boolean {
    const session = this.session;
    if (!session || !this.quiet(session)) return false;
    this.closeSession(session);
    return true;
  }

  /** Resume or deny a pending Vault escalation. */
  resolveApproval(requestId: string, approved: boolean): boolean {
    return this.approvals.resolve(requestId, approved);
  }

  /**
   * Observation-only stream of control events on the shared session: another
   * client's turns, new chats and re-roots. Unlike pi there is no readback and no
   * `agent-chunk`: Claude Code has no extension that starts turns on its own, and
   * FunkyOctopus never starts one (decision 12, limit 2).
   */
  async *observe(signal: AbortSignal, _clientId: string | null = null): AsyncIterable<ChatChunk> {
    const queue = new AsyncQueue<ChatChunk>();
    const push = (chunk: ChatChunk): void => queue.push(chunk);
    this.observers.add(push);
    const onAbort = (): void => queue.close();
    this.observeClosers.add(onAbort);
    // An abort that already happened never fires a listener added after it.
    if (signal.aborted || this.disposed) queue.close();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      yield* queue;
    } finally {
      this.observers.delete(push);
      this.observeClosers.delete(onAbort);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private broadcast(chunk: ChatChunk): void {
    for (const push of this.observers) push(chunk);
  }

  /**
   * End the live process, if any; the next send starts a fresh one. A turn it
   * was serving ends with `error` (a chat replaced under it must say so), or
   * quietly without one (shutdown). A process still starting is killed and its
   * waiting sends rejected, so nothing can hang on a start that never finishes.
   */
  private reset(error?: Error): void {
    this.epoch += 1;
    this.cancelStart?.(sessionEnded());
    this.cancelStart = null;
    this.starting = null;
    this.announce = null;
    for (const query of this.startingQueries) query.close();
    this.startingQueries.clear();
    if (this.session) this.closeSession(this.session, error);
  }

  /**
   * Re-root future turns, continuing the folder's most recent session that is not
   * running elsewhere, and answer with its transcript. Claude Code's working
   * folder is fixed per process, so a real move ends the process; the session is
   * only armed, and the next send starts it. With nothing to continue the next
   * send starts a fresh one. Only a real move is announced: every tab re-applies
   * its folder on mount.
   */
  async setRoot(path: string | null, origin: string | null = null): Promise<ChatTimelineItem[]> {
    const next = path ?? config.primaryWorkspaceRoot;
    if (next === this.root) {
      if (!this.undecided || this.session) return this.transcript();
      // The first word on the conversation after a restart: the folder's own latest, silently,
      // since no tab has been shown anything else.
      const latest = await this.latestIn(next);
      if (!this.undecided || this.session || next !== this.root) {
        // Overtaken meanwhile (a new chat, an open, a send): the pick is not taken up.
        if (latest) this.deps.release?.({ engine: 'claude-code', id: latest.convo.id });
        return this.transcript();
      }
      this.undecided = false;
      this.convo = latest ? { ...latest.convo } : null;
      this.reportIdentity();
      return latest ? toMessages(latest.stored) : [];
    }
    const latest = await this.latestIn(next);
    this.root = next;
    this.undecided = false;
    this.reset(replaced());
    this.convo = latest ? { ...latest.convo } : null;
    this.notes = [];
    this.reportIdentity();
    this.broadcast({ kind: 'session-changed', origin, session: this.info() });
    return latest ? toMessages(latest.stored) : [];
  }

  /**
   * The newest session stored for `root`'s own folder (a worktree's is not this
   * folder's) that `claude agents` does not report running, with its transcript.
   * A running-sessions read that fails does not block the move: the session is
   * only armed here, and the start asks again.
   */
  private async latestIn(root: string): Promise<{ convo: Conversation; stored: readonly unknown[] } | null> {
    const [running, rows] = await Promise.all([
      this.deps.sessions.live({ fresh: true }).catch(() => ({ live: [] })),
      this.deps.sessions.list({ dir: root, limit: LIST_LIMIT, includeWorktrees: false }).catch((error: unknown) => {
        throw new WireCallError(`Could not list Claude Code sessions — ${messageOf(error)}`, 'claude_sessions_error');
      }),
    ]);
    const busy = new Set(
      [...new Set(running.live.map((live) => live.sessionId))].filter((id) => this.otherRows(id, running.live).length > 0),
    );
    // Claimed the moment it is picked, so another slot cannot take it meanwhile.
    const claim = (id: string): boolean => this.deps.claim?.({ engine: 'claude-code', id }) ?? true;
    const row = rows.find(
      (candidate) => candidate.cwd === root && !busy.has(candidate.sessionId) && claim(candidate.sessionId),
    );
    if (!row) return null;
    return { convo: conversationOf(row, root), stored: await this.readStored(row.sessionId, root) };
  }

  /** Start a fresh conversation at the current root: the process ends, the next send starts another. */
  newChat(origin: string | null = null): Promise<ChatSessionInfo | null> {
    this.reset(replaced());
    this.undecided = false;
    this.convo = null;
    this.notes = [];
    this.reportIdentity();
    this.broadcast({ kind: 'session-changed', origin, session: null });
    return Promise.resolve(null);
  }

  /**
   * Reopen a stored session and continue it, in the folder it was recorded in
   * (resume finds a session only there). It is only armed: the process starts
   * with the next send, and opening never starts a turn. A session that is
   * running elsewhere is opened as a fork instead, and the owner is told.
   */
  openChat(path: string, origin: string | null = null): Promise<ChatTimelineItem[]> {
    const id = sessionIdOf(path);
    if (id === null) {
      return Promise.reject(new WireCallError(`not a Claude Code session: ${path}`, 'claude_bad_session'));
    }
    return this.open(id, origin);
  }

  private async open(id: string, origin: string | null): Promise<ChatTimelineItem[]> {
    // Already the live process's own session: reloading it, not replacing it.
    if (this.session?.id === id) return this.transcript();
    const row = await this.deps.sessions.info(id).catch((error: unknown) => {
      throw new WireCallError(`Could not read the Claude Code session — ${messageOf(error)}`, 'claude_sessions_error');
    });
    if (row?.cwd === undefined) {
      throw new WireCallError(`Claude Code has no session ${id} with a recorded folder`, 'claude_session_not_found');
    }
    if (!(await (this.deps.folderExists ?? isDirectory)(row.cwd))) {
      throw new WireCallError(`folder no longer exists: ${row.cwd}`, FOLDER_NOT_FOUND);
    }
    const elsewhere = await this.elsewhere(id);
    // Everything that can fail has happened: from here the chat is replaced.
    const stored = await this.readStored(id, row.cwd);
    const convo = conversationOf(row, row.cwd);
    this.reset(replaced());
    this.undecided = false;
    this.root = row.cwd;
    this.convo = elsewhere ? { ...convo, fork: true } : convo;
    this.notes = elsewhere ? [forkNotice(elsewhere)] : [];
    this.reportIdentity();
    this.broadcast({ kind: 'session-changed', origin, session: this.info() });
    return this.withNotes(toMessages(stored));
  }

  /** The stored messages of a session, or the typed failure when they cannot be read. */
  private async readStored(id: string, cwd: string): Promise<readonly unknown[]> {
    try {
      return await this.deps.sessions.messages(id, cwd);
    } catch (error) {
      throw new WireCallError(`Could not read the Claude Code session — ${messageOf(error)}`, 'claude_transcript_error');
    }
  }

  /** The notes of how this conversation was opened, in among its messages by the time they were written. */
  private withNotes(messages: ChatMessage[]): ChatTimelineItem[] {
    const timeline: ChatTimelineItem[] = [...messages];
    for (const note of this.notes) {
      const at = timeline.findIndex((item) => 'role' in item && item.createdAt > note.timestamp);
      timeline.splice(at < 0 ? timeline.length : at, 0, note);
    }
    return timeline;
  }

  /** The stored sessions of one folder, or the most recent of every folder when `root` is null. */
  async listChats(root: string | null): Promise<ChatSessionInfo[]> {
    let rows;
    try {
      rows = await this.deps.sessions.list(
        root === null ? { limit: LIST_LIMIT_GLOBAL } : { dir: root, limit: LIST_LIMIT, includeWorktrees: false },
      );
    } catch (error) {
      throw new WireCallError(`Could not list Claude Code sessions — ${messageOf(error)}`, 'claude_sessions_error');
    }
    return rows.flatMap((row) => toSessionInfo(row, root ?? undefined) ?? []);
  }

  /** Identity of the conversation, so the cockpit can mark the open row; null until there is one. */
  current(): Promise<ChatSessionInfo | null> {
    return Promise.resolve(this.info());
  }

  /**
   * The conversation as Claude Code stored it, for a reload or a tab following
   * this one. Reads, and never starts a process: empty for a fresh chat that has
   * not yet reported its session.
   */
  async transcript(): Promise<ChatTimelineItem[]> {
    const id = this.session?.id ?? this.convo?.id ?? null;
    if (id === null) return [];
    return this.withNotes(toMessages(await this.readStored(id, this.session?.root ?? this.convo?.cwd ?? this.root)));
  }

  /** Claude Code's own session id; null before one exists. */
  sessionId(): Promise<string | null> {
    return Promise.resolve(this.info()?.id ?? null);
  }

  /** The picker's models: the live process's list once there is one, the aliases before. */
  list(): Promise<ModelOption[]> {
    return Promise.resolve(this.modelCache.models ?? FALLBACK_MODELS);
  }

  /** Shut the process down (sidecar shutdown). Idempotent. */
  dispose(): Promise<void> {
    // The chat is gone: every view of it stops following it, and a turn still
    // running (or still waiting for its process) ends with that reason.
    this.disposed = true;
    for (const close of this.observeClosers) close();
    const closed = new WireCallError('this chat was closed while the turn ran', CHAT_CLOSED);
    this.cancelStart?.(closed);
    this.reset(closed);
    this.convo = null;
    this.notes = [];
    this.reportIdentity();
    return Promise.resolve();
  }
}
