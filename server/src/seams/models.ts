import type { MethodRegistry } from '../transport/registry.ts';
import type { ModelOption } from '../../../src/shared/transport/protocol.ts';

/** Where the picker's model list comes from: pi's catalog, or the Claude Code engine's. */
export interface ModelLister {
  list(): Promise<ModelOption[]>;
}

/**
 * The models of every engine in one list (T2.1): each option already carries
 * its provider, which is what tells the engines apart (Claude Code's are
 * `claude-code`). An engine that cannot list (pi without auth, say) leaves the
 * others; only when none can does the call fail, with the first one's error.
 */
export function unionModels(...listers: ModelLister[]): ModelLister {
  return {
    list: async () => {
      const results = await Promise.allSettled(listers.map((lister) => lister.list()));
      const listed = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      if (listed.length === 0) {
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        throw failed?.reason instanceof Error ? failed.reason : new Error('no models could be listed');
      }
      return listed.flat();
    },
  };
}

/**
 * A lister whose entry for the model pi routes to by default carries `isDefault`.
 * `resolve` is pi's own resolution (it throws when nothing is configured): the
 * browser learns the default here instead of keeping a model name of its own.
 * Nothing resolving (or the pick not being listed) marks nothing; the list is
 * served either way, and a send still fails with pi's own message.
 */
export function withDefaultModel(
  lister: ModelLister,
  resolve: () => { provider: string; model: string },
): ModelLister {
  return {
    list: async () => {
      const models = await lister.list();
      let pick: { provider: string; model: string };
      try {
        pick = resolve();
      } catch {
        return models;
      }
      return models.map((m): ModelOption => (m.provider === pick.provider && m.id === pick.model ? { ...m, isDefault: true } : m));
    },
  };
}

/** Registers the models seam: the picker's source of selectable chat models. */
export function registerModelsSeam(registry: MethodRegistry, models: ModelLister): void {
  registry.call('models.list', () => models.list());
}
