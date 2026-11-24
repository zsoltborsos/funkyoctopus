import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSearchHit, ChatSearchResult, ChatSessionInfo } from '../../../src/shared/transport/protocol.ts';
import { toSessionInfo, type ClaudeSessionStore, type StoredSession } from '../claude-code/sessions.ts';
import { remapGlobalRow } from '../pi/pi-chat.ts';
import { toTitle } from '../pi/session-transcript.ts';
import type { ProjectPaths } from '../projects/registry.ts';
import { messageOf } from '../util/errors.ts';
import { recordOf } from '../util/records.ts';
import { readPiSessionText } from './pi-session-text.ts';

export interface ChatSearchDeps {
  /** pi's session store: `<sessionRoot>/<cwd directory>/<session>.jsonl`. */
  sessionRoot: string;
  /** Claude Code's stored sessions and transcripts. */
  claude: Pick<ClaudeSessionStore, 'list' | 'messages'>;
  /** The Leeboard project-path index global history remaps recorded cwds with. */
  projectPaths: () => Promise<ProjectPaths[]>;
  /** Milliseconds since the epoch; tests pass their own clock. */
  now?: () => number;
}

/** Hits returned when the caller names no limit, and the most it may ask for. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Characters of the chat's text a snippet shows. */
const SNIPPET_LENGTH = 140;

/**
 * Characters kept before the match. A row shows only the snippet's start, so
 * the match sits near it rather than in the middle, where it would be cut off.
 */
const SNIPPET_LEAD = 30;

/** Chats read at once while the index fills. */
const READ_CONCURRENCY = 10;

/**
 * A chat that changed is read again at most this often. A chat in use changes
 * every turn, and reading a long one again (a Claude Code transcript can be
 * 185 MB) on every search would cost seconds; its text may trail by this much.
 */
const REREAD_MS = 60_000;

/** One indexed chat: its history row, its text (for the snippet), and what a query is matched against. */
interface Entry {
  /** What the source looked like when this was read; a different stamp means read it again. */
  stamp: string;
  /** When it was read, so a chat in use is not read again on every search. */
  readAt: number;
  row: ChatSessionInfo;
  text: string;
  /** What a query is matched against, lower-cased: the chat's name or title, and its text. */
  lower: string;
}

/** What a stored Claude Code session looked like when read; a different stamp means read it again. */
function claudeStamp(row: StoredSession): string {
  return `${row.lastModified}:${row.fileSize ?? ''}`;
}

/** `fn` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A pi session file as the walk finds it: `stamp` changes whenever its mtime or size does. */
interface PiFile {
  path: string;
  modified: Date;
  stamp: string;
}

/** Every `.jsonl` under every per-cwd directory of the session root. */
async function piFiles(sessionRoot: string): Promise<PiFile[]> {
  const dirs = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
  const found: PiFile[] = [];
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
              if (stats) found.push({ path, modified: stats.mtime, stamp: `${stats.mtimeMs}:${stats.size}` });
            }),
        );
      }),
  );
  return found;
}

/**
 * The text of a stored Claude Code transcript: user and assistant messages, a
 * string `content` or its `text` blocks (the rule pi's search text follows).
 * Tool use, tool results and thinking are blocks of other types, so they are
 * never text.
 */
function claudeText(messages: readonly unknown[]): string {
  const texts: string[] = [];
  for (const stored of messages) {
    const entry = recordOf(stored);
    if (entry?.type !== 'user' && entry?.type !== 'assistant') continue;
    const content = recordOf(entry.message)?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((block) => recordOf(block))
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block?.text as string)
              .join(' ')
          : '';
    if (text) texts.push(text);
  }
  return texts.join(' ');
}

/**
 * About {@link SNIPPET_LENGTH} characters of `text` from just before the first occurrence
 * of `word` (the start of the text when it does not occur there), whitespace
 * collapsed, with an ellipsis at each end that was cut.
 */
function snippetOf(text: string, word: string): string {
  const pattern = word ? new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu') : null;
  const at = pattern?.exec(text)?.index ?? 0;
  // Collapse only a window of the raw text, never a whole transcript.
  const from = Math.max(0, at - SNIPPET_LENGTH);
  const to = Math.min(text.length, at + word.length + SNIPPET_LENGTH);
  const excerpt = text.slice(from, to).replace(/\s+/gu, ' ');
  const matchAt = pattern?.exec(excerpt)?.index ?? 0;
  const start = Math.max(0, Math.min(matchAt - SNIPPET_LEAD, excerpt.length - SNIPPET_LENGTH));
  const end = Math.min(excerpt.length, start + SNIPPET_LENGTH);
  const before = from > 0 || start > 0 ? '…' : '';
  const after = to < text.length || end < excerpt.length ? '…' : '';
  return `${before}${excerpt.slice(start, end).trim()}${after}`;
}

/**
 * Search over every stored chat of both engines: a chat matches when each word
 * of the query occurs in its name and its user and assistant text.
 */
export class ChatSearch {
  /** pi's chats by session file path. */
  private readonly pi = new Map<string, Entry>();
  /** Claude Code's chats by session id. */
  private readonly claude = new Map<string, Entry>();
  /** A refresh in flight, shared by every search that starts meanwhile. */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: ChatSearchDeps) {}

  /** New, or changed and not read in the last {@link REREAD_MS}. */
  private due(entry: Entry | undefined, stamp: string, now: number): boolean {
    return entry === undefined || (entry.stamp !== stamp && now - entry.readAt >= REREAD_MS);
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<ChatSearchResult> {
    await this.refresh();
    const entries = [...this.pi.values(), ...this.claude.values()];
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const matches = entries
      .filter((entry) => words.every((word) => entry.lower.includes(word)))
      .sort((a, b) => b.row.modified.localeCompare(a.row.modified));
    const longest = words.reduce((best, word) => (word.length > best.length ? word : best), '');
    const page = matches.slice(0, Math.min(limit, MAX_LIMIT));
    // The folders only the returned rows need are checked, the way global history checks its rows.
    const index = page.some((entry) => entry.row.engine === 'pi') ? await this.deps.projectPaths() : [];
    const hits: ChatSearchHit[] = await Promise.all(
      page.map(async (entry) => ({
        ...(entry.row.engine === 'pi' ? await remapGlobalRow(entry.row, index) : entry.row),
        snippet: snippetOf(entry.text, longest),
      })),
    );
    return { hits, total: matches.length, searched: entries.length };
  }

  /** Brings the index up to date: reads chats that are new or whose stamp changed, forgets those gone. */
  private refresh(): Promise<void> {
    this.refreshing ??= Promise.all([this.refreshPi(), this.refreshClaude()])
      .then(() => undefined)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async refreshPi(): Promise<void> {
    const files = await piFiles(this.deps.sessionRoot);
    const present = new Set(files.map((file) => file.path));
    for (const path of this.pi.keys()) if (!present.has(path)) this.pi.delete(path);
    const now = (this.deps.now ?? Date.now)();
    const stale = files.filter((file) => this.due(this.pi.get(file.path), file.stamp, now));
    await forEachLimited(stale, READ_CONCURRENCY, async (file) => {
      const session = await readPiSessionText(file.path);
      if (!session) {
        this.pi.delete(file.path);
        return;
      }
      this.pi.set(file.path, {
        stamp: file.stamp,
        readAt: now,
        row: {
          path: file.path,
          engine: 'pi',
          id: session.id,
          cwd: session.cwd,
          title: toTitle(session.name ?? session.firstMessage),
          created: session.created ?? file.modified.toISOString(),
          modified: file.modified.toISOString(),
        },
        text: session.text,
        lower: `${session.name ?? ''} ${session.text}`.toLowerCase(),
      });
    });
  }

  private async refreshClaude(): Promise<void> {
    let rows: StoredSession[];
    try {
      rows = await this.deps.claude.list({});
    } catch (error) {
      // Claude Code may be missing or its store unreadable: pi's chats and what was already read still search.
      console.warn(`[search] Claude Code chats could not be listed: ${messageOf(error)}`);
      return;
    }
    const present = new Set(rows.map((row) => row.sessionId));
    for (const id of this.claude.keys()) if (!present.has(id)) this.claude.delete(id);
    const now = (this.deps.now ?? Date.now)();
    const stale = rows.filter((row) => this.due(this.claude.get(row.sessionId), claudeStamp(row), now));
    await forEachLimited(stale, READ_CONCURRENCY, async (row) => {
      const info = toSessionInfo(row);
      const messages = info ? await this.deps.claude.messages(row.sessionId, info.cwd).catch(() => null) : null;
      if (!info || !messages) {
        this.claude.delete(row.sessionId);
        return;
      }
      const text = claudeText(messages);
      this.claude.set(row.sessionId, {
        stamp: claudeStamp(row),
        readAt: now,
        row: info,
        text,
        lower: [row.customTitle, row.summary, text].join(' ').toLowerCase(),
      });
    });
  }
}
