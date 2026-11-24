import type { ClaudeLiveSession } from '../../../src/shared/transport/protocol.ts';
import type { ClaudeSessionStore, StoredSession } from '../claude-code/sessions.ts';
import type { LiveRead } from '../claude-code/status.ts';

/**
 * A scripted stand-in for Claude Code's stored sessions and `claude agents
 * --json`. Tests set `rows`, `transcripts` and `running`; every call is
 * recorded, so a test can say what the engine read and with which arguments.
 */
export class FakeSessions implements ClaudeSessionStore {
  rows: StoredSession[] = [];
  /** Stored messages per session id. */
  readonly transcripts = new Map<string, unknown[]>();
  /** What `claude agents --json` reports as running. */
  running: ClaudeLiveSession[] = [];
  /** Set to make the running-sessions read fail the way `readLive` reports it. */
  runningError: string | undefined;
  /** Set to make `list`, `info` or `messages` fail. */
  failure: Error | undefined;
  readonly calls: string[] = [];

  list(options: { dir?: string; limit?: number; includeWorktrees?: boolean }): Promise<StoredSession[]> {
    this.calls.push(`list:${JSON.stringify(options)}`);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.rows.slice(0, options.limit));
  }

  info(sessionId: string): Promise<StoredSession | undefined> {
    this.calls.push(`info:${sessionId}`);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.rows.find((row) => row.sessionId === sessionId));
  }

  messages(sessionId: string, dir: string): Promise<readonly unknown[]> {
    this.calls.push(`messages:${sessionId}@${dir}`);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.transcripts.get(sessionId) ?? []);
  }

  live(options?: { fresh?: boolean }): Promise<LiveRead> {
    // A fresh read is `live`, a cached one `liveCached`: tests count them apart.
    this.calls.push(options?.fresh === true ? 'live' : 'liveCached');
    return Promise.resolve({ live: this.running, ...(this.runningError !== undefined ? { error: this.runningError } : {}) });
  }

  /** The calls of one kind (`list`, `info`, `messages`, `live`, `liveCached`), in order. */
  callsTo(kind: string): string[] {
    return this.calls.filter((call) => call === kind || call.startsWith(`${kind}:`));
  }
}
