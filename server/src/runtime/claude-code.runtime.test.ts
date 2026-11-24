/**
 * Claude Code engine canary, opt-in via `npm run test:runtime`.
 *
 * Boots the production `ClaudeCodeChat` over the real Agent SDK and the owner's
 * installed `claude`, on whatever sign-in it has, and spends a handful of cheap
 * haiku turns: a plain answer; a Read the Vault must deny and one it escalates to
 * the owner (a PreToolUse hook under `bypassPermissions`); a Bash run that is
 * interrupted, and the turn after it that proves the same process survived; and
 * the turns the CLI starts by itself when a background task finishes, which the
 * engine must stop and never show. It is what notices `claude` changing under
 * the SDK pin (the stream shapes, the hook contract, the turn stamps, the
 * `--bare` default of `-p`) before the owner does; the hermetic fixtures in
 * `claude-code/fixtures` only replay what was recorded.
 *
 * The session scenarios (list, open, send, transcript; idle reap then resume;
 * a session running in another process) need sessions that are stored, so they
 * run in one scratch folder with persistence on, and the folder's Claude Code
 * state is purged (`claude purge -y`) when they are done.
 *
 * Isolation and bounds:
 * - a temp cwd, a temp Vault file, and `persistSession: false` everywhere but
 *   the session scenarios, so nothing else lands in the owner's
 *   `~/.claude/projects`;
 * - `settingSources: []`, so the owner's CLAUDE.md and hooks do not turn cheap
 *   turns into `lb` calls;
 * - a few turns in all, each capped at TURN_TIMEOUT_MS.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { config } from '../config.ts';
import { resolveClaudeBin } from '../claude-code/cli.ts';
import { ClaudeCodeChat, type ClaudeQuery, type ClaudeQueryFn } from '../claude-code/chat.ts';
import { claudeChildEnv } from '../claude-code/env.ts';
import { claudeSessionStore } from '../claude-code/sessions.ts';
import { ClaudeCodeStatus } from '../claude-code/status.ts';
import { AsyncQueue } from '../util/async-queue.ts';

const TURN_TIMEOUT_MS = 120_000;
const MODEL = { provider: 'claude-code', model: 'haiku' } as const;

/** What the tapped process did, for the assertions that look at the CLI rather than the stream. */
interface Taps {
  /** The options of every process the engine started, in order. */
  starts: Options[];
  /** How many times the engine closed a process. */
  closes: number;
  initKeySources: unknown[];
  /** One entry per `system/init`: did the CLI stamp it with the uuid of a prompt? */
  inits: { stamped: boolean }[];
  interrupts: ({ cancelQueued?: boolean } | undefined)[];
}

/** The real `query`, kept off the owner's transcripts and settings, and tapped. */
function tappedQuery(taps: Taps, { allowUnattended = false, persist = false } = {}): ClaudeQueryFn {
  return (params) => {
    const options = { ...params.options, settingSources: [], persistSession: persist };
    taps.starts.push(options);
    if (allowUnattended) {
      // Undo the engine's prevention, to watch the CLI start a turn by itself.
      delete options.disallowedTools;
      options.env = { ...options.env };
      delete options.env.CLAUDE_CODE_DISABLE_CRON;
      delete options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    }
    const live = query({ prompt: params.prompt, options });
    // Bound, not wrapped: `cancelQueued` rides through although the SDK types leave it out.
    const interrupt: ClaudeQuery['interrupt'] = live.interrupt.bind(live);
    return {
      interrupt: (opts) => {
        taps.interrupts.push(opts);
        return interrupt(opts);
      },
      setModel: (model) => live.setModel(model),
      applyFlagSettings: (settings) => live.applyFlagSettings(settings),
      supportedModels: () => live.supportedModels(),
      supportedCommands: () => live.supportedCommands(),
      accountInfo: () => live.accountInfo(),
      close: () => {
        taps.closes += 1;
        live.close();
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of live) {
          if (message.type === 'system' && message.subtype === 'init') {
            taps.initKeySources.push(message.apiKeySource);
            // The init frame carries the stamp on the wire although the SDK's type leaves it out.
            taps.inits.push({ stamped: 'user_message_uuids' in message });
          }
          yield message;
        }
      },
    };
  };
}

const SECRET = `canary-secret-${Math.random().toString(36).slice(2)}`;
let root: string;
let secretDir: string;
const chats: ClaudeCodeChat[] = [];

/** Claude Code's stored sessions and `claude agents`, as the sidecar reads them. */
const status = new ClaudeCodeStatus({ bin: config.claudeBin, version: config.version, query, listSessions });
const sessions = claudeSessionStore({
  listSessions,
  getSessionInfo,
  getSessionMessages,
  live: (fresh) => status.live(fresh),
});

/** A fresh engine over the real `claude`, in the canary's temp folder, with a Vault rule of the given kind. */
async function engine(rule: 'block' | 'escalate', unattended = false) {
  const vaultPath = join(root, `vault-${rule}-${chats.length}.json`);
  await writeFile(vaultPath, JSON.stringify([{ target: secretDir, action: rule }]));
  const taps: Taps = { starts: [], closes: 0, initKeySources: [], inits: [], interrupts: [] };
  const chat = new ClaudeCodeChat({
    query: tappedQuery(taps, { allowUnattended: unattended }),
    bin: config.claudeBin,
    version: config.version,
    root,
    vaultPath,
    sessions,
  });
  chats.push(chat);
  return { chat, taps };
}

beforeAll(async () => {
  const bin = await resolveClaudeBin(config.claudeBin, process.env.PATH ?? '');
  if (bin === null) {
    throw new Error('Claude Code is not installed (set CLAUDE_BIN); the canary has nothing to run');
  }
  root = await mkdtemp(join(tmpdir(), 'fo-claude-canary-'));
  secretDir = join(root, 'blocked');
  await mkdir(secretDir);
  await writeFile(join(secretDir, 'secret.txt'), SECRET);
});

afterAll(async () => {
  await Promise.all(chats.map((chat) => chat.dispose()));
});

/** Stream one real turn, aborted on timeout; `onChunk` may stop it early. */
async function drain(
  chat: ClaudeCodeChat,
  text: string,
  onChunk: (chunk: ChatChunk, stop: () => void) => void = () => undefined,
): Promise<ChatChunk[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of chat.send(text, controller.signal, MODEL)) {
      chunks.push(chunk);
      onChunk(chunk, () => controller.abort());
    }
  } finally {
    clearTimeout(timer);
  }
  return chunks;
}

const textOf = (chunks: ChatChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.kind === 'text' ? [chunk.delta] : [])).join('');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Claude Code engine (real claude, haiku)', () => {
  it('answers a plain turn on the installed sign-in', async () => {
    const { chat, taps } = await engine('block');

    const chunks = await drain(chat, 'Reply with exactly one word: pong');

    expect(textOf(chunks).toLowerCase()).toContain('pong');
    expect(chunks.find((chunk) => chunk.kind === 'usage')).toMatchObject({ kind: 'usage', contextWindow: expect.any(Number) as number });
    // Every init reports its key source; any sign-in method is accepted (decision 12).
    expect(taps.initKeySources.length).toBeGreaterThan(0);
    expect(taps.initKeySources.every((source) => typeof source === 'string')).toBe(true);
    // Every turn the CLI starts for a prompt is stamped with that prompt's uuid.
    expect(taps.inits.every((init) => init.stamped)).toBe(true);
    expect(await chat.sessionId()).toEqual(expect.any(String));
  });

  it('denies a Read inside a Vault-blocked folder, and the secret never reaches the stream', async () => {
    const { chat } = await engine('block');

    const chunks = await drain(chat, `Use the Read tool to read ${join(secretDir, 'secret.txt')} and tell me what it contains.`);

    const read = chunks.find((chunk) => chunk.kind === 'tool-call' && chunk.tool === 'Read');
    expect(read).toBeDefined();
    const result = chunks.find((chunk) => chunk.kind === 'tool-result' && read?.kind === 'tool-call' && chunk.callId === read.callId);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('Vault blocked access');
    expect(JSON.stringify(chunks)).not.toContain(SECRET);
  });

  it('holds an escalated Read until the owner approves it, then lets it run', async () => {
    const { chat } = await engine('escalate');
    // Long enough to show the hook is waiting on the owner, not racing a short timeout.
    const OWNER_THINKS_MS = 8_000;
    let askedAt = 0;
    let answeredAt = 0;
    const chunks: ChatChunk[] = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
    try {
      for await (const chunk of chat.send(
        `Use the Read tool to read ${join(secretDir, 'secret.txt')} and quote what it contains.`,
        controller.signal,
        MODEL,
      )) {
        chunks.push(chunk);
        if (chunk.kind === 'approval-request') {
          askedAt = Date.now();
          expect(chunks.some((c) => c.kind === 'tool-result')).toBe(false);
          await wait(OWNER_THINKS_MS);
          expect(chat.resolveApproval(chunk.requestId, true)).toBe(true);
        }
        if (chunk.kind === 'tool-result') answeredAt = Date.now();
      }
    } finally {
      clearTimeout(timer);
    }

    const request = chunks.find((chunk) => chunk.kind === 'approval-request');
    expect(request).toMatchObject({ tool: 'Read', target: secretDir });
    const result = chunks.find((chunk) => chunk.kind === 'tool-result');
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain(SECRET);
    // Nothing ran while the card was open.
    expect(answeredAt - askedAt).toBeGreaterThanOrEqual(OWNER_THINKS_MS);
  });

  it('interrupts a running tool, ends the stream without an error, and answers the next turn from the same process', async () => {
    const { chat, taps } = await engine('block');

    const chunks = await drain(
      chat,
      'Use the Bash tool to run `node -e "setTimeout(() => {}, 60000)"` and then say done.',
      (chunk, stop) => {
        if (chunk.kind === 'tool-call' && chunk.tool === 'Bash') stop();
      },
    );

    expect(chunks.some((chunk) => chunk.kind === 'tool-call' && chunk.tool === 'Bash')).toBe(true);
    expect(taps.interrupts).toEqual([{ cancelQueued: true }]);
    // The next send waits for the stopped turn's `result`, so it only answers if
    // the interrupt really ended the 60 s wait and the process lived through it.
    const started = Date.now();
    const next = await drain(chat, 'Reply with exactly one word: pong');
    expect(textOf(next).toLowerCase()).toContain('pong');
    expect(Date.now() - started).toBeLessThan(45_000);
  });

  // The CLI starts a turn of its own when a background task finishes (measured
  // 2026-10-17: a `system/init` with no uuid stamp, then a model call). With the
  // engine's prevention undone, that is what the pump must catch.
  it('stops a turn the CLI starts by itself, and the next prompt gets only its own answer', async () => {
    const { chat, taps } = await engine('block', true);

    await drain(
      chat,
      'Use the Bash tool with run_in_background set to true to run: sleep 4 && echo bg-done. Do not wait for it. Then reply with the single word started.',
    );
    // The task finishes a few seconds later and the CLI wakes itself up.
    const deadline = Date.now() + 40_000;
    while (!taps.inits.some((init) => !init.stamped) && Date.now() < deadline) await wait(250);

    expect(taps.inits.some((init) => !init.stamped)).toBe(true);
    // Stopped with a plain interrupt (a cancelling one would take a waiting prompt with it).
    await wait(1_500);
    expect(taps.interrupts).toContainEqual(undefined);
    const next = await drain(chat, 'Reply with exactly one word: pong');
    expect(textOf(next).toLowerCase()).toContain('pong');
    expect(textOf(next).toLowerCase()).not.toContain('background');
  });

  it('with its prevention in place, a background request starts no turn of its own', async () => {
    const { chat, taps } = await engine('block');

    await drain(
      chat,
      'Use the Bash tool with run_in_background set to true to run: sleep 4 && echo bg-done. Do not wait for it. Then reply with the single word started.',
    );
    await wait(15_000);

    expect(taps.inits.every((init) => init.stamped)).toBe(true);
    expect(taps.interrupts).toEqual([]);
  });
});

const execFileAsync = promisify(execFile);

/** The text of every message of a timeline, user and assistant, in order. */
const timelineText = (timeline: Awaited<ReturnType<ClaudeCodeChat['transcript']>>): string =>
  timeline
    .flatMap((item) => ('steps' in item ? item.steps.flatMap((step) => (step.kind === 'text' ? [step.text] : [])) : []))
    .join('\n');

describe('Claude Code sessions (real claude, haiku, stored in a scratch folder)', () => {
  let scratch: string;
  /** Processes the scenarios left running as "another Claude Code"; ended in afterAll. */
  const elsewhere: { close(): void }[] = [];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fo-claude-sessions-'));
  });

  afterAll(async () => {
    for (const other of elsewhere) other.close();
    await Promise.all(chats.map((chat) => chat.dispose()));
    // The scenarios stored sessions for the scratch folder; take every trace of them back out.
    const bin = await resolveClaudeBin(config.claudeBin, process.env.PATH ?? '');
    if (bin !== null) {
      await execFileAsync(bin, ['purge', '-y', scratch], { env: claudeChildEnv(process.env, config.version) });
    }
  });

  /** An engine over the real `claude` in the scratch folder, with sessions stored there. */
  async function sessionEngine({ idleMs }: { idleMs?: number } = {}) {
    const vaultPath = join(root, `vault-sessions-${chats.length}.json`);
    await writeFile(vaultPath, JSON.stringify([{ target: secretDir, action: 'block' }]));
    const taps: Taps = { starts: [], closes: 0, initKeySources: [], inits: [], interrupts: [] };
    const chat = new ClaudeCodeChat({
      query: tappedQuery(taps, { persist: true }),
      bin: config.claudeBin,
      version: config.version,
      root: scratch,
      vaultPath,
      sessions,
      ...(idleMs !== undefined ? { idleMs } : {}),
    });
    chats.push(chat);
    return { chat, taps };
  }

  /** Polls `claude agents --json` until `id` is (or is no longer) listed as running. */
  const untilRunning = (id: string, running: boolean): Promise<void> =>
    vi.waitFor(
      async () => expect((await status.live(true)).live.some((row) => row.sessionId === id)).toBe(running),
      { timeout: 30_000, interval: 500 },
    );

  /** A second process with `id` resumed and left up, as a terminal's would be. */
  async function resumeElsewhere(id: string): Promise<void> {
    const bin = await resolveClaudeBin(config.claudeBin, process.env.PATH ?? '');
    if (bin === null) throw new Error('claude is not installed');
    const input = new AsyncQueue<SDKUserMessage>();
    const other = query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: bin,
        env: claudeChildEnv(process.env, config.version),
        cwd: scratch,
        resume: id,
        model: 'haiku',
        settingSources: [],
        // It only has to be running, not to write into the session the scenario then checks.
        persistSession: false,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    elsewhere.push({
      close: () => {
        input.close();
        other.close();
      },
    });
    input.push({
      type: 'user',
      message: { role: 'user', content: 'Reply with exactly one word: here' },
      parent_tool_use_id: null,
    });
    const messages = other[Symbol.asyncIterator]();
    for (;;) {
      const next = await messages.next();
      if (next.done || next.value.type === 'result') break;
    }
  }

  it('lists, opens, resumes and rehydrates a stored session: list, open, send, transcript', async () => {
    const first = await sessionEngine();
    await drain(first.chat, 'Remember the code word kumquat-9. Reply with exactly one word: noted');
    const id = await first.chat.sessionId();
    if (id === null) throw new Error('the session never reported its id');

    // It is in the folder's history, under the folder it ran in.
    const row = (await first.chat.listChats(scratch)).find((candidate) => candidate.id === id);
    expect(row).toMatchObject({ path: `claude-code:${id}`, cwd: scratch });
    expect(row?.title).not.toBe('untitled chat');
    expect((await first.chat.listChats(null)).some((candidate) => candidate.id === id)).toBe(true);
    // A reload or a following tab reads the conversation back from Claude Code's own store.
    await vi.waitFor(async () => {
      const text = timelineText(await first.chat.transcript());
      expect(text).toContain('kumquat-9');
      expect(text.toLowerCase()).toContain('noted');
    }, { timeout: 15_000, interval: 500 });

    // The process is gone (a restart, or a long idle); the session is not.
    await first.chat.dispose();
    await untilRunning(id, false);
    const second = await sessionEngine();
    const opened = await second.chat.openChat(`claude-code:${id}`);

    expect(timelineText(opened)).toContain('kumquat-9');
    // Opening only arms the session.
    expect(second.taps.starts).toHaveLength(0);
    const answer = await drain(second.chat, 'What was the code word? Reply with just the word.');
    expect(textOf(answer).toLowerCase()).toContain('kumquat-9');
    expect(second.taps.starts[0]).toMatchObject({ resume: id, cwd: scratch });
    expect(second.taps.starts[0]).not.toHaveProperty('forkSession');
    expect(second.taps.initKeySources.every((source) => typeof source === 'string')).toBe(true);
    // Resumed in place: the same session, not a copy.
    expect(await second.chat.sessionId()).toBe(id);
    expect((await second.chat.listChats(scratch)).filter((candidate) => candidate.id === id)).toHaveLength(1);
  });

  it('closes an idle process by itself, starts nothing, and resumes the session on the next send', async () => {
    const { chat, taps } = await sessionEngine({ idleMs: 3_000 });
    await drain(chat, 'Remember the code word figwort-3. Reply with exactly one word: noted');
    const id = await chat.sessionId();
    if (id === null) throw new Error('the session never reported its id');

    await vi.waitFor(() => expect(taps.closes).toBe(1), { timeout: 30_000, interval: 250 });
    expect(taps.starts).toHaveLength(1);
    await untilRunning(id, false);
    const answer = await drain(chat, 'What was the code word? Reply with just the word.');

    expect(textOf(answer).toLowerCase()).toContain('figwort-3');
    expect(taps.starts).toHaveLength(2);
    expect(taps.starts[1]).toMatchObject({ resume: id });
    expect(taps.starts[1]).not.toHaveProperty('forkSession');
    expect(taps.initKeySources.every((source) => typeof source === 'string')).toBe(true);
    expect(await chat.sessionId()).toBe(id);
  });

  it('opens a session that is running in another process as a fork, and leaves that session alone', async () => {
    const first = await sessionEngine();
    await drain(first.chat, 'Remember the code word quince-5. Reply with exactly one word: noted');
    const id = await first.chat.sessionId();
    if (id === null) throw new Error('the session never reported its id');
    await first.chat.dispose();
    await untilRunning(id, false);
    await resumeElsewhere(id);
    await untilRunning(id, true);

    const forked = await sessionEngine();
    const opened = await forked.chat.openChat(`claude-code:${id}`);

    expect(opened.at(-1)).toMatchObject({ kind: 'custom-message', customType: 'funkyoctopus-note' });
    expect(JSON.stringify(opened.at(-1))).toContain('opened as a fork: this session is live in Claude Code');
    expect(forked.taps.starts).toHaveLength(0);
    const answer = await drain(forked.chat, 'What was the code word? Reply with just the word.');
    expect(textOf(answer).toLowerCase()).toContain('quince-5');
    expect(forked.taps.starts[0]).toMatchObject({ resume: id, forkSession: true });
    // The copy has an id of its own, and is the chat from the first init on.
    const copy = await forked.chat.sessionId();
    expect(copy).not.toBe(id);
    expect(copy).not.toBeNull();
    // The original never saw the question: nothing was written into the session running elsewhere.
    const original = JSON.stringify(await getSessionMessages(id, { dir: scratch }));
    expect(original).toContain('quince-5');
    expect(original).not.toContain('What was the code word');
    await vi.waitFor(async () => {
      expect(JSON.stringify(await getSessionMessages(copy ?? '', { dir: scratch }))).toContain('What was the code word');
    }, { timeout: 15_000, interval: 500 });
  });
});
