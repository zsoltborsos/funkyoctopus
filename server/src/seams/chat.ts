import { realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { guardedSessionPath } from '../pi/session-file.ts';
import type { MethodRegistry } from '../transport/registry.ts';
import type { ChatSlots, SlotEvent } from '../chat-registry.ts';
import type { ClaudeSessionStore } from '../claude-code/sessions.ts';
import { AsyncQueue } from '../util/async-queue.ts';
import { config } from '../config.ts';
import { discoverProjects, expandHome } from '../projects/project-discovery.ts';
import { knownProjects } from '../projects/registry.ts';
import { defaultLbRunner, type LbCliRunner } from '../leeboard/cli.ts';
import type {
  ChatCloseParams,
  ChatCompactParams,
  ChatCreateParams,
  ChatExistsParams,
  ChatImageAttachment,
  ChatListParams,
  ChatNewParams,
  ChatObserveParams,
  ChatOpenParams,
  ChatRenameParams,
  ChatSendParams,
  ChatSetRootParams,
  ChatSlotInfo,
  ChatSlotsEvent,
  ProjectResolveParams,
  VaultResolveParams,
} from '../../../src/shared/transport/protocol.ts';
import {
  CHAT_IMAGE_LIMITS,
  sessionRefOf,
  type ChatOpenResult,
  type SessionRef,
} from '../../../src/shared/transport/protocol.ts';
import { sessionIdFromHeader } from '../pi/session-index.ts';
import { BAD_SESSION_PATH, FOLDER_NOT_FOUND, WireCallError } from '../../../src/shared/transport/errors.ts';

/**
 * Narrow composer attachments at the wire boundary. Bounds are sanity limits,
 * not provider limits — a malformed or oversized payload must fail here with a
 * message the browser can show, rather than deep inside a provider call.
 */
function parseImages(raw: unknown): ChatImageAttachment[] {
  if (!Array.isArray(raw)) throw new Error('chat.send images: must be an array');
  if (raw.length > CHAT_IMAGE_LIMITS.count) {
    throw new Error(`chat.send images: at most ${CHAT_IMAGE_LIMITS.count} images`);
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`chat.send images[${index}]: must be an object`);
    }
    const { mimeType, data } = item as Record<string, unknown>;
    if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
      throw new Error(`chat.send images[${index}]: mimeType must be image/*`);
    }
    if (typeof data !== 'string' || !data) {
      throw new Error(`chat.send images[${index}]: data must be a non-empty base64 string`);
    }
    if (data.length > CHAT_IMAGE_LIMITS.base64Length) {
      throw new Error(
        `chat.send images[${index}]: data exceeds ${CHAT_IMAGE_LIMITS.base64Length} base64 characters`,
      );
    }
    return { mimeType, data };
  });
}

/**
 * The slot a chat call acts on. Required on every one: the browser, the CLI and
 * the sidecar ship together, so there is no default on the wire. An id that
 * names no slot is refused by the registry (`chat_not_found`).
 */
export function parseChatId(method: string, params: unknown): string {
  const chatId = typeof params === 'object' && params !== null ? (params as Record<string, unknown>).chatId : undefined;
  if (typeof chatId === 'string' && chatId) return chatId;
  throw new Error(`${method} requires { chatId: string }`);
}

function parseSendParams(params: unknown): ChatSendParams {
  const chatId = parseChatId('chat.send', params);
  if (typeof params === 'object' && params !== null) {
    const { text, provider, model, effort, images } = params as Record<string, unknown>;
    if (typeof text === 'string') {
      // Only set optional keys when present, to satisfy exactOptionalPropertyTypes.
      const parsed: ChatSendParams = { chatId, text };
      if (typeof provider === 'string') {
        parsed.provider = provider;
      }
      if (typeof model === 'string') {
        parsed.model = model;
      }
      if (typeof effort === 'string') {
        parsed.effort = effort;
      }
      if (images !== undefined) {
        const attachments = parseImages(images);
        if (attachments.length > 0) parsed.images = attachments;
      }
      const clientId = parseClientId('chat.send', (params as Record<string, unknown>).clientId);
      if (clientId !== null) parsed.clientId = clientId;
      return parsed;
    }
  }
  throw new Error('chat.send requires { text: string }');
}

/**
 * Narrow the optional client id at the wire boundary. Missing stays null (an
 * unclaimed origin); any non-string value is rejected before PiChat runs.
 */
function parseClientId(method: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  throw new Error(`${method}: clientId must be a string`);
}

function parseSetRoot(params: unknown): ChatSetRootParams {
  const chatId = parseChatId('chat.setRoot', params);
  if (typeof params === 'object' && params !== null && 'path' in params) {
    const path = (params as Record<string, unknown>).path;
    if (typeof path === 'string' || path === null) {
      const parsed: ChatSetRootParams = { chatId, path };
      const clientId = parseClientId('chat.setRoot', (params as Record<string, unknown>).clientId);
      if (clientId !== null) parsed.clientId = clientId;
      return parsed;
    }
  }
  throw new Error('chat.setRoot requires { path: string | null }');
}

function parseOpen(params: unknown): ChatOpenParams {
  const chatId = parseChatId('chat.open', params);
  if (typeof params === 'object' && params !== null) {
    const path = (params as Record<string, unknown>).path;
    if (typeof path === 'string' && path) {
      const parsed: ChatOpenParams = { chatId, path };
      const clientId = parseClientId('chat.open', (params as Record<string, unknown>).clientId);
      if (clientId !== null) parsed.clientId = clientId;
      return parsed;
    }
  }
  throw new Error('chat.open requires { path: string }');
}

function parseExists(params: unknown): ChatExistsParams {
  const chatId = parseChatId('chat.exists', params);
  if (typeof params === 'object' && params !== null) {
    const path = (params as Record<string, unknown>).path;
    if (typeof path === 'string' && path) return { chatId, path };
  }
  throw new Error('chat.exists requires { path: string }');
}

function parseNew(params: unknown): ChatNewParams {
  const chatId = parseChatId('chat.new', params);
  if (typeof params === 'object' && params !== null) {
    const parsed: ChatNewParams = { chatId };
    const clientId = parseClientId('chat.new', (params as Record<string, unknown>).clientId);
    if (clientId !== null) parsed.clientId = clientId;
    return parsed;
  }
  throw new Error('chat.new requires an object of params');
}

function parseObserve(params: unknown): ChatObserveParams {
  const chatId = parseChatId('chat.observe', params);
  if (typeof params === 'object' && params !== null) {
    const parsed: ChatObserveParams = { chatId };
    const clientId = parseClientId('chat.observe', (params as Record<string, unknown>).clientId);
    if (clientId !== null) parsed.clientId = clientId;
    return parsed;
  }
  throw new Error('chat.observe requires an object of params');
}

function parseList(params: unknown): ChatListParams {
  const chatId = parseChatId('chat.list', params);
  if (typeof params === 'object' && params !== null && 'root' in params) {
    const root = (params as Record<string, unknown>).root;
    if (typeof root === 'string' || root === null) return { chatId, root };
  }
  throw new Error('chat.list requires { root: string | null }');
}

function parseCreate(params: unknown): ChatCreateParams {
  if (typeof params === 'object' && params !== null) {
    const { kind, root } = params as Record<string, unknown>;
    if ((kind === 'pi' || kind === 'claude-code') && (typeof root === 'string' || root === null)) {
      const parsed: ChatCreateParams = { kind, root };
      const clientId = parseClientId('chat.create', (params as Record<string, unknown>).clientId);
      if (clientId !== null) parsed.clientId = clientId;
      return parsed;
    }
  }
  throw new Error('chat.create requires { kind: "pi" | "claude-code", root: string | null }');
}

function parseClose(params: unknown): ChatCloseParams {
  const chatId = parseChatId('chat.close', params);
  const { force } = params as Record<string, unknown>;
  if (force !== undefined && typeof force !== 'boolean') throw new Error('chat.close: force must be a boolean');
  const parsed: ChatCloseParams = { chatId };
  if (force === true) parsed.force = true;
  const clientId = parseClientId('chat.close', (params as Record<string, unknown>).clientId);
  if (clientId !== null) parsed.clientId = clientId;
  return parsed;
}

function parseCompact(params: unknown): ChatCompactParams {
  const chatId = parseChatId('chat.compact', params);
  const { instructions } = params as Record<string, unknown>;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('chat.compact: instructions must be a string');
  }
  const parsed: ChatCompactParams = { chatId };
  if (typeof instructions === 'string' && instructions.trim()) parsed.instructions = instructions.trim();
  const clientId = parseClientId('chat.compact', (params as Record<string, unknown>).clientId);
  if (clientId !== null) parsed.clientId = clientId;
  return parsed;
}

function parseRename(params: unknown): ChatRenameParams {
  const chatId = parseChatId('chat.rename', params);
  const { name } = params as Record<string, unknown>;
  if (typeof name === 'string' && name.trim()) return { chatId, name: name.trim() };
  throw new Error('chat.rename requires { name: string } (not empty)');
}

/**
 * The `chat.slotsObserve` stream: one snapshot of every slot first, then slots
 * created and closed (with the acting client) and slot-state changes. A state
 * is sent only when it differs from the last one this subscriber got, leaving
 * `lastUsedAt` out (every read of a slot's engine moves it); it is re-read on
 * every registry event and every `pollMs`, which catches what has no event of
 * its own (a crew subagent finishing in a session left behind).
 */
async function* observeSlots(chats: ChatSlots, signal: AbortSignal, pollMs: number): AsyncIterable<ChatSlotsEvent> {
  const queue = new AsyncQueue<ChatSlotsEvent>();
  const last = new Map<string, string>();
  const keyOf = ({ lastUsedAt: _lastUsedAt, ...state }: ChatSlotInfo): string => JSON.stringify(state);
  const state = (slot: ChatSlotInfo): void => {
    const key = keyOf(slot);
    if (last.get(slot.chatId) === key) return;
    last.set(slot.chatId, key);
    queue.push({ kind: 'slot-state', slot });
  };
  const sweep = (): void => {
    for (const slot of chats.list()) state(slot);
  };
  const onEvent = (event: SlotEvent): void => {
    if (event.type === 'created') {
      const slot = chats.list().find((row) => row.chatId === event.chatId);
      if (!slot) return;
      last.set(slot.chatId, keyOf(slot));
      queue.push({ kind: 'slot-created', slot, origin: event.origin });
    } else if (event.type === 'closed') {
      last.delete(event.chatId);
      queue.push({ kind: 'slot-closed', chatId: event.chatId, origin: event.origin });
    } else {
      const slot = chats.list().find((row) => row.chatId === event.chatId);
      if (slot) state(slot);
    }
  };
  const stopEvents = chats.onSlots(onEvent);
  const timer = setInterval(sweep, pollMs);
  timer.unref();
  const onAbort = (): void => queue.close();
  if (signal.aborted) queue.close();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const slots = chats.list();
    for (const slot of slots) last.set(slot.chatId, keyOf(slot));
    queue.push({ kind: 'slots', slots });
    yield* queue;
  } finally {
    stopEvents();
    clearInterval(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function parseResolve(params: unknown): ProjectResolveParams {
  if (typeof params === 'object' && params !== null) {
    const path = (params as Record<string, unknown>).path;
    if (typeof path === 'string' && path) return { path };
  }
  throw new Error('projects.resolve requires { path: string }');
}

function parseVaultResolve(params: unknown): VaultResolveParams {
  if (typeof params === 'object' && params !== null) {
    const { requestId, approved } = params as Record<string, unknown>;
    if (typeof requestId === 'string' && typeof approved === 'boolean') {
      return { requestId, approved };
    }
  }
  throw new Error('vault.resolve requires { requestId: string, approved: boolean }');
}

/**
 * Registers the chat-orchestrator seam over the chat slots: every chat call
 * names its slot (`chatId`), and the slots themselves are listed, created,
 * closed and observed here. The Leeboard runner is injectable so tests can
 * stand in a fake `lb` CLI; `claudeSessions` answers `chat.exists` for Claude
 * Code sessions.
 */
export function registerChatSeam(
  registry: MethodRegistry,
  chats: ChatSlots,
  run: LbCliRunner = defaultLbRunner,
  sessionRoot: string = join(getAgentDir(), 'sessions'),
  claudeSessions?: Pick<ClaudeSessionStore, 'info'>,
  slotsPollMs = 5_000,
): void {
  registry.stream('chat.send', (params, ctx) => {
    const parsed = parseSendParams(params);
    return chats.engine(parsed.chatId).send(parsed.text, ctx.signal, parsed, parsed.clientId ?? null);
  });
  // Observation-only stream of one slot's custom and shared-session control
  // events; the browser subscribes once per open chat and re-subscribes on
  // load/reconnect.
  registry.stream('chat.observe', (params, ctx) => {
    const parsed = parseObserve(params);
    return chats.engine(parsed.chatId).observe(ctx.signal, parsed.clientId ?? null);
  });
  registry.stream('chat.slotsObserve', (_params, ctx) => observeSlots(chats, ctx.signal, slotsPollMs));
  // Returns the resumed transcript, not an acknowledgement: re-rooting now
  // switches to that root's most recent chat instead of ending the current one.
  registry.call('chat.setRoot', (params) => {
    const parsed = parseSetRoot(params);
    return chats.engine(parsed.chatId).setRoot(parsed.path, parsed.clientId ?? null);
  });
  registry.call('chat.new', (params) => {
    const parsed = parseNew(params);
    return chats.engine(parsed.chatId).newChat(parsed.clientId ?? null);
  });
  // One holder per engine session: a session another slot holds is not opened
  // twice; the caller is told which slot has it. A pi session file must lie
  // inside pi's session store (owner, 2026-10-19): the canonical path the guard
  // returns is what is opened. Claude Code handles are ids, not paths.
  registry.call('chat.open', (params) => {
    const parsed = parseOpen(params);
    const origin = parsed.clientId ?? null;
    const open = (ref: SessionRef | null, path: string): Promise<ChatOpenResult> => {
      if (!ref) {
        // Neither the path nor the file names a session the index can key:
        // opened as before, unclaimed.
        return chats.engine(parsed.chatId).openChat(path, origin).then((items) => ({ items }));
      }
      return chats
        .openFor(parsed.chatId, ref, path, origin)
        .then((result) => ('heldBy' in result ? { heldBy: result.heldBy } : { items: result.items }));
    };
    const handle = sessionRefOf(parsed.path);
    if (handle?.engine === 'claude-code') return open(handle, parsed.path);
    chats.engine(parsed.chatId);
    return guardedSessionPath(parsed.path, sessionRoot).then(
      (path) => {
        const ref = sessionRefOf(path);
        if (ref) return open(ref, path);
        // A pi session file whose name does not carry its id (renamed): its
        // header line does.
        return sessionIdFromHeader(path).then((id) => open(id === null ? null : { engine: 'pi', id }, path));
      },
      () => {
        throw new WireCallError(
          `cannot open ${parsed.path}: not a session file inside pi's session store`,
          BAD_SESSION_PATH,
        );
      },
    );
  });
  // Read-only existence of a session, for reviewing work in its originating
  // chat: a pi session file inside the store, or a Claude Code session the
  // sessions seam knows.
  registry.call('chat.exists', (params) => {
    const { chatId, path } = parseExists(params);
    chats.engine(chatId);
    const ref = sessionRefOf(path);
    if (ref?.engine === 'claude-code') {
      if (!claudeSessions) return Promise.resolve({ exists: false });
      return claudeSessions.info(ref.id).then(
        (row) => ({ exists: row !== undefined && row !== null }),
        () => ({ exists: false }),
      );
    }
    return guardedSessionPath(path, sessionRoot).then(
      () => ({ exists: true }),
      () => ({ exists: false }),
    );
  });
  // Non-constructing readback of the live session, for followers of another
  // client's switch or turn; empty when nothing is live.
  registry.call('chat.transcript', (params) => chats.engine(parseChatId('chat.transcript', params)).transcript());
  registry.call('chat.list', (params) => {
    const parsed = parseList(params);
    return chats.engine(parsed.chatId).listChats(parsed.root);
  });
  registry.call('chat.current', (params) => chats.engine(parseChatId('chat.current', params)).current());
  // The `/` palette (T2.4b): what the slot's engine offers. A Claude slot with
  // no process answers its last-known list; nothing is started to ask.
  registry.call('chat.commands', (params) => chats.engine(parseChatId('chat.commands', params)).commands());
  // FO's own `/compact` and `/rename`, for an engine that has them (pi). A
  // Claude Code slot runs its own, sent as text.
  registry.call('chat.compact', async (params) => {
    const parsed = parseCompact(params);
    const engine = chats.engine(parsed.chatId);
    if (!engine.compact) throw new Error(`${engine.kind} compacts with its own /compact, sent as a message`);
    await engine.compact(parsed.instructions, parsed.clientId ?? null);
    return { compacted: true as const };
  });
  registry.call('chat.rename', (params) => {
    const parsed = parseRename(params);
    const engine = chats.engine(parsed.chatId);
    if (!engine.rename) throw new Error(`${engine.kind} renames with its own /rename, sent as a message`);
    return engine.rename(parsed.name);
  });
  registry.call('chat.slots', () => chats.list());
  registry.call('chat.create', (params) => {
    const parsed = parseCreate(params);
    return chats.create(parsed.kind, parsed.root, parsed.clientId ?? null);
  });
  registry.call('chat.close', async (params) => {
    const parsed = parseClose(params);
    await chats.close(parsed.chatId, { force: parsed.force === true, origin: parsed.clientId ?? null });
    return { closed: true as const };
  });
  // The catalog is sidecar-owned: global root, Leeboard registry and folders
  // under the configured roots — the browser supplies nothing.
  registry.call('projects.discover', async () => {
    const [known, folders] = await Promise.all([
      knownProjects(run),
      discoverProjects([config.primaryWorkspaceRoot, ...config.projectRoots]),
    ]);
    return { globalRoot: expandHome(config.primaryWorkspaceRoot), known, folders };
  });
  // Typed-path open: canonicalise, then answer with an option whose name is the
  // known project's display name when the path is one, else the basename.
  registry.call('projects.resolve', async (params) => {
    const submitted = parseResolve(params).path;
    const canonical = await realpath(expandHome(submitted)).catch(() => {
      throw new WireCallError(`no such folder: ${submitted}`, FOLDER_NOT_FOUND);
    });
    if (!(await stat(canonical).then((s) => s.isDirectory()).catch(() => false))) {
      throw new WireCallError(`not a folder: ${submitted}`, FOLDER_NOT_FOUND);
    }
    const known = await knownProjects(run);
    const match = known.find((project) => project.path === canonical);
    const option = { id: canonical, name: match?.name ?? (basename(canonical) || canonical), path: canonical, envTier: 'normal' } as const;
    return option;
  });
  // Routed by request id, which is unique per tool call: the slot waiting on it
  // answers. No chat id, so `fo vault approve <id>` works from anywhere.
  registry.call('vault.resolve', (params) => {
    const parsed = parseVaultResolve(params);
    return chats.resolveApproval(parsed.requestId, parsed.approved);
  });
}
