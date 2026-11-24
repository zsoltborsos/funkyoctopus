import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import type { ClaudeJsonRunner } from './cli.ts';
import { ClaudeCodeStatus, type ClaudeCodeStatusDeps } from './status.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const BIN = '/opt/claude/bin/claude';
const NOT_LOGGED_IN = 'Claude Code is not logged in — run `claude`, then /login, in a terminal';

/** A scripted `claude` CLI: the answer (or failure) per subcommand. */
interface Script {
  auth?: { exitCode: number; json: unknown } | Error;
  agents?: { exitCode: number; json: unknown } | Error;
}

function harness(script: Script = {}, overrides: Partial<ClaudeCodeStatusDeps> = {}) {
  let clock = 1_000_000;
  const answer = (value: Script['auth']) => {
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? { exitCode: 0, json: [] });
  };
  const runJson = vi.fn<ClaudeJsonRunner>((args) =>
    args[0] === 'auth'
      ? answer(script.auth ?? { exitCode: 0, json: fixture('auth-status') })
      : answer(script.agents ?? { exitCode: 0, json: [] }),
  );
  const usage = fakeQuery(usageMessages());
  const listSessions = vi.fn(() => Promise.resolve([]));
  const deps: ClaudeCodeStatusDeps = {
    bin: 'claude',
    version: '9.9.9',
    pathEnv: '/usr/bin',
    env: {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      HOME: '/home/example',
    },
    resolveBin: () => Promise.resolve(BIN),
    runJson,
    query: usage.query,
    listSessions,
    now: () => clock,
    ...overrides,
  };
  return {
    status: new ClaudeCodeStatus(deps),
    runJson,
    query: usage.calls,
    listSessions,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('ClaudeCodeStatus auth', () => {
  it('forwards only the plan facts, never the account', async () => {
    const { status } = harness();
    const result = await status.status();
    expect(result.cli).toBe('ok');
    expect(result.auth).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    });
    expect(JSON.stringify(result)).not.toMatch(/owner@example\.com|Example Organization|00000000-0000-0000-0000-000000000000|\/\.claude/);
  });

  it('runs the resolved binary with the sanitized environment and a bounded timeout', async () => {
    const { status, runJson } = harness();
    await status.status();
    expect(runJson).toHaveBeenCalledWith(
      ['auth', 'status', '--json'],
      expect.objectContaining({
        bin: BIN,
        timeoutMs: 10_000,
        env: { PATH: '/usr/bin', HOME: '/home/example', CLAUDE_AGENT_SDK_CLIENT_APP: 'funkyoctopus/9.9.9' },
      }),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['an API key', { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['an auth token', { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }],
    ['Amazon Bedrock', { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }],
  ])('reports a sign-in with %s as it is, with no subscription quota to read', async (_name, json) => {
    const { status, query } = harness({ auth: { exitCode: 0, json } });
    const result = await status.status();
    expect(result).toEqual({
      cli: 'ok',
      auth: { loggedIn: true, authMethod: json.authMethod, apiProvider: json.apiProvider },
      live: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports a logged-out CLI as a value naming the terminal fix, and reads no usage', async () => {
    const { status, query } = harness({
      auth: { exitCode: 1, json: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } },
    });
    const result = await status.status();
    expect(result).toMatchObject({
      cli: 'ok',
      auth: { loggedIn: false, authMethod: 'none' },
      live: [],
      error: NOT_LOGGED_IN,
    });
    expect(result.usage).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports a missing binary without spawning anything', async () => {
    const { status, runJson, query } = harness({}, { resolveBin: () => Promise.resolve(null) });
    const result = await status.status();
    expect(result).toEqual({
      cli: 'missing',
      live: [],
      error: 'Claude Code not found — install it, or set CLAUDE_BIN',
    });
    expect(runJson).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports a binary that vanished after resolution as missing too', async () => {
    const { status } = harness({ auth: new WireCallError('Claude Code not found: x', 'claude_unavailable') });
    expect((await status.status()).cli).toBe('missing');
  });

  it('turns a failing or confused CLI into a humane error value, never a throw', async () => {
    const failing = harness({ auth: new WireCallError('claude auth timed out after 10 s', 'claude_cli_error') });
    expect(await failing.status.status()).toEqual({
      cli: 'error',
      live: [],
      error: 'claude auth timed out after 10 s',
    });

    const confused = harness({ auth: { exitCode: 0, json: { hello: 'world' } } });
    expect(await confused.status.status()).toMatchObject({ cli: 'error', live: [] });
  });
});

const agentCalls = (runJson: ReturnType<typeof harness>['runJson']) =>
  runJson.mock.calls.filter(([args]) => args[0] === 'agents');

describe('ClaudeCodeStatus live sessions', () => {
  it('maps `claude agents --json` to wire rows, leaving the pid behind', async () => {
    const { status, runJson } = harness({ agents: { exitCode: 0, json: fixture('agents') } });
    const { live } = await status.status();
    expect(live).toHaveLength(7);
    expect(live[0]).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'alpha-a',
      cwd: '/home/example/projects/alpha',
      status: 'idle',
      kind: 'interactive',
      startedAt: 1792226587162,
    });
    expect(live.map((row) => row.status)).toEqual(['idle', 'idle', 'busy', 'idle', 'idle', 'idle', 'busy']);
    expect(agentCalls(runJson)[0]?.[0]).toEqual(['agents', '--json']);
    expect(agentCalls(runJson)[0]?.[1]).toMatchObject({ bin: BIN, timeoutMs: 10_000 });
  });

  it('skips rows without a session id and tolerates missing optional fields', async () => {
    const { status } = harness({
      agents: { exitCode: 0, json: [{ name: 'orphan' }, { sessionId: 's-1', cwd: '/w', status: 'busy', startedAt: 5 }] },
    });
    expect((await status.live()).live).toEqual([
      { sessionId: 's-1', name: 's-1', cwd: '/w', status: 'busy', kind: 'unknown', startedAt: 5 },
    ]);
  });

  it('shares one read between concurrent callers and caches it for 10 seconds', async () => {
    const { status, runJson, advance } = harness({ agents: { exitCode: 0, json: fixture('agents') } });
    await Promise.all([status.live(), status.live(), status.status()]);
    expect(agentCalls(runJson)).toHaveLength(1);

    advance(9_999);
    await status.live();
    expect(agentCalls(runJson)).toHaveLength(1);

    advance(2);
    await status.live();
    expect(agentCalls(runJson)).toHaveLength(2);
  });

  it('reads afresh when asked to, whatever the cache holds, and does not join a read already in flight', async () => {
    const { status, runJson } = harness({ agents: { exitCode: 0, json: fixture('agents') } });
    await status.live();

    const [first, second] = await Promise.all([status.live(true), status.live(true)]);

    // Opening a session acts on this answer: a cached or shared picture may be older than the call.
    expect(agentCalls(runJson)).toHaveLength(3);
    expect(first.live).toHaveLength(7);
    expect(second.live).toHaveLength(7);
  });

  it('reports a failed listing as an error value beside an empty list, leaving the rest of the status intact', async () => {
    const { status } = harness({ agents: new WireCallError('claude agents exited 2: boom', 'claude_cli_error') });
    expect(await status.status()).toMatchObject({
      cli: 'ok',
      auth: { loggedIn: true },
      live: [],
      error: 'Could not list live Claude Code sessions — claude agents exited 2: boom',
    });
  });
});

type Message = Record<string, unknown>;

/** The recorded `/usage` message stream; tests edit a copy to stage other outcomes. */
const usageMessages = (): Message[] => JSON.parse(JSON.stringify(fixture('usage-query-messages'))) as Message[];

/** A `query()` that yields `messages` and records `close()`; `hang` never yields past them. */
function fakeQuery(messages: Message[], { hang = false, throws }: { hang?: boolean; throws?: Error } = {}) {
  const close = vi.fn();
  const query = vi.fn((_params: unknown) => {
    const stream = (async function* () {
      if (throws) throw throws;
      for (const message of messages) yield message;
      if (hang) await new Promise<void>(() => undefined);
    })();
    return Object.assign(stream, { close });
  });
  return { query: query as unknown as ClaudeCodeStatusDeps['query'], calls: query, close };
}

/** The recorded reset times, 2026-10-17T18:30:00.372Z and 2026-10-21T13:00:00.372Z (month 9 is October). */
const SESSION_RESET = Date.UTC(2026, 9, 17, 18, 30, 0, 372);
const WEEK_RESET = Date.UTC(2026, 9, 21, 13, 0, 0, 372);

describe('ClaudeCodeStatus usage', () => {
  it('maps the recorded /usage report to labelled meters', async () => {
    const { query } = fakeQuery(usageMessages());
    const { status } = harness({}, { query });
    expect(await status.usage()).toEqual({
      fetchedAt: 1_000_000,
      limits: [
        { kind: 'session', label: '5h', percent: 72, resetsAt: SESSION_RESET, active: true },
        { kind: 'weekly_all', label: 'week', percent: 72, resetsAt: WEEK_RESET, active: false },
        { kind: 'weekly_scoped', label: 'Fable week', percent: 11, resetsAt: WEEK_RESET, active: false },
      ],
    });
  });

  it('asks the installed claude for /usage with the sanitized env, no transcript, no owner settings, and closes the query', async () => {
    const { query, calls, close } = fakeQuery(usageMessages());
    const { status } = harness({}, { query });
    await status.usage();
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0]?.[0]).toEqual({
      prompt: '/usage',
      options: {
        pathToClaudeCodeExecutable: BIN,
        env: { PATH: '/usr/bin', HOME: '/home/example', CLAUDE_AGENT_SDK_CLIENT_APP: 'funkyoctopus/9.9.9' },
        persistSession: false,
        cwd: tmpdir(),
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        abortController: expect.any(AbortController) as AbortController,
      },
    });
    expect(close).toHaveBeenCalled();
  });

  it('reads no numbers when the usage process turns out to run on an API key', async () => {
    const messages = usageMessages();
    (messages[0] as Message).apiKeySource = 'ANTHROPIC_API_KEY';
    const { query, close } = fakeQuery(messages);
    const { status } = harness({}, { query });
    const usage = await status.usage();
    expect(usage).toEqual({ error: 'Claude is on an API key — no subscription quota to read' });
    expect(close).toHaveBeenCalled();
    expect(await status.status()).toMatchObject({ cli: 'ok', usage: { error: expect.stringContaining('no subscription quota') as string } });
  });

  it('fails closed when Claude Code never says where its auth came from', async () => {
    const messages = usageMessages().slice(1);
    const { query } = fakeQuery(messages);
    const { status } = harness({}, { query });
    expect(await status.usage()).toEqual({ error: expect.stringContaining('did not report') as string });
  });

  it('turns an authentication failure into the logged-out line', async () => {
    const messages = usageMessages();
    const assistant = messages[1] as Message;
    delete assistant.usage_report;
    assistant.error = 'authentication_failed';
    const { query } = fakeQuery(messages);
    const { status } = harness({}, { query });
    expect(await status.usage()).toEqual({ error: NOT_LOGGED_IN });
  });

  it('says so when the report carries no meters, instead of showing nothing', async () => {
    const noReport = usageMessages();
    delete (noReport[1] as Message).usage_report;
    expect(await harness({}, { query: fakeQuery(noReport).query }).status.usage())
      .toEqual({ error: expect.stringContaining('did not report usage') as string });

    const failing = usageMessages();
    ((failing[1] as Message).usage_report as { rate_limits: unknown }).rate_limits = null;
    expect(await harness({}, { query: fakeQuery(failing).query }).status.usage())
      .toEqual({ error: expect.stringContaining('could not fetch') as string });
  });

  it('labels an unknown meter by its kind and skips rows it cannot read', async () => {
    const messages = usageMessages();
    const report = (messages[1] as Message).usage_report as { rate_limits: { limits: unknown[] } };
    report.rate_limits.limits = [
      { kind: 'daily_opus', group: 'daily', percent: 40, resets_at: null, severity: 'normal', is_active: false, shiny: true },
      { kind: 'weekly_scoped', percent: 5, resets_at: 'not a date', scope: { surface: { display_name: 'Desktop' } }, is_active: true },
      { kind: 'weekly_scoped', percent: 6, resets_at: null, scope: null, is_active: false },
      { kind: 'session', percent: 'lots' },
      'garbage',
    ];
    const { status } = harness({}, { query: fakeQuery(messages).query });
    expect(await status.usage()).toEqual({
      fetchedAt: 1_000_000,
      limits: [
        { kind: 'daily_opus', label: 'daily_opus', percent: 40, resetsAt: null, active: false },
        { kind: 'weekly_scoped', label: 'Desktop week', percent: 5, resetsAt: null, active: true },
        { kind: 'weekly_scoped', label: 'weekly_scoped', percent: 6, resetsAt: null, active: false },
      ],
    });
  });

  it('shares one read between concurrent callers and keeps it for 5 minutes', async () => {
    const { query, calls } = fakeQuery(usageMessages());
    const { status, advance } = harness({}, { query });
    await Promise.all([status.usage(), status.usage(), status.status()]);
    expect(calls).toHaveBeenCalledOnce();

    advance(4 * 60_000 + 59_000);
    await status.usage();
    expect(calls).toHaveBeenCalledOnce();

    advance(2_000);
    await status.usage();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('honours a forced refresh only once the cached read is 30 seconds old', async () => {
    const { query, calls } = fakeQuery(usageMessages());
    const { status, advance } = harness({}, { query });
    await status.usage();

    advance(10_000);
    await status.usage(true);
    expect(calls).toHaveBeenCalledOnce();

    advance(20_000);
    await status.usage(true);
    expect(calls).toHaveBeenCalledTimes(2);

    advance(1_000);
    await status.status(true);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('reports a failed read as a value and retries it after 30 seconds, not 5 minutes', async () => {
    const { query, calls } = fakeQuery([], { throws: new Error('spawn exploded') });
    const { status, advance } = harness({}, { query });
    expect(await status.usage()).toEqual({ error: 'Could not read Claude Code usage — spawn exploded' });

    advance(29_000);
    await status.usage();
    expect(calls).toHaveBeenCalledOnce();

    advance(1_000);
    await status.usage();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('gives up on a read that never finishes and tears the query down', async () => {
    const { query, close } = fakeQuery(usageMessages().slice(0, 1), { hang: true });
    const { status } = harness({}, { query, usageTimeoutMs: 20 });
    expect(await status.usage()).toEqual({ error: 'Reading Claude Code usage timed out after 0.02 s' });
    expect(close).toHaveBeenCalled();
  });

  it('reads no usage when Claude Code is not installed', async () => {
    const { query, calls } = fakeQuery(usageMessages());
    const { status } = harness({}, { query, resolveBin: () => Promise.resolve(null) });
    expect(await status.usage()).toEqual({ error: 'Claude Code not found — install it, or set CLAUDE_BIN' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('includes the meters in the composed status', async () => {
    const { query } = fakeQuery(usageMessages());
    const { status } = harness({}, { query });
    const result = await status.status();
    expect(result.usage).toMatchObject({ fetchedAt: 1_000_000, limits: [{ label: '5h' }, { label: 'week' }, { label: 'Fable week' }] });
  });
});

describe('ClaudeCodeStatus recent sessions', () => {
  const listing = (rows: unknown) =>
    vi.fn((_options: unknown) => Promise.resolve(rows)) as unknown as ClaudeCodeStatusDeps['listSessions'] &
      ReturnType<typeof vi.fn>;

  it("lists a project's 8 most recent sessions, preferring the owner's title to the summary", async () => {
    const listSessions = listing(fixture('list-sessions'));
    const { status } = harness({}, { listSessions });
    expect(await status.recent('/home/example/projects/alpha')).toEqual([
      { sessionId: '11111111-1111-4111-8111-111111111111', title: 'Flaky status poll', lastModified: 1792257696220, gitBranch: 'main' },
      { sessionId: '22222222-2222-4222-8222-222222222222', title: 'Draft the release notes', lastModified: 1792254096220 },
    ]);
    expect(listSessions).toHaveBeenCalledWith({ dir: '/home/example/projects/alpha', limit: 8 });
  });

  it('lists across every project when there is no root', async () => {
    const listSessions = listing([]);
    const { status } = harness({}, { listSessions });
    expect(await status.recent(null)).toEqual([]);
    expect(listSessions).toHaveBeenCalledWith({ limit: 8 });
  });

  it('rejects with a typed error naming what failed, since an empty list would hide it', async () => {
    const listSessions = vi.fn(() => Promise.reject(new Error('EACCES'))) as unknown as ClaudeCodeStatusDeps['listSessions'];
    const { status } = harness({}, { listSessions });
    await expect(status.recent('/x')).rejects.toMatchObject({
      name: 'WireCallError',
      code: 'claude_sessions_error',
      message: 'Could not list recent Claude Code sessions — EACCES',
    });
  });
});
