/**
 * A Claude Code chat restored after a sidecar restart (T2.3): `arm` brings its
 * session back for the next send and nothing more. It spawns no `claude`
 * (limit 2) and leaves fork-or-resume to the start-time liveness check (limit
 * 5), so a `claude agents` read that fails at boot cannot fork every tab.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionRef } from '../../../src/shared/transport/protocol.ts';
import { config } from '../config.ts';
import { harness, send } from '../test/claude-chat-harness.ts';
import type { StoredSession } from './sessions.ts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

const ROWS = fixture<StoredSession[]>('list-sessions');
const AGENTS = fixture<{ sessionId: string; name: string; cwd: string; status: string; kind: string; startedAt: number }[]>('agents');
const STORED = fixture<{ preCompact: unknown[] }>('session-messages').preCompact;
const ALPHA = '/home/example/projects/alpha';
const FIRST = '11111111-1111-4111-8111-111111111111';
const armFirst = { id: FIRST, path: `claude-code:${FIRST}` };

describe('ClaudeCodeChat.arm: restore after a restart', () => {
  it('arms the stored session in its own folder, spawning nothing and asking nobody whether it is live', async () => {
    const { chat, sessions, fake } = harness([], { fresh: true });
    sessions.rows = ROWS;
    sessions.transcripts.set(FIRST, STORED);
    sessions.running = AGENTS;
    const heard: (SessionRef | null)[] = [];
    chat.onIdentity((ref) => heard.push(ref));

    expect(await chat.arm(armFirst)).toBe(true);

    expect(fake.queries).toHaveLength(0);
    expect(sessions.callsTo('live')).toEqual([]);
    expect(sessions.callsTo('liveCached')).toEqual([]);
    expect(chat.info()).toMatchObject({ id: FIRST, cwd: ALPHA, title: 'Flaky status poll' });
    expect(chat.folder()).toBe(ALPHA);
    expect(heard).toEqual([{ engine: 'claude-code', id: FIRST }]);
    expect(chat.running()).toBe(false);
    expect((await chat.transcript()).length).toBeGreaterThan(0);
  });

  it('resumes in place at the next send when nothing else runs it', async () => {
    const { chat, sessions, fake } = harness(['plain'], { fresh: true });
    sessions.rows = ROWS;
    await chat.arm(armFirst);

    await send(chat, 'carry on');

    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST, cwd: ALPHA });
    expect(fake.queries[0]?.options).not.toHaveProperty('forkSession');
    expect(sessions.callsTo('live')).toEqual(['live']);
  });

  it('forks at the next send when a terminal runs it by then: the start decides, not the boot', async () => {
    const { chat, sessions, fake } = harness(['plain'], { fresh: true });
    sessions.rows = ROWS;
    await chat.arm(armFirst);
    sessions.running = AGENTS;

    await send(chat, 'carry on');

    expect(fake.queries[0]?.options).toMatchObject({ resume: FIRST, forkSession: true });
  });

  it('a running-sessions read that fails at boot does not turn the tab into a fork', async () => {
    const { chat, sessions, fake } = harness(['plain'], { fresh: true });
    sessions.rows = ROWS;
    sessions.runningError = 'claude agents timed out';
    await chat.arm(armFirst);
    sessions.runningError = undefined;

    await send(chat, 'carry on');

    expect(fake.queries[0]?.options).not.toHaveProperty('forkSession');
  });

  it('a session Claude Code no longer has arms nothing', async () => {
    const { chat, sessions } = harness([], { fresh: true });
    sessions.rows = [];
    expect(await chat.arm(armFirst)).toBe(false);
    expect(chat.info()).toBeNull();
  });

  it('a session whose folder is gone arms nothing', async () => {
    const { chat, sessions } = harness([], { fresh: true, folderExists: () => Promise.resolve(false) });
    sessions.rows = ROWS;
    expect(await chat.arm(armFirst)).toBe(false);
    expect(chat.info()).toBeNull();
  });

  it('a restored main does not then continue the folder’s latest over its armed session', async () => {
    const { chat, sessions } = harness([]);
    sessions.rows = ROWS;
    await chat.arm(armFirst);
    await chat.setRoot(ALPHA);
    expect(chat.info()?.id).toBe(FIRST);
    expect(sessions.callsTo('list')).toEqual([]);
  });

  it('names its folder, null at the global root', () => {
    expect(harness([], { root: config.primaryWorkspaceRoot }).chat.folder()).toBeNull();
    expect(harness([]).chat.folder()).toBe('/home/example/project');
  });
});
