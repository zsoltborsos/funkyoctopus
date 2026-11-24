import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import { CLAUDE_CODE_PROVIDER, MAIN_CHAT, type ModelOption } from '@shared/transport/protocol.ts';

/**
 * Browser face of the models seam. Fetches the models the sidecar can actually
 * reach (pi's authed runtime), so the composer's picker only offers callable
 * options. Read-only — model selection is applied per message via chat.send.
 */
export class ModelsClient {
  constructor(
    private readonly transport: TransportClient,
    /** The chat slot the picker serves: `main` for the single-tab browser. */
    readonly chatId: string = MAIN_CHAT,
  ) {}

  /**
   * The models this chat's engine can run. The sidecar lists every engine's,
   * each tagged by provider; a chat runs on one engine, so the picker offers
   * only that engine's (Claude Code's are `claude-code`, everything else is pi's).
   */
  async list(): Promise<ModelOption[]> {
    const [models, slots] = await Promise.all([this.transport.call('models.list'), this.transport.call('chat.slots')]);
    const kind = slots.find((slot) => slot.chatId === this.chatId)?.kind;
    if (kind === undefined) return models;
    return models.filter((model) => (model.provider === CLAUDE_CODE_PROVIDER) === (kind === 'claude-code'));
  }
}

export const MODELS = token<ModelsClient>('ModelsClient');

/** Stable key for a model across favourites/selection. `::` can't occur in a
 *  provider name and doesn't appear in pi model ids. */
export const modelKey = (provider: string, id: string): string => `${provider}::${id}`;
