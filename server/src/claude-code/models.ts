import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CODE_PROVIDER, type ModelOption } from '../../../src/shared/transport/protocol.ts';

/** The `provider` the picker groups Claude Code's models under. */
export const CLAUDE_PROVIDER = CLAUDE_CODE_PROVIDER;

/** One SDK model as a picker option. Claude models take images; an effort ladder is the model's own. */
export function toModelOption(
  model: Pick<ModelInfo, 'value' | 'displayName' | 'supportedEffortLevels' | 'resolvedModel'>,
): ModelOption {
  return {
    provider: CLAUDE_PROVIDER,
    id: model.value,
    name: model.displayName,
    ...(model.resolvedModel !== undefined ? { resolvedId: model.resolvedModel } : {}),
    thinkingLevels: model.supportedEffortLevels ? [...model.supportedEffortLevels] : [],
    input: ['text', 'image'],
  };
}

const alias = (id: string, name: string): ModelOption => ({
  provider: CLAUDE_PROVIDER,
  id,
  name,
  thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  input: ['text', 'image'],
});

/**
 * What the picker offers until a live process has listed the real models (the
 * SDK can only list through one): the aliases Claude Code resolves to its
 * current Sonnet, Opus and Haiku. The ladder is the one all three reported when
 * measured (2026-10-17).
 */
export const FALLBACK_MODELS: ModelOption[] = [
  alias('sonnet', 'Sonnet'),
  alias('opus', 'Opus'),
  alias('haiku', 'Haiku'),
];

/**
 * Where the models a live process listed are kept: shared by every Claude slot, so one
 * slot's listing serves them all (and `models.list`). A list read from disk is the last
 * run's, so `stale`: the first live process still lists the real ones and replaces it.
 */
export interface ClaudeModelCache {
  models: ModelOption[] | null;
  stale?: boolean;
  /** Told each live list as it replaces `models`, to keep it across restarts. */
  persist?: (models: ModelOption[]) => void;
}
