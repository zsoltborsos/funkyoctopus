import { describe, expect, it, vi } from 'vitest';
import { claudeSessionStore, sessionIdOf, sessionPath, toSessionInfo } from './sessions.ts';

const ID = '11111111-1111-4111-8111-111111111111';

describe('session identity on the wire', () => {
  it('is claude-code:<uuid>, and reads back to the uuid', () => {
    expect(sessionPath(ID)).toBe('claude-code:11111111-1111-4111-8111-111111111111');
    expect(sessionIdOf(sessionPath(ID))).toBe(ID);
  });

  it.each([
    'claude-code:',
    'claude-code:1111',
    `claude-code:${ID}x`,
    `claude-code:../${ID}`,
    `claude-code:${ID}/../../x`,
    `claude:${ID}`,
    ID,
    '/home/example/.pi/agent/sessions/a.jsonl',
  ])('does not read %s as a session', (path) => {
    expect(sessionIdOf(path)).toBeNull();
  });
});

describe('toSessionInfo', () => {
  it('takes the stored times as given and leaves the message count out', () => {
    expect(toSessionInfo({ sessionId: ID, summary: 'A summary', lastModified: 1792257696220, cwd: '/w' })).toEqual({
      path: `claude-code:${ID}`,
      engine: 'claude-code',
      id: ID,
      cwd: '/w',
      title: 'A summary',
      // No createdAt recorded: the last-modified time stands in.
      created: '2026-10-17T17:21:36.220Z',
      modified: '2026-10-17T17:21:36.220Z',
    });
  });
});

describe('claudeSessionStore', () => {
  it('reads each kind of thing from the SDK function that owns it, with the arguments it needs', async () => {
    const listSessions = vi.fn(() => Promise.resolve([]));
    const getSessionInfo = vi.fn(() => Promise.resolve(undefined));
    const getSessionMessages = vi.fn(() => Promise.resolve([]));
    const live = vi.fn((_fresh: boolean) => Promise.resolve({ live: [] }));
    const store = claudeSessionStore({ listSessions, getSessionInfo, getSessionMessages, live });

    await store.list({ dir: '/w', limit: 50 });
    await store.info(ID);
    await store.messages(ID, '/w');
    await store.live();
    await store.live({ fresh: true });

    expect(listSessions).toHaveBeenCalledWith({ dir: '/w', limit: 50 });
    // A session is found wherever it is stored: opening one does not know its folder yet.
    expect(getSessionInfo).toHaveBeenCalledWith(ID);
    expect(getSessionMessages).toHaveBeenCalledWith(ID, { dir: '/w' });
    // The cached listing unless a fresh one is asked for.
    expect(live.mock.calls).toEqual([[false], [true]]);
  });
});
