import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { Readable } from 'node:stream';
import {
  CLI_CLIENT_PREFIX,
  MAIN_CHAT,
  WIRE_STREAM_METHODS,
  DEFAULT_SIDECAR_PORT,
  WS_PATH,
  type ChatChunk,
  type ChatSendParams,
  type ChatSlotInfo,
  type EngineKind,
  type WireError,
} from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { CallTimeoutError, FoClient, SidecarUnreachable } from './fo-client.ts';

/** Sidecar call budget: 30 s unless `--timeout <seconds>` overrides it. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long an interrupted send waits for the server's `stream-end`. */
const INTERRUPT_GRACE_MS = 2_000;

/**
 * One identity shared by every chat operation from this `fo` process, marked
 * as the CLI's so a browser window knows no window sent its turns.
 */
const CLIENT_ID = `${CLI_CLIENT_PREFIX}${randomUUID()}`;

/** Machine-readable output for every command: two-space JSON, trailing newline. */
const prettyJson = (value: unknown): string =>
  `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`;

/** Everything `main` touches from the outside: streams, the URL, optional signal. */
export interface FoIo {
  stdout: Writer;
  stderr: Writer;
  /** Pre-read stdin text (tests) or a readable stream (direct execution). */
  stdin: Readable | string;
  /** Whether stdin is an interactive terminal; false unless said (direct execution reads it). */
  stdinIsTTY?: boolean;
  url: string;
  /** Injected interruption signal; direct execution installs SIGINT instead. */
  signal?: AbortSignal;
}

/** Writers only need `write(string)` so tests can capture with plain buffers. */
export interface Writer {
  write(text: string): void;
}

/** Command-line misuse: unknown command, bad options, bad params JSON. Exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** `FO_URL` wins; otherwise loopback + `SIDECAR_PORT` (default `DEFAULT_SIDECAR_PORT`) + `WS_PATH`. */
export function urlFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.FO_URL) return env.FO_URL;
  const port = env.SIDECAR_PORT || String(DEFAULT_SIDECAR_PORT);
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

// --- command parsing ---

/**
 * The chat slot a command acts on: `--chat <id>`, `main` by default.
 * `explicit` records whether `--chat` was given, which sending into a Claude
 * Code chat requires.
 */
interface ChatTarget {
  chatId: string;
  explicit: boolean;
}

type Command =
  | { kind: 'help' }
  | { kind: 'health' | 'projects' | 'models' | 'helmraiser'; json: boolean }
  | { kind: 'call'; method: string; params: unknown; json: boolean }
  | { kind: 'chats'; root: string | null; chat: ChatTarget; json: boolean }
  | { kind: 'chats-live'; json: boolean }
  | { kind: 'chat-current' | 'chat-new'; chat: ChatTarget; json: boolean }
  | { kind: 'chat-open'; path: string; chat: ChatTarget; json: boolean }
  | { kind: 'chat-root'; path: string | null; chat: ChatTarget; json: boolean }
  | { kind: 'chat-create'; engine: EngineKind; root: string | null; json: boolean }
  | { kind: 'chat-close'; chatId: string; force: boolean; json: boolean }
  | {
      kind: 'send';
      text: string;
      chat: ChatTarget;
      model: { provider: string; id: string } | undefined;
      effort: string | undefined;
      thinking: boolean;
      json: boolean;
    }
  | { kind: 'vault'; approved: boolean; requestId: string; json: boolean };

/** One parsed invocation: the command plus its call budget. */
type Parsed = { command: Command; timeoutMs: number };

type OptionName =
  | 'json'
  | 'help'
  | 'timeout'
  | 'root'
  | 'global'
  | 'model'
  | 'effort'
  | 'thinking'
  | 'chat'
  | 'live'
  | 'engine'
  | 'force';

/** Options each command tolerates; anything else is a usage error. */
function allowedOptions(command: string): readonly OptionName[] {
  if (command === 'send') return ['json', 'model', 'effort', 'thinking', 'chat'];
  if (command === 'chats') return ['json', 'timeout', 'root', 'global', 'chat', 'live'];
  if (command === 'chat') return ['json', 'timeout', 'chat', 'engine', 'root', 'force'];
  return ['json', 'timeout'];
}

function parseCommand(argv: readonly string[]): Parsed {
  let values: {
    json?: boolean;
    help?: boolean;
    timeout?: string;
    root?: string;
    global?: boolean;
    model?: string;
    effort?: string;
    thinking?: boolean;
    chat?: string;
    live?: boolean;
    engine?: string;
    force?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        timeout: { type: 'string' },
        root: { type: 'string' },
        global: { type: 'boolean' },
        model: { type: 'string' },
        effort: { type: 'string' },
        thinking: { type: 'boolean' },
        chat: { type: 'string' },
        live: { type: 'boolean' },
        engine: { type: 'string' },
        force: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }

  if (values.help) {
    return { command: { kind: 'help' }, timeoutMs: DEFAULT_TIMEOUT_MS };
  }

  const command = positionals[0];
  if (command === undefined) {
    throw new UsageError('missing command');
  }
  if (command === 'help') {
    return { command: { kind: 'help' }, timeoutMs: DEFAULT_TIMEOUT_MS };
  }

  // parseArgs rejects unknown options in strict mode; these are known options
  // that simply do not belong to the selected command.
  const allowed = allowedOptions(command);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !(allowed as readonly string[]).includes(name)) {
      throw new UsageError(`${command} does not accept --${name}`);
    }
  }

  const json = values.json === true;
  const rest = positionals.slice(1);
  if (values.chat === '') throw new UsageError('--chat needs a chat id');
  const chat: ChatTarget = { chatId: values.chat ?? MAIN_CHAT, explicit: values.chat !== undefined };
  // `send` never sees --timeout (rejected above), so this is the default there;
  // streams ignore the budget regardless.
  const timeoutMs = timeoutMsFromValue(values.timeout);

  switch (command) {
    case 'health':
    case 'projects':
    case 'models':
    case 'helmraiser': {
      if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
      return { command: { kind: command, json }, timeoutMs };
    }
    case 'call': {
      if (rest.length === 0) throw new UsageError('call needs a method name');
      if (rest.length > 2) throw new UsageError('call takes a method and optional params JSON');
      let params: unknown = null;
      if (rest.length === 2) {
        try {
          params = JSON.parse(rest[1] as string);
        } catch (e) {
          throw new UsageError(`invalid params JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const method = rest[0] as string;
      // A stream is not a call: `fo call chat.send …` would dispatch a turn past
      // everything `fo send` checks, the Claude chat rule (limit 2) first.
      if ((WIRE_STREAM_METHODS as readonly string[]).includes(method)) {
        throw new UsageError(`${method} is a stream, not a call: use fo send to send a turn`);
      }
      return {
        command: { kind: 'call', method, params, json },
        timeoutMs,
      };
    }
    case 'chats': {
      if (rest.length > 0) throw new UsageError('chats takes no positional arguments');
      if (values.live === true) {
        if (values.root !== undefined || values.global === true || values.chat !== undefined) {
          throw new UsageError('chats --live lists every chat slot: it takes no --root, --global or --chat');
        }
        return { command: { kind: 'chats-live', json }, timeoutMs };
      }
      if (values.root !== undefined && values.global === true) {
        throw new UsageError('chats: --root and --global are mutually exclusive');
      }
      return { command: { kind: 'chats', root: values.root ?? null, chat, json }, timeoutMs };
    }
    case 'chat': {
      return { command: parseChat(rest, values, chat, json), timeoutMs };
    }
    case 'send': {
      return { command: parseSend(rest, values, chat, json), timeoutMs };
    }
    case 'vault': {
      if (rest.length > 2) throw new UsageError('vault takes an action and a request id');
      const action = rest[0];
      if (action !== 'approve' && action !== 'deny') {
        throw new UsageError('vault needs "approve" or "deny" and a request id');
      }
      const requestId = rest[1];
      if (requestId === undefined) throw new UsageError('vault needs a request id');
      return {
        command: { kind: 'vault', approved: action === 'approve', requestId, json },
        timeoutMs,
      };
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function parseChat(
  rest: readonly string[],
  values: { engine?: string; root?: string; force?: boolean },
  chat: ChatTarget,
  json: boolean,
): Command {
  const sub = rest[0];
  const only = (allowed: readonly ('engine' | 'root' | 'force')[]): void => {
    for (const name of ['engine', 'root', 'force'] as const) {
      if (values[name] !== undefined && !allowed.includes(name)) throw new UsageError(`chat ${sub ?? ''} does not accept --${name}`);
    }
  };
  switch (sub) {
    case 'current':
    case 'new': {
      only([]);
      if (rest.length > 1) throw new UsageError(`chat ${sub} takes no arguments`);
      return { kind: sub === 'current' ? 'chat-current' : 'chat-new', chat, json };
    }
    case 'open': {
      only([]);
      const path = rest[1];
      if (path === undefined) throw new UsageError('chat open needs a session path');
      if (rest.length > 2) throw new UsageError('chat open takes one session path');
      return { kind: 'chat-open', path, chat, json };
    }
    case 'root': {
      only([]);
      const path = rest[1];
      if (path === undefined) throw new UsageError('chat root needs a path or "global"');
      if (rest.length > 2) throw new UsageError('chat root takes one path');
      return { kind: 'chat-root', path: path === 'global' ? null : path, chat, json };
    }
    case 'create': {
      only(['engine', 'root']);
      if (rest.length > 1) throw new UsageError('chat create takes no arguments');
      if (chat.explicit) throw new UsageError('chat create makes a new chat: it takes no --chat');
      const engine = values.engine;
      if (engine !== 'pi' && engine !== 'claude-code') {
        throw new UsageError('chat create needs --engine pi or --engine claude-code');
      }
      return { kind: 'chat-create', engine, root: values.root ?? null, json };
    }
    case 'close': {
      only(['force']);
      const chatId = rest[1];
      if (chatId === undefined) throw new UsageError('chat close needs a chat id');
      if (rest.length > 2) throw new UsageError('chat close takes one chat id');
      if (chat.explicit) throw new UsageError('chat close takes the chat id as its argument, not --chat');
      return { kind: 'chat-close', chatId, force: values.force === true, json };
    }
    case undefined:
      throw new UsageError('chat needs a subcommand: current, new, open, root, create or close');
    default:
      throw new UsageError(`unknown chat subcommand: ${sub}`);
  }
}

function parseSend(
  rest: readonly string[],
  values: { model?: string; effort?: string; thinking?: boolean },
  chat: ChatTarget,
  json: boolean,
): Command {
  if (rest.length === 0) throw new UsageError('send needs message text');
  let model: { provider: string; id: string } | undefined;
  if (values.model !== undefined) {
    model = parseModel(values.model);
  }
  return {
    kind: 'send',
    text: rest[0] === '-' && rest.length === 1 ? '-' : rest.join(' '),
    chat,
    model,
    effort: values.effort,
    thinking: values.thinking === true,
    json,
  };
}

/** `--model provider/id`: split on the first `/`; both halves must be non-empty. */
function parseModel(raw: string): { provider: string; id: string } {
  const slash = raw.indexOf('/');
  const provider = slash === -1 ? '' : raw.slice(0, slash);
  const id = slash === -1 ? '' : raw.slice(slash + 1);
  if (!provider || !id) throw new UsageError('--model must be <provider>/<id>');
  return { provider, id };
}

/** Seconds string from `--timeout` → milliseconds; anything odd is a usage error. */
function timeoutMsFromValue(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--timeout must be a positive number of seconds, got "${raw}"`);
  }
  return seconds * 1000;
}

// --- send rendering ---

/** As the browser's context meter: sub-1% occupancy is real, so it reads `<1%`; otherwise whole percent. */
const formatPercent = (percent: number): string =>
  percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;

/** One streamed chat chunk → human stdout/stdout-side notes (or nothing). */
function renderChatChunk(
  chunk: ChatChunk,
  thinking: boolean,
  stdout: Writer,
  stderr: Writer,
): void {
  switch (chunk.kind) {
    case 'text':
      stdout.write(chunk.delta);
      break;
    case 'thinking':
      if (thinking) stderr.write(`${chunk.delta}\n`);
      break;
    case 'tool-call':
      stderr.write(`› ${chunk.tool} ${chunk.summary}\n`);
      break;
    case 'tool-result':
      stderr.write(chunk.ok ? '  ✓\n' : `  ✗ ${chunk.error ?? 'tool failed'}\n`);
      break;
    case 'approval-request':
      stderr.write(
        `⚠ approval needed: ${chunk.tool} ${chunk.target}  (fo vault approve|deny ${chunk.requestId})\n`,
      );
      break;
    case 'usage':
      stderr.write(chunk.percent === null ? '· ctx ?\n' : `· ctx ${formatPercent(chunk.percent)}\n`);
      break;
    case 'custom-message':
      if (chunk.display) stderr.write(`▪ ${chunk.customType}: ${chunk.content}\n`);
      break;
    default:
      break;
  }
}

// --- command execution ---

/** Dispatch one parsed command over an open client; returns the exit code. */
async function dispatch(
  client: FoClient,
  parsed: Command,
  io: FoIo,
  timeoutMs: number,
): Promise<number> {
  switch (parsed.kind) {
    case 'health': {
      const result = await client.call('system.health', {}, timeoutMs);
      if (parsed.json) {
        io.stdout.write(prettyJson(result));
      } else {
        io.stdout.write(`ok · ${result.version} · up ${Math.floor(result.uptimeMs / 1000)}s\n`);
        for (const [backend, state] of Object.entries(result.backends)) {
          io.stdout.write(`  ${backend}: ${state}\n`);
        }
      }
      return 0;
    }
    case 'call': {
      const result = await client.callRaw(parsed.method, parsed.params, timeoutMs);
      io.stdout.write(prettyJson(result));
      return 0;
    }
    case 'projects': {
      const result = await client.call('projects.discover', {}, timeoutMs);
      if (parsed.json) {
        io.stdout.write(prettyJson(result));
      } else {
        io.stdout.write(`global  ${result.globalRoot}\n`);
        io.stdout.write('known\n');
        for (const project of result.known) {
          io.stdout.write(`  ${project.name}  ${project.path}\n`);
        }
        io.stdout.write('folders\n');
        for (const folder of result.folders) {
          io.stdout.write(`  ${folder.name}  ${folder.path}\n`);
        }
      }
      return 0;
    }
    case 'chats': {
      const rows = await client.call(
        'chat.list',
        { chatId: parsed.chat.chatId, root: parsed.root },
        timeoutMs,
      );
      if (parsed.json) {
        io.stdout.write(prettyJson(rows));
      } else {
        for (const row of rows) {
          let line = `${row.modified}  ${row.title}  ${row.path}`;
          if (row.movedFrom !== undefined) line += ` (moved from ${row.movedFrom})`;
          else if (row.folderGone) line += ' (folder gone)';
          io.stdout.write(`${line}\n`);
        }
      }
      return 0;
    }
    case 'chats-live': {
      const slots = await client.call('chat.slots', {}, timeoutMs);
      if (parsed.json) {
        io.stdout.write(prettyJson(slots));
      } else {
        const idWidth = Math.max(...slots.map((slot) => slot.chatId.length));
        const kindWidth = Math.max(...slots.map((slot) => slot.kind.length));
        for (const slot of slots) {
          io.stdout.write(
            `${slot.chatId.padEnd(idWidth)}  ${slot.kind.padEnd(kindWidth)}  ${slotState(slot)}  ${slot.session?.title ?? '—'}\n`,
          );
        }
      }
      return 0;
    }
    case 'chat-create': {
      const slot = await client.call(
        'chat.create',
        { kind: parsed.engine, root: parsed.root, clientId: CLIENT_ID },
        timeoutMs,
      );
      io.stdout.write(parsed.json ? prettyJson(slot) : `${slot.chatId}\n`);
      return 0;
    }
    case 'chat-close': {
      const result = await client.call(
        'chat.close',
        { chatId: parsed.chatId, ...(parsed.force ? { force: true } : {}), clientId: CLIENT_ID },
        timeoutMs,
      );
      io.stdout.write(parsed.json ? prettyJson(result) : `closed ${parsed.chatId}\n`);
      return 0;
    }
    case 'chat-current': {
      const row = await client.call('chat.current', { chatId: parsed.chat.chatId }, timeoutMs);
      io.stdout.write(
        parsed.json
          ? prettyJson(row)
          : `${row ? `${row.title}  ${row.cwd}  ${row.path}` : 'no open chat'}\n`,
      );
      return 0;
    }
    case 'chat-new': {
      const row = await client.call(
        'chat.new',
        { chatId: parsed.chat.chatId, clientId: CLIENT_ID },
        timeoutMs,
      );
      io.stdout.write(parsed.json ? prettyJson(row) : `${row ? row.path : 'no open chat'}\n`);
      return 0;
    }
    case 'chat-open': {
      const result = await client.call(
        'chat.open',
        { chatId: parsed.chat.chatId, path: parsed.path, clientId: CLIENT_ID },
        timeoutMs,
      );
      if (parsed.json) {
        io.stdout.write(prettyJson(result));
      } else if ('heldBy' in result) {
        // One holder per session: another chat has it open, so it was not opened twice.
        io.stdout.write(`held by chat ${result.heldBy} — open it there (fo --chat ${result.heldBy} …)\n`);
      } else {
        io.stdout.write(`opened · ${result.items.length} items\n`);
      }
      return 0;
    }
    case 'chat-root': {
      const items = await client.call(
        'chat.setRoot',
        { chatId: parsed.chat.chatId, path: parsed.path, clientId: CLIENT_ID },
        timeoutMs,
      );
      io.stdout.write(
        parsed.json
          ? prettyJson(items)
          : `root · ${parsed.path ?? 'global'} · ${items.length} items\n`,
      );
      return 0;
    }
    case 'models': {
      const models = await client.call('models.list', {}, timeoutMs);
      if (parsed.json) {
        io.stdout.write(prettyJson(models));
      } else {
        for (const model of models) {
          io.stdout.write(`${model.provider}/${model.id}  ${model.name}\n`);
        }
      }
      return 0;
    }
    case 'helmraiser': {
      const result = await client.call('helmraiser.status', {}, timeoutMs);
      io.stdout.write(prettyJson(result));
      return 0;
    }
    case 'vault': {
      const resolved = await client.call(
        'vault.resolve',
        { requestId: parsed.requestId, approved: parsed.approved },
        timeoutMs,
      );
      if (!resolved) {
        // The broker answers ok:true with `false` when no pending request
        // carries this id — that is a failed resolution, not a verdict.
        throw new WireCallError(`no pending approval request: ${parsed.requestId}`);
      }
      io.stdout.write(parsed.json ? prettyJson(resolved) : `${parsed.approved ? 'approved' : 'denied'}\n`);
      return 0;
    }
    case 'send': {
      const refusal = await claudeSendRefusal(client, parsed.chat, io, timeoutMs);
      if (refusal !== null) {
        io.stderr.write(`${refusal}\n`);
        return 2;
      }
      return runSend(client, parsed, io);
    }
    case 'help':
      // Intercepted in main before a connection is opened.
      return 0;
    default: {
      const exhaustive: never = parsed;
      throw new Error(`unhandled command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A slot's state, for `fo chats --live`. */
function slotState(slot: ChatSlotInfo): string {
  const parts: string[] = [];
  if (slot.busy) parts.push('busy');
  if (slot.attention) parts.push('needs attention');
  if (slot.crew) parts.push(slot.crewPending ? 'crew from next session' : 'crew');
  if (slot.subagentsLeftRunning > 0) {
    parts.push(`${slot.subagentsLeftRunning} ${slot.subagentsLeftRunning === 1 ? 'subagent' : 'subagents'} left running`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'idle';
}

/**
 * Decision 12, limit 2: no unattended Claude turns. A send into a Claude
 * chat must name it with `--chat` (even `main`) and come from an
 * interactive terminal, so no script, pipe or cron can spend the owner's
 * Claude plan or key. Enforced here: the sidecar cannot see the caller's terminal.
 * Null when the send may go ahead (any pi chat may be sent to from anywhere).
 */
async function claudeSendRefusal(
  client: FoClient,
  chat: ChatTarget,
  io: FoIo,
  timeoutMs: number,
): Promise<string | null> {
  const slots = await client.call('chat.slots', {}, timeoutMs);
  const slot = slots.find((candidate) => candidate.chatId === chat.chatId);
  // An unknown chat is the sidecar's to refuse (chat_not_found).
  if (slot?.kind !== 'claude-code') return null;
  if (!chat.explicit) {
    return `chat ${chat.chatId} is a Claude chat: sending into one needs an explicit --chat ${chat.chatId} (it spends your Claude plan or key)`;
  }
  if (io.stdinIsTTY !== true) {
    return `chat ${chat.chatId} is a Claude chat: fo sends into one only from an interactive terminal, never from a script or a pipe`;
  }
  return null;
}

/** Read all of `io.stdin`, whatever shape the caller handed over. */
async function readStdin(stdin: Readable | string): Promise<string> {
  if (typeof stdin === 'string') return stdin;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `fo send`: one streamed turn. Text to stdout, notes to stderr, NDJSON with --json. */
async function runSend(
  client: FoClient,
  parsed: Extract<Command, { kind: 'send' }>,
  io: FoIo,
): Promise<number> {
  const controller = new AbortController();

  let jsonEndWritten = false;
  // Reply text carries no newline of its own; on a terminal the trailing
  // context share would land on its line, so a note there ends it first.
  let replyLineOpen = false;
  let replyLineEnded = false;
  const writeJsonEnd = (error?: WireError): void => {
    if (!parsed.json || jsonEndWritten) return;
    jsonEndWritten = true;
    io.stdout.write(
      error === undefined
        ? '{"kind":"end"}\n'
        : `${JSON.stringify({ kind: 'end', error })}\n`,
    );
  };
  const withCleanup = (code: number): number => {
    if (graceTimeout !== undefined) clearTimeout(graceTimeout);
    removeInjected();
    removeSigint();
    if (parsed.json && code === 130) {
      writeJsonEnd({ message: 'interrupted', code: 'interrupted' });
    } else if (!parsed.json && !replyLineEnded) {
      io.stdout.write('\n');
    }
    return code;
  };

  // Interruption: an injected signal wins; otherwise catch SIGINT for this
  // run. All of this must be in place *before* stdin is read: `send -` can be
  // interrupted while still waiting for the pipe to close.
  let removeInjected = (): void => undefined;
  let removeSigint = (): void => undefined;
  if (io.signal) {
    const forward = (): void => {
      controller.abort();
    };
    io.signal.addEventListener('abort', forward, { once: true });
    removeInjected = () => {
      io.signal?.removeEventListener('abort', forward);
    };
    if (io.signal.aborted) controller.abort();
  } else {
    const onSigint = (): void => {
      controller.abort();
    };
    process.on('SIGINT', onSigint);
    removeSigint = () => {
      process.off('SIGINT', onSigint);
    };
  }

  // Two seconds after an abort, stop waiting — whether that wait is for the
  // stdin read, the server's stream-end, or a stream that never started.
  let graceTimeout: NodeJS.Timeout | undefined;
  let graceResolve: (value: 'grace') => void = () => undefined;
  const gracePromise = new Promise<'grace'>((resolve) => {
    graceResolve = resolve;
  });
  const onAbortGrace = (): void => {
    graceTimeout = setTimeout(() => graceResolve('grace'), INTERRUPT_GRACE_MS);
  };
  if (controller.signal.aborted) onAbortGrace();
  else controller.signal.addEventListener('abort', onAbortGrace, { once: true });

  let text: string;
  if (parsed.text === '-') {
    const readPromise = readStdin(io.stdin);
    let stdinOutcome: 'text' | 'grace';
    try {
      stdinOutcome = await Promise.race([readPromise.then(() => 'text' as const), gracePromise]);
    } catch (e) {
      io.stderr.write(`cannot read stdin: ${e instanceof Error ? e.message : String(e)}\n`);
      return withCleanup(2);
    }
    if (stdinOutcome === 'grace') {
      // Release the pipe so the process can exit; the abandoned read must not
      // surface as an unhandled rejection.
      if (typeof io.stdin !== 'string') void io.stdin.destroy();
      readPromise.catch(() => undefined);
      return withCleanup(130);
    }
    text = await readPromise;
  } else {
    text = parsed.text;
  }

  const params: ChatSendParams = { chatId: parsed.chat.chatId, text, clientId: CLIENT_ID };
  if (parsed.model) {
    params.provider = parsed.model.provider;
    params.model = parsed.model.id;
  }
  if (parsed.effort !== undefined) {
    params.effort = parsed.effort;
  }

  const onChunk = (chunk: unknown): void => {
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(chunk)}\n`);
      return;
    }
    const rendered = chunk as ChatChunk;
    if (rendered.kind === 'usage' && replyLineOpen) {
      io.stdout.write('\n');
      replyLineOpen = false;
      replyLineEnded = true;
    }
    renderChatChunk(rendered, parsed.thinking, io.stdout, io.stderr);
    if (rendered.kind === 'text' && rendered.delta) {
      replyLineOpen = !rendered.delta.endsWith('\n');
      replyLineEnded = false;
    }
  };

  const streamDone = client.stream('chat.send', params, onChunk, controller.signal);

  try {
    let outcome: 'ended' | 'grace';
    try {
      outcome = await Promise.race([
        streamDone.then(() => 'ended' as const),
        gracePromise,
      ]);
    } catch (e) {
      if (controller.signal.aborted) return withCleanup(130);
      if (e instanceof SidecarUnreachable) {
        // The connection itself died mid-turn: the same story as any other
        // unreachable sidecar, not a wire error from the seam.
        io.stderr.write(`${e.message}\n`);
        return withCleanup(3);
      }
      const error = toWireError(e);
      if (parsed.json) {
        writeJsonEnd(error);
      } else {
        io.stderr.write(
          `error: ${error.message}${error.code === undefined ? '' : ` (${error.code})`}\n`,
        );
      }
      return withCleanup(1);
    }
    if (outcome === 'grace') {
      client.close();
      return withCleanup(130);
    }
    if (controller.signal.aborted) return withCleanup(130);
    writeJsonEnd();
    return withCleanup(0);
  } catch (e) {
    withCleanup(1);
    throw e;
  }
}

function toWireError(e: unknown): WireError {
  if (e instanceof WireCallError) {
    return e.code === undefined ? { message: e.message } : { message: e.message, code: e.code };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

// --- help and entry point ---

const HELP = `fo — drive the FunkyOctopus sidecar from a shell

Usage: fo <command> [args] [--chat <id>] [--json] [--timeout <seconds>]

Chat commands act on one chat slot (a tab): --chat <id>, main by default.

Commands:
  health                     sidecar liveness: version, uptime, backend states
  call <method> [params]     invoke any wire method; params is a JSON object
  projects                   list the global root, known projects and folders
  chats [--root <path>|--global]  list stored chats (global root when no flag)
  chats --live               list the open chat slots: engine, state, session
  chat current               show the session a chat is on
  chat new                   start a new conversation in a chat
  chat open <session-path>   reopen a stored session (or say which chat has it)
  chat root <path|global>    re-root future turns (global = no project)
  chat create --engine pi|claude-code [--root <dir>]  open a new chat slot
  chat close <id> [--force]  close a chat slot (refused mid-turn unless --force)
  send <text…>               stream one chat turn; into a Claude chat only
                             with an explicit --chat and from a terminal
  models                     list selectable chat models, every engine's
  helmraiser                 print the helmraiser status ledger as JSON
  vault approve <id>         approve a pending approval request
  vault deny <id>            deny a pending approval request

Options:
  --chat <id>         the chat slot to act on (default main)
  --json              machine-readable output (NDJSON for send)
  --timeout <seconds> call budget in seconds (default 30; streams never time out)
  --model <p/id>      per-message model for send
  --effort <level>    per-message thinking effort for send
  --thinking          include thinking deltas on stderr for send
  --help              this help

Exit codes: 0 ok · 1 wire error · 2 usage · 3 sidecar unreachable ·
124 timeout · 130 interrupted.
`;

export async function main(argv: readonly string[], io: FoIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseCommand(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr.write(`${e.message} (run fo --help)\n`);
    return 2;
  }
  const { command, timeoutMs } = parsed;
  if (command.kind === 'help') {
    io.stdout.write(HELP);
    return 0;
  }
  const json = command.json;

  let client: FoClient;
  try {
    client = await FoClient.connect(io.url);
  } catch (e) {
    if (e instanceof SidecarUnreachable) {
      io.stderr.write(`${e.message}\n`);
      return 3;
    }
    throw e;
  }
  try {
    return await dispatch(client, command, io, timeoutMs);
  } catch (e) {
    if (e instanceof WireCallError) {
      if (json) io.stdout.write(wireErrorJson(e));
      else io.stderr.write(`${wireErrorText(e)}\n`);
      return 1;
    }
    if (e instanceof SidecarUnreachable) {
      io.stderr.write(`${e.message}\n`);
      return 3;
    }
    if (e instanceof CallTimeoutError) {
      io.stderr.write(`${e.message}\n`);
      return 124;
    }
    throw e;
  } finally {
    client.close();
  }
}

/** Human wire-error line: `error: <message>` plus ` (<code>)` when a code exists. */
function wireErrorText(e: WireCallError): string {
  return e.code === undefined ? `error: ${e.message}` : `error: ${e.message} (${e.code})`;
}

/** JSON wire-error envelope, compact, one object, optional code. */
function wireErrorJson(e: WireCallError): string {
  const error: WireError =
    e.code === undefined ? { message: e.message } : { message: e.message, code: e.code };
  return `${JSON.stringify({ error })}\n`;
}

// Direct execution: run main and reflect the exit code; process.exit() only on EPIPE.
const isDirect =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirect) {
  // A closed reader (`fo chats | head`) is a normal end of output, not a crash.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  void main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY,
    url: urlFromEnv(process.env),
  }).then((code) => {
    process.exitCode = code;
  });
}
