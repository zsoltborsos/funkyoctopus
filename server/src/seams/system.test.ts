import { describe, expect, it, vi } from 'vitest';
import { MethodRegistry } from '../transport/registry.ts';
import { registerSystemSeam } from './system.ts';
import type { Upkeep } from '../upkeep/upkeep.ts';
import type { UpkeepResult } from '../../../src/shared/transport/protocol.ts';
import { setBackend, trackBackend } from '../health.ts';

function call(registry: MethodRegistry, name: string) {
  const entry = registry.get(name);
  if (!entry || entry.kind !== 'call') throw new Error(`missing call ${name}`);
  return (params: unknown) => entry.handler(params, { signal: new AbortController().signal });
}

describe('system seam', () => {
  it('exposes the cached upkeep snapshot without running the updater', () => {
    const result: UpkeepResult = {
      disabled: false,
      status: 'updated',
      lastRunAt: 1,
      lastResult: 'up to date',
      globalPiVersion: '0.84.1',
      embeddedSdkVersion: '0.81.1',
      drift: 'behind',
      embedded: {
        installedVersion: '0.81.1',
        latestVersion: '0.81.1',
        verifiedVersion: '0.81.1',
        verificationLevel: 'live',
        status: 'current',
        lastCheckAt: 1,
        lastPromotionAttemptAt: null,
        lastPromotionResult: null,
        lastRecoveryAttemptAt: null,
        lastRecoveryResult: null,
      },
    };
    const snapshot = vi.fn(() => result);
    const registry = new MethodRegistry();
    registerSystemSeam(registry, 0, { snapshot } as unknown as Upkeep);
    const response = call(registry, 'system.upkeep')(undefined);
    expect(response).toEqual(result);
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it('reports desktop notifications in health only when enabled', () => {
    const upkeep = { snapshot: () => ({ disabled: true, status: 'idle' }) } as unknown as Upkeep;

    const off = new MethodRegistry();
    registerSystemSeam(off, 0, upkeep);
    expect(call(off, 'system.health')(undefined)).not.toHaveProperty('desktopNotifications');

    const on = new MethodRegistry();
    registerSystemSeam(on, 0, upkeep, true);
    expect(call(on, 'system.health')(undefined)).toMatchObject({ desktopNotifications: true });
  });

  it('reports a tool whose CLI is missing as not_installed, separate from one that is down', () => {
    const upkeep = { snapshot: () => ({ disabled: true, status: 'idle' }) } as unknown as Upkeep;
    const registry = new MethodRegistry();
    registerSystemSeam(registry, 0, upkeep);
    setBackend('helmraiser', 'not_installed');
    setBackend('leeboard', 'not_installed');
    try {
      expect(call(registry, 'system.health')(undefined)).toMatchObject({
        backends: { helmraiser: 'not_installed', leeboard: 'not_installed' },
      });
    } finally {
      setBackend('helmraiser', 'unknown');
      trackBackend('leeboard', false);
    }
  });
});
