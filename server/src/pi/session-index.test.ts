import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listRecentSessions } from './session-index.ts';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-session-index-'));
  roots.push(root);
  await mkdir(join(root, 'project'));
  return root;
}

function sessionJsonl(id: string, message = `message ${id}`): string {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-08-08T12:00:00.000Z',
      cwd: `/projects/${id}`,
    }),
    JSON.stringify({
      type: 'message',
      id: `message-${id}`,
      timestamp: '2026-08-08T12:00:01.000Z',
      message: { role: 'user', content: message },
    }),
    '',
  ].join('\n');
}

async function writeSession(
  root: string,
  id: string,
  modified = new Date('2026-08-08T12:00:00.000Z'),
): Promise<string> {
  const path = join(root, 'project', `${id}.jsonl`);
  await writeFile(path, sessionJsonl(id));
  await utimes(path, modified, modified);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('global session index', () => {
  it('skips corrupt and truncated JSONL heads without hiding valid sessions', async () => {
    const root = await createRoot();
    await writeFile(join(root, 'project', 'corrupt.jsonl'), 'not json\n{"type":"message"}\n');
    await writeFile(join(root, 'project', 'truncated.jsonl'), '{"type":"session","id":"cut');
    const validPath = await writeSession(root, 'valid');

    await expect(listRecentSessions(40, root)).resolves.toEqual([
      expect.objectContaining({ id: 'valid', path: validPath, title: 'message valid' }),
    ]);
  });

  it('does not read beyond the 128KB head budget for an oversized first line', async () => {
    const root = await createRoot();
    const oversizedHeader = JSON.stringify({
      type: 'session',
      id: 'oversized',
      timestamp: '2026-08-08T12:00:00.000Z',
      cwd: '/projects/oversized',
      padding: 'x'.repeat(128 * 1024),
    });
    await writeFile(
      join(root, 'project', 'oversized.jsonl'),
      `${oversizedHeader}\n${sessionJsonl('later-valid')}`,
    );

    await expect(listRecentSessions(40, root)).resolves.toEqual([]);
  });

  it('returns at most 40 candidates in newest-first order', async () => {
    const root = await createRoot();
    const base = Date.parse('2026-08-08T12:00:00.000Z');
    await Promise.all(
      Array.from({ length: 45 }, async (_, index) =>
        writeSession(root, `session-${index}`, new Date(base + index * 1_000)),
      ),
    );

    const rows = await listRecentSessions(undefined, root);

    expect(rows).toHaveLength(40);
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `session-${44 - index}`),
    );
  });

  it('skips missing and unreadable candidates', async () => {
    const root = await createRoot();
    await symlink(join(root, 'does-not-exist'), join(root, 'project', 'missing.jsonl'));
    await mkdir(join(root, 'project', 'unreadable.jsonl'));
    await writeSession(root, 'readable');

    const rows = await listRecentSessions(40, root);

    expect(rows.map((row) => row.id)).toEqual(['readable']);
  });

  it('omits messageCount from global history rows', async () => {
    const root = await createRoot();
    await writeSession(root, 'without-count');

    const [row] = await listRecentSessions(40, root);

    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('messageCount');
  });
});
