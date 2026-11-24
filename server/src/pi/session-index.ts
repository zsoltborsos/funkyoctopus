/**
 * A cheap, bounded listing of recent pi sessions across every root.
 *
 * `SessionManager.listAll()` is the obvious call and the wrong one here: it
 * reads *every line of every session file* to build `allMessagesText`. Measured
 * against a real store (415 sessions, 318 MB) that is ~1.7s of I/O and 6.2 MB of
 * retained text — per refresh, for a dropdown that shows a title and a
 * relative time. That was the sidecar burning CPU whenever global history was
 * open.
 *
 * So: `stat` every candidate (cheap), sort by mtime, and fully parse only the
 * newest `limit`. Of those, read just the head of each file — the header line
 * plus far enough to find the first user message, which is all a history row
 * renders. `modified` comes from the file's mtime, which is the same fallback
 * pi itself uses.
 *
 * The cost of stopping early is `messageCount`, which cannot be known without
 * reading the whole file. It is therefore optional on `ChatSessionInfo`: the
 * per-project path (`SessionManager.list`, ~9ms for one directory) still fills
 * it in, and the global path leaves it out rather than guessing.
 */

import { readdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatSessionInfo } from '../../../src/shared/transport/protocol.ts';
import { recordOf } from '../util/records.ts';
import { toTitle } from './session-transcript.ts';

/** pi's default store. Matches `SessionManager`'s own default layout. */
const SESSION_ROOT = join(homedir(), '.pi', 'agent', 'sessions');

/** Newest sessions worth offering in a dropdown. Beyond this, use search. */
const DEFAULT_LIMIT = 40;

/**
 * Head budget per file. The header is line 1 and the first user message follows
 * within a few entries, so this is generous; it exists to bound a pathological
 * file, not to be exactly right.
 */
const HEAD_BYTES = 128 * 1024;

interface Candidate {
  path: string;
  modified: Date;
}

/** Every `.jsonl` under every per-cwd session directory, with its mtime. */
async function candidates(sessionRoot: string): Promise<Candidate[]> {
  const dirs = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
  const found: Candidate[] = [];
  await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = join(sessionRoot, entry.name);
        const files = await readdir(dir).catch(() => []);
        await Promise.all(
          files
            .filter((file) => file.endsWith('.jsonl'))
            .map(async (file) => {
              const path = join(dir, file);
              const stats = await stat(path).catch(() => null);
              if (stats) found.push({ path, modified: stats.mtime });
            }),
        );
      }),
  );
  return found;
}

/** Parse the head of one session file into a history row. */
async function readHead(candidate: Candidate): Promise<ChatSessionInfo | null> {
  const handle = await open(candidate.path, 'r').catch(() => null);
  if (!handle) return null;
  let text: string;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }

  // A truncated final line is expected — we stopped mid-file on purpose.
  const lines = text.split('\n');
  let header: Record<string, unknown> | null = null;
  let firstMessage = '';

  for (const line of lines) {
    if (!line) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = recordOf(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    if (!header) {
      if (entry.type !== 'session') return null;
      header = entry;
      continue;
    }
    if (firstMessage || entry.type !== 'message') continue;
    const message = recordOf(entry.message);
    if (message?.role !== 'user') continue;
    firstMessage = textOf(message.content);
  }

  if (!header || typeof header.id !== 'string') return null;
  const created =
    typeof header.timestamp === 'string' ? header.timestamp : candidate.modified.toISOString();
  return {
    path: candidate.path,
    engine: 'pi',
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    title: toTitle(firstMessage),
    created,
    modified: candidate.modified.toISOString(),
  };
}

/** pi message content is a bare string or an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => recordOf(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join('');
}

/**
 * The session id a pi session file's header line names, read from its head
 * only; null when the file cannot be read or does not start with a `session`
 * header. For a session file whose name does not carry its id (renamed,
 * exported, copied).
 */
export async function sessionIdFromHeader(path: string): Promise<string | null> {
  return (await readHead({ path, modified: new Date(0) }))?.id ?? null;
}

/** The most recently touched sessions across every root, newest first. */
export async function listRecentSessions(
  limit = DEFAULT_LIMIT,
  sessionRoot = SESSION_ROOT,
): Promise<ChatSessionInfo[]> {
  const all = await candidates(sessionRoot);
  all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const rows = await Promise.all(all.slice(0, limit).map(readHead));
  return rows.filter((row): row is ChatSessionInfo => row !== null);
}
