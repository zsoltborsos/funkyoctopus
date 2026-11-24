import { backends, setBackend } from '../health.ts';
import type { PiModelPick } from './default-model.ts';
import type { ModelCatalog } from './model-catalog.ts';

/**
 * Mark pi in the status strip from its model catalog: up when the configured
 * model resolves, down when it does not or when no model is configured at all
 * (`pickModel` throws; the reason is logged, and the first pi turn repeats it).
 * It builds no session, so a restored sidecar (whose tabs only arm, limit 2)
 * need not show `pi: unknown` until the first pi turn. Only an `unknown` is
 * replaced: a real build's answer stands, and a pi no slot runs stays out of
 * the strip.
 */
export async function markPiReady(
  catalog: Pick<ModelCatalog, 'resolve'>,
  pickModel: () => PiModelPick,
): Promise<void> {
  let ready = false;
  try {
    const { provider, model } = pickModel();
    ready = await catalog.resolve(provider, model).then(
      (found) => found !== undefined,
      () => false,
    );
  } catch (error) {
    console.warn(`[pi] ${error instanceof Error ? error.message : String(error)}`);
  }
  if (backends.pi === 'unknown') setBackend('pi', ready ? 'up' : 'down');
}
