import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelOption } from '../../../src/shared/transport/protocol.ts';

/** The model object pi's runtime hands back — derived so we don't import a type
 *  pi doesn't re-export from its package entry. */
type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

// pi's own ladder, low→high. Mirrors getSupportedThinkingLevels (not part of the
// public API) over the public Model fields `reasoning` + `thinkingLevelMap`.
const THINKING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Effort levels a model supports, or [] when it has no reasoning knob. */
export function thinkingLevelsFor(model: Pick<PiModel, 'reasoning' | 'thinkingLevelMap'>): string[] {
  if (!model.reasoning) {
    return [];
  }
  const map = (model.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
  return THINKING_LADDER.filter((level) => {
    const mapped = map[level];
    if (mapped === null) {
      return false; // explicitly unsupported
    }
    // The two top tiers only exist when a model maps them explicitly.
    if (level === 'xhigh' || level === 'max') {
      return mapped !== undefined;
    }
    return true;
  });
}

/**
 * Owns the single pi ModelRuntime and exposes just what the shell needs: the
 * list of available (authed/reachable) models for the picker, and resolution of
 * a provider/id back to a pi model so the chat session can switch to it. Shared
 * with PiChat so there is exactly one runtime behind both chat and the picker.
 */
export class ModelCatalog {
  private runtimePromise: Promise<ModelRuntime> | null = null;

  private runtime(): Promise<ModelRuntime> {
    return (this.runtimePromise ??= ModelRuntime.create());
  }

  /** The shared runtime, so the chat session builds on the same one. */
  getRuntime(): Promise<ModelRuntime> {
    return this.runtime();
  }

  /** Available models, flattened and sorted by provider then name. */
  async list(): Promise<ModelOption[]> {
    const runtime = await this.runtime();
    const models = await runtime.getAvailable();
    return models
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        thinkingLevels: thinkingLevelsFor(model),
        input: [...model.input],
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }

  /** Resolve a provider/id to a pi model, or undefined if unknown. */
  async resolve(provider: string, id: string): Promise<PiModel | undefined> {
    const runtime = await this.runtime();
    return runtime.getModel(provider, id);
  }
}
