import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_PATH, type ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import { DEFAULT_WS_ALLOWED_ORIGINS } from '../config.ts';
import { registerUntypedForTest } from '../test/untyped-registry.ts';
import { MethodRegistry } from '../transport/registry.ts';
import { attachTransport } from '../transport/server.ts';
import { main, urlFromEnv, type FoIo, type Writer } from './fo.ts';

const apps: FastifyInstance[] = [];
/** The most recent app, for tests that must drop the connection mid-run. */
let lastApp: FastifyInstance | undefined;

async function startTransport(
  setup: (registry: MethodRegistry) => void,
): Promise<string> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const registry = new MethodRegistry();
  setup(registry);
  attachTransport(app, registry, DEFAULT_WS_ALLOWED_ORIGINS);
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  lastApp = app;
  const address = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}${WS_PATH}`;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Capturing writer: every write is concatenated in order. */
function capture(): Writer & { text(): string } {
  const parts: string[] = [];
  return {
    write: (text) => {
      parts.push(text);
    },
    text: () => parts.join(''),
  };
}

function makeIo(
  url: string,
  options: { signal?: AbortSignal; stdin?: string | Readable; stdinIsTTY?: boolean } = {},
): FoIo & {
  stdoutText: () => string;
  stderrText: () => string;
} {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    stdin: options.stdin ?? '',
    ...(options.stdinIsTTY !== undefined ? { stdinIsTTY: options.stdinIsTTY } : {}),
    url,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    stdoutText: () => stdout.text(),
    stderrText: () => stderr.text(),
  };
}

async function run(
  argv: string[],
  url: string,
  options?: { signal?: AbortSignal; stdin?: string | Readable; stdinIsTTY?: boolean },
) {
  const io = makeIo(url, options);
  const code = await main(argv, io);
  return { code, out: io.stdoutText(), err: io.stderrText() };
}

afterEach(() => {});

describe('fo call commands', () => {
  it('prints a call result as JSON, exit 0, params reach the handler', async () => {
    let seen: unknown = null;
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'echo', (params) => {
        seen = params;
        return { got: params };
      });
    });
    const result = await run(['call', 'echo', '{"x":1}'], url);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ got: { x: 1 } });
    expect(seen).toEqual({ x: 1 });
  });

  it('refuses every stream method, pointing at fo send: a raw chat.send must not skip the Claude chat rule', async () => {
    let streamed = 0;
    const url = await startTransport((registry) => {
      registry.call('chat.slots', () => [
        {
          chatId: 'main',
          kind: 'claude-code' as const,
          createdAt: 0,
          lastUsedAt: 0,
          crew: false,
          crewPending: false,
          busy: false,
          attention: false,
          session: null,
          root: null,
          subagentsLeftRunning: 0,
        },
      ]);
      registry.stream('chat.send', async function* stream() {
        streamed += 1;
        await Promise.resolve();
        yield { kind: 'text', delta: 'spent' } satisfies ChatChunk;
      });
    });

    for (const method of ['chat.send', 'chat.observe', 'chat.slotsObserve', 'helmraiser.observe']) {
      const result = await run(['call', method, '{"chatId":"main","text":"hi"}'], url);
      expect(result.code).toBe(2);
      expect(result.err).toContain('fo send');
      expect(result.out).toBe('');
    }
    expect(streamed).toBe(0);
  });

  it('prints null JSON when a successful generic call has no result', async () => {
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'void', () => undefined);
    });
    const result = await run(['call', 'void'], url);
    expect(result.code).toBe(0);
    expect(result.out).toBe('null\n');
    expect(JSON.parse(result.out)).toBeNull();
  });

  it('a wire error exits 1 with message and code in human mode', async () => {
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'boom', () => {
        throw new WireCallError('nope', 'folder_not_found');
      });
    });
    const result = await run(['call', 'boom'], url);
    expect(result.code).toBe(1);
    expect(result.err).toBe('error: nope (folder_not_found)\n');
    expect(result.out).toBe('');
  });

  it('a wire error exits 1 with a JSON envelope in --json mode', async () => {
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'boom', () => {
        throw new WireCallError('nope', 'folder_not_found');
      });
    });
    const result = await run(['call', 'boom', '--json'], url);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      error: { message: 'nope', code: 'folder_not_found' },
    });
  });

  it('health renders the human summary and backend lines', async () => {
    const url = await startTransport((registry) => {
      registry.call('system.health', () => ({
        ok: true as const,
        service: 'funkyoctopus-sidecar' as const,
        version: '0.1.0',
        uptimeMs: 65_400,
        backends: { pi: 'up', helmraiser: 'down' },
      }));
    });
    const result = await run(['health'], url);
    expect(result.code).toBe(0);
    expect(result.out).toBe('ok · 0.1.0 · up 65s\n  pi: up\n  helmraiser: down\n');
  });

  it('projects renders global, known and folders rows', async () => {
    const url = await startTransport((registry) => {
      registry.call('projects.discover', () => ({
        globalRoot: '/home/example/work',
        known: [{ id: 'a', name: 'alpha', path: '/p/alpha', envTier: 'normal' as const }],
        folders: [
          { id: 'b', name: 'beta', path: '/p/beta', envTier: 'normal' as const },
        ],
      }));
    });
    const result = await run(['projects'], url);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      'global  /home/example/work\nknown\n  alpha  /p/alpha\nfolders\n  beta  /p/beta\n',
    );
  });

  it('chats sends root per flag and renders rows with moved/gone suffixes', async () => {
    let seen: unknown = null;
    const url = await startTransport((registry) => {
      registry.call('chat.list', (params) => {
        seen = params;
        return [
          {
            path: '/s/1.jsonl',
            engine: 'pi' as const,
            id: '1',
            cwd: '/p',
            title: 'hello',
            created: '2026-01-01T00:00:00Z',
            modified: '2026-01-02T00:00:00Z',
            movedFrom: '/old/p',
          },
          {
            path: '/s/2.jsonl',
            engine: 'pi' as const,
            id: '2',
            cwd: '/q',
            title: 'gone',
            created: '2026-01-01T00:00:00Z',
            modified: '2026-01-03T00:00:00Z',
            folderGone: true,
          },
        ];
      });
    });
    const withRoot = await run(['chats', '--root', '/p'], url);
    expect(seen).toEqual({ chatId: 'main', root: '/p' });
    expect(withRoot.out).toBe(
      '2026-01-02T00:00:00Z  hello  /s/1.jsonl (moved from /old/p)\n' +
        '2026-01-03T00:00:00Z  gone  /s/2.jsonl (folder gone)\n',
    );
    const asGlobal = await run(['chats', '--global', '--chat', 'c2'], url);
    expect(seen).toEqual({ chatId: 'c2', root: null });
    expect(asGlobal.code).toBe(0);
    const defaulted = await run(['chats'], url);
    expect(seen).toEqual({ chatId: 'main', root: null });
    expect(defaulted.code).toBe(0);
  });

  it('chat current/new/open/root send the right params and render', async () => {
    let seen: unknown = null;
    let newParams: unknown = null;
    const url = await startTransport((registry) => {
      registry.call('chat.current', () => null);
      registry.call('chat.new', (params) => {
        newParams = params;
        return {
        path: '/s/new.jsonl',
        engine: 'pi' as const,
        id: 'n',
        cwd: '/p',
        title: 't',
        created: '2026-01-01T00:00:00Z',
        modified: '2026-01-01T00:00:00Z',
        };
      });
      registry.call('chat.open', (params) => {
        seen = params;
        return params.path === '/s/held.jsonl'
          ? { heldBy: 'c7' }
          : { items: [{ id: 'm', role: 'user' as const, steps: [], createdAt: 0 }] };
      });
      registry.call('chat.setRoot', (params) => {
        seen = params;
        return [];
      });
    });
    expect((await run(['chat', 'current'], url)).out).toBe('no open chat\n');
    expect((await run(['chat', 'new'], url)).out).toBe('/s/new.jsonl\n');
    // The CLI's client id is marked as the CLI's, so browser windows can tell it from one of theirs.
    expect(newParams).toEqual({ chatId: 'main', clientId: expect.stringMatching(/^cli:[0-9a-f-]{36}$/) as string });
    const opened = await run(['chat', 'open', '/s/1.jsonl', '--chat', 'c3'], url);
    expect(seen).toEqual({ chatId: 'c3', path: '/s/1.jsonl', clientId: expect.any(String) });
    expect(opened.out).toBe('opened · 1 items\n');
    const held = await run(['chat', 'open', '/s/held.jsonl'], url);
    expect(held.code).toBe(0);
    expect(held.out).toBe('held by chat c7 — open it there (fo --chat c7 …)\n');
    seen = null;
    const rooted = await run(['chat', 'root', 'global'], url);
    expect(seen).toEqual({ chatId: 'main', path: null, clientId: expect.any(String) });
    expect(rooted.out).toBe('root · global · 0 items\n');
  });

  it('chats --live lists the slots, and chat create/close manage them', async () => {
    const calls: unknown[] = [];
    const slot = (chatId: string, kind: 'pi' | 'claude-code', over: object = {}) => ({
      chatId,
      kind,
      createdAt: 0,
      lastUsedAt: 0,
      crew: chatId === 'main',
      crewPending: false,
      busy: false,
      attention: false,
      session: null,
      root: null,
      subagentsLeftRunning: 0,
      ...over,
    });
    const url = await startTransport((registry) => {
      registry.call('chat.slots', () => [
        slot('main', 'pi', {
          busy: true,
          root: null,
          subagentsLeftRunning: 2,
          session: { path: '/s/a.jsonl', engine: 'pi', id: 'a', cwd: '/p', title: 'first', created: '', modified: '' },
        }),
        slot('c1', 'claude-code', { attention: true }),
      ]);
      registry.call('chat.create', (params) => {
        calls.push(['create', params]);
        return slot('c9', params.kind);
      });
      registry.call('chat.close', (params) => {
        calls.push(['close', params]);
        return { closed: true as const };
      });
    });

    const live = await run(['chats', '--live'], url);
    expect(live.code).toBe(0);
    expect(live.out).toBe(
      'main  pi           busy · crew · 2 subagents left running  first\n' +
        'c1    claude-code  needs attention  —\n',
    );
    expect(JSON.parse((await run(['chats', '--live', '--json'], url)).out)).toHaveLength(2);

    const created = await run(['chat', 'create', '--engine', 'claude-code', '--root', '/p'], url);
    expect(created.out).toBe('c9\n');
    const closed = await run(['chat', 'close', 'c9', '--force'], url);
    expect(closed.out).toBe('closed c9\n');
    expect(calls).toEqual([
      ['create', { kind: 'claude-code', root: '/p', clientId: expect.any(String) }],
      ['close', { chatId: 'c9', force: true, clientId: expect.any(String) }],
    ]);

    expect((await run(['chat', 'create'], url)).code).toBe(2);
    expect((await run(['chat', 'create', '--engine', 'gpt'], url)).code).toBe(2);
    expect((await run(['chats', '--live', '--root', '/p'], url)).code).toBe(2);
  });

  it('a vault resolve that finds nothing is a wire error, not a verdict', async () => {
    const url = await startTransport((registry) => {
      registry.call('vault.resolve', () => false);
    });
    const human = await run(['vault', 'approve', 'req-unknown'], url);
    expect(human.code).toBe(1);
    expect(human.err).toBe('error: no pending approval request: req-unknown\n');
    const asJson = await run(['vault', 'deny', 'req-unknown', '--json'], url);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual({
      error: { message: 'no pending approval request: req-unknown' },
    });
  });

  it('a vault deny whose request was found prints denied', async () => {
    const url = await startTransport((registry) => {
      registry.call('vault.resolve', () => true);
    });
    const result = await run(['vault', 'deny', 'req-1'], url);
    expect(result.code).toBe(0);
    expect(result.out).toBe('denied\n');
  });

  it('models renders provider/id rows; vault renders the verdict', async () => {
    let seen: unknown = null;
    const url = await startTransport((registry) => {
      registry.call('models.list', () => [
        {
          provider: 'openai-codex',
          id: 'gpt-6-sol',
          name: 'GPT-6 Sol',
          thinkingLevels: [],
          input: ['text' as const],
        },
      ]);
      registry.call('vault.resolve', (params) => {
        seen = params;
        return true;
      });
    });
    const models = await run(['models'], url);
    expect(models.out).toBe('openai-codex/gpt-6-sol  GPT-6 Sol\n');
    const vault = await run(['vault', 'approve', 'req-1'], url);
    expect(seen).toEqual({ requestId: 'req-1', approved: true });
    expect(vault.out).toBe('approved\n');
  });

  it('helmraiser calls helmraiser.status and prints identical pretty JSON in both modes', async () => {
    const status = vi.fn(() => ({ updated_at: '2026-01-01' }));
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'helmraiser.status', status);
    });
    for (const argv of [['helmraiser'], ['helmraiser', '--json']]) {
      const result = await run(argv, url);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toBe(`${JSON.stringify({ updated_at: '2026-01-01' }, null, 2)}\n`);
    }
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('a dead url exits 3 with the sidecar-not-running message', async () => {
    const result = await run(['health'], 'ws://127.0.0.1:1/ws');
    expect(result.code).toBe(3);
    expect(result.err).toBe(
      'sidecar not running at ws://127.0.0.1:1/ws (start it with npm run dev:all)\n',
    );
  });

  it('a call past --timeout exits 124 and cancels the handler', async () => {
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'sleepy', async (_params, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve());
        });
        return 'late';
      });
    });
    const result = await run(['call', 'sleepy', '--timeout', '1'], url);
    expect(result.code).toBe(124);
  });

  it('usage errors exit 2 with the help hint', async () => {
    const status = vi.fn();
    const url = await startTransport((registry) => {
      registerUntypedForTest(registry, 'helmraiser.status', status);
    });
    for (const argv of [
      ['nonsense'],
      // The legacy squadron subcommand is deliberately rejected, not aliased.
      ['squadron'],
      ['call'],
      ['call', 'method', '{bad json}'],
      ['chats', '--root', '/p', '--global'],
      ['send'],
      ['send', '--timeout', '5', 'hi'],
      ['chat', 'wat'],
      ['vault', 'maybe', 'x'],
      ['--timeout', '0', 'health'],
      ['health', 'extra'],
      ['helmraiser', 'extra'],
    ]) {
      const result = await run(argv, url);
      expect(result.code).toBe(2);
      expect(result.err).toContain("run fo --help");
    }
    expect(status).not.toHaveBeenCalled();
  });

  it('urlFromEnv honours FO_URL and composes the default from SIDECAR_PORT', () => {
    expect(urlFromEnv({})).toBe('ws://127.0.0.1:14787/ws');
    expect(urlFromEnv({ SIDECAR_PORT: '9999' })).toBe('ws://127.0.0.1:9999/ws');
    expect(urlFromEnv({ FO_URL: 'ws://example:1/x' })).toBe('ws://example:1/x');
    expect(urlFromEnv({ FO_URL: 'ws://example:1/x', SIDECAR_PORT: '9999' })).toBe(
      'ws://example:1/x',
    );
  });

  it('--help and help list every command without touching the sidecar', async () => {
    const commands = [
      'health',
      'call <method>',
      'projects',
      'chats',
      'chat current',
      'chat new',
      'chat open',
      'chat root',
      'send',
      'models',
      'helmraiser',
      'vault approve',
      'vault deny',
    ];
    for (const argv of [['--help'], ['help']]) {
      const result = await run(argv, 'ws://127.0.0.1:1/ws');
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      for (const command of commands) {
        expect(result.out).toContain(command);
      }
      // Do not advertise the rejected legacy squadron subcommand.
      expect(result.out).not.toContain('squadron');
    }
  });
});

describe('fo send', () => {
  const fakeChunks: ChatChunk[] = [
    { kind: 'tool-call', callId: 'c1', tool: 'bash', summary: 'ls' },
    { kind: 'tool-result', callId: 'c1', ok: true, output: 'file.ts' },
    { kind: 'text', delta: 'Hello ' },
    { kind: 'text', delta: 'world' },
    { kind: 'usage', tokens: 120, contextWindow: 200_000, percent: 1 },
  ];

  /** The slots a send looks up before it streams: `main` on pi unless told otherwise. */
  function withSlots(registry: MethodRegistry, kinds: Record<string, 'pi' | 'claude-code'> = { main: 'pi' }): void {
    registry.call('chat.slots', () =>
      Object.entries(kinds).map(([chatId, kind]) => ({
        chatId,
        kind,
        createdAt: 0,
        lastUsedAt: 0,
        crew: false,
        crewPending: false,
        busy: false,
        attention: false,
        session: null,
        root: null,
        subagentsLeftRunning: 0,
      })),
    );
  }

  function sendRegistry(chunks: ChatChunk[], hooks?: {
    onParams?: (params: unknown) => void;
    onSignal?: (aborted: boolean) => void;
  }): (registry: MethodRegistry) => void {
    return (registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream(params, ctx) {
        await Promise.resolve();
        if (hooks?.onParams) hooks.onParams(params);
        for (const chunk of chunks) {
          if (ctx.signal.aborted) return;
          yield chunk;
        }
        hooks?.onSignal?.(ctx.signal.aborted);
      });
    };
  }

  it('text mode: stdout is exactly the joined text plus a newline, stderr ordered', async () => {
    const url = await startTransport(sendRegistry(fakeChunks));
    const result = await run(['send', 'hello', 'there'], url);
    expect(result.code).toBe(0);
    expect(result.out).toBe('Hello world\n');
    expect(result.err).toBe(
      '› bash ls\n' +
        '  ✓\n' +
        '· ctx 1%\n',
    );
  });

  it('on a terminal, the trailing context share starts its own line instead of gluing onto the reply', async () => {
    const url = await startTransport(sendRegistry(fakeChunks));
    // A terminal shows stdout and stderr interleaved, in write order.
    const screen: string[] = [];
    const io = makeIo(url);
    io.stdout = { write: (text) => void screen.push(text) };
    io.stderr = { write: (text) => void screen.push(text) };
    expect(await main(['send', 'hi'], io)).toBe(0);
    expect(screen.join('')).toMatch(/Hello world\n· ctx 1%\n$/);
  });

    it('--json mode emits one NDJSON chunk line each plus a final end line', async () => {
    const url = await startTransport(sendRegistry(fakeChunks));
    const result = await run(['send', 'hi', '--json'], url);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const lines = result.out.trimEnd().split('\n');
    expect(lines).toHaveLength(fakeChunks.length + 1);
    for (const [index, chunk] of fakeChunks.entries()) {
      expect(JSON.parse(lines[index] as string)).toEqual(chunk);
    }
    expect(JSON.parse(lines[fakeChunks.length] as string)).toEqual({ kind: 'end' });
  });

  it('--model and --effort arrive as provider, model, effort', async () => {
    let seen: unknown = null;
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream(params) {
        await Promise.resolve();
        seen = params;
        yield { kind: 'text', delta: 'ok' } satisfies ChatChunk;
      });
    });
    const result = await run(
      ['send', 'hi', '--model', 'openai-codex/gpt-6-sol', '--effort', 'high'],
      url,
    );
    expect(result.code).toBe(0);
    expect(seen).toEqual({
      chatId: 'main',
      text: 'hi',
      provider: 'openai-codex',
      model: 'gpt-6-sol',
      effort: 'high',
      clientId: expect.any(String),
    });
  });

  it('renders a fractional context share as the browser does', async () => {
    const url = await startTransport(
      sendRegistry([
        { kind: 'text', delta: 'ok' },
        { kind: 'usage', tokens: 900, contextWindow: 200_000, percent: 0.45459999999999995 },
      ]),
    );
    const small = await run(['send', 'hi'], url);
    expect(small.err).toBe('· ctx <1%\n');

    const url2 = await startTransport(
      sendRegistry([{ kind: 'usage', tokens: 90_000, contextWindow: 200_000, percent: 45.459999999999994 }]),
    );
    expect((await run(['send', 'hi'], url2)).err).toBe('· ctx 45%\n');
  });

  it('send - reads the text from injected stdin', async () => {
    let seen: unknown = null;
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream(params) {
        await Promise.resolve();
        seen = params;
        yield { kind: 'text', delta: 'ok' } satisfies ChatChunk;
      });
    });
    const result = await run(['send', '-'], url, { stdin: 'piped text' });
    expect(result.code).toBe(0);
    expect(seen).toEqual({ chatId: 'main', text: 'piped text', clientId: expect.any(String) });
  });

  describe('into a Claude chat (decision 12, limit 2: no unattended Claude turns)', () => {
    function claudeSlots(): (registry: MethodRegistry) => void {
      return (registry) => {
        withSlots(registry, { main: 'claude-code', c2: 'claude-code', c3: 'pi' });
        registry.stream('chat.send', async function* stream() {
          await Promise.resolve();
          yield { kind: 'text', delta: 'sent' } satisfies ChatChunk;
        });
      };
    }

    it('refuses without an explicit --chat, even into main, before anything is sent', async () => {
      const url = await startTransport(claudeSlots());
      const result = await run(['send', 'hi'], url, { stdinIsTTY: true });
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toMatch(/Claude chat.*--chat main/);
    });

    it('refuses when stdin is not an interactive terminal', async () => {
      const url = await startTransport(claudeSlots());
      const result = await run(['send', 'hi', '--chat', 'c2'], url, { stdinIsTTY: false });
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/interactive terminal/);
      const piped = await run(['send', '-', '--chat', 'c2'], url, { stdin: 'text', stdinIsTTY: false });
      expect(piped.code).toBe(2);
    });

    it('sends with an explicit --chat from a terminal; a pi chat needs neither', async () => {
      const url = await startTransport(claudeSlots());
      expect((await run(['send', 'hi', '--chat', 'c2'], url, { stdinIsTTY: true })).out).toBe('sent\n');
      expect((await run(['send', 'hi', '--chat', 'c3'], url, { stdinIsTTY: false })).out).toBe('sent\n');
    });
  });

  it('approvals, failed tools, custom messages and --thinking render on stderr', async () => {
    const chunks: ChatChunk[] = [
      { kind: 'thinking', delta: 'hmm' },
      {
        kind: 'approval-request',
        requestId: 'r1',
        callId: 'c1',
        tool: 'bash',
        target: 'rm -rf /',
      },
      { kind: 'tool-result', callId: 'c1', ok: false, error: 'denied' },
      { kind: 'custom-message', id: 'x', customType: 'note', display: true, content: 'hi', details: null, timestamp: 1 },
      { kind: 'custom-message', id: 'y', customType: 'hidden', display: false, content: 'no', details: null, timestamp: 2 },
    ];
    const url = await startTransport(sendRegistry(chunks));
    const withoutThinking = await run(['send', 'go'], url);
    expect(withoutThinking.err).toBe(
      '⚠ approval needed: bash rm -rf /  (fo vault approve|deny r1)\n' +
        '  ✗ denied\n' +
        '▪ note: hi\n',
    );
    expect(withoutThinking.out).toBe('\n');
    const withThinking = await run(['send', 'go', '--thinking'], url);
    expect(withThinking.err.startsWith('hmm\n')).toBe(true);
  });

  it('a stream-end error exits 1: human stderr line or JSON end-error line', async () => {
    const failing = (registry: MethodRegistry): void => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream() {
        await Promise.resolve();
        yield { kind: 'text', delta: 'partial' } satisfies ChatChunk;
        throw new WireCallError('turned bad', 'folder_not_found');
      });
    };
    const human = await run(['send', 'hi'], await startTransport(failing));
    expect(human.code).toBe(1);
    expect(human.out).toBe('partial\n');
    expect(human.err).toBe('error: turned bad (folder_not_found)\n');
    const asJson = await run(['send', 'hi', '--json'], await startTransport(failing));
    expect(asJson.code).toBe(1);
    const lines = asJson.out.trimEnd().split('\n');
    expect(JSON.parse(lines[0] as string)).toEqual({ kind: 'text', delta: 'partial' });
    expect(JSON.parse(lines[1] as string)).toEqual({
      kind: 'end',
      error: { message: 'turned bad', code: 'folder_not_found' },
    });
  });

  it('turn_in_progress before the first chunk exits 1 with its wire message', async () => {
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream(params) {
        await Promise.resolve();
        expect(params).toMatchObject({ text: 'hi', clientId: expect.any(String) });
        yield* [] as ChatChunk[];
        throw new WireCallError('a turn is already running', 'turn_in_progress');
      });
    });

    const result = await run(['send', 'hi'], url);
    expect(result.code).toBe(1);
    expect(result.err).toBe('error: a turn is already running (turn_in_progress)\n');
  });

  it('a connection dropped mid-turn exits 3 with the unreachable message', async () => {
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream() {
        await Promise.resolve();
        yield { kind: 'text', delta: 'begin ' } satisfies ChatChunk;
        await new Promise<void>(() => undefined); // never ends on its own
      });
    });
    const runPromise = run(['send', 'hi'], url);
    await new Promise((r) => setTimeout(r, 100));
    await lastApp?.close();
    const result = await runPromise;
    expect(result.code).toBe(3);
    expect(result.err).toContain('sidecar not running at');
  });

  it('send - interrupted while stdin is still open exits 130', async () => {
    const controller = new AbortController();
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream() {
        await Promise.resolve();
        yield { kind: 'text', delta: 'never' } satisfies ChatChunk;
      });
    });
    const stdin = new PassThrough(); // written to never, ended never
    const runPromise = run(['send', '-'], url, { signal: controller.signal, stdin });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const result = await runPromise;
    expect(result.code).toBe(130);
  });

  it('send - exits 2 when reading stdin fails', async () => {
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream() {
        await Promise.resolve();
        yield { kind: 'text', delta: 'never' } satisfies ChatChunk;
      });
    });
    const stdin = new PassThrough();
    const runPromise = run(['send', '-'], url, { stdin });
    await new Promise((r) => setTimeout(r, 50));
    stdin.destroy(new Error('pipe broke'));
    const result = await runPromise;
    expect(result.code).toBe(2);
    expect(result.err).toContain('cannot read stdin: pipe broke');
  });

  it('aborting an in-flight JSON send cancels the stream and writes an interrupted end', async () => {
    let sawAbort = false;
    const controller = new AbortController();
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream(_params, ctx) {
        yield { kind: 'text', delta: 'begin ' } satisfies ChatChunk;
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve());
        });
        sawAbort = ctx.signal.aborted;
        yield { kind: 'text', delta: 'end' } satisfies ChatChunk;
      });
    });
    // Run in parallel; abort once the stream is under way.
    const runPromise = run(['send', 'hi', '--json'], url, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const result = await runPromise;
    expect(sawAbort).toBe(true);
    expect(result.code).toBe(130);
    expect(result.out).toBe(
      '{"kind":"text","delta":"begin "}\n' +
        '{"kind":"end","error":{"message":"interrupted","code":"interrupted"}}\n',
    );
  });

  it('an interrupted JSON send writes its end record after the grace period', async () => {
    const controller = new AbortController();
    const url = await startTransport((registry) => {
      withSlots(registry);
      registry.stream('chat.send', async function* stream() {
        yield { kind: 'text', delta: 'begin ' } satisfies ChatChunk;
        await new Promise<void>(() => undefined);
      });
    });
    const runPromise = run(['send', 'hi', '--json'], url, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const result = await runPromise;
    expect(result.code).toBe(130);
    expect(result.out).toBe(
      '{"kind":"text","delta":"begin "}\n' +
        '{"kind":"end","error":{"message":"interrupted","code":"interrupted"}}\n',
    );
  });
});
