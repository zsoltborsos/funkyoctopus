import { CLAUDE_CODE_PROVIDER, type ModelOption } from '@shared/transport/protocol.ts';
import type { ModelRef } from '@features/settings/preferences.types.ts';

export interface ChatAgent {
  /** Who answers: what the transcript labels the assistant. */
  name: 'Claude' | 'pi';
  /** The model the label shows; null for pi when no model is picked or configured. */
  model: string | null;
}

/**
 * Who answers chat, from what the sidecar's engine serves. The engine is chosen
 * at start and lists only its own models, so a list made wholly of Claude Code's
 * means Claude Code is driving, and any other list means pi, whatever the browser
 * remembers picking under the other engine. The pick is believed on its own only
 * while the list is still empty (not loaded yet). Claude Code with nothing picked
 * runs its own default; pi's default model is the sidecar's, which marks it in
 * the list (`isDefault`), so it only labels pi, and is unknown (null) until the
 * list has loaded or when pi has none configured.
 */
export function chatAgent(models: ModelOption[], chatModel: ModelRef | null): ChatAgent {
  const pickedClaude = chatModel?.provider === CLAUDE_CODE_PROVIDER;
  if (models.length === 0) {
    return pickedClaude
      ? { name: 'Claude', model: chatModel.id }
      : { name: 'pi', model: chatModel?.id ?? null };
  }
  if (models.every((m) => m.provider === CLAUDE_CODE_PROVIDER)) {
    return { name: 'Claude', model: pickedClaude ? chatModel.id : 'default' };
  }
  // A Claude Code pick that outlived the engine it was made under is not pi's model.
  const piDefault = models.find((m) => m.isDefault)?.id ?? null;
  return { name: 'pi', model: chatModel && !pickedClaude ? chatModel.id : piDefault };
}
