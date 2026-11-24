/**
 * PiChat as one slot among several (T2.1a): non-building reads, teardown
 * reasons, the identity hook, fresh starts, skipping sessions another slot
 * holds, and the subagents left running in sessions the slot switched away
 * from. Hermetic: injected sessions on a raw host, temp session dirs, no model.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import type { SessionRef } from '../chat-engine.ts';
import type { ModelCatalog } from './model-catalog.ts';
import { PiChat, type PiChatHistorySources, type PiChatSlotOptions } from './pi-chat.ts';
import { RawSessionHost } from './session-host.ts';

const hermeticSources: PiChatHistorySources = {
  projectPaths: () => Promise.resolve([]),
  recentSessions: () => Promise.resolve([]),
};

const allowAll = () => Promise.resolve({ guard: () => Promise.resolve(undefined) });

function fakeManager(id: string, cwd = '/workspace') {
  return {
    getSessionFile: () => `/sessions/${id}.jsonl`,
    getSessionId: () => id,
    getCwd: () => cwd,
    getSessionName: () => undefined,
    getHeader: () => ({ timestamp: '2026-10-18T10:00:00.000Z' }),
    getEntries: () => [],
    buildContextEntries: () => [],
    getLeafId: () => null,
    isPersisted: () => true,
  };
}

/** Just the session surface PiChat drives; a prompt runs until `finish()`. */
class SlotSession {
  isStreaming = false;
  readonly dispose = vi.fn();
  readonly agent: { beforeToolCall?: AgentSession['agent']['beforeToolCall'] } = {};
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  finish: () => void = () => undefined;

  constructor(readonly sessionManager: unknown) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentSessionEvent): void {
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

  readonly prompt = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        this.isStreaming = true;
        this.emit({ type: 'agent_start' } as never);
        this.finish = () => {
          this.isStreaming = false;
          this.emit({ type: 'agent_end', messages: [], willRetry: false } as never);
          resolve();
        };
      }),
  );
}

let seq = 0;

/** Sessions with distinct ids, ignoring the manager PiChat would build. */
function scripted(built: SlotSession[] = []) {
  return (_root: string) => {
    seq += 1;
    const session = new SlotSession(fakeManager(`s${seq}`));
    built.push(session);
    return Promise.resolve(session as unknown as AgentSession);
  };
}

/** Sessions on the very manager PiChat would build, so its choice is visible. */
function onBuiltManager(ids: string[]) {
  return async (_root: string, manager: () => Promise<SessionManager>) => {
    const built = await manager();
    ids.push(built.getSessionId());
    return new SlotSession(built) as unknown as AgentSession;
  };
}

function piChat(
  factory: (root: string, manager: () => Promise<SessionManager>) => Promise<AgentSession>,
  slot: PiChatSlotOptions = {},
  sessionDir?: string,
): PiChat {
  return new PiChat(
    {} as ModelCatalog,
    factory,
    allowAll,
    sessionDir,
    undefined,
    hermeticSources,
    slot,
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PiChat reads that never build', () => {
  it('answers info, current and sessionId without building a session', async () => {
    const built: SlotSession[] = [];
    const chat = piChat(scripted(built));

    expect(chat.kind).toBe('pi');
    expect(chat.info()).toBeNull();
    expect(await chat.current()).toBeNull();
    expect(await chat.sessionId()).toBeNull();
    expect(built).toHaveLength(0);

    chat.prewarm();
    await settle();
    const id = built[0]?.sessionManager as ReturnType<typeof fakeManager>;
    expect(chat.info()?.id).toBe(id.getSessionId());
    expect((await chat.current())?.id).toBe(id.getSessionId());
    expect(await chat.sessionId()).toBe(id.getSessionId());
    expect(built).toHaveLength(1);
  });

  it('is busy while a client turn runs, and not after', async () => {
    const built: SlotSession[] = [];
    const chat = piChat(scripted(built));
    expect(chat.busy()).toBe(false);

    const stream = chat.send('hello', new AbortController().signal)[Symbol.asyncIterator]();
    const first = stream.next();
    await settle();
    expect(chat.busy()).toBe(true);
    built[0]?.finish();
    await first;
    while (!(await stream.next()).done) {
      // drain
    }
    expect(chat.busy()).toBe(false);
  });

  it('is busy while a run nobody sent is streaming (a pi-crew delivery)', async () => {
    const built: SlotSession[] = [];
    const chat = piChat(scripted(built));
    chat.prewarm();
    await settle();
    const session = built[0];
    if (!session) throw new Error('no session');
    session.isStreaming = true;
    expect(chat.busy()).toBe(true);
    session.isStreaming = false;
    expect(chat.busy()).toBe(false);
  });

  it('never has a running process of its own: pi runs in-process', () => {
    const chat = piChat(scripted());
    expect(chat.running()).toBe(false);
    expect(chat.idleSince()).toBeNull();
    expect(chat.closeIdle()).toBe(false);
  });
});

describe('PiChat teardown reasons', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-pi-slot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('threads new, resume (with the target file) and quit to the host', async () => {
    const reasons: unknown[][] = [];
    vi.spyOn(RawSessionHost.prototype, 'dispose').mockImplementation(function (
      this: RawSessionHost,
      ...args: unknown[]
    ) {
      reasons.push(args);
      return Promise.resolve();
    });
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      fakeManager('stored', tmpdir()) as unknown as SessionManager,
    );
    const chat = piChat(scripted(), {}, dir);
    chat.prewarm();
    await settle();

    await chat.newChat();
    await chat.openChat('/sessions/stored.jsonl');
    await chat.setRoot(dir);
    await chat.disposeLiveSession();

    expect(reasons[0]).toEqual(['new', undefined]);
    expect(reasons[1]).toEqual(['resume', '/sessions/stored.jsonl']);
    // A re-root picks its session when it builds, so no target is known yet.
    expect(reasons[2]).toEqual(['resume', undefined]);
    expect(reasons[3]).toEqual(['quit', undefined]);
    expect(reasons).toHaveLength(4);
  });

  it('tears a session whose Vault never installed down as new, never quit', async () => {
    const reasons: unknown[][] = [];
    vi.spyOn(RawSessionHost.prototype, 'dispose').mockImplementation((...args: unknown[]) => {
      reasons.push(args);
      return Promise.resolve();
    });
    const chat = new PiChat(
      {} as ModelCatalog,
      scripted(),
      () => Promise.reject(new Error('vault unreadable')),
      undefined,
      undefined,
      hermeticSources,
    );

    expect(await chat.current()).toBeNull();
    chat.prewarm();
    await settle();

    expect(reasons).toEqual([['new', undefined]]);
  });

  it('fails a turn still running with chat_closed when the slot is closed under it', async () => {
    const built: SlotSession[] = [];
    const chat = piChat(scripted(built));
    const stream = chat.send('go', new AbortController().signal)[Symbol.asyncIterator]();
    const first = stream.next();
    await settle();
    expect(chat.busy()).toBe(true);

    await chat.dispose();

    await expect(first).rejects.toMatchObject({ code: 'chat_closed' });
  });

  it('dispose() quits the live session, ends observers and builds nothing after', async () => {
    const built: SlotSession[] = [];
    const chat = piChat(scripted(built));
    chat.prewarm();
    await settle();
    const observed: ChatChunk[] = [];
    const observing = (async () => {
      for await (const chunk of chat.observe(new AbortController().signal)) observed.push(chunk);
    })();
    await settle();

    await chat.dispose();
    await observing;

    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(chat.info()).toBeNull();
    chat.prewarm();
    await settle();
    expect(built).toHaveLength(1);
  });
});

describe('PiChat identity hook', () => {
  it('reports the held session as it changes, and null when it goes', async () => {
    const seen: (SessionRef | null)[] = [];
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      fakeManager('stored', tmpdir()) as unknown as SessionManager,
    );
    const chat = piChat(scripted());
    chat.onIdentity((ref) => seen.push(ref));

    chat.prewarm();
    await settle();
    await chat.newChat();
    await chat.openChat('/sessions/stored.jsonl');
    await chat.disposeLiveSession();

    const ids = seen.map((ref) => ref?.id ?? null);
    expect(seen.every((ref) => ref === null || ref.engine === 'pi')).toBe(true);
    expect(ids[0]).toMatch(/^s\d+$/);
    expect(ids.slice(1)).toEqual([null, expect.stringMatching(/^s\d+$/), null, expect.stringMatching(/^s\d+$/), null]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('stops calling a listener once it unsubscribes', async () => {
    const seen: unknown[] = [];
    const chat = piChat(scripted());
    const off = chat.onIdentity((ref) => seen.push(ref));
    off();
    chat.prewarm();
    await settle();
    expect(seen).toEqual([]);
  });
});

describe('PiChat session choice', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-pi-slot-sessions-'));
    root = await mkdtemp(join(tmpdir(), 'fo-pi-slot-root-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  /** A persisted session for `root`, `ageMs` old by its file's mtime. */
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
    const { utimes } = await import('node:fs/promises');
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
    return manager.getSessionId();
  }

  it('continues the root’s newest session by default', async () => {
    await stored('older', 60_000);
    const newest = await stored('newer', 1_000);
    const ids: string[] = [];
    const chat = piChat(onBuiltManager(ids), { root }, dir);
    chat.prewarm();
    await settle();
    expect(ids).toEqual([newest]);
  });

  it('starts fresh when the slot is created fresh, at the slot’s root', async () => {
    const newest = await stored('newer', 1_000);
    const ids: string[] = [];
    const roots: string[] = [];
    const chat = piChat(
      async (at, manager) => {
        roots.push(at);
        return onBuiltManager(ids)(at, manager);
      },
      { root, fresh: true },
      dir,
    );
    chat.prewarm();
    await settle();
    expect(roots).toEqual([root]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(newest);
  });

  it('claims the newest session at the pick, so no other slot can take it while this one builds', async () => {
    await stored('older', 60_000);
    const newest = await stored('newer', 1_000);
    const claimed: SessionRef[] = [];
    const ids: string[] = [];
    const chat = piChat(onBuiltManager(ids), { root, claim: (ref) => (claimed.push(ref), true) }, dir);
    chat.prewarm();
    await chat.current();
    expect(ids).toEqual([newest]);
    expect(claimed).toEqual([{ engine: 'pi', id: newest }]);
  });

  it('skips a session another slot holds, claiming the next newest', async () => {
    const older = await stored('older', 60_000);
    const newest = await stored('newer', 1_000);
    const asked: SessionRef[] = [];
    const ids: string[] = [];
    const chat = piChat(
      onBuiltManager(ids),
      {
        root,
        claim: (ref) => {
          asked.push(ref);
          return ref.id !== newest;
        },
      },
      dir,
    );
    chat.prewarm();
    // Waits for the build in flight without starting one.
    await chat.current();
    expect(ids).toEqual([older]);
    expect(asked).toEqual([
      { engine: 'pi', id: newest },
      { engine: 'pi', id: older },
    ]);
  });

  it('starts fresh on a re-root when every session there is held elsewhere', async () => {
    const only = await stored('only', 1_000);
    const ids: string[] = [];
    const chat = piChat(onBuiltManager(ids), { claim: (ref) => ref.id !== only }, dir);
    await chat.setRoot(root);
    expect(ids.at(-1)).toBeDefined();
    expect(ids.at(-1)).not.toBe(only);
  });

  /** The file of a stored session, by id. */
  async function fileOf(id: string): Promise<string> {
    const row = (await SessionManager.list(root, dir)).find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no session ${id}`);
    return row.path;
  }

  it('arms a stored session for the next send without building it (restore after a restart)', async () => {
    const id = await stored('restored', 60_000);
    await stored('newer', 1_000);
    const ids: string[] = [];
    const heard: (SessionRef | null)[] = [];
    const chat = piChat(onBuiltManager(ids), { root, fresh: true }, dir);
    chat.onIdentity((ref) => heard.push(ref));

    expect(await chat.arm({ id, path: await fileOf(id) })).toBe(true);

    expect(ids).toEqual([]);
    expect(heard).toEqual([{ engine: 'pi', id }]);
    expect(chat.info()).toMatchObject({ id, cwd: root });
    expect(await chat.current()).toMatchObject({ id });
    expect((await chat.transcript()).length).toBe(2);
    expect(chat.folder()).toBe(root);
    expect(ids).toEqual([]);
    // The next build is the armed session, not the folder's newest.
    chat.prewarm();
    await settle();
    expect(ids).toEqual([id]);
    expect(heard).toEqual([{ engine: 'pi', id }]);
  });

  it('the first build after a restore reopens the file: what was written to it since boot is in the session', async () => {
    const id = await stored('restored', 1_000);
    const path = await fileOf(id);
    const built: SessionManager[] = [];
    const chat = piChat(
      async (_root, manager) => {
        const sessionManager = await manager();
        built.push(sessionManager);
        return new SlotSession(sessionManager) as unknown as AgentSession;
      },
      { root, fresh: true },
      dir,
    );
    expect(await chat.arm({ id, path })).toBe(true);
    // The pi TUI (or anything else) continues it before the tab's first send.
    SessionManager.open(path, dir).appendMessage({ role: 'user', content: 'written after boot', timestamp: Date.now() });

    chat.prewarm();
    await settle();

    expect(built).toHaveLength(1);
    expect(built[0]?.getSessionId()).toBe(id);
    expect(JSON.stringify(built[0]?.getEntries())).toContain('written after boot');
  });

  it('arms nothing outside the session store, even a real session file', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'fo-pi-slot-elsewhere-'));
    try {
      const manager = SessionManager.create(root, elsewhere);
      manager.appendMessage({ role: 'user', content: 'x', timestamp: Date.now() });
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: 'anthropic-messages',
        provider: 'p',
        model: 'm',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const path = manager.getSessionFile() ?? '';
      const chat = piChat(onBuiltManager([]), { root, fresh: true }, dir);
      expect(await chat.arm({ id: manager.getSessionId(), path })).toBe(false);
      expect(chat.info()).toBeNull();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('arms nothing for a file that is gone, or that holds another session', async () => {
    const id = await stored('one', 1_000);
    const other = await stored('two', 1_000);
    const chat = piChat(onBuiltManager([]), { root, fresh: true }, dir);
    expect(await chat.arm({ id, path: join(dir, 'gone.jsonl') })).toBe(false);
    expect(await chat.arm({ id, path: await fileOf(other) })).toBe(false);
    expect(chat.info()).toBeNull();
  });

  it('a new chat leaves the armed session for a fresh one', async () => {
    const id = await stored('restored', 1_000);
    const ids: string[] = [];
    const heard: (SessionRef | null)[] = [];
    const chat = piChat(onBuiltManager(ids), { root, fresh: true }, dir);
    await chat.arm({ id, path: await fileOf(id) });
    chat.onIdentity((ref) => heard.push(ref));

    const info = await chat.newChat();

    expect(info?.id).not.toBe(id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(id);
    expect(heard[0]).toBeNull();
  });

});

describe('PiChat subagents left running', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fo-pi-slot-left-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts the active subagents of sessions the slot switched away from', async () => {
    const active = new Map<string, number>();
    vi.spyOn(SessionManager, 'open').mockImplementation(
      (path: string) => fakeManager(path.replace(/^\/sessions\/|\.jsonl$/g, ''), tmpdir()) as unknown as SessionManager,
    );
    const chat = piChat(onBuiltManager([]), { crewActive: (id) => active.get(id) ?? 0 }, dir);
    chat.prewarm();
    await settle();
    const first = chat.info()?.id;
    if (!first) throw new Error('no first session');
    active.set(first, 2);
    expect(chat.subagentsLeftRunning()).toBe(0);

    await chat.newChat();
    expect(chat.subagentsLeftRunning()).toBe(2);

    // Back in the session that owns them: they are no longer left behind.
    await chat.openChat(`/sessions/${first}.jsonl`);
    expect(chat.info()?.id).toBe(first);
    expect(chat.subagentsLeftRunning()).toBe(0);
  });

  it('forgets a left session once its subagents finish', async () => {
    const active = new Map<string, number>();
    const reads: string[] = [];
    const chat = piChat(scripted(), {
      crewActive: (id) => {
        reads.push(id);
        return active.get(id) ?? 0;
      },
    });
    chat.prewarm();
    await settle();
    const first = chat.info()?.id ?? '';
    active.set(first, 1);
    await chat.newChat();
    expect(chat.subagentsLeftRunning()).toBe(1);
    active.set(first, 0);
    expect(chat.subagentsLeftRunning()).toBe(0);
    reads.length = 0;
    expect(chat.subagentsLeftRunning()).toBe(0);
    expect(reads).toEqual([]);
  });

  it('reports none in a slot without pi-crew', async () => {
    const chat = piChat(scripted(), { crew: () => false, crewActive: () => 5 });
    chat.prewarm();
    await settle();
    await chat.newChat();
    expect(chat.crew).toBe(false);
    expect(chat.subagentsLeftRunning()).toBe(0);
  });

  it('starts tracking once crew is handed to the slot', async () => {
    let crew = false;
    const active = new Map<string, number>();
    const chat = piChat(scripted(), { crew: () => crew, crewActive: (id) => active.get(id) ?? 0 });
    chat.prewarm();
    await settle();
    crew = true;
    await chat.newChat();
    const second = chat.info()?.id ?? '';
    active.set(second, 1);
    await chat.newChat();
    expect(chat.crew).toBe(true);
    expect(chat.subagentsLeftRunning()).toBe(1);
  });

  it('aborts the subagents it left behind when it closes with no live session to quit', async () => {
    const aborted: string[] = [];
    const active = new Map<string, number>();
    let failNext = false;
    const chat = piChat(
      (root) => (failNext ? Promise.reject(new Error('rebuild failed')) : scripted()(root)),
      { crewActive: (id) => active.get(id) ?? 0, crewAbort: (id) => aborted.push(id) },
    );
    chat.prewarm();
    await settle();
    const first = chat.info()?.id ?? '';
    active.set(first, 1);
    failNext = true;
    await chat.newChat().catch(() => undefined);
    expect(chat.info()).toBeNull();

    await chat.dispose();

    expect(aborted).toEqual([first]);
  });

  it('leaves the abort to pi-crew when a live session quits on close', async () => {
    const aborted: string[] = [];
    const active = new Map<string, number>();
    const chat = piChat(scripted(), {
      crewActive: (id) => active.get(id) ?? 0,
      crewAbort: (id) => aborted.push(id),
    });
    chat.prewarm();
    await settle();
    active.set(chat.info()?.id ?? '', 1);
    await chat.newChat();

    await chat.dispose();

    // The live session's quit makes pi-crew abort everything itself.
    expect(aborted).toEqual([]);
  });
});

describe('PiChat approvals on the observe stream', () => {
  it('broadcasts an approval to every view of the slot, tagged with the asking client, as well as into the turn', async () => {
    const built: SlotSession[] = [];
    const chat: PiChat = new PiChat(
      {} as ModelCatalog,
      scripted(built),
      () =>
        Promise.resolve({
          guard: async (callId: string, tool: string, args: unknown, signal?: AbortSignal) => {
            const broker = (chat as unknown as {
              approvals: { request: (r: unknown, s?: AbortSignal) => Promise<boolean> };
            }).approvals;
            const approved = await broker.request({ callId, tool, target: '/vault', args }, signal);
            return approved ? undefined : { block: true as const, reason: 'denied' };
          },
        }),
      undefined,
      undefined,
      hermeticSources,
    );
    const observed: ChatChunk[] = [];
    const watching = new AbortController();
    void (async () => {
      for await (const chunk of chat.observe(watching.signal)) observed.push(chunk);
    })();
    const turn: ChatChunk[] = [];
    const sending = (async () => {
      for await (const chunk of chat.send('go', new AbortController().signal, {}, 'tab-1')) turn.push(chunk);
    })();
    await settle();
    const session = built[0];
    if (!session?.agent.beforeToolCall) throw new Error('no guard installed');
    const deciding = session.agent.beforeToolCall(
      { toolCall: { id: 'call-1', name: 'bash' }, args: { command: 'x' } } as never,
      new AbortController().signal,
    );
    await settle();

    expect(turn.filter((chunk) => chunk.kind === 'approval-request')).toEqual([
      expect.not.objectContaining({ origin: expect.anything() as unknown }),
    ]);
    expect(observed.filter((chunk) => chunk.kind === 'approval-request')).toEqual([
      expect.objectContaining({ callId: 'call-1', origin: 'tab-1' }),
    ]);

    // Answered from a second view of the slot, by the id it was shown.
    const shown = observed.find((chunk) => chunk.kind === 'approval-request');
    expect(chat.resolveApproval(shown?.kind === 'approval-request' ? shown.requestId : '', true)).toBe(true);
    await expect(deciding).resolves.toBeUndefined();
    // Every view hears the answer, so a card answered in one window settles in all.
    expect(observed.filter((chunk) => chunk.kind === 'approval-resolved')).toEqual([
      { kind: 'approval-resolved', requestId: shown?.kind === 'approval-request' ? shown.requestId : '', approved: true },
    ]);
    expect(turn.some((chunk) => chunk.kind === 'approval-resolved')).toBe(false);
    session.finish();
    await sending;
    watching.abort();
  });
});
