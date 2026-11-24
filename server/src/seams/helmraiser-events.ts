import type { MethodRegistry } from '../transport/registry.ts';
import type { HelmraiserWatcher } from '../helmraiser/watcher.ts';

/** Registers the observation-only stream of awaiting-and-failed events. */
export function registerHelmraiserEventsSeam(registry: MethodRegistry, watcher: HelmraiserWatcher): void {
  registry.stream('helmraiser.observe', (_params, ctx) => watcher.observe(ctx.signal));
}
