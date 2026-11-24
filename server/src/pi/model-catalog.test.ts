/**
 * The catalog's wire mapping: what `list()` publishes as a `ModelOption`.
 * pi's ModelRuntime is faked at its single construction seam so the mapping is
 * asserted on its own; the shape of pi's `Model` itself is pinned by the
 * type-checker and by `pi-contract.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelCatalog } from './model-catalog.ts';

/** Just the fields `list()` reads off a pi model. */
function piModel(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'anthropic',
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    reasoning: false,
    input: ['text', 'image'],
    ...overrides,
  };
}

function catalogOver(models: ReturnType<typeof piModel>[]): ModelCatalog {
  vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
    getAvailable: () => Promise.resolve(models),
  } as unknown as ModelRuntime);
  return new ModelCatalog();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelCatalog.list', () => {
  it('publishes each model’s input modalities exactly as pi reports them', async () => {
    const catalog = catalogOver([
      piModel(),
      piModel({ provider: 'opencode-go', id: 'glm-5.2', name: 'GLM 5.2', input: ['text'] }),
    ]);

    const options = await catalog.list();

    expect(options.map((option) => [option.id, option.input])).toEqual([
      ['claude-opus-5', ['text', 'image']],
      ['glm-5.2', ['text']],
    ]);
  });

  it('copies the modality array so the wire payload cannot alias pi’s model', async () => {
    const model = piModel();
    const catalog = catalogOver([model]);

    const [option] = await catalog.list();

    expect(option?.input).toEqual(['text', 'image']);
    expect(option?.input).not.toBe(model.input);
  });
});
