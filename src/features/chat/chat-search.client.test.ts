import { describe, expect, it, vi } from 'vitest';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { ChatSearchResult } from '@shared/transport/protocol.ts';
import { ChatSearchClient } from './chat-search.client.ts';

describe('ChatSearchClient', () => {
  it('asks the sidecar for the query, with the default limit, and returns what it found', async () => {
    const found: ChatSearchResult = { hits: [], total: 0, searched: 1301 };
    const call = vi.fn(() => Promise.resolve(found));
    const client = new ChatSearchClient({ call } as unknown as TransportClient);

    expect(await client.search('deepseek')).toBe(found);
    expect(call).toHaveBeenCalledExactlyOnceWith('chat.search', { query: 'deepseek' });
  });
});
