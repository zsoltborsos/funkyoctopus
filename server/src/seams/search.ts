import type { MethodRegistry } from '../transport/registry.ts';
import type { ChatSearch } from '../search/chat-search.ts';
import type { ChatSearchParams } from '../../../src/shared/transport/protocol.ts';

function parseSearch(params: unknown): ChatSearchParams {
  if (typeof params === 'object' && params !== null) {
    const { query, limit } = params as Record<string, unknown>;
    if (typeof query === 'string' && query.trim()) {
      const parsed: ChatSearchParams = { query: query.trim() };
      if (limit !== undefined) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
          throw new Error('chat.search: limit must be a positive integer');
        }
        parsed.limit = limit;
      }
      return parsed;
    }
  }
  throw new Error('chat.search requires { query: string } (not empty)');
}

/**
 * Registers `chat.search`: stored chats of both engines in every folder, found
 * by the words of a query. Not slot-scoped, so it names no chat; the index it
 * reads is built on the first search (see `ChatSearch`).
 */
export function registerSearchSeam(registry: MethodRegistry, search: Pick<ChatSearch, 'search'>): void {
  registry.call('chat.search', (params) => {
    const { query, limit } = parseSearch(params);
    return search.search(query, limit);
  });
}
