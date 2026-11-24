import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { ClaudeRecentSession, ClaudeStatusResult } from '@shared/transport/protocol.ts';

/**
 * Browser face of the read-only Claude Code seam: sign-in, quota and running
 * sessions in one call, plus a project's recent sessions. The sidecar caches
 * both, so callers poll no faster than the cadence in `useClaudeStatus`.
 */
export class ClaudeCodeClient {
  constructor(private readonly transport: TransportClient) {}

  /** `refreshUsage` asks for a fresh quota read; the sidecar may still answer from a younger cache. */
  status(refreshUsage = false): Promise<ClaudeStatusResult> {
    return this.transport.call('claude.status', { refreshUsage });
  }

  /** Recent sessions for a project root; null lists every project. */
  sessions(root: string | null): Promise<ClaudeRecentSession[]> {
    return this.transport.call('claude.sessions', { root });
  }
}

export const CLAUDE_CODE = token<ClaudeCodeClient>('ClaudeCodeClient');
