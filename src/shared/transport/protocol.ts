/**
 * The wire contract between the browser cockpit and the Node sidecar.
 *
 * One WebSocket carries two interaction shapes:
 *  - request/response ("call"): the browser invokes a named method and awaits a
 *    single result.
 *  - server→client streams ("stream"): a method emits many chunks over time
 *    (chat tokens, job progress) before ending.
 *
 * Method names are the seam surface: every seam registers handlers here, and the
 * browser only ever speaks method names — never concrete server classes. This is
 * the file both sides weld to, so it holds pure data only (no DOM, no Node).
 */

/** Browser → server: invoke `method` with `params`, correlate replies by `id`. */
export interface RequestMessage {
  kind: 'request';
  id: string;
  method: string;
  params: unknown;
}

/** Browser → server: ask to stop an in-flight stream started with `id`. */
export interface CancelMessage {
  kind: 'cancel';
  id: string;
}

export type ClientMessage = RequestMessage | CancelMessage;

/** Server → browser: the single result of a `call`. */
export interface ResponseMessage {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

/** Server → browser: one chunk of a stream identified by `id`. */
export interface StreamChunkMessage {
  kind: 'stream';
  id: string;
  chunk: unknown;
}

/** Server → browser: a stream identified by `id` finished (cleanly or with error). */
export interface StreamEndMessage {
  kind: 'stream-end';
  id: string;
  error?: WireError;
}

export type ServerMessage = ResponseMessage | StreamChunkMessage | StreamEndMessage;

export interface WireError {
  message: string;
  code?: string;
}

/** Reply from the always-present `system.health` method. */
export interface HealthResult {
  ok: true;
  service: 'funkyoctopus-sidecar';
  version: string;
  uptimeMs: number;
  /**
   * Liveness of each integrated backend, filled in as seams land. `not_installed`
   * is a tool whose CLI is not on the machine (Helmraiser, Leeboard): a calm
   * state, since FunkyOctopus works without it; `down` is one that failed.
   */
  backends: Record<string, 'up' | 'down' | 'unknown' | 'not_installed'>;
  /** Present only when sidecar desktop notifications (notify-send) are on. */
  desktopNotifications?: true;
}

// --- system seam: upkeep ---

/** Lifecycle of the automatic `pi update --all` runner. */
export type UpkeepStatus =
  | 'idle'
  | 'updating'
  | 'updated'
  | 'failed'
  | 'timed_out'
  | 'missing_binary'
  /** Not run: pi chat sessions are live (the reason is in `lastResult`); retried at the next tick. */
  | 'deferred';

/**
 * How the embedded pi SDK compares to the global pi CLI: `behind` and `ahead`
 * are measured from the embedded SDK toward the global version, `unknown` when
 * either version could not be read.
 */
export type VersionDrift = 'equal' | 'behind' | 'ahead' | 'unknown';

// --- system seam: embedded upkeep ---

/** How the embedded SDK's `verifiedVersion` was established. */
export type EmbeddedVerificationLevel = 'live' | 'deterministic_only' | 'unknown';

/**
 * Embedded SDK detection/promotion lifecycle. Promotion and recovery are
 * explicit terminal commands; background detection only ever observes the
 * registry, so the promotion/recovery statuses below are never produced by
 * detection — they are preserved while detection keeps updating its own
 * fields around them.
 */
export type EmbeddedStatus =
  | 'unknown'
  | 'checking'
  | 'current'
  | 'available'
  | 'promotion_failed'
  | 'needs_attention'
  | 'recovery_required'
  | 'cleanup_pending';

/**
 * Cached embedded-SDK state. Detection updates only the
 * detection-owned fields (installed/latest versions, status, last check);
 * verification, promotion, and recovery fields are preserved across runs.
 * Deliberately absent: candidate-version, restart-required, failure-count,
 * shelved-version, and automatic-retry state — promotion is explicit.
 */
export interface EmbeddedUpkeepInfo {
  installedVersion: string | null;
  latestVersion: string | null;
  verifiedVersion: string | null;
  verificationLevel: EmbeddedVerificationLevel;
  status: EmbeddedStatus;
  /** Epoch ms of the last detection attempt; null before the first. */
  lastCheckAt: number | null;
  /** Epoch ms of the last explicit promotion attempt; null when none. */
  lastPromotionAttemptAt: number | null;
  /** Outcome message of the last explicit promotion attempt; null when none. */
  lastPromotionResult: string | null;
  /** Epoch ms of the last explicit recovery attempt; null when none. */
  lastRecoveryAttemptAt: number | null;
  /** Outcome message of the last explicit recovery attempt; null when none. */
  lastRecoveryResult: string | null;
}

/** Read-only Claude CLI/SDK pairing, cached on the upkeep cadence. */
export interface ClaudeSdkUpkeepInfo {
  status: 'in-sync' | 'drift' | 'unknown';
  cliVersion: string | null;
  sdkVersion: string | null;
}

/**
 * The cached `system.upkeep` result. Never re-runs or re-reads versions: the
 * five-second status poll reads this snapshot as-is.
 */
export interface UpkeepResult {
  /** True when FUNKYOCTOPUS_UPKEEP_DISABLED=1 — nothing runs or schedules. */
  disabled: boolean;
  status: UpkeepStatus;
  /** Epoch ms of the last run attempt; null before the first run. */
  lastRunAt: number | null;
  /** Tail of the update output, or the failure/timeout/missing-binary message. */
  lastResult: string | null;
  globalPiVersion: string | null;
  embeddedSdkVersion: string | null;
  drift: VersionDrift;
  /**
   * Epoch ms since `pi update --all` has been deferred, run after run; null (or
   * absent) when the last attempt was not deferred. A long one is shown quietly.
   */
  deferredSince?: number | null;
  /**
   * Cached embedded-SDK detection/promotion state. Served from
   * memory; the five-second status poll never re-runs or re-reads anything.
   */
  embedded: EmbeddedUpkeepInfo;
  /** Cached, read-only CLI/SDK pairing; absent on older sidecars. */
  claudeSdk?: ClaudeSdkUpkeepInfo;
}

// --- chat-orchestrator seam (→ pi AgentSession) ---

/**
 * An image attached to a user message: base64 payload (no `data:` prefix) plus
 * its MIME type — the shape pi's `ImageContent` takes, minus the `type` tag.
 */
export interface ChatImageAttachment {
  mimeType: string;
  data: string;
}

/** Sanity bounds for one `chat.send`; providers enforce their own limits. */
export const CHAT_IMAGE_LIMITS = {
  /** Max images per message. */
  count: 8,
  /** Max base64 length per image (≈7.5 MB decoded). */
  base64Length: 10_000_000,
} as const;

// --- chat slots (T2.1, decision 13) ---

/** Which engine answers a chat slot: pi, or Claude Code on the owner's own sign-in. */
export type EngineKind = 'pi' | 'claude-code';

/**
 * One engine session, qualified by its engine: what a slot holds, and what at
 * most one slot may hold.
 */
export interface SessionRef {
  engine: EngineKind;
  id: string;
}

/**
 * How the `fo` CLI's client ids begin, so a browser window can tell a request
 * a terminal sent from one another browser window sent (approval notifications
 * fire in the window that sent the turn, or everywhere when no window did).
 */
export const CLI_CLIENT_PREFIX = 'cli:';

/** The permanent chat slot: the single-tab browser's, and the `fo` CLI's default. */
export const MAIN_CHAT = 'main';

/**
 * The engine session a `path` (the open handle in `ChatSessionInfo`) names:
 * Claude Code's are `claude-code:<id>`; a pi path is a session file
 * `<timestamp>_<id>.jsonl` (pinned in pi-contract.test.ts). Null when it is
 * neither.
 */
export function sessionRefOf(path: string): SessionRef | null {
  if (path.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) {
    const id = path.slice(CLAUDE_CODE_PROVIDER.length + 1);
    return id ? { engine: 'claude-code', id } : null;
  }
  const match = /_([^/_]+)\.jsonl$/.exec(path);
  return match?.[1] ? { engine: 'pi', id: match[1] } : null;
}

/** Every chat call names the slot it acts on. */
export interface ChatSlotParams {
  chatId: string;
}

/**
 * One chat slot (tab), read without building anything: its engine, the
 * session it holds, and its state.
 */
export interface ChatSlotInfo {
  chatId: string;
  kind: EngineKind;
  createdAt: number;
  lastUsedAt: number;
  /** This slot has pi-crew (decision 13: one pi slot at most, until pi-crew binds per session). */
  crew: boolean;
  /** Crew was handed to this slot while its session was live: it loads from the slot's next session. */
  crewPending: boolean;
  /** A turn is live: a client's, or a run the engine did not start. */
  busy: boolean;
  /** Something waits on the owner: an approval request. */
  attention: boolean;
  session: ChatSessionInfo | null;
  /** The slot's working folder; null is the configured global root. */
  root: string | null;
  /** Subagents still running in sessions the slot switched away from. */
  subagentsLeftRunning: number;
}

/** `chat.create`: a new slot on a new conversation. `root` null is the global root. */
export interface ChatCreateParams {
  kind: EngineKind;
  root: string | null;
  clientId?: string;
}

/** `chat.close`: refused for `main`, and while a turn is live unless `force`. */
export interface ChatCloseParams extends ChatSlotParams {
  force?: boolean;
  clientId?: string;
}

/**
 * `chat.slotsObserve`: the slots as they come and go. A subscriber first gets
 * one `slots` snapshot of every slot, then changes: created and closed (with
 * the acting client id as `origin`) and `slot-state` when a slot's state
 * changed (its `lastUsedAt` alone is not a change).
 */
export type ChatSlotsEvent =
  | { kind: 'slots'; slots: ChatSlotInfo[] }
  | { kind: 'slot-created'; slot: ChatSlotInfo; origin: string | null }
  | { kind: 'slot-closed'; chatId: string; origin: string | null }
  | { kind: 'slot-state'; slot: ChatSlotInfo };

/** `chat.open`: opened in the slot asked, or held by another slot, which the caller can focus instead. */
export type ChatOpenResult = { items: ChatTimelineItem[] } | { heldBy: string };

// --- slash commands (T2.4b) ---

/**
 * Where a slash command comes from. pi: an extension's command, a prompt
 * template, a skill (`skill:<name>`), or one of FunkyOctopus's own built-ins
 * for pi (`compact`, `rename`). Claude Code: its own command, or one a user,
 * project, plugin or MCP server defined.
 */
export type ChatCommandSource = 'extension' | 'template' | 'skill' | 'builtin' | 'claude-builtin' | 'claude-custom';

/** One command the composer's `/` palette offers for a slot's engine. */
export interface ChatCommand {
  /** Without the leading slash, as typed: `review`, `skill:tdd`, `compact`. */
  name: string;
  /** May be empty. */
  description: string;
  argumentHint?: string;
  /** Other names that run it (Claude Code's); matched by the palette's filter. */
  aliases?: string[];
  source: ChatCommandSource;
  /**
   * `text`: goes as `/name args` through `chat.send`, and the engine runs it.
   * `action`: one of FunkyOctopus's typed calls (`chat.compact`, `chat.rename`).
   */
  kind: 'text' | 'action';
}

/** `chat.commands`: the slot's commands, and how current the list is. */
export interface ChatCommandsResult {
  commands: ChatCommand[];
  /**
   * `live`: read from the slot's session or process now. `last-known`: Claude
   * Code only, no process runs for the slot, so this is the list the last one
   * gave (nothing is started to ask, decision 12). `none`: no list is known yet.
   */
  state: 'live' | 'last-known' | 'none';
}

/** `chat.compact`: compact a pi slot's conversation now, optionally steered by `instructions`. */
export interface ChatCompactParams extends ChatSlotParams {
  instructions?: string;
  clientId?: string;
}

/** `chat.rename`: name a pi slot's conversation; the result is the session as now described. */
export interface ChatRenameParams extends ChatSlotParams {
  name: string;
}

export interface ChatSendParams extends ChatSlotParams {
  text: string;
  /**
   * Optional per-message model + effort. When present, the sidecar applies them
   * to the live pi session (setModel / setThinkingLevel) before the turn — so
   * switching either mid-conversation keeps the thread's history intact.
   */
  provider?: string;
  model?: string;
  effort?: string;
  /** Images pasted or dropped into the composer; reach pi as image content. */
  images?: ChatImageAttachment[];
  /**
   * Identity of the client this request came from, when it cares to follow the
   * shared session. Absent means an unclaimed origin.
   */
  clientId?: string;
}

/** One streamed piece of an assistant turn. Completion is the stream-end frame. */
export type ChatChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  /**
   * Emitted once at the end of a turn with the session's context-window
   * occupancy, straight from pi. `tokens`/`percent` are null when pi cannot
   * estimate yet (e.g. immediately after a compaction).
   */
  | { kind: 'usage'; tokens: number | null; contextWindow: number; percent: number | null }
  | { kind: 'tool-call'; callId: string; tool: string; summary: string; args?: unknown }
  | {
      kind: 'approval-request';
      requestId: string;
      callId: string;
      tool: string;
      target: string;
      args?: unknown;
      /**
       * Set only on the copy broadcast on the slot's observe stream: the client
       * whose turn asked (`'agent'` for a run the engine started itself), so
       * any view of the slot can answer. The asking turn's own stream carries
       * the untagged one; a client seeing both dedupes by `requestId`.
       */
      origin?: string | null;
    }
  /**
   * Observe stream only: an approval broadcast there was answered (from any
   * window, or `fo vault`), so every view of the slot settles its card at once.
   */
  | { kind: 'approval-resolved'; requestId: string; approved: boolean }
  | {
      kind: 'tool-result';
      callId: string;
      ok: boolean;
      output?: string;
      diff?: string;
      error?: string;
      /**
       * JSON-safe structured tool-result details, preserved end-to-end so crew
       * audit rendering never re-reads pi internals. Cycles and non-JSON values
       * are sanitised at the server boundary.
       */
      details?: unknown;
    }
  /**
   * The engine compacted the conversation's context (a `/compact`, or an
   * automatic one mid-turn). Engine-neutral: the browser shows it as one dim
   * divider. `postTokens` is absent when the engine does not report it.
   */
  | { kind: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | {
      /**
       * A generic extension-injected custom message (crew results, warnings).
       * The wire envelope is narrowed to JSON-safe data only — content is plain
       * text, details is never cyclic or non-JSON.
       */
      kind: 'custom-message';
      /**
       * Stable identity: the persisted `custom_message` entry id when it can be
       * reconciled, else a deterministic collision-safe fallback. This is the
       * id both the live mapping and the reopen readback deduplicate on.
       */
      id: string;
      customType: string;
      /** True items render (Phase 3); false items stay in data, never render. */
      display: boolean;
      content: string;
      details: unknown;
      /** Epoch ms. */
      timestamp: number;
    }
  /**
   * Observation-stream control events (never `chat.send` chunks): another
   * client completed a new/open, or a re-root that moved to another root, on
   * the shared session (re-applying the current root is silent). `origin` is the
   * acting client id — or 'agent' is never used here; null when unclaimed.
   * `session` is the now-live session's identity, when it has one.
   */
  | { kind: 'session-changed'; origin: string | null; session: ChatSessionInfo | null }
  /**
   * Observation-stream control events: a turn started on the shared session —
   * a `chat.send` from another client, or one pi-crew triggered itself
   * (`origin: 'agent'`). Subscribers show the shared session as busy.
   */
  | { kind: 'turn-started'; origin: string | null }
  /** Matching end of a `turn-started`; subscribers may reload the transcript. */
  | { kind: 'turn-ended'; origin: string | null }
  /**
   * Observation-stream only: one piece of a turn pi-crew triggered itself
   * (`origin` is always `'agent'`), streamed live between that run's
   * `turn-started` and `turn-ended`. `chunk` uses the same shapes as a
   * `chat.send` turn's chunks. Ordinary client turns are never broadcast this
   * way — their chunks go only to their own request stream.
   */
  | { kind: 'agent-chunk'; origin: 'agent'; chunk: ChatChunk };

/**
 * The rendered conversation. Built incrementally in the browser from `ChatChunk`
 * during a live turn, and sent whole by the server when a stored session is
 * reopened (`chat.open`) — which is why it lives here rather than in the chat
 * feature: both sides now weld to it.
 */
export type ChatRole = 'user' | 'assistant';

export type ChatStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  /** An image in a user message (live send or reopened transcript). */
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'tool-call'; callId: string; tool: string; summary: string; args?: unknown }
  | {
      kind: 'approval-request';
      requestId: string;
      callId: string;
      tool: string;
      target: string;
      args?: unknown;
      status?: 'approved' | 'denied';
    }
  | {
      kind: 'tool-result';
      callId: string;
      ok: boolean;
      output?: string;
      diff?: string;
      error?: string;
      /** JSON-safe structured tool-result details, preserved end-to-end. */
      details?: unknown;
    }
  /**
   * Where the engine compacted the context. A reopened transcript can only say
   * that it happened (the stored summary names neither trigger nor sizes), so
   * those fields are optional here; the live chunk always carries them.
   */
  | { kind: 'compaction'; trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /**
   * True for messages projected from stored entries (reopened transcripts).
   * Live reducer-created messages stay unmarked; crew audit provenance uses
   * the distinction to never label a live pending spawn as interrupted.
   */
  historical?: true;
  /** Ordered content emitted during this turn. */
  steps: ChatStep[];
  /**
   * Model that produced this assistant turn, when known. A stored session
   * records its model in `model_change` entries, so a rehydrated chat can be
   * labelled with the model it was actually held with rather than whatever the
   * composer happens to be set to now.
   */
  model?: string;
  /** Epoch ms the message was created; rendered when timestamps are enabled. */
  createdAt: number;
  /** True while the assistant turn is still streaming. */
  streaming?: boolean;
  /** Set when the turn failed. */
  error?: string;
  /** True when the reader stopped the turn (Esc / STOP) before it finished. */
  stopped?: boolean;
}

/**
 * A timeline event that is not a message: an extension-injected custom message.
 * It has no role — `ChatRole` stays binary — and is discriminated from
 * `ChatMessage` by `kind`. Fields mirror the `custom-message` wire chunk.
 */
export interface ChatEventItem {
  kind: 'custom-message';
  id: string;
  customType: string;
  display: boolean;
  content: string;
  details: unknown;
  timestamp: number;
}

/**
 * A historical crew tool call projected from raw stored entries (survives
 * compaction). Carries only JSON-safe call/result metadata sufficient for the
 * same pure crew audit model; ordinary compacted prose/tool output is never
 * rehydrated. `historical` is always true.
 */
export interface ChatCrewAuditItem {
  kind: 'crew-tool-audit';
  /** Stable derived id: persisted assistant entry id + call id. */
  id: string;
  /** Epoch ms of the assistant message that held the call. */
  timestamp: number;
  /** Always true: derived from stored entries, never live. */
  historical: true;
  call: { callId: string; tool: string; args?: unknown };
  result?: { ok: boolean; output?: string; error?: string; details?: unknown };
}

/** The rendered conversation: messages, non-role events, and historical audits. */
export type ChatTimelineItem = ChatMessage | ChatEventItem | ChatCrewAuditItem;

export const isChatEventItem = (item: ChatTimelineItem): item is ChatEventItem =>
  'kind' in item && item.kind === 'custom-message';

export const isCrewAuditItem = (item: ChatTimelineItem): item is ChatCrewAuditItem =>
  'kind' in item && item.kind === 'crew-tool-audit';

/**
 * The `customType` of a note FunkyOctopus itself puts in the timeline (a session
 * opened as a fork, say), as opposed to one an extension sent: the browser shows
 * it as a plain note.
 */
export const FUNKYOCTOPUS_NOTE = 'funkyoctopus-note';

/**
 * The pi-crew tool names both sides recognise: the browser parses them into
 * crew audits, the sidecar projects them from stored entries. pi-crew's own
 * surface, not pi's — pinned against the installed extension by
 * `server/src/pi/pi-contract.test.ts`.
 */
export const CREW_TOOLS = [
  'crew_spawn',
  'crew_list',
  'crew_status',
  'crew_abort',
  'crew_respond',
  'crew_done',
] as const;
export type CrewTool = (typeof CREW_TOOLS)[number];

export interface ProjectOption {
  id: string;
  name: string;
  path: string;
  envTier: 'normal';
}

export interface ProjectCatalog {
  /** The sidecar's expanded global (no-project) workspace root. */
  globalRoot: string;
  /** Projects Leeboard lists (`lb project list`). */
  known: ProjectOption[];
  /** The global root plus every configured root's immediate child folders. */
  folders: ProjectOption[];
}

export interface ProjectResolveParams {
  path: string;
}

export interface ChatSetRootParams extends ChatSlotParams {
  path: string | null;
  /** Identity of the client requesting the re-root, when it follows the session. */
  clientId?: string;
}

/**
 * One row of chat history, projected from pi's `SessionInfo` — never
 * re-exported from it, so pi's types stay on the server side of the wire.
 *
 * Deliberately omitted from the projection: `allMessagesText` (the whole
 * transcript — never send that for a list) and `parentSessionPath` (nothing
 * renders forks yet; it arrives with the feature).
 */
export interface ChatSessionInfo {
  /**
   * The handle used to reopen it: a pi session file's absolute path, or
   * Claude Code's `claude-code:<id>`.
   */
  path: string;
  /** With `id`, the session's identity: `{engine, id}`. */
  engine: EngineKind;
  id: string;
  /**
   * Effective working directory: the recorded cwd when it still exists, else
   * the session's original location remapped through the Leeboard project-path
   * registry (see `movedFrom`), else the recorded cwd flagged `folderGone`.
   */
  cwd: string;
  /** Display label: the session's name if it has one, else its first message. */
  title: string;
  /** ISO-8601. */
  created: string;
  /** ISO-8601. */
  modified: string;
  /**
   * Absent on the global listing. Counting messages means reading the whole
   * session file, which is exactly the cost the global path exists to avoid —
   * see `server/src/pi/session-index.ts`. Per-project rows still carry it.
   */
  messageCount?: number;
  /** Original recorded cwd when this row was remapped to the project's current location. */
  movedFrom?: string;
  /** The recorded cwd is gone and no current project location could be found. */
  folderGone?: boolean;
}

/** Read-only session-store authorization for an originating review conversation. */
export interface ChatExistsParams extends ChatSlotParams {
  path: string;
}

export interface ChatOpenParams extends ChatSlotParams {
  path: string;
  /** Identity of the client requesting the open, when it follows the session. */
  clientId?: string;
}

/** `chat.new`: start a fresh conversation at the current root. */
export interface ChatNewParams extends ChatSlotParams {
  /** Identity of the client requesting the new chat, when it follows the session. */
  clientId?: string;
}

/** `chat.observe`: subscribe to the shared session's observation stream. */
export interface ChatObserveParams extends ChatSlotParams {
  /** Identity of the subscribing client; accepted but not used to filter. */
  clientId?: string;
}

/** `null` lists every root; a path lists that project's chats. */
export interface ChatListParams extends ChatSlotParams {
  root: string | null;
}

/**
 * `chat.search`: stored chats of both engines in every folder, matched on the
 * query's words. Not slot-scoped. `limit` defaults to 30 and is capped at 100.
 */
export interface ChatSearchParams {
  query: string;
  limit?: number;
}

/** A matching stored chat: its history row plus a short plain-text excerpt around the match. */
export interface ChatSearchHit extends ChatSessionInfo {
  snippet: string;
}

export interface ChatSearchResult {
  /** The newest matches first, at most `limit`. */
  hits: ChatSearchHit[];
  /** Every chat that matched, not only the ones returned. */
  total: number;
  /** The chats in the index, matching or not. */
  searched: number;
}

export interface VaultResolveParams {
  requestId: string;
  approved: boolean;
}

// --- models seam (→ pi ModelRuntime) ---

/**
 * A model the user can pick for chat, flattened from pi's ModelRuntime to the
 * few fields the picker needs. `thinkingLevels` is the effort ladder this model
 * supports (empty when it has no reasoning knob), so the effort dropdown can
 * scope itself to the selected model.
 */
/** The `provider` of every model the Claude Code chat engine lists in `models.list`. */
export const CLAUDE_CODE_PROVIDER = 'claude-code';

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /**
   * The full model id an alias resolves to (Claude Code's `haiku` is `claude-haiku-5-5`),
   * which is what a stored turn records, so a reopened transcript can be labelled by `name`.
   */
  resolvedId?: string;
  thinkingLevels: string[];
  /** Input modalities the model accepts, mirroring pi's `Model.input`. */
  input: ('text' | 'image')[];
  /**
   * Set on the one pi model the sidecar routes to when a turn names none (the
   * environment's, else pi's own default). Absent on every other entry, and on
   * all of them when no default resolves.
   */
  isDefault?: true;
}

// --- leeboard seam (→ the `lb` CLI, read-only; T3 L3) ---

export type LeeboardKind = 'rule' | 'grant' | 'hold' | 'reference' | 'handoff' | 'request';

/**
 * One entry as `lb brief --json` lists it: a title line, never a body. The
 * kind-specific fields are carried only where Leeboard sets them.
 */
export interface LeeboardEntry {
  id: string;
  kind: LeeboardKind;
  /** `global`, `machine` or `project:<name>`. */
  scope: string;
  status: string;
  title: string;
  /** Who wrote it: Leeboard's harness name, null when unrecorded. */
  harness: string | null;
  /** The author's session id, where Leeboard recorded one. */
  session?: string;
  created: string;
  updated: string;
  /** Holds: what releases it, what it blocks, and when it lapses. */
  release?: string;
  blocks?: string[];
  until?: string;
  /** Grants. */
  holder?: string;
  /** Handoffs and requests: `project:<name>`, `session:<id>`, `harness:<name>` or `any`. */
  to?: string;
}

/** The staleness of a repo state file (`TASKS.md`, `CURRENT_STATE.md`). */
export interface LeeboardRepoFile {
  path: string;
  /** Null when the file exists but was never committed. */
  lastCommit: string | null;
  daysAgo?: number;
  commitsSince?: number;
}

/** `lb brief --json` for a chat slot's folder. */
export interface LeeboardBrief {
  /** The registered project the folder belongs to; null for none (the global root). */
  project: string | null;
  /** The git checkout the folder is in when that is not a registered project. */
  unregisteredRepo: string | null;
  holds: LeeboardEntry[];
  grants: LeeboardEntry[];
  rules: LeeboardEntry[];
  references: LeeboardEntry[];
  /** Handoffs and requests addressed to this project, to FunkyOctopus, or to anyone. */
  inbox: LeeboardEntry[];
  repoState: LeeboardRepoFile[];
}

/**
 * Every `leeboard.*` read answers in band: `lb` missing (`leeboard_unavailable`),
 * failing, timing out or printing something unreadable is a state for the
 * panel to show, never a transport error.
 */
export interface LeeboardBriefResult {
  brief: LeeboardBrief | null;
  error?: WireError;
}

/** One entry with its body, from `lb show <id> --json`. */
export interface LeeboardEntryWithBody extends LeeboardEntry {
  body: string;
}

export interface LeeboardShowResult {
  entry: LeeboardEntryWithBody | null;
  error?: WireError;
}

/** One row of the owner digest. */
export interface LeeboardReviewRow {
  id: string;
  kind: string;
  scope: string;
  title: string;
  status: string;
}

/** `lb review --peek --json`: what changed since the owner last reviewed. Reading it marks nothing seen. */
export interface LeeboardReview {
  new: LeeboardReviewRow[];
  changed: LeeboardReviewRow[];
  closed: LeeboardReviewRow[];
}

export interface LeeboardReviewResult {
  review: LeeboardReview | null;
  error?: WireError;
}

/**
 * An active request or handoff addressed to a project or a session, with the
 * tab it belongs in (T3 L5). FO routes it; Leeboard keeps it.
 */
export interface LeeboardRouted extends LeeboardEntry {
  /**
   * The open tab that should take it: the most recently used tab whose folder
   * belongs to the project, or the tab holding the session. Null when none is open.
   */
  chatId: string | null;
  /** For `project:<name>`: the project's folder, where a new tab for it opens. Null otherwise. */
  folder: string | null;
}

/** `leeboard.open`: active requests and handoffs addressed to a project or a session. */
export interface LeeboardOpenResult {
  open: LeeboardRouted[] | null;
  error?: WireError;
}

/** `leeboard.holds`: active, unexpired holds across every scope. */
export interface LeeboardHoldsResult {
  holds: LeeboardEntry[] | null;
  error?: WireError;
}

/** A request the tab's session wrote, and whether an answer came back. */
export interface LeeboardAsked extends LeeboardEntry {
  /** A `## Reply` section was appended, or the request is done. */
  replied: boolean;
}

/** `leeboard.asked`: the requests the slot's session authored; empty while it has none. */
export interface LeeboardAskedResult {
  asked: LeeboardAsked[] | null;
  error?: WireError;
}

// --- workflow-engine seam (→ helmraiser orchestration) ---

/** Provenance attached by Helmraiser to queued work and runs. */
export interface HelmraiserOrigin {
  kind: 'fo' | 'claude-code';
  session: string;
}

/**
 * Why a queued task is held (`queue_next[].held_by`, repeated in `held[]`). A run
 * hold carries `run_id`/`status`/`pending` of the oldest holding run, plus a
 * `reason` (`paths_overlap`, `project_busy`, `depends_on`) and `other_task_id`
 * when helmraiser knows why; a dependency hold is `reason: 'depends_on'` with
 * `unmet`. Both can be merged on one task. `reason` stays a plain string so a
 * code helmraiser adds later still reaches the panel.
 */
export interface HelmraiserHold {
  run_id?: string;
  status?: string;
  /** `merge`, `plan` or `scope` while parked for approval; null otherwise. */
  pending?: string | null;
  reason?: string;
  other_task_id?: string;
  detail?: string;
  unmet?: Array<{ id: string; reason: string; text: string }>;
}

/** One queued row of `helmraiser status --json`. Older builds omit project/id/title/held_by. */
export interface HelmraiserQueueEntry {
  task_id: string;
  priority: string;
  project?: string;
  id?: string;
  title?: string;
  origin?: HelmraiserOrigin | null;
  held_by?: HelmraiserHold | null;
}

/** One entry of `status.held`: a queued task and the hold it sits under. */
export interface HelmraiserHeldEntry extends HelmraiserHold {
  task_id: string;
  id?: string;
  title?: string;
  project?: string;
  origin?: HelmraiserOrigin | null;
}

/**
 * A queued task whose own budget projection reaches its provider's `stop_at`,
 * so `work` never starts it. `reason` is `never_startable:<provider>:<window>`;
 * `text` is helmraiser's one-line explanation.
 */
export interface HelmraiserNeverStartable {
  task_id: string;
  id?: string;
  title?: string;
  project?: string;
  origin?: HelmraiserOrigin | null;
  reason: string;
  model?: string;
  projected?: number;
  stop_at?: number;
  projection_usd?: number;
  text?: string;
}

/** One running row of `helmraiser status --json`. Older builds omit project/id/title. */
export interface HelmraiserStatusRunning {
  run_id: string;
  task: string;
  stage: string;
  iteration: number;
  cost_usd: number;
  minutes: number;
  project?: string;
  id?: string;
  title?: string;
  origin?: HelmraiserOrigin | null;
}

/** One awaiting-approval row of `helmraiser status --json`. Older builds omit project/id/title. */
export interface HelmraiserStatusAwaiting {
  run_id: string;
  task: string;
  pending: string;
  verdict: string;
  cost_usd: number;
  project?: string;
  id?: string;
  title?: string;
  /** Helmraiser cea2366+ metadata; absent on older status output. */
  worktree?: string;
  branch?: string;
  base_commit?: string;
  origin?: HelmraiserOrigin | null;
  /** Newer Helmraiser scope approvals include the requested paths and reason. */
  scope_request?: { paths: string[]; reason: string } | null;
}

/** One run approved at plan and waiting for its worker to continue. */
export interface HelmraiserStatusResuming {
  run_id: string;
  task: string;
  project: string;
  id: string;
  title: string;
  stage: string;
  origin?: HelmraiserOrigin | null;
}

/**
 * One approver rework request of a run (`status.reworks[].reworks[]`, helmraiser
 * `Ledger.hand_back`): `note` is what the implementer was told, `rebase` is set
 * (true) when the run branch was also to be rebased, and the rest is helmraiser's
 * accounting for the extra pass.
 */
export interface HelmraiserReworkRequest {
  round: number;
  note: string;
  rebase?: true;
  approval_id: number;
  findings?: unknown[];
  iteration_allowance?: number;
  extra_cost_usd?: number;
  extra_minutes?: number;
  iterations_before?: number;
}

/** One reworked run of `status.reworks[]`: every active or awaiting run, and the terminal ones of the last 24 h. */
export interface HelmraiserReworkHistory {
  run_id: string;
  task: string;
  status: string;
  rework_rounds: number;
  reworks: HelmraiserReworkRequest[];
}

/** One failed row of `helmraiser status --json`. Older builds omit project/id/title. */
export interface HelmraiserStatusFailed {
  run_id: string;
  task: string;
  reason: string;
  ended_at: string;
  project?: string;
  id?: string;
  title?: string;
  origin?: HelmraiserOrigin | null;
}

/** One provider window of the `usage` map; estimates carry `live_fraction: null`. */
export interface HelmraiserUsageWindow {
  fraction: number;
  spend_usd: number;
  resets_at: number;
  warn_at: number;
  stop_at: number | null;
  source: 'live' | 'estimate';
  live_fraction: number | null;
  estimate_fraction: number;
}

/** Worker liveness; a stopped worker carries only `state`. */
export interface HelmraiserWorker {
  state: string;
  pid?: number;
  started_at?: string;
  argv?: string[];
  log?: string;
  /** The projects a running worker serves; `null` is every project. Absent on older workers. */
  projects?: string[] | null;
  /** Projects a running worker leaves alone. Absent on older workers. */
  exclude_projects?: string[];
}

/** Older output omits lens; consumers treat it as state. */
export type HelmraiserScoutLens = 'state' | 'docs' | 'tests' | 'guardrails';
export type HelmraiserScoutSettingsSource = 'ledger' | 'config' | 'default';
export interface HelmraiserScoutSettings {
  lenses: Record<HelmraiserScoutLens, {
    auto: boolean;
    cooldown_hours: number;
    source: { auto: HelmraiserScoutSettingsSource; cooldown_hours: HelmraiserScoutSettingsSource };
  }>;
}
export interface HelmraiserScoutSettingsUpdate {
  lens: HelmraiserScoutLens;
  auto?: boolean;
  cooldownHours?: number;
}

export type HelmraiserScoutWaitReason =
  | 'queue paused'
  | 'project busy'
  | 'draft cap'
  | 'no headroom'
  | 'slots busy';

export interface HelmraiserScouts {
  lenses?: HelmraiserScoutSettings['lenses'];
  focus_projects: string[];
  paused_projects: string[];
  pending: Array<{ project: string; lens?: HelmraiserScoutLens; requested_at: string; wait_reason: HelmraiserScoutWaitReason | null }>;
  // Older output can omit project metadata on running and recent scouts.
  running: Array<{ project?: string; lens?: HelmraiserScoutLens; scout_id: string; started_at: string }>;
  recent: Array<{
    project?: string;
    lens?: HelmraiserScoutLens;
    scout_id: string;
    ended_at: string;
    ok: boolean;
    drafts: number;
    report: string | null;
    error: string | null;
  }>;
}

export interface HelmraiserRequestScoutsResult {
  requested: string[];
  already_pending: string[];
}

export interface HelmraiserCancelScoutsResult {
  cancelled: string[];
  not_pending: string[];
}

/** The full `helmraiser status --json` ledger snapshot. */
export interface HelmraiserStatus {
  updated_at: string;
  queued_count: number;
  queue_next: HelmraiserQueueEntry[];
  running: HelmraiserStatusRunning[];
  awaiting_count: number;
  failed_24h_count: number;
  spend: Record<string, { '5h': number; '7d': number; '30d': number }>;
  /** Per provider, only the windows it has: openai-codex reports `week` alone. */
  usage: Record<string, Partial<Record<'5h' | 'week' | 'month', HelmraiserUsageWindow>>>;
  caps_enforced: boolean;
  paused: { reason: string; until: number | null } | null;
  held_providers: Record<string, { until: number; detail: string }>;
  worker: HelmraiserWorker;
  queue: { failed: number; landed: number; queued: number; running: number; awaiting_approval: number };
  awaiting: HelmraiserStatusAwaiting[];
  failed: HelmraiserStatusFailed[];
  /** Approved plans waiting for/being picked up by a worker; older output omits it. */
  resuming?: HelmraiserStatusResuming[];
  /** Rework rounds of reworked runs, oldest first; absent on older output and when nothing was reworked. */
  reworks?: HelmraiserReworkHistory[];
  /** Every queued task under a hold, not only the first five; older output omits it. */
  held?: HelmraiserHeldEntry[];
  /** Queued tasks that can never start under `stop_at`; empty unless caps are enforced. */
  never_startable?: HelmraiserNeverStartable[];
  /** Runs ended in the last 24 h; Helmraiser d14f7f2+, so older output omits it. */
  landed?: HelmraiserStatusLanded[];
  /** Scout lifecycle; older Helmraiser output omits it. */
  scouts?: HelmraiserScouts;
  status_path: string;
}

/** One landed (recently completed) row of `helmraiser status --json`; Helmraiser d14f7f2+. */
export interface HelmraiserStatusLanded {
  run_id: string;
  task: string;
  ended_at: string;
  project?: string;
  id?: string;
  title?: string;
  origin?: HelmraiserOrigin | null;
}

/** The windows `helmraiser report --since` accepts. */
export type HelmraiserReportWindow = '24h' | '7d' | '30d';

/** The windows `helmraiser stats --since` accepts. */
export type HelmraiserStatsWindow = '24h' | '7d' | '30d' | '90d' | 'all';

/** Run counts by outcome; `active` is every nonterminal status that is not awaiting approval. */
export interface HelmraiserStatsRunCounts {
  landed: number;
  failed: number;
  aborted: number;
  awaiting_approval: number;
  active: number;
}

/** A median and 90th percentile, both `null` without samples. */
export interface HelmraiserStatsPercentiles {
  median: number | null;
  p90: number | null;
}

/** A scout row's `dropped` split by drop class; `unclassified` is a drop with none given (or one not recognized). All five keys are always present. */
export type HelmraiserStatsDroppedByClass = Record<HelmraiserDropClass | 'unclassified', number>;

/**
 * One project x lens row of `helmraiser stats --json` `scouts`: every lens for
 * every focus project or project with historical scouts. `last_scout_*` describe
 * the latest scout regardless of the window and are all `null` before any scout.
 * `next_eligible_at` is the cooldown only (null: eligible now), and an unavailable
 * repository has `scheduling_error` set. The draft outcomes are for this cohort.
 */
export interface HelmraiserStatsScoutRow {
  project: string;
  lens: HelmraiserScoutLens;
  in_focus: boolean;
  /** From the lens settings. */
  auto: boolean;
  cooldown_hours: number;
  /** Scouts started in the window. */
  scouts: number;
  succeeded: number;
  failed: number;
  /** Scouts neither succeeded nor failed, so `scouts = succeeded + failed + running`. */
  running: number;
  drafts_written: number;
  cost_usd: number;
  /** Drafts never queued. */
  pending: number;
  /** Queued, running or awaiting approval. */
  queued: number;
  /** Drafts with any landed run. */
  landed: number;
  dropped: number;
  /** `dropped` by the class the owner gave when dropping. */
  dropped_by_class: HelmraiserStatsDroppedByClass;
  /** Drafts whose latest run failed or aborted, with no landed run. */
  failed_drafts: number;
  /** Ever-queued drafts by whether the owner changed the scout's text. */
  queued_unchanged: number;
  queued_changed: number;
  queued_unknown: number;
  last_scout_ended_at: string | null;
  last_scout_ok: boolean | null;
  last_scout_error: string | null;
  last_scout_drafts: number | null;
  next_eligible_at: string | null;
  scheduling_error: string | null;
}

/**
 * `helmraiser stats [--since <window>] [--project <path>] --json`, passed through
 * unchanged (docs/reference.md "Stats" in Helmraiser is the contract). Every
 * section is always present; rates are fractions or `null` for a zero denominator.
 */
export interface HelmraiserStats {
  window: { since: HelmraiserStatsWindow; since_seconds: number | null; generated_at: string; project: string | null };
  runs: {
    overall: HelmraiserStatsRunCounts;
    by_project: Array<HelmraiserStatsRunCounts & { project: string }>;
  };
  quality: {
    first_time_right: { count: number; rate: number | null };
    rework_rate: number | null;
    scope_request_rate: number | null;
    retried_tasks: number;
    review_verdicts: { pass: number; concerns: number; uncertain: number; none: number };
  };
  /** Failed and aborted runs by class; `run_ids` are the three newest. */
  failures: Record<string, { count: number; run_ids: string[] }>;
  cost: {
    total_usd: number;
    plan_usd: number;
    implement_usd: number;
    /** Review and anything not recorded separately, floored at zero. */
    other_usd: number;
    per_landed_usd: number | null;
  };
  latency: {
    active_minutes: HelmraiserStatsPercentiles;
    approval_wait_minutes: { plan: HelmraiserStatsPercentiles; scope: HelmraiserStatsPercentiles; merge: HelmraiserStatsPercentiles };
  };
  scouts: HelmraiserStatsScoutRow[];
  /** Oldest-first ISO-week buckets (`YYYY-Www`), at most 26. */
  weekly: Array<{
    week: string;
    landed: number;
    failed: number;
    first_time_right_rate: number | null;
    drafts_written: number;
    drafts_landed: number;
  }>;
}

/**
 * The small slice of `helmraiser report --since <window> --json --models` the
 * dashboard shows. The sidecar maps the raw report to this and drops its big
 * per-run fields (`fragment`, `verify_tails`, `leeboard_entries`; about 144 KB
 * for 7d). `models` is `[]` when Helmraiser predates `--models`.
 */
export interface HelmraiserReport {
  since: HelmraiserReportWindow;
  generated_at: string;
  landed_count: number;
  awaiting_count: number;
  failed: Array<{
    run_id: string;
    task_id: string;
    title: string;
    failure_reason: string | null;
    ended_at: string | null;
  }>;
  cost: { total_usd: number; by_model: Record<string, number> };
  models: Array<{
    model: string;
    runs: number;
    landed: number;
    failed: number;
    first_pass: number;
    review_rounds: number;
    avg_iterations: number;
    avg_minutes: number;
    cost_per_landed: number | null;
  }>;
}

/** One Helmraiser parked-for-approval, failed or landed run the sidecar notices. */
export interface HelmraiserEvent {
  kind: 'helmraiser-event';
  event: 'awaiting' | 'failed' | 'landed';
  runId: string;
  task: string;
  title: string;
}

/** One per-file entry parsed from a run's bounded `diff.patch`. */
export interface HelmraiserDiffFileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface HelmraiserDiffStat {
  files: HelmraiserDiffFileStat[];
  /** Total changed files, including any omitted by the display cap. */
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface HelmraiserRunReview {
  summary: string | null;
  review: string | null;
  diffStat: HelmraiserDiffStat;
  /** True when either the patch read or the displayed file list was cut. */
  diffTruncated: boolean;
  /** Canonical task path, supplied by the sidecar so custom data dirs work. */
  taskPath: string;
}

/**
 * One ledger event of `helmraiser log <run> --json`, without its `run_id` and
 * `session_id` (the caller knows the run). `type` is helmraiser's, and a type added
 * later still arrives; the `payload` shape depends on it (`verify_result` carries
 * `results[]`, `run_end` a `status` and `failure_reason`).
 */
export interface HelmraiserLogEvent {
  id: number;
  /** Epoch seconds. */
  ts: number;
  source: string;
  stage: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** The last events of a run's ledger (at most 200); `truncated` when earlier ones were left out. */
export interface HelmraiserLogResult {
  events: HelmraiserLogEvent[];
  truncated: boolean;
}

export interface HelmraiserDraftPreflightStep {
  name: string;
  exit_code: number;
  seconds: number;
  class: string;
  hint: string;
  tail: string;
}

export interface HelmraiserDraftPreflight {
  summary: string;
  error: string | null;
  steps: HelmraiserDraftPreflightStep[];
}

/**
 * Why a draft was dropped (`helmraiser drafts drop --class`): `wrong` the finding
 * is not real, `unwanted` real but not worth doing, `duplicate` already tracked,
 * fixed or the same as another draft, `unusable` real and wanted but needing too
 * much rework to queue.
 */
export const HELMRAISER_DROP_CLASSES = ['wrong', 'unwanted', 'duplicate', 'unusable'] as const;
export type HelmraiserDropClass = (typeof HELMRAISER_DROP_CLASSES)[number];

/** One row from either draft read; newer identity fields remain optional. */
export interface HelmraiserScoutedDraft {
  kind?: 'scout' | 'manual';
  lens?: HelmraiserScoutLens;
  project: string;
  id: string;
  task_id?: string;
  title: string;
  size: 'S' | 'M' | 'L' | '?';
  source: string;
  age: number;
  intake_status: string;
  intake_error: string | null;
  proposal: Record<string, unknown> | null;
  preflight: HelmraiserDraftPreflight | null;
  path?: string;
  origin?: HelmraiserOrigin | null;
}

/** `helmraiser add --json`: a task file drafted on disk; `add` prints status `draft`. */
export interface HelmraiserDraftResult {
  task_id: string;
  id: string;
  status: 'draft';
  path: string;
}

/** `helmraiser intake <path> --propose --json`: the accepted proposal plus the whole rendered file. */
export interface HelmraiserProposalResult extends HelmraiserDraftResult {
  proposal: Record<string, unknown> | null;
  task: string;
  notes: string[];
}

/** `helmraiser intake <path> --yes --json`: the queued task, echoing the accepted proposal. */
export interface HelmraiserQueueResult {
  task_id: string;
  id: string;
  status: 'queued';
  path: string;
  proposal: Record<string, unknown> | null;
  notes: string[];
}

/**
 * `helmraiser retry <run> [--implement] --json` (helmraiser `_hand_back`): the run is
 * `resuming` at `stage` and a worker picks it up. `retried` echoes the failure
 * reason; `worker_serves_project` is whether a running worker covers the project.
 */
export interface HelmraiserRetryResult {
  retried: string;
  run_id: string;
  task_id: string;
  project: string;
  status: 'resuming';
  stage: 'start' | 'implement' | 'verify';
  worker: string;
  worker_serves_project: boolean;
  /** Present (true) when there were no commits, so the run restarts from its start. */
  restarted_without_commits?: true;
}

/**
 * `helmraiser rework <run> [--note <note>] [--rebase] --json` (helmraiser `rework` +
 * `_hand_back`): the run is `resuming` at `implement` and a worker picks it up.
 * `worker_serves_project` is whether a running worker covers the project.
 */
export interface HelmraiserReworkResult {
  reworked: 'merge';
  /** Present (true) when the run branch is also to be rebased onto its base. */
  rebase?: true;
  run_id: string;
  task_id: string;
  project: string;
  status: 'resuming';
  stage: 'implement';
  worker: string;
  worker_serves_project: boolean;
}

/**
 * The sign-in facts Claude Code reports, whitelisted by the sidecar: the plan
 * and how it is billed, never the account (no email, organisation or path).
 */
export interface ClaudeAuthInfo {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  /** The plan, lower-case as Claude Code reports it (`max`, `pro`, ...). */
  subscriptionType?: string;
}

/** One quota meter of the subscription (`/usage`), already labelled for display. */
export interface ClaudeUsageLimit {
  /** Claude Code's meter kind: `session`, `weekly_all`, `weekly_scoped`, or one FO does not know yet. */
  kind: string;
  /** `5h`, `week`, `<Model> week`, or the kind itself for an unknown meter. */
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  /** Epoch ms when the window resets; null when unreported. */
  resetsAt: number | null;
  /** Claude Code's headline pick: the meter a single-value indicator shows. */
  active: boolean;
}

/** The quota read: the meters and when they were read, or why they could not be. */
export type ClaudeUsage = { limits: ClaudeUsageLimit[]; fetchedAt: number } | { error: string };

/** A running Claude Code session from `claude agents --json`. */
export interface ClaudeLiveSession {
  sessionId: string;
  name: string;
  cwd: string;
  /** `busy` while a turn runs, `idle` between turns. */
  status: string;
  /** `interactive` for a terminal session, otherwise how it was started. */
  kind: string;
  /** Epoch ms. */
  startedAt: number;
}

/**
 * `claude.status`: a read-only picture of Claude Code on this machine.
 * `cli` says whether the installed `claude` could be run at all; `error` is
 * one humane line naming the terminal fix when something else failed.
 */
export interface ClaudeStatusResult {
  cli: 'ok' | 'missing' | 'error';
  auth?: ClaudeAuthInfo;
  usage?: ClaudeUsage;
  live: ClaudeLiveSession[];
  error?: string;
}

/** A recent Claude Code session for a project, from `claude.sessions`. */
export interface ClaudeRecentSession {
  sessionId: string;
  title: string;
  /** Epoch ms. */
  lastModified: number;
  gitBranch?: string;
}

type NoParams = Record<string, never> | undefined;

/**
 * Compile-time contract for every request/response method on the sidecar wire.
 * Runtime frames remain untrusted and are still validated by each seam.
 */
export interface WireCalls {
  'system.health': { params: NoParams; result: HealthResult };
  'system.upkeep': { params: NoParams; result: UpkeepResult };
  'claude.status': { params: { refreshUsage?: boolean }; result: ClaudeStatusResult };
  'claude.sessions': { params: { root: string | null }; result: ClaudeRecentSession[] };
  'chat.setRoot': { params: ChatSetRootParams; result: ChatTimelineItem[] };
  'chat.new': { params: ChatNewParams; result: ChatSessionInfo | null };
  'chat.open': { params: ChatOpenParams; result: ChatOpenResult };
  'chat.exists': { params: ChatExistsParams; result: { exists: boolean } };
  'chat.transcript': { params: ChatSlotParams; result: ChatTimelineItem[] };
  'chat.list': { params: ChatListParams; result: ChatSessionInfo[] };
  'chat.search': { params: ChatSearchParams; result: ChatSearchResult };
  'chat.current': { params: ChatSlotParams; result: ChatSessionInfo | null };
  'chat.slots': { params: NoParams; result: ChatSlotInfo[] };
  'chat.create': { params: ChatCreateParams; result: ChatSlotInfo };
  'chat.close': { params: ChatCloseParams; result: { closed: true } };
  'chat.commands': { params: ChatSlotParams; result: ChatCommandsResult };
  'chat.compact': { params: ChatCompactParams; result: { compacted: true } };
  'chat.rename': { params: ChatRenameParams; result: ChatSessionInfo | null };
  'projects.discover': { params: NoParams; result: ProjectCatalog };
  'projects.resolve': { params: ProjectResolveParams; result: ProjectOption };
  'vault.resolve': { params: VaultResolveParams; result: boolean };
  'models.list': { params: NoParams; result: ModelOption[] };
  'leeboard.brief': { params: ChatSlotParams; result: LeeboardBriefResult };
  'leeboard.show': { params: { id: string }; result: LeeboardShowResult };
  'leeboard.review': { params: NoParams; result: LeeboardReviewResult };
  'leeboard.open': { params: NoParams; result: LeeboardOpenResult };
  'leeboard.holds': { params: NoParams; result: LeeboardHoldsResult };
  'leeboard.asked': { params: ChatSlotParams; result: LeeboardAskedResult };
  'helmraiser.status': { params: NoParams; result: HelmraiserStatus };
  'helmraiser.report': { params: { since: HelmraiserReportWindow }; result: HelmraiserReport };
  'helmraiser.stats': { params: { since: HelmraiserStatsWindow; project?: string }; result: HelmraiserStats };
  'helmraiser.allDrafts': { params: NoParams; result: HelmraiserScoutedDraft[] };
  'helmraiser.scoutSettings': { params: NoParams; result: HelmraiserScoutSettings };
  'helmraiser.setScoutSettings': { params: HelmraiserScoutSettingsUpdate; result: HelmraiserScoutSettings };
  'helmraiser.resetScoutSettings': { params: { lens: HelmraiserScoutLens }; result: HelmraiserScoutSettings };
  'helmraiser.drafts': { params: NoParams; result: HelmraiserScoutedDraft[] };
  'helmraiser.requestScouts': { params: { projects: string[]; lens?: HelmraiserScoutLens }; result: HelmraiserRequestScoutsResult };
  'helmraiser.cancelScouts': { params: { projects: string[]; lens?: HelmraiserScoutLens }; result: HelmraiserCancelScoutsResult };
  'helmraiser.abort': { params: { projectPath: string; runId: string }; result: void };
  'helmraiser.plan': { params: { runId: string }; result: { text: string; path: string } };
  'helmraiser.runReview': { params: { runId: string }; result: HelmraiserRunReview };
  /** A run's ledger events, the last 200; `sinceId` returns only events after that id. */
  'helmraiser.log': { params: { runId: string; sinceId?: number }; result: HelmraiserLogResult };
  'helmraiser.approve': {
    params: { runId: string; note?: string };
    result: Record<string, unknown>;
  };
  'helmraiser.reject': {
    params: { runId: string; note?: string };
    result: Record<string, unknown>;
  };
  'helmraiser.workerStart': { params: NoParams; result: Record<string, unknown> };
  'helmraiser.workerStop': { params: NoParams; result: Record<string, unknown> };
  'helmraiser.pause': { params: NoParams; result: Record<string, unknown> };
  'helmraiser.resume': { params: NoParams; result: Record<string, unknown> };
  'helmraiser.draft': {
    params: { project: string; title: string; text: string };
    result: HelmraiserDraftResult;
  };
  'helmraiser.propose': { params: { path: string }; result: HelmraiserProposalResult };
  'helmraiser.queue': { params: { path: string; origin?: string }; result: HelmraiserQueueResult };
  'helmraiser.dropDraft': {
    params: { taskId: string; reason: string; class?: HelmraiserDropClass };
    result: Record<string, unknown>;
  };
  /** Take one queued task back to draft (`helmraiser queue remove`); `taskId` is the full `<project-slug>:<id>`. */
  'helmraiser.queueRemove': {
    params: { taskId: string };
    result: Record<string, unknown>;
  };
  /** Hand a failed run back to the worker (`helmraiser retry`); `implement` goes back to implement. */
  'helmraiser.retry': {
    params: { runId: string; implement?: boolean };
    result: HelmraiserRetryResult;
  };
  /** Hand a run awaiting merge back to the worker (`helmraiser rework`); a note, a rebase, or both. */
  'helmraiser.rework': {
    params: { runId: string; note?: string; rebase?: boolean };
    result: HelmraiserReworkResult;
  };
}

/**
 * Every `stream` method: its params and the chunk type it yields. Clients and
 * the sidecar type their stream calls against this, as `WireCalls` does calls.
 */
export interface WireStreams {
  'chat.send': { params: ChatSendParams; chunk: ChatChunk };
  'chat.observe': { params: ChatObserveParams; chunk: ChatChunk };
  'chat.slotsObserve': { params: NoParams; chunk: ChatSlotsEvent };
  'helmraiser.observe': { params: NoParams; chunk: HelmraiserEvent };
}

/**
 * The `stream` method names, at runtime: what `fo call` refuses (a raw stream
 * request would skip what `fo send` checks). Kept equal to `WireStreams`'s
 * keys by the type below.
 */
export const WIRE_STREAM_METHODS = ['chat.send', 'chat.observe', 'chat.slotsObserve', 'helmraiser.observe'] as const;
type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const streamMethodsCoverWireStreams: ExactKeys<(typeof WIRE_STREAM_METHODS)[number], keyof WireStreams> = true;
void streamMethodsCoverWireStreams;

export const WS_PATH = '/ws';

/**
 * The always-on service's port, and the default for everything that looks for
 * it: the sidecar, `fo`, the deploy script and the promotion safety probe.
 * Sharing one value keeps that probe from missing a live sidecar.
 */
export const DEFAULT_SIDECAR_PORT = 14787;
