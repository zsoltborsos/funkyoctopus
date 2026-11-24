import { useCallback, useEffect, useState } from 'react';
import { useService } from '@core/container/useService.ts';
import type { ClaudeStatusResult } from '@shared/transport/protocol.ts';
import { CLAUDE_CODE } from './claude-code.client.ts';

/** The sidecar caches every part of the answer; polling faster would only repeat it. */
export const CLAUDE_POLL_MS = 30_000;

export interface UseClaudeStatus {
  /** Null until the first answer, while disconnected, and when the sidecar cannot answer. */
  status: ClaudeStatusResult | null;
  refreshing: boolean;
  /** Ask for a fresh quota read; the sidecar still serves a read younger than 30 s. */
  refresh: () => Promise<void>;
}

/** Polls `claude.status` while the sidecar connection is open. */
export function useClaudeStatus(connected: boolean): UseClaudeStatus {
  const claude = useService(CLAUDE_CODE);
  const [status, setStatus] = useState<ClaudeStatusResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // A dropped connection clears the last answer in the same render.
  const [wasConnected, setWasConnected] = useState(connected);
  if (connected !== wasConnected) {
    setWasConnected(connected);
    if (!connected) setStatus(null);
  }

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const poll = (): void => {
      claude
        .status()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {
          if (active) setStatus(null);
        });
    };
    poll();
    const timer = setInterval(poll, CLAUDE_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connected, claude]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await claude.status(true));
    } catch {
      // Keep what is on screen; the next poll recovers.
    } finally {
      setRefreshing(false);
    }
  }, [claude]);

  return { status, refreshing, refresh };
}
