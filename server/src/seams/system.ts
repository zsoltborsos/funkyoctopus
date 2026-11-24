import type { MethodRegistry } from '../transport/registry.ts';
import { config } from '../config.ts';
import { backends } from '../health.ts';
import type { Upkeep } from '../upkeep/upkeep.ts';
import type { HealthResult } from '../../../src/shared/transport/protocol.ts';

/**
 * The always-present liveness seam. `backends` is seeded with every integration
 * (pi, helmraiser) as `unknown`; each seam overwrites its own entry the
 * first time it succeeds or fails, so a poll of this method always returns the
 * full set. The upkeep result is served from its cache — the five-second status
 * poll must never re-run or re-read versions.
 */
export function registerSystemSeam(
  registry: MethodRegistry,
  startedAt: number,
  upkeep: Upkeep,
  desktopNotifications = false,
): void {
  registry.call(
    'system.health',
    (): HealthResult => ({
      ok: true,
      service: 'funkyoctopus-sidecar',
      version: config.version,
      uptimeMs: Date.now() - startedAt,
      backends: { ...backends },
      // Optional literal: absence tells the browser its own Helmraiser
      // notifications are wanted; presence means the sidecar already does it.
      ...(desktopNotifications ? { desktopNotifications: true } : {}),
    }),
  );

  registry.call('system.upkeep', () => upkeep.snapshot());
}
