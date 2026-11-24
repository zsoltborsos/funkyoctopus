import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { humaneError, type HumaneError } from '@core/transport/humane-error.ts';
import type {
  LeeboardAsked,
  LeeboardBrief,
  LeeboardEntry,
  LeeboardEntryWithBody,
  LeeboardReview,
  LeeboardRouted,
  WireError,
} from '@shared/transport/protocol.ts';
import { CHAT_SESSION } from '../chat-session.service.ts';
import { CHAT_SESSIONS } from '../chat-sessions.service.ts';
import { useTabFolder } from '../useTabFolder.ts';
import { LEEBOARD } from './leeboard.client.ts';

export interface UseLeeboard {
  brief: LeeboardBrief | null;
  briefError: HumaneError | null;
  review: LeeboardReview | null;
  reviewError: HumaneError | null;
  /** Active requests and handoffs to a project or a session, routed to their tabs (L5). */
  open: LeeboardRouted[] | null;
  openError: HumaneError | null;
  holds: LeeboardEntry[] | null;
  holdsError: HumaneError | null;
  /** The requests this tab's session wrote (L5). */
  asked: LeeboardAsked[] | null;
  askedError: HumaneError | null;
  loading: boolean;
  /** Ask `lb` again: the panel's manual refresh. */
  refresh: () => void;
}

/** One read's answer as the panel holds it: the value, or why there is none. */
function settle<R extends { error?: WireError }, V>(
  read: Promise<R>,
  value: (result: R) => V | null,
  failed: string,
): Promise<{ value: V | null; error: HumaneError | null }> {
  return read.then(
    (result) => ({ value: value(result), error: result.error ? humaneError(result.error, failed) : null }),
    (e: unknown) => ({ value: null, error: humaneError(e, 'could not reach the sidecar') }),
  );
}

/**
 * The brief, the owner digest, the routed open requests and this tab's own
 * requests, plus active holds across every scope. Asked on mount (a tab switch remounts the panel), when the tab's
 * folder changes, when the sidecar confirms the tab's session moved folder (a
 * Claude Code tab re-roots only after it has looked up the folder's latest
 * session, so the folder change alone can ask before the slot has moved), when
 * the tab's session changes, and when a turn ends in any tab: an agent writes
 * its `lb request` or `lb reply` during a turn. Never polled.
 */
export function useLeeboard(): UseLeeboard {
  const leeboard = useService(LEEBOARD);
  const chat = useService(CHAT_SESSION);
  const tabs = useService(CHAT_SESSIONS);
  const folder = useTabFolder().folder?.path ?? null;
  const sessionCwd = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().activeSession?.cwd ?? null);
  const sessionId = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().activeSession?.id ?? null);
  const [round, setRound] = useState(0);
  const [state, setState] = useState<Omit<UseLeeboard, 'refresh' | 'loading'> & { answered: string | null }>({
    brief: null,
    briefError: null,
    review: null,
    reviewError: null,
    open: null,
    openError: null,
    holds: null,
    holdsError: null,
    asked: null,
    askedError: null,
    answered: null,
  });
  // Which read the panel wants; it is loading until that read has answered.
  // What was shown stays until then: a refresh does not blank the panel.
  const request = JSON.stringify([folder, sessionCwd, sessionId, round]);

  useEffect(
    () =>
      tabs.subscribeActivity((activity) => {
        if (activity.kind === 'turn-ended') setRound((n) => n + 1);
      }),
    [tabs],
  );

  useEffect(() => {
    let live = true;
    void Promise.all([
      settle(leeboard.brief(), (r) => r.brief, 'lb brief failed'),
      settle(leeboard.review(), (r) => r.review, 'lb review failed'),
      settle(leeboard.open(), (r) => r.open, 'lb list failed'),
      settle(leeboard.asked(), (r) => r.asked, 'lb list failed'),
      settle(leeboard.holds(), (r) => r.holds, 'lb list failed'),
    ]).then(([brief, review, open, asked, holds]) => {
      if (!live) return;
      setState({
        brief: brief.value,
        briefError: brief.error,
        review: review.value,
        reviewError: review.error,
        open: open.value,
        openError: open.error,
        asked: asked.value,
        askedError: asked.error,
        holds: holds.value,
        holdsError: holds.error,
        answered: request,
      });
    });
    return () => {
      live = false;
    };
  }, [leeboard, request]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);
  const { answered, ...shown } = state;
  return { ...shown, loading: answered !== request, refresh };
}

export interface UseLeeboardEntry {
  entry: LeeboardEntryWithBody | null;
  error: HumaneError | null;
  loading: boolean;
}

/** One entry's body, read when it is opened. */
export function useLeeboardEntry(id: string): UseLeeboardEntry {
  const leeboard = useService(LEEBOARD);
  // An answer counts only for the entry it was asked about; another id shows loading.
  const [answer, setAnswer] = useState<{ id: string; entry: LeeboardEntryWithBody | null; error: HumaneError | null } | null>(null);
  useEffect(() => {
    let live = true;
    leeboard.show(id).then(
      (result) => {
        if (live) setAnswer({ id, entry: result.entry, error: result.error ? humaneError(result.error, 'lb show failed') : null });
      },
      (e: unknown) => {
        if (live) setAnswer({ id, entry: null, error: humaneError(e, 'could not reach the sidecar') });
      },
    );
    return () => {
      live = false;
    };
  }, [leeboard, id]);
  if (answer?.id !== id) return { entry: null, error: null, loading: true };
  return { entry: answer.entry, error: answer.error, loading: false };
}
