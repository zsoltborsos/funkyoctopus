import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { FakeClaude, held, MAX_ACCOUNT, type ScriptItem } from '../test/fake-claude-query.ts';
import { FakeSessions } from '../test/fake-claude-sessions.ts';
import { turnFixture, type TurnFixture, type TurnName } from '../test/claude-fixtures.ts';
import type { ToolGuard } from '../pi/pi-chat.ts';
import { VaultGuard } from '../security/vault.ts';
import { config } from '../config.ts';
import { ClaudeCodeChat, type ClaudeCodeChatDeps } from './chat.ts';

const ROOT = '/home/example/project';
const NOBODY_BLOCKED: ToolGuard = { guard: () => Promise.resolve(undefined) };

/** An engine over a scripted `claude`: the named recorded turns answer its sends, in order. */
function harness(
  turns: (TurnName | ScriptItem)[],
  // `guard: null` leaves the engine to build its own Vault guard (from `vaultPath`).
  overrides: Omit<Partial<ClaudeCodeChatDeps>, 'guardFactory'> & { guard?: ToolGuard | null } = {},
  models: unknown[] | Error = [],
  account: ConstructorParameters<typeof FakeClaude>[2] = MAX_ACCOUNT,
) {
  const { guard = NOBODY_BLOCKED, ...rest } = overrides;
  const fake = new FakeClaude(
    turns.map((turn) => (typeof turn === 'string' ? turnFixture(turn) : turn)),
    models,
    account,
  );
  const chat = new ClaudeCodeChat({
    query: fake.query,
    bin: 'claude',
    version: '9.9.9',
    root: ROOT,
    env: { PATH: '/usr/bin', HOME: '/home/example', ANTHROPIC_API_KEY: 'sk-owner', CLAUDECODE: '1' },
    resolveBin: () => Promise.resolve('/opt/claude/bin/claude'),
    sessions: new FakeSessions(),
    ...(guard ? { guardFactory: () => Promise.resolve(guard) } : {}),
    ...rest,
  });
  return { chat, fake };
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const send = (chat: ClaudeCodeChat, text: string, opts = {}) =>
  drain(chat.send(text, new AbortController().signal, opts));

const textOf = (chunks: ChatChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.kind === 'text' ? [chunk.delta] : [])).join('');

describe('ClaudeCodeChat: a turn', () => {
  it('sends the prompt as a human user message and streams the recorded answer back', async () => {
    const { chat, fake } = harness(['plain']);

    const chunks = await send(chat, 'what is 17 * 23?');

    expect(textOf(chunks)).toBe('17 × 23 = **391**.');
    expect(chunks.at(-1)).toMatchObject({ kind: 'usage', tokens: 17828 });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.inputs).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'what is 17 * 23?' },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      },
    ]);
  });
});

describe('ClaudeCodeChat: the process', () => {
  it('starts claude on the owner\'s login, with Claude Code\'s own prompt, settings and hooks', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'hi');

    const options = fake.queries[0]?.options;
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      cwd: ROOT,
      // The SDK's default prompt is a bare one; the preset is Claude Code's own.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
    });
    // Setting sources stay at their default so CLAUDE.md, skills and the owner's
    // hooks load, and nothing here asks for `--bare` (which never reads OAuth).
    expect(options).not.toHaveProperty('settingSources');
    expect(options).not.toHaveProperty('extraArgs');
    expect(options?.persistSession).not.toBe(false);
    // The owner's own sign-in settings reach the child as set; a parent-session marker does not.
    expect(options?.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/example',
      ANTHROPIC_API_KEY: 'sk-owner',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'funkyoctopus/9.9.9',
    });
    expect(options?.env).not.toHaveProperty('CLAUDECODE');
  });

  it('leaves Claude Code nothing that starts a turn on its own', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'hi');

    const options = fake.queries[0]?.options;
    // Both names are read by claude 2.1.302 (strings in the binary; the second removes
    // run_in_background from Bash, measured 2026-10-17).
    expect(options?.env).toMatchObject({ CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expect(options?.disallowedTools).toEqual([
      'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'Monitor',
    ]);
  });

  it('serves consecutive turns from the one process', async () => {
    const { chat, fake } = harness(['plain', 'bash']);

    await send(chat, 'first');
    const second = await send(chat, 'second');

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.inputs.map((input) => input.message.content)).toEqual(['first', 'second']);
    expect(second.find((chunk) => chunk.kind === 'tool-call')).toMatchObject({ tool: 'Bash' });
  });

  it('says so when Claude Code is not installed, before starting anything', async () => {
    const { chat, fake } = harness([], { resolveBin: () => Promise.resolve(null) });

    await expect(send(chat, 'hi')).rejects.toMatchObject({
      message: 'Claude Code not found — install it, or set CLAUDE_BIN',
      code: 'claude_unavailable',
    });
    expect(fake.queries).toHaveLength(0);
  });
});

describe('ClaudeCodeChat: compaction', () => {
  it('shows a /compact as one compaction chunk and ends the turn, with no answer text', async () => {
    const { chat } = harness(['compact']);

    const chunks = await send(chat, '/compact');

    expect(chunks).toEqual([{ kind: 'compaction', trigger: 'manual', preTokens: 14166, postTokens: 2016 }]);
  });
});

const DENY = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

describe('ClaudeCodeChat: the Vault as a PreToolUse hook', () => {
  const blocked = (target: string): ToolGuard =>
    new VaultGuard([{ target, action: 'block' }], () => Promise.resolve(false), ROOT);

  it('registers one hook for every tool call, with time for a human to answer', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'hi');

    const matchers = fake.queries[0]?.options.hooks?.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.matcher).toBeUndefined();
    expect(matchers[0]?.hooks).toHaveLength(1);
    expect(matchers[0]?.timeout).toBe(600);
  });

  it('hands the guard the call id, tool and input the CLI announced', async () => {
    const guard = vi.fn<ToolGuard['guard']>(() => Promise.resolve(undefined));
    const { chat, fake } = harness(['bash'], { guard: { guard } });

    await send(chat, 'run it');

    expect(guard).toHaveBeenCalledOnce();
    expect(guard.mock.calls[0]?.slice(0, 3)).toEqual([
      'toolu_01NdUCvwD9UAXLfko3Ko8TWU',
      'Bash',
      { command: 'echo fixture-ok', description: 'Print fixture-ok string' },
    ]);
    expect(guard.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    expect(fake.queries[0]?.hookAnswers).toEqual([{}]);
  });

  it('denies a blocked read with the Vault\'s reason, and the turn carries on', async () => {
    const { chat, fake } = harness(['denied'], { guard: blocked(`${ROOT}/blocked`) });

    const chunks = await send(chat, 'read the secret');

    expect(fake.queries[0]?.hookAnswers).toEqual([DENY(`Vault blocked access to ${ROOT}/blocked`)]);
    expect(chunks.find((chunk) => chunk.kind === 'tool-result')).toMatchObject({ ok: false });
    expect(textOf(chunks)).toContain("couldn't read");
  });

  // Measured 2026-10-17: a hook that throws does NOT stop the tool; one that times out does.
  it.each([
    ['rejects', () => Promise.reject(new Error('vault.json is unreadable'))],
    ['throws', (): never => { throw new Error('vault.json is unreadable'); }],
  ])('denies the call when the guard %s, because a failing hook would let the tool run', async (_how, check) => {
    const { chat, fake } = harness(['bash'], { guard: { guard: check } });

    await send(chat, 'run it');

    expect(fake.queries[0]?.hookAnswers).toEqual([
      DENY('Vault could not check this call — vault.json is unreadable'),
    ]);
  });

  it('asks the owner when a rule escalates, and lets the call through on approval', async () => {
    const vaultPath = join(await mkdtemp(join(tmpdir(), 'fo-claude-vault-')), 'vault.json');
    await writeFile(vaultPath, JSON.stringify([{ target: `${ROOT}/blocked`, action: 'escalate' }]));
    const { chat, fake } = harness(['denied'], { guard: null, vaultPath });

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('read the secret', new AbortController().signal)) {
      chunks.push(chunk);
      if (chunk.kind === 'approval-request') {
        expect(chunk).toMatchObject({ callId: 'toolu_01JEciy4y7qVRsMwrBSxnUvx', tool: 'Read', target: `${ROOT}/blocked` });
        expect(chat.resolveApproval(chunk.requestId, true)).toBe(true);
      }
    }

    expect(chunks.some((chunk) => chunk.kind === 'approval-request')).toBe(true);
    expect(fake.queries[0]?.hookAnswers).toEqual([{}]);
  });

  it('turns a refused escalation into the same denial', async () => {
    const vaultPath = join(await mkdtemp(join(tmpdir(), 'fo-claude-vault-')), 'vault.json');
    await writeFile(vaultPath, JSON.stringify([{ target: `${ROOT}/blocked`, action: 'escalate' }]));
    const { chat, fake } = harness(['denied'], { guard: null, vaultPath });

    for await (const chunk of chat.send('read the secret', new AbortController().signal)) {
      if (chunk.kind === 'approval-request') chat.resolveApproval(chunk.requestId, false);
    }

    expect(fake.queries[0]?.hookAnswers).toEqual([DENY(`Vault denied access to ${ROOT}/blocked`)]);
  });
});

describe('ClaudeCodeChat: stopping a turn', () => {
  it('interrupts the run on abort, ends the stream quietly, and answers the next turn from the same process', async () => {
    const { chat, fake } = harness(['interrupted', 'after-interrupt']);
    const stop = new AbortController();
    const chunks: ChatChunk[] = [];

    // The recorded run sits on a long Bash call until interrupt() arrives.
    for await (const chunk of chat.send('wait forty seconds', stop.signal)) {
      chunks.push(chunk);
      if (chunk.kind === 'tool-call') stop.abort();
    }

    expect(fake.queries[0]?.calls).toEqual(['accountInfo', 'input', 'interrupt:cancelQueued']);
    expect(chunks.some((chunk) => chunk.kind === 'tool-call')).toBe(true);

    // Sent straight away, while the stopped turn is still draining.
    const next = await send(chat, 'reply with one word');
    expect(textOf(next)).toBe('pong');
    expect(fake.queries).toHaveLength(1);
  });

  it('never sends a prompt for a request that was already aborted', async () => {
    const { chat, fake } = harness(['plain']);
    const stop = new AbortController();
    stop.abort();

    expect(await drain(chat.send('hi', stop.signal))).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });

  it('refuses a second turn while one is running', async () => {
    const { chat } = harness(['interrupted']);
    const stop = new AbortController();
    const first = chat.send('wait', stop.signal)[Symbol.asyncIterator]();

    // Pull until the run is parked on its tool call.
    for (;;) {
      const step = await first.next();
      if (step.done || step.value.kind === 'tool-call') break;
    }

    await expect(send(chat, 'and another')).rejects.toMatchObject({
      message: 'a turn is already running',
      code: 'turn_in_progress',
    });
    stop.abort();
    await first.return?.();
  });

  it('releases a call waiting on an approval card when the turn is stopped', async () => {
    const vaultPath = join(await mkdtemp(join(tmpdir(), 'fo-claude-vault-')), 'vault.json');
    await writeFile(vaultPath, JSON.stringify([{ target: `${ROOT}/blocked`, action: 'escalate' }]));
    const { chat, fake } = harness(['denied'], { guard: null, vaultPath });
    const stop = new AbortController();

    for await (const chunk of chat.send('read the secret', stop.signal)) {
      if (chunk.kind === 'approval-request') stop.abort();
    }

    await vi.waitFor(() =>
      expect(fake.queries[0]?.hookAnswers).toEqual([DENY(`Vault denied access to ${ROOT}/blocked`)]),
    );
    expect(chat.resolveApproval('toolu_01JEciy4y7qVRsMwrBSxnUvx', true)).toBe(false);
  });
});

describe('ClaudeCodeChat: model and effort', () => {
  it('starts the process on the first turn\'s model and effort', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'hi', { provider: 'claude-code', model: 'sonnet', effort: 'high' });

    expect(fake.queries[0]?.options).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(fake.queries[0]?.calls).toEqual(['accountInfo', 'input']);
  });

  it('switches model and effort in place, before the prompt that wants them, only when they changed', async () => {
    const { chat, fake } = harness(['plain', 'set-model', 'plain']);

    await send(chat, 'one', { provider: 'claude-code', model: 'haiku', effort: 'high' });
    const second = await send(chat, 'two', { provider: 'claude-code', model: 'claude-haiku-4-5-20251001', effort: 'low' });
    await send(chat, 'three', { provider: 'claude-code', model: 'claude-haiku-4-5-20251001', effort: 'low' });

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.calls).toEqual([
      'accountInfo',
      'input',
      'setModel:claude-haiku-4-5-20251001',
      'applyFlagSettings:{"effortLevel":"low"}',
      'input',
      'input',
    ]);
    // The recorded turn after setModel starts with a local-command echo, then init.
    expect(textOf(second)).toBe('pong');
  });

  it('leaves the process alone when the picker names a model of another engine', async () => {
    const { chat, fake } = harness(['plain', 'plain']);

    await send(chat, 'one', { provider: 'opencode', model: 'deepseek-v4-flash', effort: 'high' });
    await send(chat, 'two', { provider: 'opencode', model: 'other', effort: 'off' });

    expect(fake.queries[0]?.options).not.toHaveProperty('model');
    expect(fake.queries[0]?.options).not.toHaveProperty('effort');
    expect(fake.queries[0]?.calls).toEqual(['accountInfo', 'input', 'input']);
  });

  it('ignores an effort Claude Code has no level for', async () => {
    const { chat, fake } = harness(['plain', 'plain']);

    await send(chat, 'one', { provider: 'claude-code', effort: 'minimal' });
    await send(chat, 'two', { effort: 'off' });

    expect(fake.queries[0]?.options).not.toHaveProperty('effort');
    expect(fake.queries[0]?.calls).toEqual(['accountInfo', 'input', 'input']);
  });
});

describe('ClaudeCodeChat: images', () => {
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

  it('sends pasted images as base64 image blocks ahead of the text', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'what colour is this?', { images: [image, image] });

    expect(fake.queries[0]?.inputs[0]?.message.content).toEqual([
      block,
      block,
      { type: 'text', text: 'what colour is this?' },
    ]);
  });

  it('sends an image on its own without an empty text block', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, '', { images: [image] });

    expect(fake.queries[0]?.inputs[0]?.message.content).toEqual([block]);
  });
});

/** A recorded turn whose `system/init` reports a different API-key source. */
function initWith(turn: TurnName, apiKeySource: string): TurnFixture {
  const fixture = turnFixture(turn);
  return {
    ...fixture,
    messages: fixture.messages.map((m) => (m.type === 'system' && m.subtype === 'init' ? { ...m, apiKeySource } : m)),
  };
}

describe('ClaudeCodeChat: whatever sign-in the CLI uses', () => {
  it('answers a session that runs on the owner\'s API key, as on any other sign-in', async () => {
    const { chat, fake } = harness([initWith('plain', 'ANTHROPIC_API_KEY')]);

    expect(textOf(await send(chat, 'hi'))).toBe('17 × 23 = **391**.');
    expect(fake.queries[0]?.calls).not.toContain('close');
  });

  it('accepts the subscription login', async () => {
    const { chat } = harness([initWith('plain', 'none')]);
    expect(textOf(await send(chat, 'hi'))).toBe('17 × 23 = **391**.');
  });
});

describe('ClaudeCodeChat: failures', () => {
  it('says to sign in when logged out, and starts a fresh process for the retry', async () => {
    const { chat, fake } = harness(['auth-failed', 'plain']);

    await expect(send(chat, 'hi')).rejects.toMatchObject({
      message: 'Claude Code is not logged in — run `claude`, then /login, in a terminal',
      code: 'claude_not_logged_in',
    });
    expect(fake.queries[0]?.calls).toContain('close');

    // A process started logged out would never see the new login.
    expect(textOf(await send(chat, 'hi again'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(2);
  });

  it('reports a process that dies mid-turn, and recovers on the next turn', async () => {
    const { chat, fake } = harness(['interrupted', 'plain']);
    const died = (async () => {
      for await (const chunk of chat.send('wait', new AbortController().signal)) {
        if (chunk.kind === 'tool-call') fake.queries[0]?.exit();
      }
    })();

    await expect(died).rejects.toMatchObject({ code: 'claude_exited', message: 'Claude Code stopped unexpectedly' });
    expect(textOf(await send(chat, 'again'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(2);
  });
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('ClaudeCodeChat: the session', () => {
  it('has none until the first turn, then is the process\'s own session', async () => {
    const { chat } = harness(['plain']);
    expect(await chat.current()).toBeNull();
    expect(await chat.sessionId()).toBeNull();

    await send(chat, 'What is\n  17 times 23?');

    expect(await chat.current()).toEqual({
      path: `claude-code:${SESSION_ID}`,
      engine: 'claude-code',
      id: SESSION_ID,
      cwd: ROOT,
      title: 'What is 17 times 23?',
      created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      modified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });
    expect(await chat.sessionId()).toBe(SESSION_ID);
  });

  it('starts a clean session on newChat: the old process is closed, the next send starts another', async () => {
    const { chat, fake } = harness(['plain', 'plain']);
    await send(chat, 'one');

    expect(await chat.newChat()).toBeNull();

    expect(fake.queries[0]?.calls).toContain('close');
    expect(await chat.current()).toBeNull();
    await send(chat, 'two');
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[1]?.inputs.map((input) => input.message.content)).toEqual(['two']);
  });

  it('moves to another folder on setRoot, and does nothing for the folder it is already in', async () => {
    const { chat, fake } = harness(['plain', 'plain', 'plain']);
    await send(chat, 'one');

    expect(await chat.setRoot(ROOT)).toEqual([]);
    expect(fake.queries[0]?.calls).not.toContain('close');

    expect(await chat.setRoot('/home/example/other')).toEqual([]);
    expect(fake.queries[0]?.calls).toContain('close');
    await send(chat, 'two');
    expect(fake.queries[1]?.options.cwd).toBe('/home/example/other');

    await chat.setRoot(null);
    await send(chat, 'three');
    expect(fake.queries[2]?.options.cwd).toBe(config.primaryWorkspaceRoot);
  });

  it('closes its process on dispose, and again is harmless', async () => {
    const { chat, fake } = harness(['plain']);
    await send(chat, 'one');

    await chat.dispose();
    await chat.dispose();

    expect(fake.queries[0]?.calls).toContain('close');
    expect(await chat.current()).toBeNull();
  });
});

/** Collects what a client following the shared session sees, until `stop`. */
function follow(chat: ClaudeCodeChat) {
  const stop = new AbortController();
  const seen: ChatChunk[] = [];
  const done = (async () => {
    for await (const chunk of chat.observe(stop.signal)) seen.push(chunk);
  })();
  return { seen, end: () => { stop.abort(); return done; } };
}

describe('ClaudeCodeChat: following the shared session', () => {
  it('tells other clients when a turn starts and ends, and who started it', async () => {
    const { chat } = harness(['plain']);
    const watcher = follow(chat);

    await send(chat, 'hi');
    // `send` takes the origin as its fourth argument.
    await watcher.end();

    expect(watcher.seen).toEqual([
      { kind: 'turn-started', origin: null },
      { kind: 'turn-ended', origin: null },
    ]);
  });

  it('carries the sender\'s client id, and announces new chats and re-roots', async () => {
    const { chat } = harness(['plain']);
    const watcher = follow(chat);

    await drain(chat.send('hi', new AbortController().signal, {}, 'tab-1'));
    await chat.newChat('tab-2');
    await chat.setRoot('/home/example/other', 'tab-3');
    await watcher.end();

    expect(watcher.seen).toEqual([
      { kind: 'turn-started', origin: 'tab-1' },
      { kind: 'turn-ended', origin: 'tab-1' },
      { kind: 'session-changed', origin: 'tab-2', session: null },
      { kind: 'session-changed', origin: 'tab-3', session: null },
    ]);
  });

  it('ends a turn\'s broadcast even when the turn fails', async () => {
    const { chat } = harness([], { resolveBin: () => Promise.resolve(null) });
    const watcher = follow(chat);

    await expect(send(chat, 'hi')).rejects.toBeInstanceOf(Error);
    await watcher.end();

    expect(watcher.seen.map((chunk) => chunk.kind)).toEqual(['turn-started', 'turn-ended']);
  });
});

describe('ClaudeCodeChat: the model picker', () => {
  const recorded = JSON.parse(
    readFileSync(new URL('./fixtures/supported-models.json', import.meta.url), 'utf8'),
  ) as unknown[];

  it('offers the three aliases until a process has listed the real models', async () => {
    const { chat } = harness([], {}, recorded);

    expect((await chat.list()).map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('lists the models Claude Code reports once the first process is up, asking only once', async () => {
    const { chat, fake } = harness(['plain', 'plain'], {}, recorded);

    await send(chat, 'one');
    await vi.waitFor(async () => expect((await chat.list()).map((model) => model.id)).toEqual([
      'opus', 'sonnet', 'haiku', 'claude-haiku-4-5-20251001',
    ]));
    await chat.newChat();
    await send(chat, 'two');

    expect(fake.queries.map((query) => query.supportedModelsAsked)).toEqual([1, 0]);
    expect((await chat.list())[0]).toMatchObject({ provider: 'claude-code', id: 'opus', name: 'Opus 5.5' });
  });

  it('keeps the aliases when the process cannot list models, and the turn is unaffected', async () => {
    const { chat } = harness(['plain'], {}, new Error('control request failed'));

    expect(textOf(await send(chat, 'hi'))).toBe('17 × 23 = **391**.');
    expect((await chat.list()).map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ClaudeCodeChat: only the owner starts turns', () => {
  it('stamps each prompt with its own uuid, which the CLI echoes on the turn it starts for it', async () => {
    const { chat, fake } = harness(['stamped', 'plain']);

    await send(chat, 'one');
    await send(chat, 'two');

    const [first, second] = fake.queries[0]?.inputs ?? [];
    expect(first?.uuid).toMatch(UUID);
    expect(second?.uuid).toMatch(UUID);
    expect(first?.uuid).not.toBe(second?.uuid);
  });

  it('interrupts a turn the CLI starts on its own and never lets it reach the next prompt', async () => {
    // A background task finishes: the CLI starts a turn, unprompted, with no stamps (recorded 2026-10-17).
    const { chat, fake } = harness(['background', 'bash']);
    await send(chat, 'start a background task');
    const query = fake.queries[0];
    if (!query) throw new Error('no process');

    void query.startUnsolicited(turnFixture('unsolicited'));
    await vi.waitFor(() => expect(query.calls).toContain('interrupt'));
    const answer = await send(chat, 'now run echo');

    expect(answer.find((chunk) => chunk.kind === 'tool-call')).toMatchObject({ tool: 'Bash' });
    expect(textOf(answer)).toBe('The command printed `fixture-ok`, which is the exact text it was asked to echo.');
    // A plain interrupt: `cancelQueued` would cancel the prompt waiting behind it.
    expect(query.calls).toEqual(['accountInfo', 'input', 'interrupt', 'input']);
  });

  it('gives a prompt sent just as the CLI starts its own turn the prompt\'s answer, not the other turn\'s', async () => {
    const { chat, fake } = harness(['plain', 'after-interrupt']);
    await send(chat, 'one');
    const query = fake.queries[0];
    if (!query) throw new Error('no process');
    // The unprompted turn is about to start, but has not yet said anything.
    const unprompted = query.startUnsolicited(turnFixture('unsolicited'), { holdAt: 0 });

    const answer = send(chat, 'reply with one word');
    await vi.waitFor(() => expect(query.inputs).toHaveLength(2));
    unprompted.release();

    expect(textOf(await answer)).toBe('pong');
    expect(query.calls).toEqual(['accountInfo', 'input', 'input', 'interrupt']);
  });

  it('denies every tool call made outside a turn the owner started', async () => {
    const guard = vi.fn<ToolGuard['guard']>(() => Promise.resolve(undefined));
    const { chat, fake } = harness(['plain', 'plain'], { guard: { guard } });
    await send(chat, 'one');
    const query = fake.queries[0];
    if (!query) throw new Error('no process');
    // A CLI that ignores the interrupt keeps running the unprompted turn, tool call and all.
    query.ignoreInterrupts = true;

    await query.startUnsolicited(turnFixture('bash')).done;

    expect(query.hookAnswers).toEqual([
      DENY('Vault blocked this call: no turn started by you is running'),
    ]);
    expect(guard).not.toHaveBeenCalled();
    // The chat carries on once that turn has ended.
    expect(textOf(await send(chat, 'two'))).toBe('17 × 23 = **391**.');
  });

  it('ends a turn only on a result that names its prompt', async () => {
    const plain = turnFixture('plain');
    // Stamp the turn with a token the fake swaps for the prompt's uuid.
    const mine = plain.messages.map((message) =>
      message.type === 'result' || (message.type === 'system' && ['init', 'status'].includes(String(message.subtype)))
        ? { ...message, user_message_uuid: 'MINE', user_message_uuids: ['MINE'] }
        : message,
    );
    const someoneElses = { ...mine.at(-1), user_message_uuid: 'other', user_message_uuids: ['other'] };
    // After init and status, before any of the answer.
    const { chat } = harness([{ ...plain, stampedWith: 'MINE', messages: [...mine.slice(0, 2), someoneElses, ...mine.slice(2)] }]);

    // The result for another prompt passes by; the turn runs on to its own.
    expect(textOf(await send(chat, 'hi'))).toBe('17 × 23 = **391**.');
  });

  it('falls back to position when the CLI stamps nothing at all', async () => {
    const { chat } = harness([{ ...turnFixture('plain'), stamp: false }, { ...turnFixture('bash'), stamp: false }]);

    expect(textOf(await send(chat, 'one'))).toBe('17 × 23 = **391**.');
    expect(textOf(await send(chat, 'two'))).toContain('fixture-ok');
  });
});

describe('ClaudeCodeChat: no send outlives its session', () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  // A stopped turn that never finishes draining (a CLI that ignores the interrupt),
  // with a second prompt waiting behind it when its session goes away.
  it.each([
    ['the process exits', (_chat: ClaudeCodeChat, query: { exit(): void }) => Promise.resolve(query.exit())],
    ['the chat is replaced', (chat: ClaudeCodeChat) => chat.newChat().then(() => undefined)],
    ['the folder changes', (chat: ClaudeCodeChat) => chat.setRoot('/home/example/other').then(() => undefined)],
    ['the sidecar shuts down', (chat: ClaudeCodeChat) => chat.dispose()],
  ])('ends a send waiting for a stopped turn, and frees the chat, when %s', async (_name, endSession) => {
    const { chat, fake } = harness(['interrupted', 'plain']);
    const stop = new AbortController();
    for await (const chunk of chat.send('wait', stop.signal)) {
      if (chunk.kind === 'tool-call') {
        const query = fake.queries[0];
        if (query) query.ignoreInterrupts = true;
        stop.abort();
      }
    }
    const waiting = send(chat, 'and then this');
    waiting.catch(() => undefined);
    await tick();

    await endSession(chat, fake.queries[0] as { exit(): void });

    await expect(waiting).rejects.toMatchObject({
      message: 'the Claude Code session ended — send again',
      code: 'claude_exited',
    });
    // The chat is not stuck: the next send starts a fresh process.
    expect(textOf(await send(chat, 'once more'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(2);
  });
});

describe('ClaudeCodeChat: checking the login before the first prompt', () => {
  it('asks who is logged in first, and goes ahead on the subscription', async () => {
    const { chat, fake } = harness(['plain']);

    await send(chat, 'hi');

    expect(fake.queries[0]?.calls.slice(0, 2)).toEqual(['accountInfo', 'input']);
  });

  it.each<[string, AccountInfo]>([
    ['an API key', { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }],
    ['an API key from /login', { apiKeySource: '/login managed key', apiProvider: 'firstParty' }],
    ['an auth token', { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' }],
    ['Amazon Bedrock', { apiProvider: 'bedrock' }],
    ['Google Vertex AI', { apiProvider: 'vertex' }],
    ['Microsoft Foundry', { apiProvider: 'foundry' }],
  ])('goes ahead on %s, the sign-in the CLI chose', async (_name, account) => {
    const { chat, fake } = harness(['plain'], {}, [], account);

    expect(textOf(await send(chat, 'hi'))).toBe('17 × 23 = **391**.');
    expect(fake.queries[0]?.calls.slice(0, 2)).toEqual(['accountInfo', 'input']);
  });

  it('refuses when nothing is signed in, and never sends the prompt', async () => {
    const { chat, fake } = harness(['plain', 'plain'], {}, [], { tokenSource: 'none', apiProvider: 'firstParty' });

    await expect(send(chat, 'a private question')).rejects.toMatchObject({
      code: 'claude_not_logged_in',
      message: 'Claude Code is not logged in — run `claude`, then /login, in a terminal',
    });

    expect(fake.queries[0]?.inputs).toEqual([]);
    expect(fake.queries[0]?.calls).toContain('close');
    // Nothing is cached: the next send asks again, on a fresh process.
    await expect(send(chat, 'again')).rejects.toMatchObject({ code: 'claude_not_logged_in' });
    expect(fake.queries).toHaveLength(2);
  });

  it('refuses when the login cannot be read at all', async () => {
    const { chat, fake } = harness(['plain'], {}, [], new Error('the process exited'));

    await expect(send(chat, 'hi')).rejects.toMatchObject({
      code: 'claude_account_unreadable',
      message: 'Could not confirm the Claude Code login — the process exited',
    });
    expect(fake.queries[0]?.inputs).toEqual([]);
  });
});

describe('ClaudeCodeChat: a stopped prompt does not run unseen', () => {
  const stopOnceSent = async (chat: ClaudeCodeChat, fake: { queries: { inputs: unknown[] }[] }) => {
    const stop = new AbortController();
    const stream = drain(chat.send('a prompt the CLI has not started', stop.signal));
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));
    stop.abort();
    return stream;
  };

  it('cancels it with the interrupt, so the next prompt is not stuck behind it', async () => {
    const { chat, fake } = harness([held(turnFixture('plain')), 'after-interrupt']);

    expect(await stopOnceSent(chat, fake)).toEqual([]);

    expect(fake.queries[0]?.calls).toContain('interrupt:cancelQueued');
    expect(textOf(await send(chat, 'reply with one word'))).toBe('pong');
  });

  it('interrupts it again if the CLI starts it anyway', async () => {
    // A CLI that ignores `cancelQueued` keeps the prompt and runs it later.
    const { chat, fake } = harness([held(turnFixture('plain')), 'after-interrupt']);
    const query = () => {
      const first = fake.queries[0];
      if (!first) throw new Error('no process');
      return first;
    };
    const stop = new AbortController();
    const stopped = drain(chat.send('a prompt the CLI has not started', stop.signal));
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));
    query().honourCancelQueued = false;
    stop.abort();
    await stopped;
    const next = send(chat, 'reply with one word');

    void query().startHeld();

    expect(textOf(await next)).toBe('pong');
    expect(query().calls.filter((call) => call.startsWith('interrupt'))).toEqual(['interrupt:cancelQueued', 'interrupt']);
  });
});

describe('ClaudeCodeChat: replacing a chat mid-turn', () => {
  const replacedMidTurn = (replace: (chat: ClaudeCodeChat) => Promise<unknown>) => {
    const { chat } = harness(['interrupted']);
    const seen: ChatChunk[] = [];
    const turn = (async () => {
      // The recorded run sits on a long Bash call; the chat is replaced while it runs.
      for await (const chunk of chat.send('wait', new AbortController().signal)) {
        seen.push(chunk);
        if (chunk.kind === 'tool-call') await replace(chat);
      }
    })();
    return { turn, seen };
  };

  it.each([
    ['a new chat', (chat: ClaudeCodeChat) => chat.newChat()],
    ['another folder', (chat: ClaudeCodeChat) => chat.setRoot('/home/example/other')],
  ])('tells the turn it was cut off by %s, instead of ending it as if it had finished', async (_name, replace) => {
    const { turn } = replacedMidTurn(replace);

    await expect(turn).rejects.toMatchObject({ message: 'chat was replaced', code: 'claude_replaced' });
  });

  it('ends a turn with chat_closed when the chat is closed (a forced close, or the sidecar shutting down)', async () => {
    const { turn } = replacedMidTurn((chat) => chat.dispose());

    await expect(turn).rejects.toMatchObject({ code: 'chat_closed' });
  });
});

describe('ClaudeCodeChat: a login check that never answers', () => {
  const never = (): Promise<AccountInfo> => new Promise(() => undefined);
  const firstNeverAnswers = (attempt: number): Promise<AccountInfo> =>
    attempt === 0 ? never() : Promise.resolve(MAX_ACCOUNT);

  it('lets Esc end the send, frees the chat, and does not make a new chat wait', async () => {
    const { chat, fake } = harness(['plain'], {}, [], firstNeverAnswers);
    const stop = new AbortController();
    const first = drain(chat.send('hi', stop.signal));
    await vi.waitFor(() => expect(fake.queries).toHaveLength(1));

    stop.abort();
    expect(await first).toEqual([]);
    await chat.newChat();

    // The process that never answered is killed, and the chat is free again.
    expect(fake.queries[0]?.calls).toContain('close');
    expect(fake.queries[0]?.inputs).toEqual([]);
    expect(textOf(await send(chat, 'again'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(2);
  });

  it('gives up after a while with a message, and the next send tries again', async () => {
    const { chat, fake } = harness(['plain'], { accountTimeoutMs: 20 }, [], firstNeverAnswers);

    await expect(send(chat, 'hi')).rejects.toMatchObject({
      code: 'claude_account_unreadable',
      message: 'Could not confirm the Claude Code login — the check did not answer in time',
    });
    expect(fake.queries[0]?.calls).toContain('close');
    expect(fake.queries[0]?.inputs).toEqual([]);

    expect(textOf(await send(chat, 'again'))).toBe('17 × 23 = **391**.');
  });

  it('ends a send waiting for the start when the chat is replaced, and never sends to the late process', async () => {
    let answer: (account: AccountInfo) => void = () => undefined;
    const { chat, fake } = harness(['plain'], {}, [], (attempt) =>
      attempt === 0 ? new Promise<AccountInfo>((resolve) => { answer = resolve; }) : Promise.resolve(MAX_ACCOUNT),
    );
    // A process that is slow to die: it is still alive when its start finally finishes.
    fake.onStart = (query) => {
      query.survivesClose = true;
    };
    const waiting = send(chat, 'hi');
    waiting.catch(() => undefined);
    await vi.waitFor(() => expect(fake.queries).toHaveLength(1));

    await chat.newChat();
    await expect(waiting).rejects.toMatchObject({ code: 'claude_exited' });
    answer(MAX_ACCOUNT);

    await vi.waitFor(() => expect(fake.queries[0]?.calls.filter((call) => call === 'close')).toHaveLength(2));
    expect(fake.queries[0]?.inputs).toEqual([]);
    // The late process was discarded, not adopted: this send starts its own.
    expect(textOf(await send(chat, 'again'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[0]?.inputs).toEqual([]);
  });
});

describe('ClaudeCodeChat: a prompt the CLI ends without showing a turn', () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const noAnswer = { code: 'claude_no_answer', message: 'Claude Code ended this prompt without showing an answer — send it again' };

  it('settles on a result that names the prompt even though no turn began, and says nothing was shown', async () => {
    // A local command's reply with no `system/init` before it (the CLI's own error path does the same).
    const usage = JSON.parse(
      readFileSync(new URL('./fixtures/usage-query-messages.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>[];
    const initless: TurnFixture = {
      description: 'a turn without an init',
      hookInputs: [],
      awaitInterruptAt: null,
      messages: usage.filter((message) => message.type !== 'system'),
    };
    const { chat } = harness([initless, 'plain']);

    await expect(send(chat, '/usage')).rejects.toMatchObject(noAnswer);
    // Not stuck behind it.
    expect(textOf(await send(chat, 'next'))).toBe('17 × 23 = **391**.');
  });

  it('settles a prompt the CLI folded into a turn of its own, whose answer is not shown', async () => {
    const unsolicited = turnFixture('unsolicited');
    const messages = unsolicited.messages.slice(unsolicited.messages.findIndex((m) => m.subtype === 'init'));
    const folded: TurnFixture = {
      ...unsolicited,
      stampedWith: 'FOLDED',
      messages: [
        ...messages.slice(0, -1),
        { ...messages.at(-1), user_message_uuid: 'FOLDED', user_message_uuids: ['FOLDED'] },
      ],
    };
    const { chat, fake } = harness([folded, 'plain']);

    await expect(send(chat, 'a prompt the CLI folds into its own turn')).rejects.toMatchObject(noAnswer);

    expect(fake.queries[0]?.calls).toContain('interrupt');
    expect(JSON.stringify(folded.messages)).toContain('background command');
    expect(textOf(await send(chat, 'next'))).toBe('17 × 23 = **391**.');
  });

  it.each(['cancelled', 'completed'] as const)(
    'settles a prompt the CLI reports %s without ever starting it',
    async (state) => {
      const { chat, fake } = harness([held(turnFixture('plain')), 'after-interrupt']);
      const waiting = send(chat, 'a prompt the CLI drops');
      waiting.catch(() => undefined);
      await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));

      fake.queries[0]?.dropHeld(state);

      await expect(waiting).rejects.toMatchObject(noAnswer);
      expect(textOf(await send(chat, 'reply with one word'))).toBe('pong');
    },
  );

  it('settles a stopped prompt the CLI drops, without a word to the owner', async () => {
    const { chat, fake } = harness([held(turnFixture('plain')), 'after-interrupt']);
    const stop = new AbortController();
    const first = drain(chat.send('a prompt the CLI drops', stop.signal));
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));
    const query = fake.queries[0];
    if (query) query.honourCancelQueued = false;
    stop.abort();
    expect(await first).toEqual([]);

    const next = send(chat, 'reply with one word');
    await tick();
    query?.dropHeld('cancelled');

    expect(textOf(await next)).toBe('pong');
  });

  it('lets Esc abandon the wait for a stopped prompt that never ends, so the next send is not stuck behind it', async () => {
    // The CLI neither starts the stopped prompt nor says what became of it.
    const { chat, fake } = harness([held(turnFixture('plain')), 'after-interrupt']);
    const stopFirst = new AbortController();
    const first = drain(chat.send('A', stopFirst.signal));
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));
    const query = fake.queries[0];
    if (query) query.honourCancelQueued = false;
    stopFirst.abort();
    await first;

    const stopSecond = new AbortController();
    const second = drain(chat.send('B', stopSecond.signal));
    await tick(30);
    stopSecond.abort();
    expect(await second).toEqual([]);
    expect(query?.inputs).toHaveLength(1);

    expect(textOf(await send(chat, 'C'))).toBe('pong');
    expect(query?.inputs).toHaveLength(2);
  });
});

describe('ClaudeCodeChat: the tail of an abandoned turn', () => {
  it('never reaches the prompt sent after it was abandoned', async () => {
    const { chat, fake } = harness(['interrupted', 'plain']);
    const stopFirst = new AbortController();
    for await (const chunk of chat.send('wait', stopFirst.signal)) {
      // The CLI sits on the interrupt, so the stopped turn keeps draining.
      if (chunk.kind === 'tool-call') {
        const query = fake.queries[0];
        if (query) query.ignoreInterrupts = true;
        stopFirst.abort();
      }
    }
    // The owner gives up on the wait with Esc, which abandons the stopped turn.
    const stopSecond = new AbortController();
    const second = drain(chat.send('B', stopSecond.signal));
    await new Promise((resolve) => setTimeout(resolve, 30));
    stopSecond.abort();
    await second;

    const third = send(chat, 'C');
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(2));
    fake.queries[0]?.releaseStopped();

    const answer = await third;
    expect(textOf(answer)).toBe('17 × 23 = **391**.');
    // The stopped turn's tool result is its own, not C's.
    expect(answer.some((chunk) => chunk.kind === 'tool-result' || chunk.kind === 'tool-call')).toBe(false);
  });
});

describe('ClaudeCodeChat: a turn of its own before the first prompt\'s turn', () => {
  const withoutCapabilities = (fixture: TurnFixture): TurnFixture => ({
    ...fixture,
    messages: fixture.messages.map((message) =>
      Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'capabilities')),
    ),
  });

  it.each([
    ['a CLI that reports it stamps (msg_lifecycle_v1)', turnFixture('unsolicited')],
    ['a CLI that reports nothing about stamping', withoutCapabilities(turnFixture('unsolicited'))],
  ])('is not taken for the owner\'s, for %s', async (_name, unprompted) => {
    const { chat, fake } = harness(['plain']);
    let release: () => void = () => undefined;
    // The CLI is already busy with its own turn when the first prompt arrives.
    fake.onStart = (query) => {
      const playing = query.startUnsolicited(unprompted, { holdAt: 0 });
      release = () => playing.release();
    };
    const answer = send(chat, 'what is 17 * 23?');
    await vi.waitFor(() => expect(fake.queries[0]?.inputs).toHaveLength(1));

    release();

    expect(textOf(await answer)).toBe('17 × 23 = **391**.');
    expect(fake.queries[0]?.calls).toEqual(['accountInfo', 'input', 'interrupt']);
  });
});
