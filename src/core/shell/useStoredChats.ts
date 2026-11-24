import { useEffect, useState } from 'react';
import { useService } from '@core/container/useService.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { CHAT_SEARCH } from '@features/chat/chat-search.client.ts';
import type { ChatSearchResult } from '@shared/transport/protocol.ts';
import { storedQuery } from './quick-switcher.ts';

/** How long typing must pause before the sidecar is asked. */
const PAUSE_MS = 250;

/**
 * What the switcher shows of the stored-chat search. `off` is no section at
 * all: the query is too short, or the pause is still running with nothing
 * earlier to show. While a refined query is out, the last answer stays.
 */
export type StoredChats =
  | { phase: 'off' }
  | { phase: 'searching'; result: ChatSearchResult | null }
  | { phase: 'done'; result: ChatSearchResult }
  | { phase: 'failed'; message: string };

/** The latest call: its query, how it stands, and the newest answer held, for any query. */
interface Latest {
  query: string;
  done: boolean;
  result: ChatSearchResult | null;
  /** Why the call failed; it leaves no rows. */
  error: string | null;
}

/**
 * The stored chats matching what the owner has typed in the switcher: asked
 * for once typing pauses, and an answer to an older query is dropped.
 */
export function useStoredChats(query: string): StoredChats {
  const search = useService(CHAT_SEARCH);
  const wanted = storedQuery(query);
  const [latest, setLatest] = useState<Latest | null>(null);

  // A short query leaves nothing behind, so a later one starts clean.
  if (wanted === null && latest !== null) setLatest(null);

  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    const timer = setTimeout(() => {
      setLatest((was) => ({ query: wanted, done: false, result: was?.result ?? null, error: null }));
      search.search(wanted).then(
        (result) => {
          if (live) setLatest({ query: wanted, done: true, result, error: null });
        },
        (e: unknown) => {
          if (live) {
            const error = humaneError(e, 'the search failed').message;
            setLatest({ query: wanted, done: true, result: null, error });
          }
        },
      );
    }, PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [search, wanted]);

  if (wanted === null || latest === null) return { phase: 'off' };
  if (latest.query === wanted) {
    if (latest.error !== null) return { phase: 'failed', message: latest.error };
    return latest.done && latest.result
      ? { phase: 'done', result: latest.result }
      : { phase: 'searching', result: latest.result };
  }
  return latest.result ? { phase: 'searching', result: latest.result } : { phase: 'off' };
}
