import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../../../src/shared/transport/protocol.ts';
import { MethodRegistry } from '../transport/registry.ts';
import { registerModelsSeam, unionModels, withDefaultModel } from './models.ts';

const model = (provider: string, id: string): ModelOption => ({ provider, id, name: id, thinkingLevels: [], input: ['text'] });

describe('models.list', () => {
  it('is the union of both engines’ models, each tagged by its provider', async () => {
    const lister = unionModels(
      { list: () => Promise.resolve([model('opencode-go', 'deepseek')]) },
      { list: () => Promise.resolve([model('claude-code', 'sonnet')]) },
    );
    const registry = new MethodRegistry();
    registerModelsSeam(registry, lister);
    const entry = registry.get('models.list');
    if (entry?.kind !== 'call') throw new Error('missing models.list');

    expect(await entry.handler({}, { signal: new AbortController().signal })).toEqual([
      model('opencode-go', 'deepseek'),
      model('claude-code', 'sonnet'),
    ]);
  });

  it('keeps one engine’s models when the other cannot list, and fails only when none can', async () => {
    const failing = { list: () => Promise.reject(new Error('no pi auth')) };
    const claude = { list: () => Promise.resolve([model('claude-code', 'opus')]) };

    expect(await unionModels(failing, claude).list()).toEqual([model('claude-code', 'opus')]);
    await expect(unionModels(failing, failing).list()).rejects.toThrow('no pi auth');
  });

  describe('pi default model', () => {
    const listPi = () => Promise.resolve([model('alpha', 'small'), model('alpha', 'large'), model('beta', 'large')]);
    const claude = { list: () => Promise.resolve([model('claude-code', 'large')]) };

    /** What the browser reads: `models.list` over the registered seam. */
    const wire = async (lister: ReturnType<typeof unionModels>): Promise<ModelOption[]> => {
      const registry = new MethodRegistry();
      registerModelsSeam(registry, lister);
      const entry = registry.get('models.list');
      if (entry?.kind !== 'call') throw new Error('missing models.list');
      return (await entry.handler({}, { signal: new AbortController().signal })) as ModelOption[];
    };

    it('is marked on the one entry pi resolves to, by provider and id, and on no other', async () => {
      const lister = unionModels(
        withDefaultModel({ list: listPi }, () => ({ provider: 'alpha', model: 'large' })),
        claude,
      );

      expect(await wire(lister)).toEqual([
        model('alpha', 'small'),
        { ...model('alpha', 'large'), isDefault: true },
        model('beta', 'large'),
        model('claude-code', 'large'),
      ]);
    });

    it('is marked on nothing, and the list is still served, when no pi model is configured', async () => {
      const unconfigured = () => {
        throw new Error('no pi model is configured');
      };

      expect(await wire(unionModels(withDefaultModel({ list: listPi }, unconfigured), claude))).toEqual([
        model('alpha', 'small'),
        model('alpha', 'large'),
        model('beta', 'large'),
        model('claude-code', 'large'),
      ]);
    });

    it('is marked on nothing when the configured model is not among those pi lists', async () => {
      const lister = withDefaultModel({ list: listPi }, () => ({ provider: 'alpha', model: 'retired' }));

      expect(await wire(lister)).toEqual([model('alpha', 'small'), model('alpha', 'large'), model('beta', 'large')]);
    });
  });
});
