import type { ChatSessionInfo } from '../../../src/shared/transport/protocol.ts';
import { toTitle } from '../pi/session-transcript.ts';
import type { LiveRead } from './status.ts';

/**
 * One stored Claude Code session, as the Agent SDK's `listSessions` and
 * `getSessionInfo` describe it; the SDK's own `SDKSessionInfo` satisfies this.
 */
export interface StoredSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  /** Bytes of the session file; the SDK leaves it out for a store that is not local files. */
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
}

/**
 * Everything the chat engine reads about sessions it did not just start:
 * Claude Code's stored sessions and transcripts, and which sessions are running
 * right now. One seam, so tests never touch `~/.claude` or spawn `claude`.
 */
export interface ClaudeSessionStore {
  /**
   * Stored sessions, newest first, for one project folder or (no `dir`) every project; no
   * `limit` lists them all. `includeWorktrees: false` keeps a folder's list to the folder's own sessions.
   */
  list(options: { dir?: string; limit?: number; includeWorktrees?: boolean }): Promise<StoredSession[]>;
  /** One session's description, wherever it is stored; undefined when there is none. */
  info(sessionId: string): Promise<StoredSession | undefined>;
  /** The stored messages of a session that belongs to the folder `dir`; empty when it has none yet. */
  messages(sessionId: string, dir: string): Promise<readonly unknown[]>;
  /**
   * Running sessions. A decision about opening or starting a session reads `fresh`, since a
   * cached picture may be 10 s old; a send into a running process takes the cached one.
   */
  live(options?: { fresh?: boolean }): Promise<LiveRead>;
}

/** The production store: the Agent SDK's readers, and `claude agents --json` (cached 10 s, or read fresh). */
export function claudeSessionStore(deps: {
  listSessions: (options: { dir?: string; limit?: number; includeWorktrees?: boolean }) => Promise<StoredSession[]>;
  getSessionInfo: (sessionId: string) => Promise<StoredSession | undefined>;
  getSessionMessages: (sessionId: string, options: { dir: string }) => Promise<readonly unknown[]>;
  live: (fresh: boolean) => Promise<LiveRead>;
}): ClaudeSessionStore {
  return {
    list: (options) => deps.listSessions(options),
    info: (sessionId) => deps.getSessionInfo(sessionId),
    messages: (sessionId, dir) => deps.getSessionMessages(sessionId, { dir }),
    live: (options) => deps.live(options?.fresh === true),
  };
}

const PREFIX = 'claude-code:';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A session's identity on the wire. Not a file: Claude Code owns its transcript, and the id names it. */
export const sessionPath = (sessionId: string): string => `${PREFIX}${sessionId}`;

/** The session id a wire path names; null for anything that is not `claude-code:<uuid>`. */
export function sessionIdOf(path: string): string | null {
  if (!path.startsWith(PREFIX)) return null;
  const id = path.slice(PREFIX.length);
  return SESSION_ID.test(id) ? id : null;
}

/**
 * A stored session as a history row. A session with no recorded folder is
 * `fallbackCwd`'s (the folder it was listed under), or none at all, in which
 * case it cannot be reopened and is left out.
 */
export function toSessionInfo(row: StoredSession, fallbackCwd?: string): ChatSessionInfo | null {
  const cwd = row.cwd ?? fallbackCwd;
  if (cwd === undefined) return null;
  return {
    path: sessionPath(row.sessionId),
    engine: 'claude-code',
    id: row.sessionId,
    cwd,
    title: toTitle([row.customTitle, row.summary, row.firstPrompt].find((label) => label !== undefined && label.trim() !== '') ?? ''),
    created: new Date(row.createdAt ?? row.lastModified).toISOString(),
    modified: new Date(row.lastModified).toISOString(),
  };
}
