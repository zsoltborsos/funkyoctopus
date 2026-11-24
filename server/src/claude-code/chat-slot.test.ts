/**
 * ClaudeCodeChat as one slot among several (T2.1a): non-building reads, the
 * identity hook, the grace map shared across slots, skipping a session another
 * slot holds, the running-process cap and fresh starts. Scripted `claude`, no
 * process is ever spawned.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk, ModelOption } from '../../../src/shared/transport/protocol.ts';
import { describe, expect, it } from 'vitest';
import type { SessionRef } from '../chat-engine.ts';
import { wireErrorCode } from '../../../src/shared/transport/errors.ts';
import { follow, harness, ROOT, send } from '../test/claude-chat-harness.ts';
import { held } from '../test/fake-claude-query.ts';
import { turnFixture } from '../test/claude-fixtures.ts';
import type { StoredSession } from './sessions.ts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

const ROWS = fixture<StoredSession[]>('list-sessions');
const AGENTS = fixture<{ sessionId: string; name: string; cwd: string; status: string; kind: string; startedAt: number }[]>('agents');
const ALPHA = '/home/example/projects/alpha';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const own = (sessionId: string) => ({ ...(AGENTS[0] as (typeof AGENTS)[number]), sessionId });

describe('ClaudeCodeChat slot reads', () => {
  it('is a claude-code engine with no subagents left behind and nothing held at first', () => {
    const { chat } = harness([]);
    expect(chat.kind).toBe('claude-code');
    expect(chat.info()).toBeNull();
    expect(chat.busy()).toBe(false);
    expect(chat.running()).toBe(false);
    expect(chat.subagentsLeftRunning()).toBe(0);
  });

  it('counts as running from the start of its process until it is closed', async () => {
    const { chat, timers } = harness(['plain']);
    const turn = send(chat, 'hello');
    expect(chat.running()).toBe(true);
    expect(chat.busy()).toBe(true);
    await turn;
    expect(chat.running()).toBe(true);
    expect(chat.busy()).toBe(false);
    timers.fire();
    expect(chat.running()).toBe(false);
  });
});

describe('ClaudeCodeChat identity hook', () => {
  it('reports the session on open, re-root and adoption, and null on a new chat', async () => {
    const { chat, sessions } = harness(['plain']);
    sessions.rows = ROWS;
    const seen: (SessionRef | null)[] = [];
    chat.onIdentity((ref) => seen.push(ref));

    await chat.setRoot(ALPHA);
    await chat.openChat(`claude-code:${SECOND}`);
    await chat.newChat();
    // A fresh chat holds nothing until its process reports the id it got.
    await send(chat, 'hello');

    expect(seen).toEqual([
      { engine: 'claude-code', id: FIRST },
      { engine: 'claude-code', id: SECOND },
      null,
      { engine: 'claude-code', id: FIRST },
    ]);
  });

  it('reports nothing for a fork until the fork has an id of its own', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.running = AGENTS;
    const seen: (SessionRef | null)[] = [];
    chat.onIdentity((ref) => seen.push(ref));

    await chat.openChat(`claude-code:${FIRST}`);

    expect(chat.info()).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe('ClaudeCodeChat grace map shared across slots', () => {
  const clock = () => {
    let at = 1_000_000;
    return { now: () => at, advance: (ms: number) => { at += ms; } };
  };

  it('lets slot B resume a session slot A closed a moment ago, rather than forking it', async () => {
    const time = clock();
    const closed = new Map<string, number>();
    const a = harness(['plain'], { now: time.now, closed });
    const b = harness([], { now: time.now, closed });
    await send(a.chat, 'one');
    a.timers.fire();
    b.sessions.rows = ROWS;
    // `claude agents` still lists A's dying process.
    b.sessions.running = [own(FIRST)];
    time.advance(2_000);

    await b.chat.openChat(`claude-code:${FIRST}`);

    expect(b.chat.info()?.id).toBe(FIRST);
  });

  it('forks in slot B when the slots do not share one (the single-slot behaviour)', async () => {
    const time = clock();
    const a = harness(['plain'], { now: time.now });
    const b = harness([], { now: time.now });
    await send(a.chat, 'one');
    a.timers.fire();
    b.sessions.rows = ROWS;
    b.sessions.running = [own(FIRST)];
    time.advance(2_000);

    await b.chat.openChat(`claude-code:${FIRST}`);

    expect(b.chat.info()).toBeNull();
  });
});

describe('ClaudeCodeChat continuing a folder’s latest', () => {
  it('claims its pick, passing over a session another slot holds or claimed', async () => {
    const asked: SessionRef[] = [];
    const { chat, sessions } = harness([], {
      claim: (ref) => {
        asked.push(ref);
        return ref.id !== FIRST;
      },
    });
    sessions.rows = ROWS;

    await chat.setRoot(ALPHA);

    expect(chat.info()?.id).toBe(SECOND);
    expect(asked).toEqual([
      { engine: 'claude-code', id: FIRST },
      { engine: 'claude-code', id: SECOND },
    ]);
  });

  it('gives its pick back when a new chat overtakes the first re-root', async () => {
    const released: SessionRef[] = [];
    const { chat, sessions } = harness([], {
      root: ALPHA,
      claim: () => true,
      release: (ref) => released.push(ref),
    });
    sessions.rows = ROWS;

    const rooting = chat.setRoot(ALPHA);
    await chat.newChat();
    await rooting;

    expect(chat.info()).toBeNull();
    expect(released).toEqual([{ engine: 'claude-code', id: FIRST }]);
  });

  it('arms nothing in a slot created fresh: a re-applied folder continues nothing', async () => {
    const { chat, sessions } = harness([], { fresh: true });
    sessions.rows = ROWS;

    await chat.setRoot(ROOT);

    expect(chat.info()).toBeNull();
    expect(sessions.callsTo('list')).toEqual([]);
  });
});

describe('ClaudeCodeChat idle process', () => {
  it('is idle from the end of its last turn, and not while a turn runs or with no process', async () => {
    let at = 1_000;
    const { chat } = harness(['plain', 'plain'], { now: () => at });
    expect(chat.idleSince()).toBeNull();
    at = 2_000;
    const turn = send(chat, 'one');
    expect(chat.idleSince()).toBeNull();
    await turn;
    expect(chat.idleSince()).toBe(2_000);
  });

  it('closes an idle process on request, into the shared grace map, and the next send resumes', async () => {
    const closed = new Map<string, number>();
    const { chat, fake } = harness(['plain', 'plain'], { closed, now: () => 5_000 });
    await send(chat, 'one');

    expect(chat.closeIdle()).toBe(true);

    expect(chat.running()).toBe(false);
    expect(closed.get(FIRST)).toBe(5_000);
    expect(chat.info()?.id).toBe(FIRST);
    await send(chat, 'two');
    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST });
  });

  it('refuses to close a process that is not idle', async () => {
    const { chat } = harness(['plain']);
    expect(chat.closeIdle()).toBe(false);
    const turn = send(chat, 'one');
    expect(chat.closeIdle()).toBe(false);
    await turn;
  });
});

describe('ClaudeCodeChat running-process cap', () => {
  it('refuses to start a process when the cap says no, spawning nothing', async () => {
    const { chat, fake } = harness(['plain'], { mayStart: () => false });

    const error = await send(chat, 'hello').then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(wireErrorCode(error)).toBe('claude_cap_reached');
    expect(fake.queries).toHaveLength(0);
    expect(chat.running()).toBe(false);
    expect(chat.busy()).toBe(false);
  });

  it('asks only before a start: a process already up keeps serving', async () => {
    let allowed = true;
    const { chat, fake } = harness(['plain', 'plain'], { mayStart: () => allowed });
    await send(chat, 'one');
    allowed = false;
    await send(chat, 'two');
    expect(fake.queries).toHaveLength(1);
  });
});

describe('ClaudeCodeChat approvals on the observe stream', () => {
  it('broadcasts an approval to every view of the slot, tagged with the asking client, as well as into the turn', async () => {
    const vaultPath = join(await mkdtemp(join(tmpdir(), 'fo-claude-vault-')), 'vault.json');
    await writeFile(vaultPath, JSON.stringify([{ target: `${ROOT}/blocked`, action: 'escalate' }]));
    const { chat } = harness(['denied'], { guard: null, vaultPath });
    const watcher = follow(chat);

    const turn: ChatChunk[] = [];
    for await (const chunk of chat.send('read the secret', new AbortController().signal, {}, 'tab-1')) {
      turn.push(chunk);
      if (chunk.kind === 'approval-request') {
        // Answered from another view, which saw the broadcast copy.
        await new Promise((resolve) => setImmediate(resolve));
        const copy = watcher.seen.find((seen) => seen.kind === 'approval-request');
        expect(copy).toMatchObject({ requestId: chunk.requestId, origin: 'tab-1' });
        expect(chat.resolveApproval(chunk.requestId, true)).toBe(true);
      }
    }
    await watcher.end();

    expect(turn.filter((chunk) => chunk.kind === 'approval-request')).toEqual([
      expect.not.objectContaining({ origin: expect.anything() as unknown }),
    ]);
    // Every view hears the answer, so a card answered in one window settles in all.
    const asked = watcher.seen.find((seen) => seen.kind === 'approval-request');
    expect(watcher.seen.filter((seen) => seen.kind === 'approval-resolved')).toEqual([
      { kind: 'approval-resolved', requestId: asked?.kind === 'approval-request' ? asked.requestId : '', approved: true },
    ]);
    expect(turn.some((chunk) => chunk.kind === 'approval-resolved')).toBe(false);
  });
});

describe('ClaudeCodeChat model list shared across slots', () => {
  const recorded = JSON.parse(
    readFileSync(new URL('./fixtures/supported-models.json', import.meta.url), 'utf8'),
  ) as unknown[];

  it('lets every Claude slot offer the models one slot’s process listed, without asking again', async () => {
    const modelCache = { models: null };
    const first = harness(['plain'], { modelCache }, recorded);
    const second = harness(['plain'], { modelCache }, recorded);
    expect((await second.chat.list()).map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);

    await send(first.chat, 'one');
    await expect.poll(async () => (await second.chat.list())[0]?.id).toBe('opus');

    await send(second.chat, 'two');
    expect(second.fake.queries[0]?.supportedModelsAsked).toBe(0);
  });
});

describe('ClaudeCodeChat model list kept from the last run', () => {
  const recorded = JSON.parse(
    readFileSync(new URL('./fixtures/supported-models.json', import.meta.url), 'utf8'),
  ) as { value: string }[];
  // What a restart brings back: the last run's list, which the first live process must still replace.
  const lastRun = (): ModelOption[] => [
    { provider: 'claude-code', id: 'last-run', name: 'Last run', thinkingLevels: [], input: ['text'] },
  ];
  const ids = (models: ModelOption[]): string[] => models.map((model) => model.id);

  it('offers the last run’s list before any process, then replaces it with the first live process’s list', async () => {
    const modelCache = { models: lastRun(), stale: true };
    const { chat, fake } = harness(['plain'], { modelCache }, recorded);
    expect(ids(await chat.list())).toEqual(['last-run']);
    expect(fake.queries).toHaveLength(0);

    await send(chat, 'one');

    await expect.poll(async () => ids(await chat.list())).toEqual(recorded.map((model) => model.value));
    expect(fake.queries[0]?.supportedModelsAsked).toBe(1);
  });

  it('hands the live list to the cache’s persist hook once, and asks no further process', async () => {
    const persisted: ModelOption[][] = [];
    const modelCache = { models: lastRun(), stale: true, persist: (models: ModelOption[]) => persisted.push(models) };
    const first = harness(['plain'], { modelCache }, recorded);
    const second = harness(['plain'], { modelCache }, recorded);

    await send(first.chat, 'one');
    await expect.poll(() => persisted.length).toBe(1);
    await send(second.chat, 'two');

    expect(persisted.map(ids)).toEqual([recorded.map((model) => model.value)]);
    expect(second.fake.queries[0]?.supportedModelsAsked).toBe(0);
  });

  it('keeps the last run’s list, and persists nothing, when the live process cannot list models', async () => {
    const persisted: ModelOption[][] = [];
    const modelCache = { models: lastRun(), stale: true, persist: (models: ModelOption[]) => persisted.push(models) };
    const { chat, fake } = harness(['plain'], { modelCache }, new Error('no models today'));

    await send(chat, 'one');
    await expect.poll(() => fake.queries[0]?.supportedModelsAsked).toBe(1);

    expect(ids(await chat.list())).toEqual(['last-run']);
    expect(persisted).toEqual([]);
  });
});

describe('ClaudeCodeChat dispose', () => {
  it('fails a turn still running with chat_closed, rather than ending it silently', async () => {
    const { chat, fake } = harness([held(turnFixture('plain'))]);
    const turn = send(chat, 'wait for it');
    await expect.poll(() => fake.queries[0]?.calls.includes('input') ?? false).toBe(true);

    await chat.dispose();

    await expect(turn).rejects.toMatchObject({ code: 'chat_closed' });
  });

  it('ends every observe stream, as closing the chat must', async () => {
    const { chat } = harness([]);
    const watcher = follow(chat);
    let ended = false;
    void watcher.done.then(() => {
      ended = true;
    });

    await chat.dispose();
    await expect.poll(() => ended).toBe(true);
  });
});
