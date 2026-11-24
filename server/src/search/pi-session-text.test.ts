/**
 * Contract: the text search reads from a pi session file is the text pi itself
 * builds for the same file (`SessionInfo.allMessagesText`, also its `name` and
 * first message). pi exports no reader for one file, so `readPiSessionText`
 * re-applies pi's rule; this holds the two equal against the installed pi, so a
 * bump that changes the rule fails here, in `verify`, rather than as a search
 * that quietly finds the wrong chats.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { readPiSessionText } from './pi-session-text.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();

let counter = 0;
const entry = (type: string, fields: Record<string, unknown>): object => {
  counter += 1;
  return { type, id: `e${counter}`, parentId: counter > 1 ? `e${counter - 1}` : null, timestamp: at(counter), ...fields };
};
const message = (message: Record<string, unknown>): object => entry('message', { message });

const header = (id: string): object => ({ type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/project' });

/** Realistic sessions: named, tool-heavy, array-content, odd whitespace, a cleared name, entries that are not messages. */
const SESSIONS: Record<string, object[]> = {
  'named-and-tool-heavy': [
    header('s-named'),
    entry('model_change', { provider: 'anthropic', modelId: 'claude-sonnet' }),
    message({ role: 'user', content: 'Why does the build fail on CI?', timestamp: 1 }),
    message({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me look at the workflow file first.' },
        { type: 'text', text: 'I will check the workflow.' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'cat .github/workflows/ci.yml' } },
      ],
      timestamp: 2,
    }),
    message({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'name: CI\non: push\njobs: {}' }],
      isError: false,
      timestamp: 3,
    }),
    message({ role: 'assistant', content: [{ type: 'text', text: 'The workflow has no jobs.' }], timestamp: 4 }),
    entry('session_info', { name: '  CI breakage  ' }),
  ],
  'array-parts-and-skipped-entries': [
    header('s-parts'),
    message({
      role: 'user',
      content: [
        { type: 'text', text: 'first part' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'second part' },
      ],
      timestamp: 1,
    }),
    // An assistant turn that only calls a tool has no text: pi leaves it out of the join.
    message({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'a.ts' } }],
      timestamp: 2,
    }),
    message({ role: 'bashExecution', command: 'ls', output: 'secret listing', exitCode: 0, timestamp: 3 }),
    entry('custom_message', { customType: 'note', content: 'not a conversation message', display: true }),
    message({ role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4 }),
  ],
  'whitespace-and-cleared-name': [
    header('s-space'),
    entry('session_info', { name: 'Temporary name' }),
    message({ role: 'user', content: '  keep   the\n\nspacing  ', timestamp: 1 }),
    message({ role: 'assistant', content: [{ type: 'text', text: 'line one\nline two' }], timestamp: 2 }),
    entry('session_info', { name: '   ' }),
  ],
  // Lines longer than a read chunk, and characters that are several bytes: a chunk boundary can fall inside either.
  'large-and-multibyte': [
    header('s-large'),
    message({ role: 'user', content: 'Zażółć gęślą jaźń 日本語 🙂 first', timestamp: 1 }),
    message({
      role: 'toolResult',
      toolCallId: 'call-3',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ünïcödé output '.repeat(20_000) }],
      isError: false,
      timestamp: 2,
    }),
    message({ role: 'assistant', content: [{ type: 'text', text: `${'日本語🙂 '.repeat(30_000)}end` }], timestamp: 3 }),
    message({ role: 'user', content: 'after the long lines', timestamp: 4 }),
  ],
};

async function writeSessions(): Promise<{ dir: string; paths: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-pi-text-'));
  roots.push(root);
  const dir = join(root, 'cwd-a');
  await mkdir(dir);
  const paths: Record<string, string> = {};
  for (const [name, entries] of Object.entries(SESSIONS)) {
    paths[name] = join(dir, `${name}.jsonl`);
    await writeFile(paths[name], `${entries.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  return { dir, paths };
}

describe("a pi session file's text", () => {
  it("equals pi's own allMessagesText, name and first message for the same file", async () => {
    const { dir, paths } = await writeSessions();

    const listed = await SessionManager.listAll(dir);

    expect(listed).toHaveLength(Object.keys(paths).length);
    for (const info of listed) {
      const read = await readPiSessionText(info.path);
      expect(read, info.path).not.toBeNull();
      expect(read?.text, info.path).toBe(info.allMessagesText);
      expect(read?.name, info.path).toBe(info.name);
      expect(read?.id, info.path).toBe(info.id);
      expect(read?.cwd, info.path).toBe(info.cwd);
      // pi shows "(no messages)" for a chat with no text; the reader has nothing, and says so.
      expect(read?.firstMessage || '(no messages)', info.path).toBe(info.firstMessage);
    }
  });

  it('is the text pi would build, as plain literals (so the rule itself is visible)', async () => {
    const { paths } = await writeSessions();

    expect(await readPiSessionText(paths['named-and-tool-heavy'] as string)).toEqual({
      id: 's-named',
      cwd: '/work/project',
      created: '2026-10-01T10:00:00.000Z',
      name: 'CI breakage',
      firstMessage: 'Why does the build fail on CI?',
      text: 'Why does the build fail on CI? I will check the workflow. The workflow has no jobs.',
    });
    expect((await readPiSessionText(paths['array-parts-and-skipped-entries'] as string))?.text).toBe(
      'first part second part done',
    );
    const spaced = await readPiSessionText(paths['whitespace-and-cleared-name'] as string);
    expect(spaced?.name).toBeUndefined();
    expect(spaced?.text).toBe('  keep   the\n\nspacing   line one\nline two');
  });

  it('is null for a file that does not open with a session header', async () => {
    const { dir } = await writeSessions();
    await writeFile(join(dir, 'headless.jsonl'), `${JSON.stringify(message({ role: 'user', content: 'hi' }))}\n`);

    expect(await readPiSessionText(join(dir, 'headless.jsonl'))).toBeNull();
    expect(await readPiSessionText(join(dir, 'missing.jsonl'))).toBeNull();
  });
});
