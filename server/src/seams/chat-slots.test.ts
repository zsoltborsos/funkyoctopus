/**
 * The session-keyed chat wire (T2.1b), hermetic: the chat seam over a
 * real ChatRegistry, with fake engines for routing and real PiChats on injected
 * sessions (raw host) for concurrent turns. One suite drives a real in-process
 * app over one WebSocket. No model, no `~/.pi`, no `claude`.
 */
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatChunk, ChatSlotsEvent } from '../../../src/shared/transport/protocol.ts';
import { wireErrorCode } from '../../../src/shared/transport/errors.ts';
import { createApp } from '../app.ts';
import { ChatRegistry, MAIN, type EngineFactory } from '../chat-registry.ts';
import type { EngineKind } from '../chat-engine.ts';
import { FoClient } from '../cli/fo-client.ts';
import type { ModelCatalog } from '../pi/model-catalog.ts';
import { PiChat } from '../pi/pi-chat.ts';
import { FakeEngine } from '../test/fake-chat-engine.ts';
import { MethodRegistry } from '../transport/registry.ts';
import { registerChatSeam } from './chat.ts';

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeSlots(mainKind: EngineKind = 'pi') {
  const built: FakeEngine[] = [];
  const factory =
    (kind: EngineKind): EngineFactory =>
    (ctx) => {
      const engine = new FakeEngine(kind, ctx);
      built.push(engine);
      return engine;
    };
  let minted = 0;
  // Every read of the clock moves it on, so a field stamped with it always changes.
  let clock = 0;
  const chats = new ChatRegistry({
    mainKind,
    factories: { pi: factory('pi'), 'claude-code': factory('claude-code') },
    mintId: () => `c${(minted += 1)}`,
    now: () => (clock += 1),
  });
  const engine = (chatId: string): FakeEngine => {
    const found = built.find((candidate) => candidate.ctx.chatId === chatId);
    if (!found) throw new Error(`no engine for ${chatId}`);
    return found;
  };
  return { chats, engine };
}

function wire(
  chats: ChatRegistry,
  claudeSessions?: { info: (id: string) => Promise<unknown> },
  sessionRoot = '/nonexistent-session-root',
) {
  const registry = new MethodRegistry();
  registerChatSeam(registry, chats, undefined, sessionRoot, claudeSessions as never, 20);
  const call = (method: string, params: unknown): Promise<unknown> => {
    const entry = registry.get(method);
    if (!entry || entry.kind !== 'call') throw new Error(`missing call ${method}`);
    return Promise.resolve().then(() => entry.handler(params, { signal: new AbortController().signal }));
  };
  const stream = (method: string, params: unknown, signal = new AbortController().signal): AsyncIterator<unknown> => {
    const entry = registry.get(method);
    if (!entry || entry.kind !== 'stream') throw new Error(`missing stream ${method}`);
    return entry.handler(params, { signal })[Symbol.asyncIterator]();
  };
  return { registry, call, stream };
}

const codeOf = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => wireErrorCode(error),
  );

describe('chat wire: every call names its slot', () => {
  it('routes chat calls to the slot named, and refuses an unknown one as chat_not_found', async () => {
    const { chats, engine } = fakeSlots();
    const { call, stream } = wire(chats);
    const { chatId } = chats.create('pi', null);
    engine(chatId).hold('second');

    expect(await call('chat.current', { chatId: MAIN })).toBeNull();
    expect(await call('chat.current', { chatId })).toMatchObject({ id: 'second', engine: 'pi' });

    expect(await codeOf(call('chat.current', { chatId: 'nope' }))).toBe('chat_not_found');
    expect(() => stream('chat.send', { chatId: 'nope', text: 'hi' })).toThrow(
      expect.objectContaining({ code: 'chat_not_found' }) as Error,
    );
  });

  it('requires the chat id: there is no default on the wire', async () => {
    const { chats } = fakeSlots();
    const { call } = wire(chats);
    await expect(call('chat.current', {})).rejects.toThrow(/chatId/);
  });
});

describe('chat wire: slots', () => {
  it('lists the slots without building, creates a fresh one, and closes it', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);

    const created = (await call('chat.create', { kind: 'claude-code', root: '/w', clientId: 'tab-1' })) as {
      chatId: string;
      kind: string;
    };
    expect(created).toMatchObject({ chatId: 'c1', kind: 'claude-code', busy: false, attention: false });
    expect(engine('c1').ctx).toMatchObject({ fresh: true, root: '/w' });
    expect(((await call('chat.slots', {})) as { chatId: string }[]).map((slot) => slot.chatId)).toEqual([MAIN, 'c1']);

    expect(await call('chat.close', { chatId: 'c1' })).toEqual({ closed: true });
    expect(((await call('chat.slots', {})) as unknown[]).length).toBe(1);
  });

  it('refuses to close main, and a slot mid-turn unless forced', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);
    chats.create('pi', null);
    engine('c1').busyNow = true;

    expect(await codeOf(call('chat.close', { chatId: MAIN, force: true }))).toBe('chat_permanent');
    expect(await codeOf(call('chat.close', { chatId: 'c1' }))).toBe('turn_in_progress');
    expect(await call('chat.close', { chatId: 'c1', force: true })).toEqual({ closed: true });
  });

  it('refuses a malformed create', async () => {
    const { chats } = fakeSlots();
    const { call } = wire(chats);
    await expect(call('chat.create', { kind: 'gpt', root: null })).rejects.toThrow(/kind/);
  });
});

describe('chat wire: slash commands (T2.4b)', () => {
  it('lists the commands of the slot named', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);
    const { chatId } = chats.create('claude-code', null);
    engine(chatId).commandList = { commands: [{ name: 'context', description: '', source: 'claude-builtin', kind: 'text' }], state: 'last-known' };

    expect(await call('chat.commands', { chatId })).toEqual(engine(chatId).commandList);
    expect(await call('chat.commands', { chatId: MAIN })).toEqual({ commands: [], state: 'live' });
    expect(await codeOf(call('chat.commands', { chatId: 'nope' }))).toBe('chat_not_found');
  });

  it('routes compact and rename to an engine that has them, trimmed, with the asking client', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);
    const compact = vi.fn(() => Promise.resolve());
    const rename = vi.fn(() => Promise.resolve(null));
    Object.assign(engine(MAIN), { compact, rename });

    expect(await call('chat.compact', { chatId: MAIN, instructions: '  keep notes ', clientId: 'tab-1' })).toEqual({ compacted: true });
    expect(await call('chat.compact', { chatId: MAIN, instructions: '   ' })).toEqual({ compacted: true });
    expect(compact.mock.calls).toEqual([
      ['keep notes', 'tab-1'],
      [undefined, null],
    ]);
    expect(await call('chat.rename', { chatId: MAIN, name: '  Palette  ' })).toBeNull();
    expect(rename).toHaveBeenCalledWith('Palette');
  });

  it('refuses them for an engine without them (Claude Code runs its own as text), and a malformed ask', async () => {
    const { chats } = fakeSlots();
    const { call } = wire(chats);
    const { chatId } = chats.create('claude-code', null);
    await expect(call('chat.compact', { chatId })).rejects.toThrow(/its own \/compact/);
    await expect(call('chat.rename', { chatId, name: 'x' })).rejects.toThrow(/its own \/rename/);
    await expect(call('chat.rename', { chatId: MAIN, name: '  ' })).rejects.toThrow(/name/);
    await expect(call('chat.compact', { chatId: MAIN, instructions: 7 })).rejects.toThrow(/instructions/);
  });
});

/** A session file as pi writes it: a header line carrying the id. */
const sessionHeader = (id: string): string =>
  `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-18T10:00:00.000Z', cwd: '/w' })}\n`;

describe('chat wire: opening a stored session', () => {
  let scratch = '';
  let store = '';
  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = '';
  });
  /** A temporary pi session store (`<store>/--w--/<file>`) holding these files. */
  const storeWith = async (files: Record<string, string>): Promise<void> => {
    scratch = await mkdtemp(join(tmpdir(), 'fo-open-store-'));
    store = join(scratch, 'sessions');
    await mkdir(join(store, '--w--'), { recursive: true });
    await mkdir(join(scratch, 'elsewhere'));
    for (const [name, text] of Object.entries(files)) await writeFile(join(store, '--w--', name), text);
  };

  it('answers with the holding slot instead of opening it twice', async () => {
    await storeWith({
      '2026-10-18T10-00-00-000Z_held-1.jsonl': sessionHeader('held-1'),
      '2026-10-18T10-00-00-000Z_free-2.jsonl': sessionHeader('free-2'),
    });
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats, undefined, store);
    chats.create('pi', null);
    engine(MAIN).hold('held-1');

    const held = join(store, '--w--', '2026-10-18T10-00-00-000Z_held-1.jsonl');
    expect(await call('chat.open', { chatId: 'c1', path: held })).toEqual({ heldBy: MAIN });
    expect(engine('c1').opened).toEqual([]);

    const free = join(store, '--w--', '2026-10-18T10-00-00-000Z_free-2.jsonl');
    expect(await call('chat.open', { chatId: 'c1', path: free })).toEqual({ items: [] });
    expect(engine('c1').opened).toEqual([await realpath(free)]);
    expect(chats.holder({ engine: 'pi', id: 'free-2' })).toBe('c1');
  });

  it('reads the id from the session header of a renamed file in the store, so a session another slot holds is still not opened twice', async () => {
    await storeWith({ 'renamed copy.jsonl': sessionHeader('held-9') });
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats, undefined, store);
    chats.create('pi', null);
    engine(MAIN).hold('held-9');

    expect(await call('chat.open', { chatId: 'c1', path: join(store, '--w--', 'renamed copy.jsonl') })).toEqual({
      heldBy: MAIN,
    });
    expect(engine('c1').opened).toEqual([]);
  });

  it('opens unclaimed only when the header of a file in the store cannot be read', async () => {
    await storeWith({ 'not a session.jsonl': 'not json\n' });
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats, undefined, store);
    const broken = join(store, '--w--', 'not a session.jsonl');

    expect(await call('chat.open', { chatId: MAIN, path: broken })).toEqual({ items: [] });
    expect(engine(MAIN).opened).toEqual([await realpath(broken)]);
  });

  it('refuses a copied or exported session file outside the store, whatever its header says', async () => {
    await storeWith({});
    const exported = join(scratch, 'elsewhere', 'exported copy.jsonl');
    await writeFile(exported, sessionHeader('held-9'));
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats, undefined, store);
    chats.create('pi', null);
    engine(MAIN).hold('held-9');

    expect(await codeOf(call('chat.open', { chatId: 'c1', path: exported }))).toBe('bad_session_path');
    expect(engine('c1').opened).toEqual([]);
    expect(chats.holder({ engine: 'pi', id: 'held-9' })).toBe(MAIN);
  });

  it('still opens a Claude Code session by its handle, which is an id and not a path in any store', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);
    chats.create('claude-code', null);

    expect(await call('chat.open', { chatId: 'c1', path: 'claude-code:aaaa-1' })).toEqual({ items: [] });
    expect(engine('c1').opened).toEqual(['claude-code:aaaa-1']);
    expect(chats.holder({ engine: 'claude-code', id: 'aaaa-1' })).toBe('c1');
  });
});

describe('chat wire: approvals', () => {
  it('routes vault.resolve by request id to the slot waiting on it, with no chat id', async () => {
    const { chats, engine } = fakeSlots();
    const { call } = wire(chats);
    chats.create('claude-code', null);
    engine('c1').pendingApprovals.add('toolu_1');

    expect(await call('vault.resolve', { requestId: 'toolu_1', approved: true })).toBe(true);
    expect(engine('c1').resolved).toEqual([{ requestId: 'toolu_1', approved: true }]);
    expect(await call('vault.resolve', { requestId: 'toolu_1', approved: true })).toBe(false);
  });
});

describe('chat wire: chat.exists', () => {
  it('answers for a Claude Code session through the sessions seam', async () => {
    const { chats } = fakeSlots();
    const asked: string[] = [];
    const { call } = wire(chats, {
      info: (id) => {
        asked.push(id);
        return Promise.resolve(id === 'aaaa-1' ? { sessionId: id } : undefined);
      },
    });

    expect(await call('chat.exists', { chatId: MAIN, path: 'claude-code:aaaa-1' })).toEqual({ exists: true });
    expect(await call('chat.exists', { chatId: MAIN, path: 'claude-code:bbbb-2' })).toEqual({ exists: false });
    expect(asked).toEqual(['aaaa-1', 'bbbb-2']);
  });
});

describe('chat wire: chat.slotsObserve', () => {
  it('starts with one snapshot of every slot, then reports created, changed and closed, each create and close with its origin', async () => {
    const { chats, engine } = fakeSlots();
    const { call, stream } = wire(chats);
    const stop = new AbortController();
    const events = stream('chat.slotsObserve', {}, stop.signal);
    const next = async (): Promise<ChatSlotsEvent> => (await events.next()).value as ChatSlotsEvent;

    expect(await next()).toMatchObject({ kind: 'slots', slots: [{ chatId: MAIN }] });

    // Reading a slot's engine marks it used; that alone is not a state change.
    chats.engine(MAIN);
    await call('chat.create', { kind: 'pi', root: null, clientId: 'tab-1' });
    expect(await next()).toMatchObject({ kind: 'slot-created', origin: 'tab-1', slot: { chatId: 'c1', kind: 'pi' } });

    await tick();
    engine('c1').busyNow = true;
    engine('c1').broadcast({ kind: 'turn-started', origin: 'tab-1' });
    expect(await next()).toMatchObject({ kind: 'slot-state', slot: { chatId: 'c1', busy: true } });

    // Polled: a count that changes with no event still reaches subscribers.
    engine('c1').busyNow = false;
    engine('c1').left = 2;
    expect(await next()).toMatchObject({ kind: 'slot-state', slot: { chatId: 'c1', busy: false, subagentsLeftRunning: 2 } });

    await call('chat.close', { chatId: 'c1', clientId: 'cli-9' });
    expect(await next()).toEqual({ kind: 'slot-closed', chatId: 'c1', origin: 'cli-9' });
    stop.abort();
    expect((await events.next()).done).toBe(true);
  });
});

/** A scripted pi session whose prompt streams `word` and finishes when told. */
class TurnSession {
  isStreaming = false;
  readonly agent = {};
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  finish: () => void = () => undefined;
  readonly sessionManager;

  constructor(
    id: string,
    private readonly word: string,
  ) {
    this.sessionManager = {
      getSessionFile: () => `/sessions/x_${id}.jsonl`,
      getSessionId: () => id,
      getCwd: () => '/w',
      getSessionName: () => undefined,
      getHeader: () => ({ timestamp: '2026-10-18T10:00:00.000Z' }),
      getEntries: () => [],
      buildContextEntries: () => [],
      getLeafId: () => null,
      isPersisted: () => true,
    };
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  getContextUsage(): undefined {
    return undefined;
  }
  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {}
  /** Ends the run with one text delta: what a scripted prompt says when it is done. */
  finishWith(word: string): void {
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: word } } as never);
    this.isStreaming = false;
    this.emit({ type: 'agent_end', messages: [], willRetry: false } as never);
  }
  prompt(): Promise<void> {
    return new Promise((resolve) => {
      this.isStreaming = true;
      this.emit({ type: 'agent_start' } as never);
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: this.word } } as never);
      this.finish = () => {
        this.isStreaming = false;
        this.emit({ type: 'agent_end', messages: [], willRetry: false } as never);
        resolve();
      };
    });
  }
}

describe('chat wire over one socket, with real pi slots', () => {
  const apps: FastifyInstance[] = [];
  const clients: FoClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const app of apps.splice(0)) await app.close();
  });

  it('streams two slots’ turns concurrently on one socket, each into its own stream, and refuses a close mid-turn', async () => {
    const sessions: TurnSession[] = [];
    let seq = 0;
    const realPi: EngineFactory = (ctx) =>
      new PiChat(
        {} as ModelCatalog,
        () => {
          seq += 1;
          const session = new TurnSession(`s${seq}`, ctx.chatId === MAIN ? 'alpha' : 'bravo');
          sessions.push(session);
          return Promise.resolve(session as unknown as AgentSession);
        },
        () => Promise.resolve({ guard: () => Promise.resolve(undefined) }),
        undefined,
        undefined,
        { projectPaths: () => Promise.resolve([]), recentSessions: () => Promise.resolve([]) },
        { crew: ctx.crew, claim: ctx.claim },
      );
    const chats = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: realPi, 'claude-code': () => { throw new Error('no claude here'); } },
    });
    const { registry } = wire(chats);
    const app = await createApp(registry, []);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = await FoClient.connect(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`);
    clients.push(client);

    const second = await client.call('chat.create', { kind: 'pi', root: null }, 5_000);
    const seenMain: ChatChunk[] = [];
    const seenSecond: ChatChunk[] = [];
    const mainTurn = client.stream('chat.send', { chatId: MAIN, text: 'one' }, (chunk) => seenMain.push(chunk as ChatChunk));
    const secondTurn = client.stream('chat.send', { chatId: second.chatId, text: 'two' }, (chunk) =>
      seenSecond.push(chunk as ChatChunk),
    );
    await expect.poll(() => seenMain.length > 0 && seenSecond.length > 0).toBe(true);

    await expect(client.call('chat.close', { chatId: second.chatId }, 5_000)).rejects.toMatchObject({
      code: 'turn_in_progress',
    });
    const busy = await client.call('chat.slots', {}, 5_000);
    expect(busy.map((slot) => slot.busy)).toEqual([true, true]);

    for (const session of sessions) session.finish();
    await Promise.all([mainTurn, secondTurn]);

    expect(seenMain).toEqual([{ kind: 'text', delta: 'alpha' }]);
    expect(seenSecond).toEqual([{ kind: 'text', delta: 'bravo' }]);
    expect(await client.call('chat.close', { chatId: second.chatId }, 5_000)).toEqual({ closed: true });
    await chats.dispose();
  });

  it('lets a second client answer the approval a first client’s turn is waiting on', async () => {
    let built: PiChat | null = null;
    const realPi: EngineFactory = (ctx) => {
      const chat: PiChat = new PiChat(
        {} as ModelCatalog,
        () => {
          const session = new TurnSession('approve-1', 'asked');
          // The turn calls a tool the Vault escalates, and answers with the verdict.
          session.prompt = function prompt(this: TurnSession): Promise<void> {
            const agent = this.agent as { beforeToolCall?: (context: unknown, signal: AbortSignal) => Promise<unknown> };
            return (async () => {
              this.isStreaming = true;
              const decision = await agent.beforeToolCall?.(
                { toolCall: { id: 'call-9', name: 'bash' }, args: { command: 'deploy' } },
                new AbortController().signal,
              );
              this.finishWith(decision === undefined ? 'allowed' : 'blocked');
            })();
          };
          return Promise.resolve(session as unknown as AgentSession);
        },
        () =>
          Promise.resolve({
            guard: async (callId: string, tool: string, args: unknown, signal?: AbortSignal) => {
              const broker = (chat as unknown as {
                approvals: { request: (r: unknown, s?: AbortSignal) => Promise<boolean> };
              }).approvals;
              return (await broker.request({ callId, tool, target: '/srv/prod', args }, signal))
                ? undefined
                : { block: true as const, reason: 'denied' };
            },
          }),
        undefined,
        undefined,
        { projectPaths: () => Promise.resolve([]), recentSessions: () => Promise.resolve([]) },
        { crew: ctx.crew, claim: ctx.claim },
      );
      built = chat;
      return chat;
    };
    const chats = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: realPi, 'claude-code': () => { throw new Error('no claude here'); } },
    });
    expect(built).not.toBeNull();
    const { registry } = wire(chats);
    const app = await createApp(registry, []);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const first = await FoClient.connect(url);
    const second = await FoClient.connect(url);
    clients.push(first, second);

    const watching = new AbortController();
    const seenBySecond: ChatChunk[] = [];
    const observing = second
      .stream('chat.observe', { chatId: MAIN, clientId: 'tab-2' }, (chunk) => seenBySecond.push(chunk as ChatChunk), watching.signal)
      .catch(() => undefined);
    const firstTurn: ChatChunk[] = [];
    const turn = first.stream('chat.send', { chatId: MAIN, text: 'deploy', clientId: 'tab-1' }, (chunk) =>
      firstTurn.push(chunk as ChatChunk),
    );

    await expect
      .poll(() => seenBySecond.find((chunk) => chunk.kind === 'approval-request'))
      .toMatchObject({ callId: 'call-9', target: '/srv/prod', origin: 'tab-1' });
    const asked = seenBySecond.find((chunk) => chunk.kind === 'approval-request');
    const requestId = asked?.kind === 'approval-request' ? asked.requestId : '';
    expect(await second.call('vault.resolve', { requestId, approved: true }, 5_000)).toBe(true);
    await turn;

    expect(firstTurn.filter((chunk) => chunk.kind === 'approval-request')).toHaveLength(1);
    expect(firstTurn.at(-1)).toEqual({ kind: 'text', delta: 'allowed' });
    watching.abort();
    await observing;
    await chats.dispose();
  });
});
