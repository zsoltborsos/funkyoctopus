/**
 * Sidecar liveness probe shared by everything that must not mutate
 * `node_modules` under a live server: the quarantined upkeep CLI
 * (`tools/pi-upkeep/upkeep-cli.ts`) and the promotion script
 * (`scripts/promote-pi.ts`).
 *
 * The sidecar itself takes no lock at boot, so a bounded TCP connect to
 * `SIDECAR_HOST:SIDECAR_PORT` (defaults mirror `server/src/config.ts`:
 * 127.0.0.1:14787) is the only thing standing between an installer and a
 * running process. The probe is machine-scoped where the repository lock was
 * repo-scoped; operator discipline (stop the sidecar before promoting) is the
 * documented mitigation.
 */

import { connect } from 'node:net';
import { DEFAULT_SIDECAR_PORT } from '../../../src/shared/transport/protocol.ts';

/** Ceiling for the sidecar liveness probe; a silent port reads as "not listening". */
export const SIDECAR_PROBE_TIMEOUT_MS = 1_500;

/**
 * Bounded TCP connect: resolves true the moment something accepts the
 * connection on host:port, false on refusal, error, or timeout. Rejects only
 * for an invalid host/port (node's synchronous argument validation) — callers
 * validate the port first, so a bad `SIDECAR_PORT` is a bounded refusal there,
 * never a skipped probe here. The socket is destroyed on every path, so the
 * probe leaves no handle behind.
 */
export function probeSidecar(host: string, port: number, timeoutMs = SIDECAR_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({ host, port });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const settle = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(listening);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/** `SIDECAR_HOST`/`SIDECAR_PORT` exactly as the sidecar reads them (`server/src/config.ts`). */
export function sidecarAddressFromEnv(env: NodeJS.ProcessEnv): { host: string; port: number } {
  return { host: env.SIDECAR_HOST ?? '127.0.0.1', port: Number(env.SIDECAR_PORT ?? DEFAULT_SIDECAR_PORT) };
}
