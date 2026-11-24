import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredSession } from '../claude-code/sessions.ts';
import type { ProjectPaths } from '../projects/registry.ts';
import { FakeSessions } from '../test/fake-claude-sessions.ts';
import { ChatSearch } from './chat-search.ts';

const roots: string[] = [];

/** A temp pi session store; its own path doubles as the (existing) cwd every fixture chat ran in. */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-chat-search-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const header = (id: string, cwd: string): object => ({
  type: 'session',
  version: 3,
  id,
  timestamp: '2026-08-08T12:00:00.000Z',
  cwd,
});

const user = (text: string): object => ({
  type: 'message',
  id: `u-${text.length}`,
  timestamp: '2026-08-08T12:00:01.000Z',
  message: { role: 'user', content: text },
});

const sessionInfo = (name: string): object => ({
  type: 'session_info',
  id: `n-${name.length}`,
  timestamp: '2026-08-08T12:00:02.000Z',
  name,
});

const assistant = (content: object[]): object => ({
  type: 'message',
  id: `a-${JSON.stringify(content).length}`,
  timestamp: '2026-08-08T12:00:03.000Z',
  message: { role: 'assistant', content },
});

const toolResult = (text: string): object => ({
  type: 'message',
  id: `t-${text.length}`,
  timestamp: '2026-08-08T12:00:04.000Z',
  message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text }] },
});

interface PiFixture {
  /** The per-cwd directory under the session root. */
  dir?: string;
  /** The folder the chat recorded; the temp root, which exists, by default. */
  cwd?: string;
  entries: object[];
  modified?: Date;
}

/** Write one pi session file the way pi lays it out; returns its path. */
async function writePi(root: string, id: string, fixture: PiFixture): Promise<string> {
  const dir = join(root, fixture.dir ?? 'proj');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `2026-08-08T12-00-00-000Z_${id}.jsonl`);
  const lines = [header(id, fixture.cwd ?? root), ...fixture.entries].map((entry) => JSON.stringify(entry));
  await writeFile(path, `${lines.join('\n')}\n`);
  const modified = fixture.modified ?? new Date('2026-08-08T12:00:00.000Z');
  await utimes(path, modified, modified);
  return path;
}

function makeSearch(
  root: string,
  claude = new FakeSessions(),
  projectPaths: () => Promise<ProjectPaths[]> = () => Promise.resolve([]),
  // A minute passes between searches unless a test holds the clock.
  now: () => number = minuteClock(),
): ChatSearch {
  return new ChatSearch({ sessionRoot: root, claude, projectPaths, now });
}

function minuteClock(): () => number {
  let at = 0;
  return () => (at += 60_000);
}

describe('word matching over pi chats', () => {
  it('finds a chat that holds every query word, in any order and any case', async () => {
    const root = await createRoot();
    await writePi(root, 'both', { entries: [user('Why does DeepSeek stream tool calls oddly?')] });
    await writePi(root, 'half', { entries: [user('only the deepseek half of it')] });
    await writePi(root, 'none', { entries: [user('nothing relevant here')] });

    const result = await makeSearch(root).search('TOOL deepseek');

    expect(result.hits.map((hit) => hit.id)).toEqual(['both']);
    expect(result.total).toBe(1);
    expect(result.searched).toBe(3);
  });
});

describe('what a pi chat is searched on', () => {
  it('returns the history row of each match, without a message count', async () => {
    const root = await createRoot();
    const path = await writePi(root, 'row-1', {
      entries: [user('Plan the   migration\nof the sessions')],
      modified: new Date('2026-09-01T10:30:00.000Z'),
    });

    const { hits } = await makeSearch(root).search('migration');

    expect(hits).toEqual([
      {
        path,
        engine: 'pi',
        id: 'row-1',
        cwd: root,
        title: 'Plan the migration of the sessions',
        created: '2026-08-08T12:00:00.000Z',
        modified: '2026-09-01T10:30:00.000Z',
        snippet: expect.any(String),
      },
    ]);
  });

  it("matches the chat's name, which is also its title", async () => {
    const root = await createRoot();
    await writePi(root, 'named', {
      entries: [user('first question about caching'), sessionInfo('Quarterly planning')],
    });

    const { hits } = await makeSearch(root).search('quarterly');

    expect(hits.map((hit) => hit.title)).toEqual(['Quarterly planning']);
  });

  it('matches the text of user messages and of assistant text parts', async () => {
    const root = await createRoot();
    await writePi(root, 'said', {
      entries: [user('ask about zebrafish'), assistant([{ type: 'text', text: 'the answer mentions narwhals' }])],
    });

    const search = makeSearch(root);

    expect((await search.search('zebrafish')).total).toBe(1);
    expect((await search.search('narwhals')).total).toBe(1);
  });

  it('does not match tool calls, tool output or thinking', async () => {
    const root = await createRoot();
    await writePi(root, 'quiet', {
      entries: [
        user('please list the files'),
        assistant([
          { type: 'thinking', thinking: 'hmm, a hidden marmoset thought' },
          { type: 'text', text: 'listing now' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls /srv/pangolin' } },
        ]),
        toolResult('output mentions an aardvark'),
      ],
    });

    const search = makeSearch(root);

    for (const word of ['marmoset', 'pangolin', 'aardvark']) {
      expect((await search.search(word)).total).toBe(0);
    }
    expect((await search.search('listing')).total).toBe(1);
  });
});

describe('ordering and limits', () => {
  /** `count` chats that all mention "shared", chat `n` last touched `n` days after the first of the month. */
  async function manyChats(root: string, count: number): Promise<void> {
    for (let n = 1; n <= count; n += 1) {
      await writePi(root, `chat-${String(n).padStart(3, '0')}`, {
        entries: [user(`shared topic number ${n}`)],
        modified: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000),
      });
    }
  }

  it('lists the newest match first and says how many matched in all', async () => {
    const root = await createRoot();
    await manyChats(root, 5);

    const result = await makeSearch(root).search('shared', 2);

    expect(result.hits.map((hit) => hit.id)).toEqual(['chat-005', 'chat-004']);
    expect(result.total).toBe(5);
    expect(result.searched).toBe(5);
  });

  it('returns 30 hits unless asked for another number', async () => {
    const root = await createRoot();
    await manyChats(root, 35);

    const result = await makeSearch(root).search('shared');

    expect(result.hits).toHaveLength(30);
    expect(result.total).toBe(35);
  });

  it('never returns more than 100 hits', async () => {
    const root = await createRoot();
    await manyChats(root, 102);

    const result = await makeSearch(root).search('shared', 5_000);

    expect(result.hits).toHaveLength(100);
    expect(result.total).toBe(102);
  });
});

describe('snippets', () => {
  const snippetFor = async (text: string, query: string, name?: string): Promise<string> => {
    const root = await createRoot();
    await writePi(root, 'snip', { entries: [user(text), ...(name ? [sessionInfo(name)] : [])] });
    const { hits } = await makeSearch(root).search(query);
    return hits[0]?.snippet ?? '(no hit)';
  };

  it('is the whole text, with no ellipsis, when the chat is short', async () => {
    expect(await snippetFor('a short question about pangolins', 'pangolins')).toBe('a short question about pangolins');
  });

  it('collapses whitespace to single spaces', async () => {
    expect(await snippetFor('line one\n\n   line   two\tpangolins', 'pangolins')).toBe('line one line two pangolins');
  });

  it('cuts about 140 characters around the match and marks both cuts with an ellipsis', async () => {
    const text = `${'before '.repeat(60)}needle${' after'.repeat(60)}`;

    const snippet = await snippetFor(text, 'NEEDLE');

    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    const body = snippet.slice(1, -1);
    // About 140: a space left at either cut is trimmed.
    expect(body.length).toBeGreaterThan(130);
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body).toContain('needle');
    expect(text).toContain(body);
    // Near the start, where a one-line row still shows it, with some context before it.
    const at = body.indexOf('needle');
    expect(at).toBeGreaterThan(20);
    expect(at).toBeLessThanOrEqual(30);
  });

  it('marks only the cut that was made', async () => {
    const lead = `pangolins ${'filler '.repeat(60)}`;
    const trail = `${'filler '.repeat(60)}pangolins`;

    const head = await snippetFor(lead, 'pangolins');
    const tail = await snippetFor(trail, 'pangolins');

    expect(head.startsWith('pangolins')).toBe(true);
    expect(head.endsWith('…')).toBe(true);
    expect(head.length).toBeGreaterThan(130);
    expect(head.length).toBeLessThanOrEqual(141);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('pangolins')).toBe(true);
    expect(tail.length).toBeGreaterThan(130);
    expect(tail.length).toBeLessThanOrEqual(141);
  });

  it('starts just before the longest query word, not the first', async () => {
    const text = `we start here with the ${'padding '.repeat(40)}and then pangolins appear ${'tail '.repeat(40)}`;

    const snippet = await snippetFor(text, 'the pangolins');

    expect(snippet).toContain('pangolins');
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('shows the start of the chat when only its name matched', async () => {
    expect(await snippetFor('how do I cache things?', 'quarterly', 'Quarterly planning')).toBe('how do I cache things?');
  });
});

describe('the pi index', () => {
  const T1 = new Date('2026-08-08T12:00:00.000Z');
  const T2 = new Date('2026-08-09T12:00:00.000Z');

  it('reads nothing until the first search', async () => {
    const root = await createRoot();
    await writePi(root, 'early', { entries: [user('written before the search object')] });
    const search = makeSearch(root);
    // Written after construction: only a first search that builds the index sees it.
    await writePi(root, 'late', { entries: [user('written after the search object')] });

    const result = await search.search('written');

    expect(result.hits.map((hit) => hit.id).sort()).toEqual(['early', 'late']);
  });

  it('does not read a file again while its mtime and size are unchanged', async () => {
    const root = await createRoot();
    const entries = (word: string): object[] => [user(`${word} topic`)];
    await writePi(root, 'same', { entries: entries('alpha'), modified: T1 });
    const search = makeSearch(root);
    expect((await search.search('alpha')).total).toBe(1);

    // Same size, same mtime, different words: a re-read would see them.
    await writePi(root, 'same', { entries: entries('bravo'), modified: T1 });

    expect((await search.search('alpha')).total).toBe(1);
    expect((await search.search('bravo')).total).toBe(0);
  });

  it('reads a file again when its mtime changes', async () => {
    const root = await createRoot();
    await writePi(root, 'touched', { entries: [user('alpha topic')], modified: T1 });
    const search = makeSearch(root);
    await search.search('alpha');

    await writePi(root, 'touched', { entries: [user('bravo topic')], modified: T2 });

    expect((await search.search('alpha')).total).toBe(0);
    expect((await search.search('bravo')).total).toBe(1);
  });

  it('reads a file again when its size changes', async () => {
    const root = await createRoot();
    await writePi(root, 'grown', { entries: [user('alpha topic')], modified: T1 });
    const search = makeSearch(root);
    await search.search('alpha');

    await writePi(root, 'grown', { entries: [user('alpha topic'), user('and then charlie')], modified: T1 });

    expect((await search.search('charlie')).total).toBe(1);
  });

  it('reads a changed file again at most once a minute', async () => {
    const root = await createRoot();
    await writePi(root, 'busy', { entries: [user('alpha topic')], modified: T1 });
    let at = 0;
    const search = makeSearch(root, undefined, undefined, () => at);
    await search.search('alpha');

    await writePi(root, 'busy', { entries: [user('bravo topic')], modified: T2 });
    at = 59_999;
    expect((await search.search('bravo')).total).toBe(0);

    at = 60_000;
    expect((await search.search('bravo')).total).toBe(1);
  });

  it('adds new files and drops deleted ones', async () => {
    const root = await createRoot();
    const gone = await writePi(root, 'gone', { entries: [user('shared words')] });
    const search = makeSearch(root);
    expect((await search.search('shared')).searched).toBe(1);

    await rm(gone);
    await writePi(root, 'fresh', { entries: [user('shared words again')] });
    const result = await search.search('shared');

    expect(result.hits.map((hit) => hit.id)).toEqual(['fresh']);
    expect(result.searched).toBe(1);
  });
});

describe('files that cannot be read', () => {
  it('skips a corrupt, truncated or headerless file without hiding the valid chats', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'proj'), { recursive: true });
    await writeFile(join(root, 'proj', 'corrupt.jsonl'), 'not json\n{"type":"message"}\n');
    await writeFile(join(root, 'proj', 'truncated.jsonl'), '{"type":"session","id":"cut');
    await writeFile(join(root, 'proj', 'empty.jsonl'), '');
    await writeFile(join(root, 'proj', 'notes.txt'), 'shared words');
    await writePi(root, 'valid', { entries: [user('shared words')] });

    const result = await makeSearch(root).search('shared');

    expect(result.hits.map((hit) => hit.id)).toEqual(['valid']);
    expect(result.searched).toBe(1);
  });

  it('skips a malformed line and still reads the rest of the chat', async () => {
    const root = await createRoot();
    const path = await writePi(root, 'patchy', { entries: [user('before the damage')] });
    await appendFile(path, 'this line is not json\n');
    await appendFile(path, `${JSON.stringify(user('after the damage'))}\n`);

    const result = await makeSearch(root).search('before damage after');

    expect(result.total).toBe(1);
  });

  it('has no pi chats when the session root does not exist', async () => {
    const root = await createRoot();

    const result = await makeSearch(join(root, 'never-created')).search('anything');

    expect(result).toEqual({ hits: [], total: 0, searched: 0 });
  });
});

describe('folders that moved', () => {
  it('remaps a pi chat the way global history does', async () => {
    const root = await createRoot();
    const current = join(root, 'projects', 'app');
    await mkdir(current, { recursive: true });
    await writePi(root, 'moved', { cwd: '/old-machine/app', entries: [user('relocated topic')] });
    await writePi(root, 'lost', { cwd: '/nowhere/at/all', entries: [user('relocated topic')] });
    await writePi(root, 'home', { cwd: current, entries: [user('relocated topic')] });
    const index: ProjectPaths[] = [{ name: 'app', path: current, oldPaths: ['/old-machine/app'] }];

    const { hits } = await makeSearch(root, new FakeSessions(), () => Promise.resolve(index)).search('relocated');

    const byId = Object.fromEntries(hits.map((hit) => [hit.id, hit]));
    expect(byId.moved).toMatchObject({ cwd: current, movedFrom: '/old-machine/app' });
    expect(byId.lost).toMatchObject({ cwd: '/nowhere/at/all', folderGone: true });
    expect(byId.home).toMatchObject({ cwd: current });
    expect(byId.home).not.toHaveProperty('movedFrom');
    expect(byId.home).not.toHaveProperty('folderGone');
  });
});

const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const CLAUDE_B = '22222222-2222-4222-8222-222222222222';
const CLAUDE_C = '33333333-3333-4333-8333-333333333333';

/** A stored Claude Code session as `listSessions` describes it. */
const claudeRow = (sessionId: string, cwd: string, rest: Partial<StoredSession> = {}): StoredSession => ({
  sessionId,
  summary: '',
  lastModified: Date.UTC(2026, 8, 1, 9, 0, 0),
  fileSize: 1_000,
  cwd,
  ...rest,
});

/** A stored message as `getSessionMessages` returns it. */
const claudeMessage = (type: 'user' | 'assistant', content: unknown): object => ({
  type,
  uuid: `m-${JSON.stringify(content).length}`,
  session_id: CLAUDE_A,
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

describe('Claude Code chats', () => {
  it('are searched with the pi chats, from the transcript the store reads for their folder', async () => {
    const root = await createRoot();
    await writePi(root, 'pi-chat', { entries: [user('discussing kestrels with pi')], modified: new Date('2026-08-01T00:00:00.000Z') });
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, '/work/claude-folder', { summary: 'Kestrel notes', lastModified: Date.UTC(2026, 8, 1, 9, 0, 0) })];
    store.transcripts.set(CLAUDE_A, [claudeMessage('user', 'tell me about kestrels'), claudeMessage('assistant', [{ type: 'text', text: 'they hover' }])]);

    const result = await makeSearch(root, store).search('kestrels');

    expect(result.hits.map((hit) => hit.id)).toEqual([CLAUDE_A, 'pi-chat']);
    expect(result.hits[0]).toEqual({
      path: `claude-code:${CLAUDE_A}`,
      engine: 'claude-code',
      id: CLAUDE_A,
      cwd: '/work/claude-folder',
      title: 'Kestrel notes',
      created: '2026-09-01T09:00:00.000Z',
      modified: '2026-09-01T09:00:00.000Z',
      snippet: 'tell me about kestrels they hover',
    });
    expect(result.searched).toBe(2);
    // Every session of every folder, and the transcript of the folder the session records.
    expect(store.callsTo('list')).toEqual(['list:{}']);
    expect(store.callsTo('messages')).toEqual([`messages:${CLAUDE_A}@/work/claude-folder`]);
  });

  it('are matched on text blocks and string content, not on tool use, tool results or thinking', async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, root)];
    store.transcripts.set(CLAUDE_A, [
      claudeMessage('user', [{ type: 'text', text: 'please list the files' }]),
      claudeMessage('assistant', [{ type: 'thinking', thinking: 'a hidden marmoset thought' }]),
      claudeMessage('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls /srv/pangolin' } }]),
      claudeMessage('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'an aardvark appears' }]),
      claudeMessage('assistant', 'listing them now'),
    ]);
    const search = makeSearch(root, store);

    for (const word of ['marmoset', 'pangolin', 'aardvark']) {
      expect((await search.search(word)).total).toBe(0);
    }
    expect((await search.search('files')).total).toBe(1);
    expect((await search.search('listing')).total).toBe(1);
  });

  it("are matched on the session's own title as well as its text", async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    store.rows = [
      claudeRow(CLAUDE_A, root, { summary: 'Refactor billing module' }),
      claudeRow(CLAUDE_B, root, { summary: 'Something else', customTitle: 'Invoice cleanup' }),
    ];

    const search = makeSearch(root, store);

    expect((await search.search('billing')).hits.map((hit) => hit.id)).toEqual([CLAUDE_A]);
    expect((await search.search('invoice')).hits.map((hit) => hit.id)).toEqual([CLAUDE_B]);
  });

  it('keep the recorded folder, with no remap, and leave out a session that records none', async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, '/gone/folder', { summary: 'shared words' }), claudeRow(CLAUDE_B, root, { summary: 'shared words' })];
    delete store.rows[1]?.cwd;
    const index: ProjectPaths[] = [{ name: 'p', path: root, oldPaths: ['/gone/folder'] }];

    const { hits } = await makeSearch(root, store, () => Promise.resolve(index)).search('shared');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: CLAUDE_A, cwd: '/gone/folder' });
    expect(hits[0]).not.toHaveProperty('movedFrom');
    expect(hits[0]).not.toHaveProperty('folderGone');
  });
});

describe('the Claude Code index', () => {
  const textOf = (word: string): unknown[] => [claudeMessage('user', `${word} topic`)];

  it('reads a transcript again only when the session was modified or its file changed size', async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, root), claudeRow(CLAUDE_B, root), claudeRow(CLAUDE_C, root)];
    for (const id of [CLAUDE_A, CLAUDE_B, CLAUDE_C]) store.transcripts.set(id, textOf('alpha'));
    const search = makeSearch(root, store);
    await search.search('alpha');
    expect(store.callsTo('messages')).toHaveLength(3);

    store.rows = [
      claudeRow(CLAUDE_A, root),
      claudeRow(CLAUDE_B, root, { lastModified: Date.UTC(2026, 8, 2) }),
      claudeRow(CLAUDE_C, root, { fileSize: 2_000 }),
    ];
    store.calls.length = 0;
    await search.search('alpha');

    expect(store.callsTo('messages').sort()).toEqual([`messages:${CLAUDE_B}@${root}`, `messages:${CLAUDE_C}@${root}`].sort());
  });

  it('reads at most ten transcripts at a time', async () => {
    const root = await createRoot();
    let running = 0;
    let most = 0;
    class Counting extends FakeSessions {
      override async messages(sessionId: string, dir: string): Promise<readonly unknown[]> {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return super.messages(sessionId, dir);
      }
    }
    const store = new Counting();
    store.rows = Array.from({ length: 35 }, (_, n) => claudeRow(`${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, root));

    const result = await makeSearch(root, store).search('anything');

    expect(result.searched).toBe(35);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(10);
  });

  it('adds new sessions and drops deleted ones', async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, root)];
    store.transcripts.set(CLAUDE_A, textOf('alpha'));
    store.transcripts.set(CLAUDE_B, textOf('alpha'));
    const search = makeSearch(root, store);
    expect((await search.search('alpha')).hits.map((hit) => hit.id)).toEqual([CLAUDE_A]);

    store.rows = [claudeRow(CLAUDE_B, root)];
    const result = await search.search('alpha');

    expect(result.hits.map((hit) => hit.id)).toEqual([CLAUDE_B]);
    expect(result.searched).toBe(1);
  });

  it('skips a session whose transcript cannot be read and keeps the others', async () => {
    const root = await createRoot();
    class OneBroken extends FakeSessions {
      override messages(sessionId: string, dir: string): Promise<readonly unknown[]> {
        if (sessionId === CLAUDE_A) return Promise.reject(new Error('transcript unreadable'));
        return super.messages(sessionId, dir);
      }
    }
    const store = new OneBroken();
    store.rows = [claudeRow(CLAUDE_A, root, { summary: 'alpha' }), claudeRow(CLAUDE_B, root)];
    store.transcripts.set(CLAUDE_B, textOf('alpha'));

    const result = await makeSearch(root, store).search('alpha');

    expect(result.hits.map((hit) => hit.id)).toEqual([CLAUDE_B]);
  });

  it('still searches pi, and what Claude Code already gave, when its listing fails', async () => {
    const root = await createRoot();
    await writePi(root, 'pi-chat', { entries: [user('alpha from pi')], modified: new Date('2026-08-01T00:00:00.000Z') });
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, root)];
    store.transcripts.set(CLAUDE_A, textOf('alpha'));
    const search = makeSearch(root, store);
    expect((await search.search('alpha')).total).toBe(2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.failure = new Error('claude is not installed');
    const result = await search.search('alpha');

    expect(result.hits.map((hit) => hit.id)).toEqual([CLAUDE_A, 'pi-chat']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('sharing the work', () => {
  it('does nothing at construction and lets concurrent searches share one refresh', async () => {
    const root = await createRoot();
    await writePi(root, 'a', { entries: [user('alpha bravo')] });
    const store = new FakeSessions();
    store.rows = [claudeRow(CLAUDE_A, root)];
    store.transcripts.set(CLAUDE_A, [claudeMessage('user', 'alpha bravo')]);
    let indexReads = 0;
    const search = makeSearch(root, store, () => {
      indexReads += 1;
      return Promise.resolve([]);
    });
    expect(store.calls).toEqual([]);
    expect(indexReads).toBe(0);

    const [first, second] = await Promise.all([search.search('alpha'), search.search('bravo')]);

    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(store.callsTo('list')).toHaveLength(1);
    expect(store.callsTo('messages')).toHaveLength(1);
  });

  it('refreshes again on the next search once the shared one has finished', async () => {
    const root = await createRoot();
    const store = new FakeSessions();
    const search = makeSearch(root, store);

    await Promise.all([search.search('alpha'), search.search('alpha')]);
    await search.search('alpha');

    expect(store.callsTo('list')).toHaveLength(2);
  });
});
