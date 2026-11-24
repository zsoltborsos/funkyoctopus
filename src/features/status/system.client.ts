import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { HealthResult, UpkeepResult } from '@shared/transport/protocol.ts';

/** Thin browser-side face of the sidecar's `system.*` methods. */
export class SystemClient {
  constructor(private readonly transport: TransportClient) {}

  health(): Promise<HealthResult> {
    return this.transport.call('system.health');
  }

  /** The cached upkeep result — the sidecar never re-runs on this read. */
  upkeep(): Promise<UpkeepResult> {
    return this.transport.call('system.upkeep');
  }
}

export const SYSTEM = token<SystemClient>('SystemClient');
