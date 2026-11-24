import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { ChatSearchResult } from '@shared/transport/protocol.ts';

/**
 * Browser face of `chat.search` (T2.5): stored chats of both engines in every
 * folder, matched by the sidecar. Not tied to a tab. Read-only.
 */
export class ChatSearchClient {
  constructor(private readonly transport: TransportClient) {}

  /** The newest stored chats whose name or text holds every word of `query`. */
  search(query: string): Promise<ChatSearchResult> {
    return this.transport.call('chat.search', { query });
  }
}

export const CHAT_SEARCH = token<ChatSearchClient>('ChatSearchClient');
