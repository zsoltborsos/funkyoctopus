import { tmpdir } from 'node:os';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import type {
  ClaudeAuthInfo,
  ClaudeLiveSession,
  ClaudeRecentSession,
  ClaudeStatusResult,
  ClaudeUsage,
  ClaudeUsageLimit,
} from '../../../src/shared/transport/protocol.ts';
import { messageOf } from '../util/errors.ts';
import { isRecord } from '../util/records.ts';
import { claudeChildEnv } from './env.ts';
import { resolveClaudeBin, runClaudeJson, type ClaudeJsonRunner } from './cli.ts';

const AUTH_TIMEOUT_MS = 10_000;
/** `claude auth status` is a process spawn; polls from several tabs share one read. */
const AUTH_TTL_MS = 10_000;
const LIVE_TIMEOUT_MS = 10_000;
const LIVE_TTL_MS = 10_000;
const USAGE_TIMEOUT_MS = 30_000;
/** A good usage read is kept this long; the meter moves slowly and a read starts a claude process. */
const USAGE_TTL_MS = 5 * 60_000;
/** A failed read is retried at the next poll after this, not held for the full TTL. */
const USAGE_RETRY_MS = 30_000;
/** A forced refresh cannot re-read a usage answer younger than this. */
const USAGE_FORCE_FLOOR_MS = 30_000;

const NOT_LOGGED_IN = 'Claude Code is not logged in — run `claude`, then /login, in a terminal';
const NOT_FOUND = 'Claude Code not found — install it, or set CLAUDE_BIN';
const API_KEY = 'Claude is on an API key — no subscription quota to read';
const RECENT_LIMIT = 8;

/** The slice of the Agent SDK's `listSessions` this module uses; the real function satisfies it. */
export type ListSessionsFn = (options: { dir?: string; limit: number }) => Promise<
  {
    sessionId: string;
    summary: string;
    lastModified: number;
    customTitle?: string;
    gitBranch?: string;
  }[]
>;

/** The slice of the Agent SDK's `query` this module uses; the real function satisfies it. */
export type UsageQueryFn = (params: {
  prompt: string;
  options: {
    pathToClaudeCodeExecutable: string;
    env: Record<string, string>;
    persistSession: boolean;
    cwd: string;
    settingSources: [];
    strictMcpConfig: boolean;
    mcpServers: Record<string, never>;
    abortController: AbortController;
  };
}) => AsyncIterable<unknown> & { close(): void };

export interface ClaudeCodeStatusDeps {
  /** The configured `claude` (CLAUDE_BIN): a bare name searched on `pathEnv`, or a path. */
  bin: string;
  /** FunkyOctopus's version, reported to Claude Code as the client app. */
  version: string;
  /** Search path for a bare `bin`; the sidecar's PATH by default. */
  pathEnv?: string;
  /** Environment the child env is derived from; the sidecar's by default. */
  env?: NodeJS.ProcessEnv;
  resolveBin?: (bin: string, pathEnv: string) => Promise<string | null>;
  /** Runs `claude <args>` for JSON; injected so tests never spawn the CLI. */
  runJson?: ClaudeJsonRunner;
  /** The Agent SDK's `query`, used only for the local `/usage` command. */
  query: UsageQueryFn;
  /** The Agent SDK's `listSessions`, which reads Claude Code's own transcript index. */
  listSessions: ListSessionsFn;
  usageTimeoutMs?: number;
  now?: () => number;
}

export interface LiveRead {
  live: ClaudeLiveSession[];
  error?: string;
}

type AuthRead =
  | { cli: 'ok'; auth: ClaudeAuthInfo }
  | { cli: 'missing' }
  | { cli: 'error'; error: string };

/**
 * A value that is read at most once per its TTL, with concurrent callers
 * sharing the read in flight. The loader must settle to a value: failures are
 * part of what is cached. `read(true)` asks for a fresh read but is only
 * honoured once the cached one is `forceFloorMs` old.
 */
class Cached<T> {
  private entry: { at: number; value: T } | null = null;
  private inflight: Promise<T> | null = null;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: (value: T) => number,
    private readonly now: () => number,
    private readonly forceFloorMs = Infinity,
  ) {}

  read(force = false): Promise<T> {
    if (this.inflight) return this.inflight;
    if (this.entry) {
      const age = this.now() - this.entry.at;
      if (age < this.ttlMs(this.entry.value) && !(force && age >= this.forceFloorMs)) {
        return Promise.resolve(this.entry.value);
      }
    }
    this.inflight = this.load()
      .then((value) => {
        this.entry = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/**
 * A read-only picture of Claude Code on this machine: sign-in, quota, running
 * sessions and recent sessions. Every failure is a value naming the terminal
 * fix; FunkyOctopus never logs in and never reads a credential file. All CLI
 * and SDK calls get the sanitized child env (`claudeChildEnv`).
 */
export class ClaudeCodeStatus {
  private readonly pathEnv: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveBin: (bin: string, pathEnv: string) => Promise<string | null>;
  private readonly runJson: ClaudeJsonRunner;
  private readonly now: () => number;
  private readonly authRead: Cached<AuthRead>;
  private readonly liveRead: Cached<LiveRead>;
  private readonly usageRead: Cached<ClaudeUsage>;

  constructor(private readonly deps: ClaudeCodeStatusDeps) {
    this.pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
    this.env = deps.env ?? process.env;
    this.resolveBin = deps.resolveBin ?? resolveClaudeBin;
    this.runJson = deps.runJson ?? runClaudeJson;
    this.now = deps.now ?? Date.now;
    this.authRead = new Cached(() => this.readAuth(), () => AUTH_TTL_MS, this.now);
    this.liveRead = new Cached(() => this.readLive(), () => LIVE_TTL_MS, this.now);
    this.usageRead = new Cached(
      () => this.readUsage(),
      (usage) => ('limits' in usage ? USAGE_TTL_MS : USAGE_RETRY_MS),
      this.now,
      USAGE_FORCE_FLOOR_MS,
    );
  }

  /**
   * Everything the status chip and popover show. Never throws. `refreshUsage`
   * asks for a fresh quota read, honoured only when the cached one is 30 s old.
   */
  async status(refreshUsage = false): Promise<ClaudeStatusResult> {
    const auth = await this.authRead.read();
    if (auth.cli === 'missing') return { cli: 'missing', live: [], error: NOT_FOUND };
    if (auth.cli === 'error') return { cli: 'error', live: [], error: auth.error };
    // Listing running sessions is local, so it works logged out too. Only a
    // subscription has a quota; an API key or a cloud provider is billed per use.
    const [live, usage] = await Promise.all([
      this.live(),
      auth.auth.loggedIn && isSubscription(auth.auth) ? this.usage(refreshUsage) : undefined,
    ]);
    if (!auth.auth.loggedIn) return { cli: 'ok', auth: auth.auth, live: live.live, error: NOT_LOGGED_IN };
    return {
      cli: 'ok',
      auth: auth.auth,
      ...(usage !== undefined ? { usage } : {}),
      live: live.live,
      ...(live.error !== undefined ? { error: live.error } : {}),
    };
  }

  /** The subscription's quota meters, cached for 5 minutes. A failure is `{ error }`, never a throw. */
  usage(force = false): Promise<ClaudeUsage> {
    return this.usageRead.read(force);
  }

  /**
   * Running Claude Code sessions (terminals and headless), cached for 10 seconds.
   * `fresh` reads again, whatever is cached or already being read, for a decision
   * that acts on the answer (opening a session) rather than showing it.
   */
  live(fresh = false): Promise<LiveRead> {
    return fresh ? this.readLive() : this.liveRead.read();
  }

  /**
   * The most recent Claude Code sessions for a project root (every project when
   * null). Rejects with a typed error rather than answering empty, so the
   * popover can say the listing failed.
   */
  async recent(root: string | null): Promise<ClaudeRecentSession[]> {
    try {
      const rows = await this.deps.listSessions(
        root === null ? { limit: RECENT_LIMIT } : { dir: root, limit: RECENT_LIMIT },
      );
      return rows.map((row) => ({
        sessionId: row.sessionId,
        title: row.customTitle ?? row.summary,
        lastModified: row.lastModified,
        ...(row.gitBranch !== undefined ? { gitBranch: row.gitBranch } : {}),
      }));
    } catch (error) {
      throw new WireCallError(
        `Could not list recent Claude Code sessions — ${messageOf(error)}`,
        'claude_sessions_error',
      );
    }
  }

  private async readAuth(): Promise<AuthRead> {
    const bin = await this.resolveBin(this.deps.bin, this.pathEnv);
    if (bin === null) return { cli: 'missing' };
    try {
      const { json } = await this.runJson(['auth', 'status', '--json'], {
        bin,
        env: claudeChildEnv(this.env, this.deps.version),
        timeoutMs: AUTH_TIMEOUT_MS,
      });
      if (!isRecord(json) || typeof json.loggedIn !== 'boolean') {
        return { cli: 'error', error: 'claude auth status gave an unexpected answer' };
      }
      // A whitelist, not a filter: the answer also carries email and organisation.
      const auth: ClaudeAuthInfo = { loggedIn: json.loggedIn };
      if (typeof json.authMethod === 'string') auth.authMethod = json.authMethod;
      if (typeof json.apiProvider === 'string') auth.apiProvider = json.apiProvider;
      if (typeof json.subscriptionType === 'string') auth.subscriptionType = json.subscriptionType;
      return { cli: 'ok', auth };
    } catch (error) {
      if (error instanceof WireCallError && error.code === 'claude_unavailable') return { cli: 'missing' };
      return { cli: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readLive(): Promise<LiveRead> {
    const bin = await this.resolveBin(this.deps.bin, this.pathEnv);
    if (bin === null) return { live: [], error: NOT_FOUND };
    try {
      const { exitCode, json } = await this.runJson(['agents', '--json'], {
        bin,
        env: claudeChildEnv(this.env, this.deps.version),
        timeoutMs: LIVE_TIMEOUT_MS,
      });
      if (exitCode !== 0 || !Array.isArray(json)) {
        return { live: [], error: 'Could not list live Claude Code sessions — claude agents gave an unexpected answer' };
      }
      return { live: json.flatMap(liveSession) };
    } catch (error) {
      return { live: [], error: `Could not list live Claude Code sessions — ${messageOf(error)}` };
    }
  }

  private async readUsage(): Promise<ClaudeUsage> {
    const bin = await this.resolveBin(this.deps.bin, this.pathEnv);
    if (bin === null) return { error: NOT_FOUND };
    const timeoutMs = this.deps.usageTimeoutMs ?? USAGE_TIMEOUT_MS;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ClaudeUsage>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({ error: `Reading Claude Code usage timed out after ${timeoutMs / 1000} s` });
      }, timeoutMs);
    });
    let stream: ReturnType<UsageQueryFn> | undefined;
    try {
      stream = this.deps.query({
        prompt: '/usage',
        options: {
          pathToClaudeCodeExecutable: bin,
          env: claudeChildEnv(this.env, this.deps.version),
          persistSession: false,
          // A status read, not a session: no project CLAUDE.md, owner settings,
          // hooks or MCP connections, and no project entry for the sidecar's cwd.
          cwd: tmpdir(),
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          abortController: abort,
        },
      });
      const reading = this.consumeUsage(stream);
      // Closing the query after a timeout rejects the abandoned read; nobody awaits it.
      reading.catch(() => undefined);
      return await Promise.race([reading, timedOut]);
    } catch (error) {
      return { error: `Could not read Claude Code usage — ${messageOf(error)}` };
    } finally {
      clearTimeout(timer);
      stream?.close();
    }
  }

  /**
   * `/usage` is a local command: Claude Code answers with a synthetic assistant
   * message carrying `usage_report` and spends no model tokens. Read only for a
   * subscription login; a session that turns out to run on an API key
   * (`init.apiKeySource` other than "none") has no quota to report.
   */
  private async consumeUsage(stream: AsyncIterable<unknown>): Promise<ClaudeUsage> {
    let sawInit = false;
    let report: unknown;
    let refusal: string | undefined;
    for await (const message of stream) {
      if (!isRecord(message)) continue;
      if (message.type === 'system' && message.subtype === 'init') {
        sawInit = true;
        if (message.apiKeySource !== 'none') return { error: API_KEY };
      } else if (message.type === 'assistant') {
        if (message.error === 'authentication_failed') return { error: NOT_LOGGED_IN };
        if (typeof message.error === 'string') refusal = message.error;
        if (message.usage_report !== undefined) report = message.usage_report;
      } else if (message.type === 'result') {
        break;
      }
    }
    if (!sawInit) return { error: 'Claude Code did not report its auth source — usage not read' };
    if (report === undefined) {
      return {
        error: refusal !== undefined
          ? `Claude Code could not report usage (${refusal})`
          : 'Claude Code did not report usage — is this a subscription login?',
      };
    }
    const limits = isRecord(report) && isRecord(report.rate_limits) ? report.rate_limits.limits : undefined;
    if (!Array.isArray(limits)) return { error: 'Claude Code could not fetch usage right now' };
    return { limits: limits.flatMap(usageLimit), fetchedAt: this.now() };
  }
}

/**
 * Whether the sign-in is a claude.ai subscription, the only one with a quota:
 * `claude auth status` names a plan only then (measured: an API key in the
 * environment takes over from a stored login and the plan disappears).
 */
function isSubscription(auth: ClaudeAuthInfo): boolean {
  return auth.subscriptionType !== undefined && auth.subscriptionType !== '';
}

/** One `claude agents --json` row as a wire row; a row without a session id is dropped. */
function liveSession(row: unknown): ClaudeLiveSession[] {
  if (!isRecord(row) || typeof row.sessionId !== 'string') return [];
  const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
  return [{
    sessionId: row.sessionId,
    name: text(row.name, row.sessionId),
    cwd: text(row.cwd, ''),
    status: text(row.status, 'unknown'),
    kind: text(row.kind, 'unknown'),
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
  }];
}
function displayName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.display_name === 'string' && value.display_name !== ''
    ? value.display_name
    : undefined;
}

/** The short label the status bar shows; an unknown meter keeps its kind. */
function limitLabel(kind: string, scope: unknown): string {
  switch (kind) {
    case 'session':
      return '5h';
    case 'weekly_all':
      return 'week';
    case 'weekly_scoped': {
      const named = isRecord(scope) ? (displayName(scope.model) ?? displayName(scope.surface)) : undefined;
      return named !== undefined ? `${named} week` : kind;
    }
    default:
      return kind;
  }
}

/** One `usage_report` row as a wire meter; a row without a kind or a numeric percent is dropped. */
function usageLimit(row: unknown): ClaudeUsageLimit[] {
  if (!isRecord(row) || typeof row.kind !== 'string') return [];
  if (typeof row.percent !== 'number' || !Number.isFinite(row.percent)) return [];
  const resetsAt = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN;
  return [{
    kind: row.kind,
    label: limitLabel(row.kind, row.scope),
    percent: row.percent,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    active: row.is_active === true,
  }];
}
