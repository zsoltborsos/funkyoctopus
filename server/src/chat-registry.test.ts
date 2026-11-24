/**
 * The chat-slot registry (T2.1a), hermetic: fake engines for the slot rules,
 * and real PiChats on injected sessions (raw host, temp session dirs) for the
 * holder index driving pi's continue-recent. No model, no `~/.pi`, no `claude`.
 */
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { wireErrorCode } from '../../src/shared/transport/errors.ts';
import type { EngineKind } from './chat-engine.ts';
import { FakeEngine } from './test/fake-chat-engine.ts';
import { ChatRegistry, MAIN, type EngineFactory, type SlotEvent } from './chat-registry.ts';
import type { ModelCatalog } from './pi/model-catalog.ts';
import { PiChat } from './pi/pi-chat.ts';
import type { SlotRecord } from './chat-slots-file.ts';
import { harness } from './test/claude-chat-harness.ts';


function fakes(
  mainKind: EngineKind = 'pi',
  options: { maxSlots?: number; maxClaudeRunning?: number; restored?: SlotRecord[] } = {},
) {
  const built: FakeEngine[] = [];
  const factory =
    (kind: EngineKind): EngineFactory =>
    (ctx) => {
      const engine = new FakeEngine(kind, ctx);
      built.push(engine);
      return engine;
    };
  let at = 1_000;
  let minted = 0;
  const registry = new ChatRegistry({
    mainKind,
    factories: { pi: factory('pi'), 'claude-code': factory('claude-code') },
    now: () => at,
    mintId: () => `c${(minted += 1)}`,
    ...options,
  });
  const engine = (chatId: string): FakeEngine => {
    const found = built.find((candidate) => candidate.ctx.chatId === chatId);
    if (!found) throw new Error(`no engine for ${chatId}`);
    return found;
  };
  return { registry, built, engine, tick: (ms: number) => (at += ms) };
}

/** Lets the registry's watch of each engine's observe stream catch up. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => wireErrorCode(error),
  );

const codeOfSync = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return wireErrorCode(error);
  }
};

describe('ChatRegistry slots', () => {
  it('always has a main slot of the configured engine, continuing rather than fresh', () => {
    const { registry, engine } = fakes('claude-code');
    const main = engine(MAIN);
    expect(main.kind).toBe('claude-code');
    expect(main.ctx).toMatchObject({ chatId: MAIN, fresh: false, root: null });
    expect(registry.engine()).toBe(main);
    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN]);
  });

  it('creates a fresh slot at the root asked for, under a short minted id', () => {
    const { registry, engine } = fakes();
    const slot = registry.create('claude-code', '/home/example/project');
    expect(slot.chatId).toBe('c1');
    expect(slot.kind).toBe('claude-code');
    expect(engine('c1').ctx).toMatchObject({ fresh: true, root: '/home/example/project' });
    expect(registry.list().map((row) => row.chatId)).toEqual([MAIN, 'c1']);
  });

  it('mints short random ids by default, never main', () => {
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: (ctx) => new FakeEngine('pi', ctx), 'claude-code': (ctx) => new FakeEngine('claude-code', ctx) },
    });
    const ids = [registry.create('pi', null).chatId, registry.create('pi', null).chatId];
    expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it('lists what each slot holds without building anything', () => {
    const { registry, engine, tick } = fakes();
    registry.create('pi', null);
    engine('c1').hold('abc');
    engine('c1').busyNow = true;
    engine('c1').left = 2;
    tick(50);

    const rows = registry.list();

    expect(rows[1]).toEqual({
      chatId: 'c1',
      kind: 'pi',
      createdAt: 1_000,
      lastUsedAt: 1_000,
      crew: false,
      crewPending: false,
      attention: false,
      busy: true,
      session: expect.objectContaining({ id: 'abc' }) as unknown,
      root: null,
      subagentsLeftRunning: 2,
    });
    expect(rows[0]).toMatchObject({ chatId: MAIN, session: null, busy: false });
  });

  it('marks a slot used whenever its engine is resolved', () => {
    const { registry, tick } = fakes();
    registry.create('pi', null);
    tick(500);
    registry.engine('c1');
    expect(registry.list()[1]?.lastUsedAt).toBe(1_500);
    expect(codeOfSync(() => registry.engine('nope'))).toBe('chat_not_found');
  });

  it('refuses a slot past the cap, main included', () => {
    const { registry } = fakes('pi', { maxSlots: 3 });
    registry.create('pi', null);
    registry.create('claude-code', null);
    expect(codeOfSync(() => registry.create('pi', null))).toBe('chat_cap_reached');
    expect(registry.list()).toHaveLength(3);
  });
});

describe('ChatRegistry close', () => {
  it('never closes main', async () => {
    const { registry, engine } = fakes();
    expect(await codeOf(registry.close(MAIN))).toBe('chat_permanent');
    expect(await codeOf(registry.close(MAIN, { force: true }))).toBe('chat_permanent');
    expect(engine(MAIN).disposed).toBe(0);
  });

  it('refuses a slot whose turn is live unless forced, then disposes it and forgets it', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine('c1').busyNow = true;

    expect(await codeOf(registry.close('c1'))).toBe('turn_in_progress');
    expect(engine('c1').disposed).toBe(0);

    await registry.close('c1', { force: true });
    expect(engine('c1').disposed).toBe(1);
    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN]);
    expect(await codeOf(registry.close('c1'))).toBe('chat_not_found');
  });

  it('frees the slot’s place under the cap', async () => {
    const { registry } = fakes('pi', { maxSlots: 2 });
    registry.create('pi', null);
    await registry.close('c1');
    expect(registry.create('pi', null).chatId).toBe('c2');
  });

  it('tells slot listeners what was created and closed, and by whom', async () => {
    const { registry } = fakes();
    const events: SlotEvent[] = [];
    registry.onSlots((event) => events.push(event));
    registry.create('claude-code', null, 'tab-1');
    await registry.close('c1', { origin: 'cli-2' });
    expect(events).toEqual([
      { type: 'created', chatId: 'c1', kind: 'claude-code', origin: 'tab-1' },
      { type: 'closed', chatId: 'c1', kind: 'claude-code', origin: 'cli-2' },
    ]);
  });

  it('tells slot listeners a slot changed when its engine broadcasts a turn or a switch', async () => {
    const { registry, engine } = fakes();
    const events: SlotEvent[] = [];
    registry.onSlots((event) => events.push(event));
    await tick();

    engine(MAIN).broadcast({ kind: 'turn-started', origin: 'tab-1' });
    engine(MAIN).broadcast({ kind: 'text', delta: 'not a state change' });
    engine(MAIN).broadcast({ kind: 'turn-ended', origin: 'tab-1' });
    engine(MAIN).broadcast({ kind: 'session-changed', origin: null, session: null });
    await tick();

    expect(events).toEqual([
      { type: 'changed', chatId: MAIN },
      { type: 'changed', chatId: MAIN },
      { type: 'changed', chatId: MAIN },
    ]);
  });

  it('disposes every slot, main included, on shutdown', async () => {
    const { registry, built } = fakes();
    registry.create('claude-code', null);
    await registry.dispose();
    expect(built.map((engine) => engine.disposed)).toEqual([1, 1]);
  });

  it('refuses to create a slot once shutdown has begun, so none is left undisposed', async () => {
    const { registry, built } = fakes();
    const stopping = registry.dispose();
    expect(codeOfSync(() => registry.create('pi', null))).toBe('shutting_down');
    await stopping;
    expect(built).toHaveLength(1);
    expect(codeOfSync(() => registry.create('claude-code', null))).toBe('shutting_down');
  });

  it('logs a slot whose teardown fails, and it is gone all the same', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine('c1').disposeError = new Error('teardown exploded');

    await registry.close('c1');

    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('teardown exploded'));
    errors.mockRestore();
  });

  it('settles shutdown even when a teardown fails, disposing the rest and logging it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { registry, engine, built } = fakes();
    registry.create('pi', null);
    engine(MAIN).disposeError = new Error('main teardown exploded');

    await expect(registry.dispose()).resolves.toBeUndefined();

    expect(built.map((one) => one.disposed)).toEqual([1, 1]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('main teardown exploded'));
    errors.mockRestore();
  });
});

describe('ChatRegistry holder index', () => {
  it('maps each held session to its slot, fed by the identity hook', () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine(MAIN).hold('one');
    engine('c1').hold('two');

    expect(registry.holder({ engine: 'pi', id: 'one' })).toBe(MAIN);
    expect(registry.holder({ engine: 'pi', id: 'two' })).toBe('c1');
    // Engine-qualified: the same id under the other engine is a different session.
    expect(registry.holder({ engine: 'claude-code', id: 'one' })).toBeNull();

    engine(MAIN).hold('three');
    expect(registry.holder({ engine: 'pi', id: 'one' })).toBeNull();
    expect(registry.holder({ engine: 'pi', id: 'three' })).toBe(MAIN);
  });

  it('lets an engine claim a session in one step: refused when another slot holds or claimed it', () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine(MAIN).hold('one');

    expect(engine('c1').ctx.claim({ engine: 'pi', id: 'one' })).toBe(false);
    expect(engine(MAIN).ctx.claim({ engine: 'pi', id: 'one' })).toBe(true);
    expect(engine('c1').ctx.claim({ engine: 'pi', id: 'other' })).toBe(true);
    // Claimed, not yet built: already nobody else's.
    expect(registry.holder({ engine: 'pi', id: 'other' })).toBe('c1');
    expect(engine(MAIN).ctx.claim({ engine: 'pi', id: 'other' })).toBe(false);
    engine('c1').ctx.release({ engine: 'pi', id: 'other' });
    expect(engine(MAIN).ctx.claim({ engine: 'pi', id: 'other' })).toBe(true);
  });

  it('keeps a claim across the moment a swapping slot holds nothing, and drops stale claims once it reports', () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    const c1 = engine('c1');
    c1.ctx.claim({ engine: 'pi', id: 'picked' });
    c1.ctx.claim({ engine: 'pi', id: 'stale' });
    c1.hold(null);
    expect(registry.holder({ engine: 'pi', id: 'picked' })).toBe('c1');

    c1.hold('picked');
    expect(registry.holder({ engine: 'pi', id: 'picked' })).toBe('c1');
    expect(registry.holder({ engine: 'pi', id: 'stale' })).toBeNull();
  });

  it('never lets a report take a session another slot holds: the index keeps the first, and says so', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine(MAIN).hold('one');
    engine('c1').hold('one');
    expect(registry.holder({ engine: 'pi', id: 'one' })).toBe(MAIN);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('already held by main'));
    errors.mockRestore();
  });

  it('R1: two concurrent opens of one session: the first claims it, the second is pointed at it', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    registry.create('pi', null);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    engine('c1').gate = gate;
    engine('c2').gate = gate;
    const ref = { engine: 'pi' as const, id: 'X' };

    const first = registry.openFor('c1', ref, '/s/X');
    const second = registry.openFor('c2', ref, '/s/X');
    open();

    expect(await first).toEqual({ chatId: 'c1', items: [] });
    expect(await second).toEqual({ heldBy: 'c1' });
    expect(engine('c2').opened).toEqual([]);
    expect(registry.holder(ref)).toBe('c1');
  });

  it('R2: a continue-recent racing an open of the same session: only one gets it', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    engine(MAIN).gate = gate;
    engine('c1').gate = gate;
    const Y = { engine: 'pi' as const, id: 'Y' };

    const continued = engine(MAIN).continueLatest(['Y', 'older']);
    const opened = registry.openFor('c1', Y, '/s/Y');
    open();

    expect(await continued).toBe('Y');
    expect(await opened).toEqual({ heldBy: MAIN });
    expect(registry.holder(Y)).toBe(MAIN);
    expect(engine('c1').info()).toBeNull();
  });

  it('R3: a slot closed while its open is in flight leaves nothing held', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    let open = (): void => undefined;
    engine('c1').gate = new Promise<void>((resolve) => (open = resolve));
    const Z = { engine: 'pi' as const, id: 'Z' };

    const opening = registry.openFor('c1', Z, '/s/Z');
    await registry.close('c1');
    open();
    await opening;

    expect(registry.holder(Z)).toBeNull();
    expect(engine(MAIN).ctx.claim(Z)).toBe(true);
  });

  it('gives a claim back when the open fails', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine('c1').openError = new Error('folder gone');
    const ref = { engine: 'pi' as const, id: 'gone' };

    await expect(registry.openFor('c1', ref, '/s/gone')).rejects.toThrow('folder gone');

    expect(registry.holder(ref)).toBeNull();
  });

  it('forgets what a closed slot held', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine('c1').hold('two');
    await registry.close('c1');
    expect(registry.holder({ engine: 'pi', id: 'two' })).toBeNull();
  });

  it('points an open at the slot already holding the session, opening nothing', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    engine(MAIN).hold('one');

    const result = await registry.openFor('c1', { engine: 'pi', id: 'one' }, '/s/one');

    expect(result).toEqual({ heldBy: MAIN });
    expect(engine('c1').opened).toEqual([]);
  });

  it('opens a session nobody holds in the slot asked, which then holds it', async () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);

    const result = await registry.openFor('c1', { engine: 'pi', id: 'free' }, '/s/free', 'tab-1');

    expect(result).toEqual({ chatId: 'c1', items: [] });
    expect(engine('c1').opened).toEqual(['/s/free']);
    expect(registry.holder({ engine: 'pi', id: 'free' })).toBe('c1');
  });

  it('reopens in place a session the slot itself holds', async () => {
    const { registry, engine } = fakes();
    engine(MAIN).hold('one');
    expect(await registry.openFor(MAIN, { engine: 'pi', id: 'one' }, '/s/one')).toEqual({ chatId: MAIN, items: [] });
  });

  it('refuses to open one engine’s session in the other engine’s slot', async () => {
    const { registry } = fakes();
    expect(await codeOf(registry.openFor(MAIN, { engine: 'claude-code', id: 'x' }, 'claude-code:x'))).toBe(
      'engine_mismatch',
    );
  });
});

describe('ChatRegistry approvals', () => {
  it('routes an answer to the slot whose engine is waiting on that request', () => {
    const { registry, engine } = fakes();
    registry.create('pi', null);
    registry.create('claude-code', null);
    engine('c2').pendingApprovals.add('call-7');

    expect(registry.resolveApproval('call-7', true)).toBe(true);
    expect(engine('c2').resolved).toEqual([{ requestId: 'call-7', approved: true }]);
    expect(engine(MAIN).resolved).toEqual([]);
    expect(registry.resolveApproval('call-7', true)).toBe(false);
    expect(registry.resolveApproval('nobody', false)).toBe(false);
  });

  it('marks a slot as needing attention while an approval it broadcast waits, until answered or the turn ends', async () => {
    const { registry, engine } = fakes();
    const events: SlotEvent[] = [];
    registry.onSlots((event) => events.push(event));
    await tick();
    const ask = { kind: 'approval-request' as const, requestId: 'r1', callId: 'r1', tool: 'bash', target: 'rm', origin: 'tab-1' };

    engine(MAIN).pendingApprovals.add('r1');
    engine(MAIN).broadcast(ask);
    await tick();
    expect(registry.list()[0]?.attention).toBe(true);
    expect(events).toEqual([{ type: 'changed', chatId: MAIN }]);

    registry.resolveApproval('r1', false);
    expect(registry.list()[0]?.attention).toBe(false);
    expect(events).toHaveLength(2);

    engine(MAIN).broadcast({ ...ask, requestId: 'r2' });
    engine(MAIN).broadcast({ kind: 'turn-ended', origin: 'tab-1' });
    await tick();
    expect(registry.list()[0]?.attention).toBe(false);
  });
});

describe('ChatRegistry approvals across real pi slots', () => {
  /** A PiChat whose broker the test drives as its Vault guard would. */
  const piWithBroker: EngineFactory = (ctx) =>
    new PiChat(
      {} as ModelCatalog,
      undefined,
      undefined,
      undefined,
      undefined,
      { projectPaths: () => Promise.resolve([]), recentSessions: () => Promise.resolve([]) },
      { crew: ctx.crew, claim: ctx.claim },
    );
  const ask = (chat: unknown, callId: string): Promise<boolean> =>
    (chat as { approvals: { request: (r: unknown) => Promise<boolean> } }).approvals.request({
      callId,
      tool: 'read',
      target: '/x',
      args: {},
    });

  it('answers only the slot whose request it is, when two slots wait on the same tool-call id', async () => {
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: piWithBroker, 'claude-code': () => { throw new Error('no claude here'); } },
    });
    const { chatId } = registry.create('pi', null);
    const asked: { chatId: string; requestId: string }[] = [];
    for (const id of [MAIN, chatId]) {
      void (async () => {
        for await (const chunk of registry.engine(id).observe(new AbortController().signal)) {
          if (chunk.kind === 'approval-request') asked.push({ chatId: id, requestId: chunk.requestId });
        }
      })();
    }
    await tick();
    const mainDecision = ask(registry.engine(MAIN), 'read:5');
    const otherDecision = ask(registry.engine(chatId), 'read:5');
    await tick();
    const other = asked.find((entry) => entry.chatId === chatId);
    if (!other) throw new Error('no request from the second slot');

    expect(new Set(asked.map((entry) => entry.requestId)).size).toBe(2);
    expect(registry.resolveApproval(other.requestId, true)).toBe(true);
    await expect(otherDecision).resolves.toBe(true);
    expect(registry.resolveApproval(other.requestId, true)).toBe(false);

    const first = asked.find((entry) => entry.chatId === MAIN);
    expect(registry.resolveApproval(first?.requestId ?? '', false)).toBe(true);
    await expect(mainDecision).resolves.toBe(false);
    await registry.dispose();
  });
});

describe('ChatRegistry pi-crew slot', () => {
  it('gives crew to main when main is pi, and to no other pi slot', () => {
    const { registry, engine } = fakes('pi');
    registry.create('pi', null);
    expect(engine(MAIN).ctx.crew()).toBe(true);
    expect(engine('c1').ctx.crew()).toBe(false);
    expect(registry.list().map((slot) => slot.crew)).toEqual([true, false]);
  });

  it('gives crew to the first pi slot when main is Claude', () => {
    const { registry, engine } = fakes('claude-code');
    registry.create('pi', null);
    registry.create('pi', null);
    registry.create('claude-code', null);
    expect([MAIN, 'c1', 'c2', 'c3'].map((id) => engine(id).ctx.crew())).toEqual([false, true, false, false]);
  });

  it('moves crew to the oldest remaining pi slot when the crew slot closes, from its next session', async () => {
    const { registry, engine } = fakes('claude-code');
    registry.create('pi', null);
    registry.create('pi', null);
    registry.create('pi', null);
    engine('c2').hold('live');

    await registry.close('c1');

    expect(engine('c2').ctx.crew()).toBe(true);
    expect(engine('c3').ctx.crew()).toBe(false);
    // Its live session was built without pi-crew and is not rebuilt under it.
    expect(registry.list().find((slot) => slot.chatId === 'c2')).toMatchObject({ crew: true, crewPending: true });

    engine('c2').hold('next');
    expect(registry.list().find((slot) => slot.chatId === 'c2')).toMatchObject({ crew: true, crewPending: false });

    // A later pi slot does not take it.
    registry.create('pi', null);
    expect(engine('c4').ctx.crew()).toBe(false);
  });

  it('gives a promoted slot with no live session crew at once', async () => {
    const { registry, engine } = fakes('claude-code');
    registry.create('pi', null);
    registry.create('pi', null);
    await registry.close('c1');
    expect(registry.list().find((slot) => slot.chatId === 'c2')).toMatchObject({ crew: true, crewPending: false });
    expect(engine('c2').ctx.crew()).toBe(true);
  });
});

describe('ChatRegistry running Claude processes', () => {
  it('lets a Claude slot start a process only while fewer than the cap are running', () => {
    const { registry, engine } = fakes('claude-code', { maxClaudeRunning: 2 });
    registry.create('claude-code', null);
    registry.create('pi', null);
    const ask = engine(MAIN).ctx.mayStartClaude;

    expect(ask()).toBe(true);
    engine('c1').runningNow = true;
    expect(ask()).toBe(true);
    // A pi slot never counts, whatever it reports.
    engine('c2').runningNow = true;
    expect(ask()).toBe(true);
    engine(MAIN).runningNow = true;
    expect(engine('c1').ctx.mayStartClaude()).toBe(false);
  });

  it('at the cap, closes the least recently used idle process instead of refusing', () => {
    const { registry, engine } = fakes('claude-code', { maxClaudeRunning: 2 });
    registry.create('claude-code', null);
    registry.create('claude-code', null);
    engine(MAIN).runningNow = true;
    engine(MAIN).idleAt = 500;
    engine('c1').runningNow = true;
    engine('c1').idleAt = 200;

    expect(engine('c2').ctx.mayStartClaude()).toBe(true);

    expect(engine('c1').closedIdle).toBe(1);
    expect(engine(MAIN).closedIdle).toBe(0);
  });

  it('refuses at the cap only when no running process is idle', () => {
    const { registry, engine } = fakes('claude-code', { maxClaudeRunning: 1 });
    registry.create('claude-code', null);
    engine(MAIN).runningNow = true; // mid-turn: not idle
    expect(engine('c1').ctx.mayStartClaude()).toBe(false);
    expect(engine(MAIN).closedIdle).toBe(0);
  });
});

describe('ChatRegistry with real pi slots', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-registry-sessions-'));
    root = await mkdtemp(join(tmpdir(), 'fo-registry-root-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  async function stored(text: string, ageMs: number): Promise<string> {
    const manager = SessionManager.create(root, dir);
    manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: 'anthropic-messages',
      provider: 'p',
      model: 'm',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    if (!file) throw new Error('not persisted');
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
    return manager.getSessionId();
  }

  /** A real PiChat whose sessions are scripted shells over the manager PiChat chose. */
  const realPi: EngineFactory = (ctx) =>
    new PiChat(
      {} as ModelCatalog,
      async (_root, manager) => {
        const sessionManager = await manager();
        return {
          sessionManager,
          isStreaming: false,
          agent: {},
          subscribe: () => () => undefined,
          dispose: () => undefined,
          abort: () => Promise.resolve(),
        } as unknown as AgentSession;
      },
      () => Promise.resolve({ guard: () => Promise.resolve(undefined) }),
      dir,
      undefined,
      { projectPaths: () => Promise.resolve([]), recentSessions: () => Promise.resolve([]) },
      {
        ...(ctx.root !== null ? { root: ctx.root } : {}),
        fresh: ctx.fresh,
        crew: ctx.crew,
        claim: ctx.claim,
        crewActive: () => 0,
      },
    );

  it('a second pi slot moving to main’s folder continues the next session, not the one main holds', async () => {
    const older = await stored('older', 60_000);
    const newest = await stored('newer', 1_000);
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: realPi, 'claude-code': () => { throw new Error('no claude here'); } },
    });
    const main = registry.engine();
    await main.setRoot(root);
    expect(main.info()?.id).toBe(newest);
    expect(registry.holder({ engine: 'pi', id: newest })).toBe(MAIN);

    const { chatId } = registry.create('pi', null);
    const second = registry.engine(chatId);
    await second.setRoot(root);

    expect(second.info()?.id).toBe(older);
    expect(registry.holder({ engine: 'pi', id: older })).toBe(chatId);
    expect(registry.list().map((slot) => slot.crew)).toEqual([true, false]);

    // Closing the second slot frees its session for main's next continue.
    await registry.close(chatId);
    expect(registry.holder({ engine: 'pi', id: older })).toBeNull();
    expect(second.info()).toBeNull();
    await registry.dispose();
  });

  it('a slot created fresh starts a new session even where the folder has one free', async () => {
    const newest = await stored('newer', 1_000);
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: realPi, 'claude-code': () => { throw new Error('no claude here'); } },
    });
    const { chatId } = registry.create('pi', root);
    const slot = registry.engine(chatId);
    expect(registry.list()[1]?.session).toBeNull();
    // Re-applying its own folder builds the slot's first session, as a tab mounting would.
    await slot.setRoot(root);
    const id = await (slot as PiChat).sessionId();

    expect(id).not.toBeNull();
    expect(id).not.toBe(newest);
    expect(registry.holder({ engine: 'pi', id: id ?? '' })).toBe(chatId);
    expect(registry.holder({ engine: 'pi', id: newest })).toBeNull();
    await registry.dispose();
  });
});

describe('ChatRegistry restore after a restart (T2.3)', () => {
  const pi = (id: string) => ({ engine: 'pi' as const, id, path: `/s/${id}` });
  const claude = (id: string) => ({ engine: 'claude-code' as const, id, path: `claude-code:${id}` });
  const record = (chatId: string, kind: EngineKind, root: string | null, session: SlotRecord['session']): SlotRecord => ({
    chatId,
    kind,
    root,
    session,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('brings every recorded slot back under its own id, kind and folder, main first, building nothing', () => {
    const { registry, engine, built } = fakes('pi', {
      restored: [
        record('main', 'pi', '/w/main', pi('m1')),
        record('a1', 'claude-code', '/w/a', claude('k1')),
        record('b2', 'pi', null, null),
      ],
    });
    expect(registry.list().map(({ chatId, kind, root }) => ({ chatId, kind, root }))).toEqual([
      { chatId: MAIN, kind: 'pi', root: '/w/main' },
      { chatId: 'a1', kind: 'claude-code', root: '/w/a' },
      { chatId: 'b2', kind: 'pi', root: null },
    ]);
    // Every slot is told it is restored: none builds now (main's prewarm included), and only main continues.
    expect(engine(MAIN).ctx).toMatchObject({ restored: true, fresh: false, root: '/w/main' });
    expect(engine('a1').ctx).toMatchObject({ restored: true, fresh: true });
    expect(engine('b2').ctx).toMatchObject({ restored: true, fresh: true });
    // Nothing is armed until asked.
    expect(built.flatMap((one) => one.armed)).toEqual([]);
  });

  it('a first start (nothing recorded) is main alone, not restored, as before', () => {
    const { registry, engine } = fakes('pi', { restored: [] });
    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN]);
    expect(engine(MAIN).ctx).toMatchObject({ restored: false, fresh: false, root: null });
  });

  it('arms each recorded session and holds it in the index, so no other slot can take it', async () => {
    const { registry, engine } = fakes('pi', {
      restored: [record('main', 'pi', '/w', pi('m1')), record('a1', 'claude-code', '/w', claude('k1'))],
    });
    await registry.armRestored();
    expect(engine(MAIN).armed).toEqual(['m1']);
    expect(engine('a1').armed).toEqual(['k1']);
    expect(registry.holder({ engine: 'pi', id: 'm1' })).toBe(MAIN);
    expect(registry.holder({ engine: 'claude-code', id: 'k1' })).toBe('a1');
    expect(registry.list().map((slot) => slot.session?.id)).toEqual(['m1', 'k1']);
    // Another slot opening it is pointed at the holder.
    const { chatId } = registry.create('pi', null);
    expect(await registry.openFor(chatId, { engine: 'pi', id: 'm1' }, '/s/m1')).toEqual({ heldBy: MAIN });
  });

  it('two records naming one session: the first holds it, the second comes back without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, engine } = fakes('pi', {
      restored: [record('a1', 'pi', '/w', pi('p1')), record('b2', 'pi', '/w', pi('p1'))],
    });
    await registry.armRestored();
    expect(engine('a1').armed).toEqual(['p1']);
    expect(engine('b2').armed).toEqual([]);
    expect(registry.holder({ engine: 'pi', id: 'p1' })).toBe('a1');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/b2.*p1.*held by a1/));
  });

  it('a session that is gone is given back and warned about; the slot stays, empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, built } = fakes('pi', { restored: [record('a1', 'pi', '/w', pi('gone'))] });
    const a1 = built.find((one) => one.ctx.chatId === 'a1');
    if (!a1) throw new Error('a1 missing');
    a1.armResult = false;
    await registry.armRestored();
    expect(registry.holder({ engine: 'pi', id: 'gone' })).toBeNull();
    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN, 'a1']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/a1.*gone/));
  });

  it('main keeps the configured engine: a record of the other engine restores only its folder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, engine } = fakes('claude-code', { restored: [record('main', 'pi', '/w/main', pi('m1'))] });
    await registry.armRestored();
    expect(engine(MAIN).kind).toBe('claude-code');
    expect(engine(MAIN).ctx).toMatchObject({ root: '/w/main', restored: true, fresh: false });
    expect(engine(MAIN).armed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/main.*pi.*claude-code/));
  });

  it('a session of the wrong engine for its slot is not armed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, engine } = fakes('pi', { restored: [record('a1', 'pi', '/w', claude('k1'))] });
    await registry.armRestored();
    expect(engine('a1').armed).toEqual([]);
  });

  it('caps apply: records past the slot cap are dropped, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry } = fakes('pi', {
      maxSlots: 2,
      restored: [record('a1', 'pi', null, null), record('b2', 'pi', null, null), record('c3', 'pi', null, null)],
    });
    expect(registry.list().map((slot) => slot.chatId)).toEqual([MAIN, 'a1']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/b2, c3/));
  });

  it('crew goes to main when it is pi', () => {
    const { registry } = fakes('pi', { restored: [record('a1', 'pi', null, null), record('b2', 'pi', null, null)] });
    expect(registry.list().map((slot) => slot.crew)).toEqual([true, false, false]);
  });

  it('under a Claude main, crew goes to the oldest restored pi slot', () => {
    const { registry } = fakes('claude-code', {
      restored: [record('a1', 'claude-code', null, null), record('b2', 'pi', null, null), record('c3', 'pi', null, null)],
    });
    expect(registry.list().map((slot) => slot.crew)).toEqual([false, false, true, false]);
  });

  it('new slots never take a restored id', () => {
    let minted = 0;
    const ids = ['a1', 'a1', 'z9'];
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: (ctx) => new FakeEngine('pi', ctx), 'claude-code': (ctx) => new FakeEngine('claude-code', ctx) },
      mintId: () => ids[minted++] ?? 'x',
      restored: [record('a1', 'pi', null, null)],
    });
    expect(registry.create('pi', null).chatId).toBe('z9');
  });

  it('records each slot as it stands now: kind, folder and held session, without what closed', async () => {
    const { registry, engine } = fakes('pi');
    const { chatId } = registry.create('claude-code', '/w/c');
    engine(chatId).hold('k9');
    const other = registry.create('pi', null).chatId;
    engine(MAIN).root = '/w/m';
    expect(registry.records()).toEqual([
      record(MAIN, 'pi', '/w/m', null),
      record(chatId, 'claude-code', '/w/c', { engine: 'claude-code', id: 'k9', path: '/s/k9' }),
      record(other, 'pi', null, null),
    ]);
    await registry.close(other);
    expect(registry.records().map((one) => one.chatId)).toEqual([MAIN, chatId]);
  });

  it('the listing carries each slot’s folder', () => {
    const { registry } = fakes('pi');
    registry.create('pi', '/w/x');
    expect(registry.list().map((slot) => slot.root)).toEqual([null, '/w/x']);
  });
});

describe('ChatRegistry restore with real engines: arming starts and builds nothing', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-restore-sessions-'));
    root = await mkdtemp(join(tmpdir(), 'fo-restore-root-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  /** A persisted pi session in `root`, and its file. */
  function stored(text: string): { id: string; path: string } {
    const manager = SessionManager.create(root, dir);
    manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `re: ${text}` }],
      api: 'anthropic-messages',
      provider: 'p',
      model: 'm',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const path = manager.getSessionFile();
    if (!path) throw new Error('not persisted');
    return { id: manager.getSessionId(), path };
  }

  it('pi slots and a Claude slot come back armed: no pi session built, no claude spawned, no turn, no liveness asked', async () => {
    const first = stored('first');
    const second = stored('second');
    const builds: string[] = [];
    const prompts: string[] = [];
    const piFactory: EngineFactory = (ctx) => {
      const chat = new PiChat(
        {} as ModelCatalog,
        async (_root, manager) => {
          const sessionManager = await manager();
          builds.push(sessionManager.getSessionId());
          const listeners = new Set<(event: unknown) => void>();
          return {
            sessionManager,
            isStreaming: false,
            agent: {},
            subscribe: (listener: (event: unknown) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            getContextUsage: () => undefined,
            dispose: () => undefined,
            abort: () => Promise.resolve(),
            prompt: (text: string) => {
              prompts.push(text);
              for (const listener of listeners) listener({ type: 'agent_end', messages: [], willRetry: false });
              return Promise.resolve();
            },
          } as unknown as AgentSession;
        },
        () => Promise.resolve({ guard: () => Promise.resolve(undefined) }),
        dir,
        undefined,
        { projectPaths: () => Promise.resolve([]), recentSessions: () => Promise.resolve([]) },
        {
          ...(ctx.root !== null ? { root: ctx.root } : {}),
          fresh: ctx.fresh,
          crew: ctx.crew,
          claim: ctx.claim,
          crewActive: () => 0,
        },
      );
      if (!ctx.fresh && !ctx.restored) chat.prewarm();
      return chat;
    };
    const claudeId = '11111111-1111-4111-8111-111111111111';
    const claude = harness([]);
    claude.sessions.rows = [
      { sessionId: claudeId, summary: 'stored', lastModified: 1_000, createdAt: 1_000, cwd: root, fileSize: 1 },
    ] as never;
    const registry = new ChatRegistry({
      mainKind: 'pi',
      factories: { pi: piFactory, 'claude-code': () => claude.chat },
      restored: [
        { chatId: 'main', kind: 'pi', root, session: { engine: 'pi', ...first } },
        { chatId: 'p2', kind: 'pi', root, session: { engine: 'pi', ...second } },
        { chatId: 'k3', kind: 'claude-code', root, session: { engine: 'claude-code', id: claudeId, path: `claude-code:${claudeId}` } },
      ],
    });
    await registry.armRestored();
    await tick();

    // Limit 2: nothing was built, spawned or sent.
    expect(builds).toEqual([]);
    expect(prompts).toEqual([]);
    expect(claude.fake.queries).toHaveLength(0);
    // Limit 5: the Claude slot did not decide fork-or-resume at boot.
    expect(claude.sessions.callsTo('live')).toEqual([]);
    // Each slot holds its own session, read without building.
    expect(registry.list().map((slot) => slot.session?.id)).toEqual([first.id, second.id, claudeId]);
    expect(registry.holder({ engine: 'pi', id: first.id })).toBe(MAIN);
    expect(registry.holder({ engine: 'pi', id: second.id })).toBe('p2');
    expect(registry.holder({ engine: 'claude-code', id: claudeId })).toBe('k3');
    // A tab reconnecting reads each conversation, still without building.
    const transcript = await registry.engine('p2').transcript();
    expect(transcript.map((item) => ('role' in item ? item.role : item.kind))).toEqual(['user', 'assistant']);
    expect(await registry.engine(MAIN).current()).toMatchObject({ id: first.id, cwd: root });
    expect(builds).toEqual([]);

    // The next send builds exactly the armed session: pi keeps its context.
    for await (const _chunk of registry.engine('p2').send('again', new AbortController().signal)) void _chunk;
    expect(builds).toEqual([second.id]);
    expect(prompts).toEqual(['again']);
    await registry.dispose();
  });
});
