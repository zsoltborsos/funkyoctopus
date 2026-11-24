/**
 * Phase 4 runtime-suite preflight: resolve the exact model pin and fail the
 * suite *before any session is created* when that exact model or its
 * authentication is unavailable. There is no fallback to a default model —
 * the pin is the pin.
 */

import type { ModelCatalog } from '../pi/model-catalog.ts';

/** The accepted default pin for the runtime suite. */
export const DEFAULT_RUNTIME_PIN = { provider: 'opencode-go', id: 'deepseek-v4.1-flash' } as const;

export interface RuntimePin {
  provider: string;
  id: string;
}

/**
 * `FUNKYOCTOPUS_RUNTIME_MODEL` must be an explicit `provider/id` pair when set.
 * Unset resolves to the default pin.
 */
export function resolveRuntimePin(): RuntimePin {
  const raw = process.env.FUNKYOCTOPUS_RUNTIME_MODEL;
  if (!raw) return { ...DEFAULT_RUNTIME_PIN };
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(
      `FUNKYOCTOPUS_RUNTIME_MODEL must be an explicit provider/id pair, got "${raw}"`,
    );
  }
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

/**
 * Fail fast when the exact pin is not resolvable or not authenticated.
 *
 * `resolve` covers model-store presence; `getAuth` is the same gate pi itself
 * uses before a request (`prepareRequest` throws when it returns undefined), so
 * this matches what a real turn would do — minus the turn.
 */
export async function assertRuntimePinAvailable(
  catalog: ModelCatalog,
  pin: RuntimePin,
): Promise<void> {
  const runtime = await catalog.getRuntime();
  const model = await catalog.resolve(pin.provider, pin.id);
  if (!model) {
    throw new Error(
      `Runtime pin unavailable: model ${pin.provider}/${pin.id} is not in the pi model store. ` +
        'Refusing to create a session or fall back.',
    );
  }
  const auth = await runtime.getAuth(model);
  if (!auth) {
    throw new Error(
      `Runtime pin unavailable: no authentication for ${pin.provider}/${pin.id}. ` +
        'Refusing to create a session or fall back.',
    );
  }
}
