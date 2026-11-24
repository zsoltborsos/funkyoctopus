import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { StoredSession } from './sessions.ts';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { drain, follow, harness, ROOT, send, textOf } from '../test/claude-chat-harness.ts';
import { inSession, turnFixture } from '../test/claude-fixtures.ts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

/** Two real rows of `listSessions` for /home/example/projects/alpha, and the sessions `claude agents --json` reported. */
const ROWS = fixture<StoredSession[]>('list-sessions');
const AGENTS = fixture<{ sessionId: string; name: string; cwd: string; status: string; kind: string; startedAt: number }[]>('agents');

const ALPHA = '/home/example/projects/alpha';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

describe('ClaudeCodeChat: the history list', () => {
  it('lists the root\'s stored sessions, newest first as the SDK gives them, as history rows', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;

    const rows = await chat.listChats(ALPHA);

    expect(sessions.callsTo('list')).toEqual([`list:${JSON.stringify({ dir: ALPHA, limit: 50, includeWorktrees: false })}`]);
    expect(rows).toEqual([
      {
        path: `claude-code:${FIRST}`,
        engine: 'claude-code',
        id: FIRST,
        cwd: ALPHA,
        // The owner's /rename wins over the generated summary.
        title: 'Flaky status poll',
        created: '2026-10-17T16:39:16.225Z',
        modified: '2026-10-17T17:21:36.220Z',
      },
      {
        path: `claude-code:${SECOND}`,
        engine: 'claude-code',
        id: SECOND,
        cwd: ALPHA,
        title: 'Draft the release notes',
        created: '2026-10-17T14:39:16.225Z',
        modified: '2026-10-17T16:21:36.220Z',
      },
    ]);
  });

  it('lists the root\'s own sessions only: a folder inside a git repository does not borrow its worktrees\' chats', async () => {
    // The SDK folds in the sessions of every worktree of the repository by default, so a fresh scratch folder
    // under a repo showed that repo's history (measured). pi lists the folder's own, and so does this.
    const { chat, sessions } = harness([]);

    await chat.listChats(ROOT);
    await chat.setRoot('/home/example/other');

    expect(sessions.callsTo('list').every((call) => call.includes('"includeWorktrees":false'))).toBe(true);
    expect(sessions.callsTo('list')).toHaveLength(2);
  });

  it('lists the most recent sessions of every folder, fewer of them, when no root is given', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;

    await chat.listChats(null);

    expect(sessions.callsTo('list')).toEqual([`list:${JSON.stringify({ limit: 40 })}`]);
  });

  it('labels a session by its first prompt when it has neither a name nor a summary, and collapses it to one line', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = [{ sessionId: FIRST, summary: '', firstPrompt: 'why does\n   the build fail?', lastModified: 1792257696220, cwd: ALPHA }];

    const [row] = await chat.listChats(ALPHA);

    expect(row?.title).toBe('why does the build fail?');
  });

  it('places a session that recorded no folder in the folder it was listed under, and leaves it out of the global list', async () => {
    const { chat, sessions } = harness([]);
    const bare: StoredSession = { ...(ROWS[0] as StoredSession) };
    delete bare.cwd;
    sessions.rows = [bare];

    expect((await chat.listChats(ALPHA)).map((row) => row.cwd)).toEqual([ALPHA]);
    expect(await chat.listChats(null)).toEqual([]);
  });

  it('says so when the sessions cannot be listed, instead of showing an empty history', async () => {
    const { chat, sessions } = harness([]);
    sessions.failure = new Error('EACCES: permission denied');

    await expect(chat.listChats(ROOT)).rejects.toMatchObject({
      message: 'Could not list Claude Code sessions — EACCES: permission denied',
      code: 'claude_sessions_error',
    });
  });
});

/** Real `getSessionMessages` output for FIRST (see the fixture), before its /compact. */
const STORED = fixture<{ preCompact: unknown[] }>('session-messages').preCompact;

describe('ClaudeCodeChat: opening a session that is not live elsewhere', () => {
  it('rejects an id it cannot read, naming the problem, before reading or changing anything', async () => {
    const { chat, sessions, fake } = harness([]);

    for (const path of ['claude-code:not-a-uuid', '/home/example/.pi/agent/sessions/a.jsonl', 'claude-code:', `claude-code:${FIRST}/../x`]) {
      await expect(chat.openChat(path)).rejects.toMatchObject({ code: 'claude_bad_session' });
    }

    expect(sessions.calls).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });

  it('answers with the stored conversation and arms the session without starting a process', async () => {
    const { chat, sessions, fake } = harness([]);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);

    const timeline = await chat.openChat(`claude-code:${FIRST}`);

    expect(sessions.callsTo('messages')).toEqual([`messages:${FIRST}@${ALPHA}`]);
    expect(timeline).toHaveLength(8);
    expect(timeline[0]).toMatchObject({ role: 'user', steps: [{ kind: 'text', text: 'Reply with exactly: pineapple-7' }] });
    // Opening only arms: no process, so no prompt and no turn.
    expect(fake.queries).toHaveLength(0);
  });

  it('is then the current session and the session id, before any process exists', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;

    await chat.openChat(`claude-code:${FIRST}`);

    expect(await chat.current()).toEqual({
      path: `claude-code:${FIRST}`,
      engine: 'claude-code',
      id: FIRST,
      cwd: ALPHA,
      title: 'Flaky status poll',
      created: '2026-10-17T16:39:16.225Z',
      modified: '2026-10-17T17:21:36.220Z',
    });
    expect(await chat.sessionId()).toBe(FIRST);
  });

  it('tells followers, with the session, and re-roots the engine at the session\'s own folder', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    const watcher = follow(chat);

    await chat.openChat(`claude-code:${FIRST}`, 'tab-1');
    await send(chat, 'carry on');
    await watcher.end();

    expect(watcher.seen[0]).toMatchObject({ kind: 'session-changed', origin: 'tab-1', session: { id: FIRST, cwd: ALPHA } });
    // Resume looks the session up under its own folder, so the process starts there.
    expect(fake.queries[0]?.options.cwd).toBe(ALPHA);
  });

  it('resumes it in place on the next send, and the init that confirms the same id announces nothing', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    const watcher = follow(chat);
    await chat.openChat(`claude-code:${FIRST}`);

    const chunks = await send(chat, 'carry on');
    await watcher.end();

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST });
    expect(fake.queries[0]?.options).not.toHaveProperty('forkSession');
    expect(fake.queries[0]?.inputs.map((input) => input.message.content)).toEqual(['carry on']);
    expect(textOf(chunks)).toBe('17 × 23 = **391**.');
    expect(watcher.seen.map((chunk) => chunk.kind)).toEqual(['session-changed', 'turn-started', 'turn-ended']);
    expect((await chat.current())?.title).toBe('Flaky status poll');
  });

  it('gates the resumed process on the login check like any other start', async () => {
    const { chat, sessions, fake } = harness(['plain'], {}, [], { apiProvider: 'firstParty' });
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);

    await expect(send(chat, 'carry on')).rejects.toMatchObject({ code: 'claude_not_logged_in' });

    expect(fake.queries[0]?.inputs).toEqual([]);
  });

  it('reads the stored conversation again for a follower or a reload, from the session it armed', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    await chat.openChat(`claude-code:${FIRST}`);

    expect(await chat.transcript()).toHaveLength(8);
    expect(sessions.callsTo('messages')).toEqual([`messages:${FIRST}@${ALPHA}`, `messages:${FIRST}@${ALPHA}`]);
  });

  it('leaves the open chat alone when the session is unknown, or its folder is gone', async () => {
    const { chat, sessions } = harness(['plain']);
    sessions.rows = ROWS;
    await send(chat, 'first');

    await expect(chat.openChat(`claude-code:${SECOND.replace('2', '9')}`)).rejects.toMatchObject({
      code: 'claude_session_not_found',
    });
    const gone = harness([], { folderExists: () => Promise.resolve(false) });
    gone.sessions.rows = ROWS;
    await expect(gone.chat.openChat(`claude-code:${FIRST}`)).rejects.toMatchObject({ code: 'folder_not_found' });

    expect((await chat.current())?.id).toBe(FIRST);
    expect(await gone.chat.current()).toBeNull();
  });

  it('says so when the stored conversation cannot be read, and changes nothing', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    sessions.failure = undefined;
    const failing = new Error('EIO');
    const original = sessions.messages.bind(sessions);
    sessions.messages = () => Promise.reject(failing);

    await expect(chat.openChat(`claude-code:${FIRST}`)).rejects.toMatchObject({
      message: 'Could not read the Claude Code session — EIO',
      code: 'claude_transcript_error',
    });

    sessions.messages = original;
    expect(await chat.current()).toBeNull();
  });
});

/** `claude agents --json` shows the owner's terminal session FIRST ('alpha-a') as running. */
const NOTE_LIVE =
  "opened as a fork: this session is live in Claude Code 'alpha-a' (/home/example/projects/alpha); your terminal session is untouched";
/** The id a fork reports once its process is up. */
const FORK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('ClaudeCodeChat: opening a session that is live elsewhere', () => {
  it('opens it as a fork and tells the owner, naming where it is running', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    sessions.running = AGENTS;

    const timeline = await chat.openChat(`claude-code:${FIRST}`);

    expect(timeline).toHaveLength(9);
    expect(timeline.at(-1)).toMatchObject({
      kind: 'custom-message',
      customType: 'funkyoctopus-note',
      display: true,
      content: NOTE_LIVE,
    });
    // Still only armed: nothing is spawned, so nothing is resumed in place beside the terminal's.
    expect(fake.queries).toHaveLength(0);
    expect(sessions.callsTo('live')).toEqual(['live']);

    await send(chat, 'carry on');
    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    // The fork needs no second answer: it can never drive the original.
    expect(sessions.callsTo('live')).toEqual(['live']);
  });

  it('keeps the note with the conversation, for a reload or a following tab', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    sessions.running = AGENTS;
    await chat.openChat(`claude-code:${FIRST}`);

    const again = await chat.transcript();

    expect(again.at(-1)).toMatchObject({ kind: 'custom-message', content: NOTE_LIVE });
    expect(again).toHaveLength(9);
  });

  it('adopts the id the fork reports, and tells the other tabs once the turn is over', async () => {
    const { chat, sessions } = harness([inSession(turnFixture('plain'), FORK)]);
    sessions.rows = ROWS;
    sessions.running = AGENTS;
    await chat.openChat(`claude-code:${FIRST}`);
    const watcher = follow(chat);

    await drain(chat.send('carry on', new AbortController().signal, {}, 'tab-1'));
    await watcher.end();

    expect(await chat.sessionId()).toBe(FORK);
    expect(await chat.current()).toMatchObject({ path: `claude-code:${FORK}`, id: FORK, cwd: ALPHA });
    // After the turn, not in the middle of it: a tab told mid-turn would show the chat idle while it streams.
    expect(watcher.seen).toEqual([
      { kind: 'turn-started', origin: 'tab-1' },
      { kind: 'turn-ended', origin: 'tab-1' },
      { kind: 'session-changed', origin: 'tab-1', session: expect.objectContaining({ id: FORK }) as unknown },
    ]);
    // What a follower reloads is the fork's own transcript now, still with the note.
    await chat.transcript();
    expect(sessions.callsTo('messages').at(-1)).toBe(`messages:${FORK}@${ALPHA}`);
  });

  it('has no session of its own to report until the fork\'s process has said which it is', async () => {
    // The original is running in a terminal: acting on its id would be acting on the
    // terminal's session.
    const { chat, sessions } = harness([inSession(turnFixture('plain'), FORK)]);
    sessions.rows = ROWS;
    sessions.running = AGENTS;
    const watcher = follow(chat);

    await chat.openChat(`claude-code:${FIRST}`, 'tab-1');

    expect(await chat.sessionId()).toBeNull();
    expect(await chat.current()).toBeNull();
    // What the owner is reading is still the original's conversation, which the fork will continue.
    expect((await chat.transcript()).length).toBeGreaterThan(0);
    expect(sessions.callsTo('messages').at(-1)).toBe(`messages:${FIRST}@${ALPHA}`);
    await watcher.end();
    // The other tabs were shown no session either.
    expect(watcher.seen).toEqual([{ kind: 'session-changed', origin: 'tab-1', session: null }]);

    await send(chat, 'carry on');
    expect(await chat.sessionId()).toBe(FORK);
  });

  it('has none either in the stretch between a start that forked and the fork\'s first init', async () => {
    const { chat, sessions } = harness([inSession(turnFixture('plain'), FORK)]);
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);
    sessions.running = AGENTS;
    const seen: (string | null)[] = [];

    for await (const chunk of chat.send('carry on', new AbortController().signal)) {
      // The note leads the turn's stream, ahead of the prompt: no init has happened yet.
      if (chunk.kind === 'custom-message') seen.push(await chat.sessionId());
    }

    expect(seen).toEqual([null]);
    expect(await chat.sessionId()).toBe(FORK);
  });

  it('does not count its own live process as another one', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    await send(chat, 'first');
    // The engine\'s own process is running, and `claude agents` lists it like any other.
    sessions.running = AGENTS;
    const watcher = follow(chat);

    const timeline = await chat.openChat(`claude-code:${FIRST}`);
    await watcher.end();

    expect(timeline).toHaveLength(8);
    expect(timeline.some((item) => 'kind' in item && item.kind === 'custom-message')).toBe(false);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.calls).not.toContain('close');
    expect(watcher.seen).toEqual([]);
  });

  it('forks rather than guess when it cannot tell whether the session is running', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    sessions.runningError = 'Could not list live Claude Code sessions — claude agents gave an unexpected answer';

    const timeline = await chat.openChat(`claude-code:${FIRST}`);
    await send(chat, 'carry on');

    expect(timeline.at(-1)).toMatchObject({
      content:
        'opened as a fork: could not check whether this session is live in another Claude Code (Could not list live Claude Code sessions — claude agents gave an unexpected answer); the original is untouched',
    });
    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST, forkSession: true });
  });
});

describe('ClaudeCodeChat: the liveness check when the process starts', () => {
  it('asks again, and resumes in place when the session is still not running', async () => {
    const { chat, sessions, fake } = harness(['plain', 'plain']);
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);

    await send(chat, 'one');
    await send(chat, 'two');

    expect(sessions.callsTo('live')).toHaveLength(2);
    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST });
    expect(fake.queries[0]?.options).not.toHaveProperty('forkSession');
    // The second send rides the same process: no new start, no new question.
    expect(fake.queries).toHaveLength(1);
  });

  it('forks at the start when the session went live after it was opened, and says so in the turn\'s own stream', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);
    // The owner resumed it in a terminal in the meantime.
    sessions.running = AGENTS;

    const chunks = await send(chat, 'carry on');

    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    expect(chunks[0]).toMatchObject({ kind: 'custom-message', customType: 'funkyoctopus-note', content: NOTE_LIVE });
    expect(textOf(chunks)).toBe('17 × 23 = **391**.');
    // And a reload shows it too.
    expect((await chat.transcript()).at(-1)).toMatchObject({ content: NOTE_LIVE });
  });

  it('keeps the fork note when the start that decided it fails, so the next send does not fork silently', async () => {
    const { chat, fake, sessions } = harness(
      ['plain'],
      {},
      [],
      (attempt) => (attempt === 0 ? Promise.reject(new Error('the login check failed')) : Promise.resolve(LOGGED_IN)),
    );
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);
    // The owner resumed it in a terminal after it was armed.
    sessions.running = AGENTS;

    await expect(send(chat, 'one')).rejects.toMatchObject({ code: 'claude_account_unreadable' });
    // The conversation is already a fork: a reload shows why.
    expect((await chat.transcript()).filter((item) => 'kind' in item && item.kind === 'custom-message')).toHaveLength(1);

    const chunks = await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    // Said once, not again for the retry that forked.
    expect(chunks.some((chunk) => chunk.kind === 'custom-message')).toBe(false);
    expect((await chat.transcript()).filter((item) => 'kind' in item && item.kind === 'custom-message')).toHaveLength(1);
  });

  it('starts a fresh chat without asking: there is nothing to double-drive', async () => {
    const { chat, sessions } = harness(['plain']);

    await send(chat, 'hello');

    expect(sessions.callsTo('live')).toEqual([]);
  });
});

describe('ClaudeCodeChat: continuing a folder\'s latest session', () => {
  it('arms the newest session that is not running elsewhere and answers with its conversation', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    const watcher = follow(chat);

    const timeline = await chat.setRoot(ALPHA, 'tab-1');
    await watcher.end();

    expect(timeline).toHaveLength(8);
    expect(sessions.callsTo('list')).toEqual([`list:${JSON.stringify({ dir: ALPHA, limit: 50, includeWorktrees: false })}`]);
    expect(await chat.sessionId()).toBe(FIRST);
    expect(watcher.seen).toEqual([
      { kind: 'session-changed', origin: 'tab-1', session: expect.objectContaining({ id: FIRST, cwd: ALPHA }) as unknown },
    ]);
    expect(fake.queries).toHaveLength(0);

    await send(chat, 'carry on');
    expect(fake.queries[0]?.options).toMatchObject({ cwd: ALPHA, resume: FIRST });
  });

  it('passes over a session running elsewhere to the next one', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.running = AGENTS.filter((agent) => agent.sessionId === FIRST);

    await chat.setRoot(ALPHA);

    expect(await chat.sessionId()).toBe(SECOND);
  });

  it('starts fresh when there is nothing to continue, or all of it is running elsewhere', async () => {
    const { chat, sessions, fake } = harness(['plain']);
    const watcher = follow(chat);

    expect(await chat.setRoot(ALPHA, 'tab-1')).toEqual([]);
    expect(await chat.current()).toBeNull();

    sessions.rows = ROWS.slice(0, 1);
    sessions.running = AGENTS;
    expect(await chat.setRoot('/home/example/projects/beta', 'tab-1')).toEqual([]);
    expect(await chat.setRoot(ALPHA, 'tab-1')).toEqual([]);
    await watcher.end();

    expect(watcher.seen.every((chunk) => chunk.kind === 'session-changed' && chunk.session === null)).toBe(true);
    await send(chat, 'hello');
    expect(fake.queries[0]?.options).not.toHaveProperty('resume');
  });

  it('does not continue a session recorded in another folder, such as a worktree\'s', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: '/home/example/projects/alpha-wt' }];

    await chat.setRoot(ALPHA);

    expect(await chat.current()).toBeNull();
  });

  it('continues the folder\'s latest session on the first setRoot even in the folder the engine started in', async () => {
    // A sidecar restart and a page reload: the browser re-applies its folder, which is the engine's own.
    const { chat, sessions, fake } = harness(['plain']);
    sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT }];
    sessions.transcripts.set(FIRST, STORED);
    const watcher = follow(chat);

    const timeline = await chat.setRoot(ROOT, 'tab-1');
    await watcher.end();

    expect(timeline).toHaveLength(8);
    expect(await chat.sessionId()).toBe(FIRST);
    // Nothing changed for the other tabs' folder, and nothing was started.
    expect(watcher.seen).toEqual([]);
    expect(fake.queries).toHaveLength(0);
    await send(chat, 'carry on');
    expect(fake.queries[0]?.options).toMatchObject({ cwd: ROOT, resume: FIRST });
  });

  it('then is silent and reads nothing for the folder it is already in', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT }];
    await chat.setRoot(ROOT, 'tab-1');
    sessions.calls.length = 0;
    const watcher = follow(chat);

    await chat.setRoot(ROOT, 'tab-2');
    await watcher.end();

    expect(sessions.callsTo('list')).toEqual([]);
    expect(sessions.callsTo('live')).toEqual([]);
    expect(watcher.seen).toEqual([]);
  });

  it('does not replace a chat the owner started afresh, or one already running, when a tab re-applies its folder', async () => {
    const afresh = harness(['plain']);
    afresh.sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT }];
    await afresh.chat.newChat();
    await afresh.chat.setRoot(ROOT);
    expect(await afresh.chat.current()).toBeNull();

    const running = harness(['plain']);
    running.sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT, sessionId: SECOND }];
    await send(running.chat, 'hello');
    await running.chat.setRoot(ROOT);
    expect(await running.chat.sessionId()).toBe(FIRST);
  });

  it('still arms the latest session when the running-sessions read fails: the start asks again', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    sessions.runningError = 'claude agents gave an unexpected answer';

    await chat.setRoot(ALPHA);

    expect(await chat.sessionId()).toBe(FIRST);
  });

  it('keeps the chat it has, and says so, when the folder\'s sessions cannot be listed', async () => {
    const { chat, sessions } = harness(['plain']);
    await send(chat, 'first');
    sessions.failure = new Error('EACCES');

    await expect(chat.setRoot(ALPHA)).rejects.toMatchObject({ code: 'claude_sessions_error' });

    expect(await chat.sessionId()).toBe(FIRST);
  });
});

describe('ClaudeCodeChat: the idle reaper', () => {
  it('schedules the close for the configured quiet time once a turn has ended, 15 minutes by default', async () => {
    const quick = harness(['plain'], { idleMs: 5_000 });
    const usual = harness(['plain']);

    await send(quick.chat, 'hi');
    await send(usual.chat, 'hi');

    expect(quick.timers.pending()).toEqual([{ ms: 5_000 }]);
    expect(usual.timers.pending()).toEqual([{ ms: 15 * 60_000 }]);
  });

  it('has nothing scheduled before the first turn, and none while a turn runs', async () => {
    const { chat, timers } = harness(['plain', 'plain']);
    expect(timers.pending()).toEqual([]);
    await send(chat, 'one');
    expect(timers.pending()).toHaveLength(1);

    const second = chat.send('two', new AbortController().signal);
    const first = await second[Symbol.asyncIterator]().next();

    expect(first.done).toBe(false);
    expect(timers.pending()).toEqual([]);
  });

  it('restarts the timer at each turn\'s end', async () => {
    const { chat, timers } = harness(['plain', 'plain']);

    await send(chat, 'one');
    await send(chat, 'two');

    expect(timers.pending()).toHaveLength(1);
  });

  it('closes the process when the time is up, and the conversation stays the open one', async () => {
    const { chat, fake, timers } = harness(['plain']);
    await send(chat, 'one');

    timers.fire();

    expect(fake.queries[0]?.calls).toContain('close');
    expect(await chat.sessionId()).toBe(FIRST);
    expect(await chat.current()).toMatchObject({ id: FIRST, title: 'one' });
    expect(timers.pending()).toEqual([]);
  });

  it('starts nothing by itself: no process, no prompt, nothing announced', async () => {
    const { chat, fake, timers } = harness(['plain']);
    await send(chat, 'one');
    const watcher = follow(chat);

    timers.fire();
    await watcher.end();

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.inputs).toHaveLength(1);
    expect(watcher.seen).toEqual([]);
  });

  it('lets the next send resume the session transparently: login check, liveness check, resume', async () => {
    const { chat, fake, sessions, timers } = harness(['plain', 'plain']);
    await send(chat, 'one');
    timers.fire();
    const watcher = follow(chat);

    const chunks = await send(chat, 'two');
    await watcher.end();

    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, cwd: ROOT });
    expect(fake.queries[1]?.options).not.toHaveProperty('forkSession');
    expect(fake.queries[1]?.calls.slice(0, 2)).toEqual(['accountInfo', 'input']);
    expect(sessions.callsTo('live')).toHaveLength(1);
    expect(textOf(chunks)).toBe('17 × 23 = **391**.');
    // Same session, same id: the tabs have nothing to reload.
    expect(watcher.seen.map((chunk) => chunk.kind)).toEqual(['turn-started', 'turn-ended']);
  });

  it('forks on the resume when the owner took the session over in a terminal while it was reaped', async () => {
    let at = 1_000_000;
    const { chat, fake, sessions, timers } = harness(['plain', 'plain'], { now: () => at });
    await send(chat, 'one');
    timers.fire();
    // Long after: a row for the session now is somebody else's, not the process that was closed.
    at += 15 * 60_000;
    sessions.running = AGENTS;

    const chunks = await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    expect(chunks[0]).toMatchObject({ kind: 'custom-message', content: NOTE_LIVE });
  });

  it('does not close a process whose stopped turn is still draining, and looks again later', async () => {
    const { chat, fake, timers } = harness(['interrupted']);
    const stop = new AbortController();
    // The CLI ignores the interrupt for now: the stopped turn plays on after the stream has ended.
    for await (const chunk of chat.send('wait forty seconds', stop.signal)) {
      if (chunk.kind === 'tool-call') {
        fake.queries[0]!.ignoreInterrupts = true;
        stop.abort();
      }
    }
    expect(timers.pending()).toHaveLength(1);

    timers.fire();

    expect(fake.queries[0]?.calls).not.toContain('close');
    expect(timers.pending()).toHaveLength(1);
  });

  it('does not close the process while a turn waits for the owner\'s approval', async () => {
    const vaultPath = join(await mkdtemp(join(tmpdir(), 'fo-claude-vault-')), 'vault.json');
    await writeFile(vaultPath, JSON.stringify([{ target: `${ROOT}/blocked`, action: 'escalate' }]));
    const { chat, fake, timers } = harness(['denied'], { guard: null, vaultPath });
    const seen: ChatChunk[] = [];

    for await (const chunk of chat.send('read the secret', new AbortController().signal)) {
      seen.push(chunk);
      if (chunk.kind === 'approval-request') {
        // The owner is still reading the card: nothing is scheduled, and nothing closes.
        expect(timers.pending()).toEqual([]);
        expect(fake.queries[0]?.calls).not.toContain('close');
        chat.resolveApproval(chunk.requestId, true);
      }
    }

    expect(seen.some((chunk) => chunk.kind === 'approval-request')).toBe(true);
    expect(timers.pending()).toHaveLength(1);
  });

  it('is cancelled with the process: a reset, or dispose, leaves nothing scheduled', async () => {
    const { chat, timers } = harness(['plain', 'plain']);
    await send(chat, 'one');
    await chat.newChat();
    expect(timers.pending()).toEqual([]);

    await send(chat, 'two');
    await chat.dispose();
    expect(timers.pending()).toEqual([]);
  });

  it('resumes the same conversation after a process dies, not a new one', async () => {
    const { chat, fake } = harness(['interrupted', 'plain']);
    const died = (async () => {
      for await (const chunk of chat.send('wait', new AbortController().signal)) {
        if (chunk.kind === 'tool-call') fake.queries[0]?.exit();
      }
    })();
    await expect(died).rejects.toMatchObject({ code: 'claude_exited' });

    await send(chat, 'again');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST });
  });
});

/** A promise settled from outside, for holding one step of the engine open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const LOGGED_IN = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' } as const;

describe('ClaudeCodeChat: a send that ends before its process has started', () => {
  it('still gets the idle close once the start completes, so an abandoned process does not live forever', async () => {
    // Esc, or the tab closing, during the second or so it takes `claude` to start.
    const login = deferred<typeof LOGGED_IN>();
    const { chat, fake, timers } = harness(['plain'], {}, [], () => login.promise);
    const stop = new AbortController();
    const sending = drain(chat.send('hi', stop.signal));
    await vi.waitFor(() => expect(fake.queries[0]?.calls).toContain('accountInfo'));

    stop.abort();
    await sending;
    expect(timers.pending()).toEqual([]);
    login.resolve(LOGGED_IN);

    await vi.waitFor(() => expect(timers.pending()).toEqual([{ ms: 15 * 60_000 }]));
    timers.fire();
    expect(fake.queries[0]?.calls).toContain('close');
    expect(fake.queries[0]?.inputs).toEqual([]);
  });

  it('leaves the timer to the send that is waiting on the start, which arms it at its own end', async () => {
    const login = deferred<typeof LOGGED_IN>();
    const { chat, fake, timers } = harness(['plain'], {}, [], () => login.promise);
    const sending = send(chat, 'hi');
    await vi.waitFor(() => expect(fake.queries[0]?.calls).toContain('accountInfo'));

    login.resolve(LOGGED_IN);
    await sending;

    expect(timers.pending()).toEqual([{ ms: 15 * 60_000 }]);
  });
});

describe('ClaudeCodeChat: a start that a reset has discarded', () => {
  it('spawns nothing when the chat is replaced while it waits for the liveness answer', async () => {
    const answer = deferred<{ live: never[] }>();
    const { chat, fake, sessions } = harness(['plain', 'plain']);
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);
    const live = sessions.live.bind(sessions);
    let asked = 0;
    sessions.live = (options) => {
      asked += 1;
      return answer.promise.then(() => live(options));
    };

    const sending = send(chat, 'hi');
    await vi.waitFor(() => expect(asked).toBe(1));
    await chat.newChat();
    answer.resolve({ live: [] });

    await expect(sending).rejects.toMatchObject({ code: 'claude_exited' });
    // Not even long enough to be closed: a process resumed on the old conversation, beside the new chat.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.queries).toHaveLength(0);
  });

  it('spawns nothing when the chat is replaced while it resolves the binary or builds the guard', async () => {
    const found = deferred<string>();
    const { chat, fake } = harness(['plain'], { resolveBin: () => found.promise });
    const sending = send(chat, 'hi');
    await new Promise((resolve) => setTimeout(resolve, 10));

    await chat.newChat();
    found.resolve('/opt/claude/bin/claude');

    await expect(sending).rejects.toMatchObject({ code: 'claude_exited' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.queries).toHaveLength(0);
  });

  it('closes a process whose login check is still out when the chat is replaced, and never lets it go on', async () => {
    const login = deferred<typeof LOGGED_IN>();
    const { chat, fake } = harness(['plain', 'plain'], {}, [], (attempt) => (attempt === 0 ? login.promise : Promise.resolve(LOGGED_IN)));
    const first = send(chat, 'one');
    await vi.waitFor(() => expect(fake.queries[0]?.calls).toContain('accountInfo'));

    await chat.newChat();
    await expect(first).rejects.toMatchObject({ code: 'claude_exited' });
    expect(fake.queries[0]?.calls).toContain('close');
    // The new chat starts its own process meanwhile; the first one's login answer then arrives.
    const second = send(chat, 'two');
    await vi.waitFor(() => expect(fake.queries).toHaveLength(2));
    login.resolve(LOGGED_IN);
    await second;

    expect(fake.queries[0]?.inputs).toEqual([]);
    expect(fake.queries[1]?.inputs.map((input) => input.message.content)).toEqual(['two']);
  });

  it('closes every process still starting when the chat is replaced again, not only the last one begun', async () => {
    const never = deferred<typeof LOGGED_IN>();
    const { chat, fake } = harness(['plain', 'plain'], {}, [], () => never.promise);
    const first = send(chat, 'one');
    await vi.waitFor(() => expect(fake.queries[0]?.calls).toContain('accountInfo'));
    await chat.newChat();
    await expect(first).rejects.toBeInstanceOf(Error);
    const second = send(chat, 'two');
    await vi.waitFor(() => expect(fake.queries).toHaveLength(2));

    await chat.newChat();
    await expect(second).rejects.toBeInstanceOf(Error);

    expect(fake.queries.map((query) => query.calls.includes('close'))).toEqual([true, true]);
  });
});

describe('ClaudeCodeChat: its own process, just closed', () => {
  /** The engine's clock, by hand. */
  const clock = () => {
    let at = 1_000_000;
    return { now: () => at, advance: (ms: number) => { at += ms; } };
  };
  const own = (sessionId: string) => ({ ...(AGENTS[0] as (typeof AGENTS)[number]), sessionId });

  it('is not taken for another Claude Code when it is still listed a moment after it was closed', async () => {
    const time = clock();
    const { chat, fake, sessions, timers } = harness(['plain', 'plain'], { now: time.now });
    await send(chat, 'one');
    timers.fire();
    // `claude agents` still lists the process that was just closed.
    sessions.running = [own(FIRST)];
    time.advance(2_000);

    const chunks = await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST });
    expect(fake.queries[1]?.options).not.toHaveProperty('forkSession');
    expect(chunks.some((chunk) => chunk.kind === 'custom-message')).toBe(false);
  });

  it('counts again once the grace period is over: a row that stays is somebody else\'s', async () => {
    const time = clock();
    const { chat, fake, sessions, timers } = harness(['plain', 'plain'], { now: time.now });
    await send(chat, 'one');
    timers.fire();
    sessions.running = [own(FIRST)];
    time.advance(6_000);

    const chunks = await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    expect(chunks[0]).toMatchObject({ kind: 'custom-message', content: NOTE_LIVE });
  });

  it('only forgives the session it closed: another session\'s row counts at once', async () => {
    const time = clock();
    const { chat, fake, sessions, timers } = harness(['plain', 'plain'], { now: time.now });
    sessions.rows = ROWS;
    await send(chat, 'one');
    timers.fire();
    await chat.openChat(`claude-code:${SECOND}`);
    sessions.running = [own(SECOND)];

    await chat.openChat(`claude-code:${SECOND}`);
    await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: SECOND, forkSession: true });
  });

  it('still sees a terminal that resumed the session while the engine held it, when the engine\'s process dies and the owner resends at once', async () => {
    // Only the engine\'s own dying row is forgiven in the grace period, not a terminal\'s.
    const time = clock();
    const { chat, fake, sessions } = harness(['plain', 'plain'], { now: time.now });
    await send(chat, 'one');
    sessions.running = [{ ...own(FIRST), name: 'engine', startedAt: 10 }, { ...own(FIRST), name: 'alpha-a', startedAt: 20 }];
    fake.queries[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    time.advance(1_000);

    const chunks = await send(chat, 'two');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    expect(chunks[0]).toMatchObject({ kind: 'custom-message', content: NOTE_LIVE });
  });

  it('skips a session a terminal holds as well when choosing the folder\'s latest, though the engine closed its own a moment ago', async () => {
    const time = clock();
    const { chat, sessions } = harness(['plain'], { now: time.now });
    sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT }, { ...(ROWS[1] as StoredSession), cwd: ROOT }];
    await send(chat, 'one');
    await chat.setRoot('/home/example/elsewhere');
    sessions.running = [{ ...own(FIRST), startedAt: 10 }, { ...own(FIRST), name: 'alpha-a', startedAt: 20 }];
    time.advance(1_000);

    await chat.setRoot(ROOT);

    expect(await chat.sessionId()).toBe(SECOND);
  });

  it('does not refuse a send because the process it just replaced is still listed beside the new one', async () => {
    // A cached listing taken while the old process was exiting shows both of the engine\'s own processes.
    const time = clock();
    const { chat, fake, sessions } = harness(['plain', 'plain', 'plain'], { now: time.now });
    await send(chat, 'one');
    fake.queries[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    time.advance(100);
    await send(chat, 'two');
    sessions.running = [{ ...own(FIRST), name: 'old', startedAt: 10 }, { ...own(FIRST), name: 'new', startedAt: 30 }];

    expect(textOf(await send(chat, 'three'))).toBe('17 × 23 = **391**.');

    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[1]?.calls).not.toContain('close');
  });

  it('refuses once the grace period is over and the session is still listed twice', async () => {
    const time = clock();
    const { chat, fake, sessions } = harness(['plain', 'plain', 'plain'], { now: time.now });
    await send(chat, 'one');
    fake.queries[0]?.exit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    time.advance(100);
    await send(chat, 'two');
    time.advance(6_000);
    sessions.running = [{ ...own(FIRST), name: 'old', startedAt: 10 }, { ...own(FIRST), name: 'alpha-a', startedAt: 30 }];

    await expect(send(chat, 'three')).rejects.toMatchObject({ code: 'claude_live_elsewhere' });
  });

  it('is not taken for another when the folder\'s latest session is chosen right after the engine closed it', async () => {
    const time = clock();
    const { chat, sessions } = harness(['plain'], { now: time.now });
    sessions.rows = [{ ...(ROWS[0] as StoredSession), cwd: ROOT }];
    await send(chat, 'one');
    await chat.setRoot('/home/example/elsewhere');
    sessions.running = [own(FIRST)];
    time.advance(1_000);

    await chat.setRoot(ROOT);

    expect(await chat.sessionId()).toBe(FIRST);
  });
});

describe('ClaudeCodeChat: a conversation a terminal has also resumed', () => {
  const terminal = { ...(AGENTS[0] as (typeof AGENTS)[number]), sessionId: FIRST, name: 'alpha-a', startedAt: 2_000 };
  const engineRow = { ...terminal, name: 'funkyoctopus-fo', startedAt: 1_000 };
  const REFUSAL =
    "this conversation is now also open in Claude Code 'alpha-a' — FunkyOctopus stopped here to avoid forking it; send again to continue as a fork";

  it('refuses the send, says where it is open, closes its process and sends no prompt', async () => {
    const { chat, fake, sessions } = harness(['plain', 'plain']);
    await send(chat, 'one');
    // The owner resumed the same session in a terminal: two processes now hold it.
    sessions.running = [engineRow, terminal];

    await expect(send(chat, 'two')).rejects.toMatchObject({ code: 'claude_live_elsewhere', message: REFUSAL });

    expect(fake.queries[0]?.calls).toContain('close');
    expect(fake.queries[0]?.inputs.map((input) => input.message.content)).toEqual(['one']);
    expect(sessions.callsTo('liveCached')).toHaveLength(1);
  });

  it('names the process that started later: the engine\'s own is the earlier one, as it forks rather than resume a live session', async () => {
    const { chat, sessions } = harness(['plain', 'plain']);
    await send(chat, 'one');
    // The order of the rows is not the order of the starts.
    sessions.running = [terminal, engineRow];

    await expect(send(chat, 'two')).rejects.toMatchObject({ message: REFUSAL });
  });

  it('carries on as a fork when the owner sends again, the conversation still held for the next start', async () => {
    const { chat, fake, sessions } = harness(['plain', 'plain']);
    await send(chat, 'one');
    sessions.running = [engineRow, terminal];
    await expect(send(chat, 'two')).rejects.toMatchObject({ code: 'claude_live_elsewhere' });
    expect(await chat.sessionId()).toBe(FIRST);
    // The engine\'s process is gone; what is left running is the terminal\'s.
    sessions.running = [terminal];

    const chunks = await send(chat, 'three');

    expect(fake.queries[1]?.options).toMatchObject({ resume: FIRST, forkSession: true });
    expect(chunks[0]).toMatchObject({ kind: 'custom-message', content: NOTE_LIVE });
  });

  it('sends as usual when the session is listed once, which is the engine\'s own process', async () => {
    const { chat, fake, sessions } = harness(['plain', 'plain']);
    await send(chat, 'one');
    sessions.running = [engineRow];

    expect(textOf(await send(chat, 'two'))).toBe('17 × 23 = **391**.');
    expect(fake.queries).toHaveLength(1);
  });

  it('sends as usual when it cannot tell: an unreadable listing does not stop the owner', async () => {
    const { chat, sessions } = harness(['plain', 'plain']);
    await send(chat, 'one');
    sessions.runningError = 'claude agents gave an unexpected answer';

    expect(textOf(await send(chat, 'two'))).toBe('17 × 23 = **391**.');
  });

  it('does not ask again for the send that resumed the session: its start has just asked, fresh', async () => {
    const { chat, sessions } = harness(['plain', 'plain']);
    sessions.rows = ROWS;
    await chat.openChat(`claude-code:${FIRST}`);

    await send(chat, 'one');
    expect(sessions.callsTo('liveCached')).toEqual([]);
    await send(chat, 'two');

    expect(sessions.callsTo('liveCached')).toHaveLength(1);
  });

  it('reads from the cached listing, and only for a send into a process that already existed', async () => {
    const { chat, sessions } = harness(['plain', 'plain']);

    await send(chat, 'one');
    // The process was started by that send, which asked the fresh question already (or had no one to ask about).
    expect(sessions.callsTo('liveCached')).toEqual([]);
    await send(chat, 'two');

    expect(sessions.callsTo('liveCached')).toHaveLength(1);
    expect(sessions.callsTo('live')).toEqual([]);
  });
});
