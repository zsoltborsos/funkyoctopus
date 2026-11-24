import { describe, expect, it, vi } from 'vitest';
import { MethodRegistry, type CallContext } from '../transport/registry.ts';
import type { ChatSlots } from '../chat-registry.ts';
import type { LbCliRunner, LbInvocation } from '../leeboard/cli.ts';
import type { ChatSlotInfo, ProjectOption } from '../../../src/shared/transport/protocol.ts';
import { registerLeeboardSeam } from './leeboard.ts';

const ctx: CallContext = { signal: new AbortController().signal };

const slot = (chatId: string, root: string | null): ChatSlotInfo => ({
  chatId,
  kind: 'pi',
  createdAt: 0,
  lastUsedAt: 0,
  crew: false,
  crewPending: false,
  attention: false,
  busy: false,
  session: null,
  root,
  subagentsLeftRunning: 0,
});

const entry = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  scope: 'project:funkyoctopus',
  status: 'active',
  title,
  author: { harness: 'claude-code', session: 's1', origin: 'user-stated' },
  created: '2026-10-18T11:00:00Z',
  updated: '2026-10-18T11:00:00Z',
  ...extra,
});

const BRIEF = {
  project: 'funkyoctopus',
  unregisteredRepo: null,
  holds: [entry('hold-no-deploys-ab12', 'hold', 'No deploys', { release: 'when the tunnel closes', blocks: ['deploy'] })],
  grants: [],
  rules: [entry('rule-stage-by-name-cd34', 'rule', 'Stage files by name')],
  references: [],
  inbox: [entry('handoff-take-l3-ef56', 'handoff', 'Take L3', { to: 'project:funkyoctopus' })],
  repoState: [{ path: 'TASKS.md', lastCommit: '2026-10-19', daysAgo: 0, commitsSince: 2 }],
};

const ok = (value: unknown): LbInvocation => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

const project = (name: string, path: string): ProjectOption => ({ id: path, name, path, envTier: 'normal' });

function seam(
  answer: (args: string[]) => LbInvocation | Promise<LbInvocation> = () => ok(BRIEF),
  slots: ChatSlotInfo[] = [slot('main', null), slot('b', '/work/alpha')],
  projects: ProjectOption[] = [],
) {
  const calls: string[][] = [];
  const run: LbCliRunner = vi.fn((args: string[]) => {
    calls.push(args);
    return Promise.resolve(answer(args));
  });
  const chats: Pick<ChatSlots, 'list'> = { list: () => slots };
  const registry = new MethodRegistry();
  registerLeeboardSeam(registry, chats, run, '/home/me/Work', () => Promise.resolve(projects));
  const invoke = (name: string, params: unknown) => {
    const handler = registry.get(name);
    if (handler?.kind !== 'call') throw new Error(`no such call: ${name}`);
    // As the transport does: a handler that throws is a rejected call.
    return Promise.resolve().then(() => handler.handler(params, ctx));
  };
  return { invoke, calls };
}

describe('leeboard.brief', () => {
  it("briefs the slot's own folder, and the configured global root for a slot with none", async () => {
    const { invoke, calls } = seam();
    await invoke('leeboard.brief', { chatId: 'b' });
    await invoke('leeboard.brief', { chatId: 'main' });
    expect(calls).toEqual([
      ['brief', '--json', '--harness', 'funkyoctopus', '--cwd=/work/alpha'],
      ['brief', '--json', '--harness', 'funkyoctopus', '--cwd=/home/me/Work'],
    ]);
  });

  it("parses Leeboard's brief into the wire shape", async () => {
    const { invoke } = seam();
    const result = await invoke('leeboard.brief', { chatId: 'main' });
    expect(result).toEqual({
      brief: {
        project: 'funkyoctopus',
        unregisteredRepo: null,
        holds: [
          expect.objectContaining({
            id: 'hold-no-deploys-ab12',
            kind: 'hold',
            title: 'No deploys',
            harness: 'claude-code',
            release: 'when the tunnel closes',
            blocks: ['deploy'],
          }),
        ],
        grants: [],
        rules: [expect.objectContaining({ id: 'rule-stage-by-name-cd34', title: 'Stage files by name' })],
        references: [],
        inbox: [expect.objectContaining({ id: 'handoff-take-l3-ef56', to: 'project:funkyoctopus' })],
        repoState: [{ path: 'TASKS.md', lastCommit: '2026-10-19', daysAgo: 0, commitsSince: 2 }],
      },
    });
  });

  it('drops a malformed row but keeps the rest', async () => {
    const { invoke } = seam(() => ok({ ...BRIEF, rules: [{ id: '--help', title: 'x' }, ...BRIEF.rules] }));
    const result = (await invoke('leeboard.brief', { chatId: 'main' })) as { brief: { rules: unknown[] } };
    expect(result.brief.rules).toHaveLength(1);
  });

  it('refuses an unknown chat and a missing chatId without running lb', async () => {
    const { invoke, calls } = seam();
    await expect(invoke('leeboard.brief', { chatId: 'gone' })).rejects.toMatchObject({ code: 'chat_not_found' });
    await expect(invoke('leeboard.brief', {})).rejects.toThrow(/chatId/);
    expect(calls).toEqual([]);
  });
});

describe('leeboard faults are values, never transport errors', () => {
  it('lb missing reads as leeboard_unavailable', async () => {
    const { invoke } = seam(() => ({ code: 127, stdout: '', stderr: '' }));
    expect(await invoke('leeboard.brief', { chatId: 'main' })).toEqual({
      brief: null,
      error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' },
    });
  });

  it('a non-zero exit carries the first stderr line', async () => {
    const { invoke } = seam(() => ({ code: 1, stdout: '', stderr: 'lb: store is locked\nmore\n' }));
    expect(await invoke('leeboard.review', {})).toEqual({
      review: null,
      error: { code: 'leeboard_failed', message: 'lb review exited 1: lb: store is locked' },
    });
  });

  it('a timeout, a rejected runner and unparsable JSON each say so', async () => {
    expect(await seam(() => ({ code: 124, stdout: '', stderr: '' })).invoke('leeboard.brief', { chatId: 'main' }))
      .toEqual({ brief: null, error: { code: 'leeboard_timeout', message: 'lb brief timed out' } });
    expect(await seam(() => Promise.reject(new Error('spawn EACCES'))).invoke('leeboard.brief', { chatId: 'main' }))
      .toEqual({ brief: null, error: { code: 'leeboard_failed', message: 'lb brief exited 1: spawn EACCES' } });
    expect(await seam(() => ({ code: 0, stdout: 'not json', stderr: '' })).invoke('leeboard.brief', { chatId: 'main' }))
      .toMatchObject({ brief: null, error: { code: 'leeboard_bad_output' } });
  });

  it('a brief whose lists are not lists is bad output, not an empty brief', async () => {
    const { invoke } = seam(() => ok({ ...BRIEF, inbox: 'none' }));
    expect(await invoke('leeboard.brief', { chatId: 'main' })).toMatchObject({
      brief: null,
      error: { code: 'leeboard_bad_output' },
    });
  });
});

describe('leeboard.show', () => {
  it('runs lb show for a well-formed id and returns the body', async () => {
    const { invoke, calls } = seam(() => ok({ ...entry('hold-no-deploys-ab12', 'hold', 'No deploys'), body: 'Wait for the tunnel.' }));
    const result = await invoke('leeboard.show', { id: 'hold-no-deploys-ab12' });
    expect(calls).toEqual([['show', 'hold-no-deploys-ab12', '--json']]);
    expect(result).toMatchObject({ entry: { id: 'hold-no-deploys-ab12', title: 'No deploys', body: 'Wait for the tunnel.' } });
  });

  it.each([['-x'], ['--help'], ['hold'], ['hold--x'], ['HOLD-a'], ['note-abc'], ['hold-a b'], ['hold-a/../b'], [''], [42], [null]])(
    'rejects %j without running lb',
    async (id) => {
      const { invoke, calls } = seam();
      await expect(invoke('leeboard.show', { id })).rejects.toThrow(/leeboard\.show requires/);
      expect(calls).toEqual([]);
    },
  );

  it('an unknown id is its own fault', async () => {
    const { invoke } = seam(() => ({ code: 4, stdout: '', stderr: "lb: no entry matches 'rule-gone-0000'\n" }));
    expect(await invoke('leeboard.show', { id: 'rule-gone-0000' })).toEqual({
      entry: null,
      error: { code: 'leeboard_unknown_id', message: "lb: no entry matches 'rule-gone-0000'" },
    });
  });
});

describe('leeboard.review', () => {
  it('always peeks, so reading the digest never marks it seen', async () => {
    const row = { id: 'rule-new-one-1111', kind: 'rule', scope: 'global', title: 'New one', status: 'active', harness: 'bosun' };
    const { invoke, calls } = seam(() => ok({ new: [row], changed: [], closed: [] }));
    const result = await invoke('leeboard.review', {});
    await invoke('leeboard.review', { peek: false });
    expect(calls).toEqual([
      ['review', '--peek', '--json'],
      ['review', '--peek', '--json'],
    ]);
    expect(result).toEqual({
      review: {
        new: [{ id: 'rule-new-one-1111', kind: 'rule', scope: 'global', title: 'New one', status: 'active' }],
        changed: [],
        closed: [],
      },
    });
  });
});

describe('leeboard.holds', () => {
  it('lists every scope newest first with exactly lb list --kind=hold --status=active --json, no identity filters', async () => {
    const scopes = ['global', 'machine', 'project:alpha', 'project:beta', 'project:gamma'];
    const rows = scopes.map((scope, i) => entry(`hold-scope-${i}`, 'hold', scope, {
      scope, updated: `2026-10-${20 + i}T11:00:00Z`,
    }));
    const { invoke, calls } = seam(() => ok([
      ...rows, null, { id: '--help' },
      entry('request-not-hold-1', 'request', 'Not a hold'),
      entry('hold-done-1', 'hold', 'Done', { status: 'done' }),
    ]), []);
    const result = await invoke('leeboard.holds', {});
    expect(calls).toEqual([['list', '--kind=hold', '--status=active', '--json']]);
    expect(result).toEqual({ holds: rows.toReversed().map((row): unknown => expect.objectContaining({ id: row.id, scope: row.scope })) });
  });

  it('returns an honest empty array', async () => {
    expect(await seam(() => ok([])).invoke('leeboard.holds', {})).toEqual({ holds: [] });
  });

  it('mirrors isActive expiry: lapsed date-only and timestamps drop; today, equal, future, missing and unreadable stay', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-14T23:59:59.000Z'));
      const untils = ['2026-11-13', '2026-11-14', '2026-11-14T23:59:58.999Z',
        '2026-11-14T23:59:59.000Z', '2026-11-15T00:00:00Z', undefined, 'unreadable'];
      const rows = untils.map((until, i) => entry(`hold-expiry-${i}`, 'hold', 'Wait', { until }));
      const { invoke } = seam(() => ok(rows));
      expect(await invoke('leeboard.holds', {})).toEqual({
        holds: [1, 3, 4, 5, 6].map((i): unknown => expect.objectContaining({ id: `hold-expiry-${i}` })),
      });
      vi.setSystemTime(new Date('2026-11-14T23:59:59.999Z'));
      expect(await seam(() => ok([rows[1]])).invoke('leeboard.holds', {})).toMatchObject({ holds: [{ id: 'hold-expiry-1' }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['missing CLI', { code: 127, stdout: '', stderr: '' }, 'leeboard_unavailable', 'lb was not found on PATH'],
    ['timeout', { code: 124, stdout: '', stderr: '' }, 'leeboard_timeout', 'lb list timed out'],
    ['nonzero exit', { code: 2, stdout: '', stderr: 'locked\nmore' }, 'leeboard_failed', 'lb list exited 2: locked'],
    ['invalid JSON', { code: 0, stdout: 'not json', stderr: '' }, 'leeboard_bad_output', 'lb list printed something FunkyOctopus cannot read'],
    ['non-array output', ok({ holds: [] }), 'leeboard_bad_output', 'lb list printed something FunkyOctopus cannot read'],
  ])('reports %s in band', async (_name, answer, code, message) => {
    expect(await seam(() => answer).invoke('leeboard.holds', {})).toEqual({ holds: null, error: { code, message } });
  });

  it('reports runner rejection in band', async () => {
    expect(await seam(() => Promise.reject(new Error('spawn EACCES'))).invoke('leeboard.holds', {})).toEqual({
      holds: null, error: { code: 'leeboard_failed', message: 'lb list exited 1: spawn EACCES' },
    });
  });
});

describe('leeboard.open (T3 L5)', () => {
  const request = entry('request-fix-the-login-aa11', 'request', 'Fix the login', {
    scope: 'global',
    to: 'project:alpha',
    author: { harness: 'pi', session: '0199-asker', origin: 'agent-inferred' },
    updated: '2026-10-19T09:00:00Z',
  });
  const handoff = entry('handoff-ship-the-beta-bb22', 'handoff', 'Ship the beta', {
    to: 'project:beta',
    updated: '2026-10-19T10:00:00Z',
  });
  const toSession = entry('request-for-a-session-cc33', 'request', 'For a session', { to: 'session:sess-held' });
  const toAnyone = entry('request-for-anyone-dd44', 'request', 'For anyone', { to: 'any' });
  const lists = (args: string[]) =>
    ok(args.includes('--kind=request') ? [request, toSession, toAnyone] : [handoff]);
  const held = (chatId: string, root: string | null, id: string, lastUsedAt = 0): ChatSlotInfo => ({
    ...slot(chatId, root),
    lastUsedAt,
    session: { engine: 'claude-code', id, path: `/x/${id}.jsonl` } as ChatSlotInfo['session'],
  });

  it('lists active requests and handoffs with no author filter and no FO identity', async () => {
    const { invoke, calls } = seam(lists);
    await invoke('leeboard.open', {});
    expect(calls).toEqual([
      ['list', '--kind=request', '--status=active', '--json'],
      ['list', '--kind=handoff', '--status=active', '--json'],
    ]);
  });

  it("routes a project target to its newest tab inside the project's folder, with the folder", async () => {
    const slots = [
      slot('main', null),
      { ...slot('old', '/work/alpha'), lastUsedAt: 1 },
      { ...slot('new', '/work/alpha/app'), lastUsedAt: 5 },
      // Nested project: this tab belongs to alpha-docs, not alpha.
      { ...slot('docs', '/work/alpha/docs'), lastUsedAt: 9 },
      // A sibling sharing the prefix is not inside.
      { ...slot('sib', '/work/alpha-old'), lastUsedAt: 9 },
    ];
    const projects = [project('alpha', '/work/alpha'), project('alpha-docs', '/work/alpha/docs'), project('beta', '/work/beta')];
    const { invoke } = seam(lists, slots, projects);
    const result = (await invoke('leeboard.open', {})) as { open: { id: string; chatId: string | null; folder: string | null }[] };
    expect(result.open.map(({ id, chatId, folder }) => ({ id, chatId, folder }))).toEqual([
      { id: 'handoff-ship-the-beta-bb22', chatId: null, folder: '/work/beta' },
      { id: 'request-fix-the-login-aa11', chatId: 'new', folder: '/work/alpha' },
      { id: 'request-for-a-session-cc33', chatId: null, folder: null },
    ]);
  });

  it('carries the author session, so the prompt can say who asked', async () => {
    const { invoke } = seam(lists, [slot('main', null)], [project('alpha', '/work/alpha')]);
    const result = (await invoke('leeboard.open', {})) as { open: { id: string; harness: string; session?: string }[] };
    expect(result.open.find((row) => row.id === 'request-fix-the-login-aa11')).toMatchObject({
      harness: 'pi',
      session: '0199-asker',
      to: 'project:alpha',
    });
  });

  it('routes a session target to the tab holding that session; any and harness targets are not routed', async () => {
    const { invoke } = seam(lists, [slot('main', null), held('c', '/work/x', 'sess-held')]);
    const result = (await invoke('leeboard.open', {})) as { open: { id: string; chatId: string | null }[] };
    expect(result.open.find((row) => row.id === 'request-for-a-session-cc33')?.chatId).toBe('c');
    expect(result.open.some((row) => row.id === 'request-for-anyone-dd44')).toBe(false);
  });

  it('a project Leeboard lists no folder for routes nowhere', async () => {
    const { invoke } = seam(lists, [slot('main', '/work/alpha')], []);
    const result = (await invoke('leeboard.open', {})) as { open: { id: string; chatId: string | null; folder: string | null }[] };
    expect(result.open.find((row) => row.id === 'request-fix-the-login-aa11')).toMatchObject({ chatId: null, folder: null });
  });

  it('a failing list is an in-band fault', async () => {
    const { invoke } = seam(() => ({ code: 127, stdout: '', stderr: '' }));
    expect(await invoke('leeboard.open', {})).toEqual({
      open: null,
      error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' },
    });
    expect(await seam(() => ok({ not: 'a list' })).invoke('leeboard.open', {})).toMatchObject({
      open: null,
      error: { code: 'leeboard_bad_output' },
    });
  });
});

describe('leeboard.asked (T3 L5)', () => {
  const asking = (session: string | null) =>
    session === null ? slot('main', null) : { ...slot('main', null), session: { engine: 'pi', id: session, path: '/s.jsonl' } as ChatSlotInfo['session'] };
  const waiting = entry('request-waiting-one-1111', 'request', 'Waiting', { to: 'project:alpha' });
  const answered = entry('request-answered-2222', 'request', 'Answered', { to: 'project:alpha' });
  const closed = entry('request-closed-3333', 'request', 'Closed', { to: 'project:beta', status: 'done' });
  const answer = (args: string[]) => {
    if (args[0] === 'list') return ok([waiting, answered, closed]);
    const body = args[1] === answered.id ? 'Please fix it.\n\n## Reply (2026-10-19T10:00:00Z, claude-code/s2)\nFixed.\n' : 'Please.';
    return ok({ ...entry(args[1]!, 'request', 'x'), body });
  };

  it("lists the slot session's requests by author filter, reading only active bodies", async () => {
    const { invoke, calls } = seam(answer, [asking('0199a1b2-c3d4')]);
    const result = await invoke('leeboard.asked', { chatId: 'main' });
    expect(calls[0]).toEqual(['list', '--kind=request', '--session=0199a1b2-c3d4', '--json']);
    expect(calls.slice(1).sort()).toEqual([
      ['show', 'request-answered-2222', '--json'],
      ['show', 'request-waiting-one-1111', '--json'],
    ]);
    expect((result as { asked: { id: string; replied: boolean }[] }).asked.map(({ id, replied }) => ({ id, replied }))).toEqual([
      { id: 'request-waiting-one-1111', replied: false },
      { id: 'request-answered-2222', replied: true },
      { id: 'request-closed-3333', replied: true },
    ]);
  });

  it('is empty, without running lb, while the slot has no session', async () => {
    const { invoke, calls } = seam(answer, [asking(null)]);
    expect(await invoke('leeboard.asked', { chatId: 'main' })).toEqual({ asked: [] });
    expect(calls).toEqual([]);
  });

  it.each([['--help'], ['-x'], ['a b'], ['a/../b'], [''], ['x'.repeat(129)]])(
    'never hands lb a session id like %j',
    async (id) => {
      const { invoke, calls } = seam(answer, [asking(id)]);
      expect(await invoke('leeboard.asked', { chatId: 'main' })).toEqual({ asked: [] });
      expect(calls).toEqual([]);
    },
  );

  it('an unreadable body leaves that request unanswered, not the list unread', async () => {
    const { invoke } = seam((args) => (args[0] === 'list' ? ok([waiting]) : { code: 1, stdout: '', stderr: 'boom' }), [asking('s1')]);
    expect(await invoke('leeboard.asked', { chatId: 'main' })).toMatchObject({ asked: [{ id: waiting.id, replied: false }] });
  });

  it('refuses an unknown chat without running lb', async () => {
    const { invoke, calls } = seam(answer, [asking('s1')]);
    await expect(invoke('leeboard.asked', { chatId: 'gone' })).rejects.toMatchObject({ code: 'chat_not_found' });
    expect(calls).toEqual([]);
  });
});
