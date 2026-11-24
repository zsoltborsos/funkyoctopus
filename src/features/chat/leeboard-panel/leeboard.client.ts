import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import {
  MAIN_CHAT,
  type LeeboardAskedResult,
  type LeeboardBriefResult,
  type LeeboardOpenResult,
  type LeeboardHoldsResult,
  type LeeboardReviewResult,
  type LeeboardShowResult,
} from '@shared/transport/protocol.ts';

/**
 * Browser face of the Leeboard panel's reads (T3 L3, L5). Read-only: FO owns no
 * memory, and nothing here writes to Leeboard or marks the digest seen.
 */
export class LeeboardClient {
  /** The chat slot whose folder the brief is for. */
  constructor(
    private readonly transport: TransportClient,
    readonly chatId: string = MAIN_CHAT,
  ) {}

  /** The brief for the slot's folder; the sidecar picks the folder, never the browser. */
  brief(): Promise<LeeboardBriefResult> {
    return this.transport.call('leeboard.brief', { chatId: this.chatId });
  }

  /** One entry with its body. */
  show(id: string): Promise<LeeboardShowResult> {
    return this.transport.call('leeboard.show', { id });
  }

  /** The owner digest, peeked: reading it marks nothing seen. */
  review(): Promise<LeeboardReviewResult> {
    return this.transport.call('leeboard.review', {});
  }

  /** Active requests and handoffs to a project or a session, each with the tab it belongs in. */
  open(): Promise<LeeboardOpenResult> {
    return this.transport.call('leeboard.open', {});
  }

  /** Active holds across every scope, without author filtering. */
  holds(): Promise<LeeboardHoldsResult> {
    return this.transport.call('leeboard.holds', {});
  }

  /** The requests the slot's session wrote; the sidecar picks the session, never the browser. */
  asked(): Promise<LeeboardAskedResult> {
    return this.transport.call('leeboard.asked', { chatId: this.chatId });
  }
}

export const LEEBOARD = token<LeeboardClient>('LeeboardClient');
