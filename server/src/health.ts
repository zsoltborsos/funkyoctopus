/**
 * `not_installed` is a tool whose CLI is not on this machine (Helmraiser, Leeboard):
 * a calm state, not a fault, because FunkyOctopus works without it. `down` is a
 * tool that is there but failed.
 */
export type BackendStatus = 'up' | 'down' | 'unknown' | 'not_installed';

/**
 * Shared liveness map for integrated backends. Seeded with every backend the
 * sidecar integrates so the status strip can render the full set from the first
 * health read — a seam that has not been exercised yet reports `unknown` rather
 * than vanishing. Seams overwrite their own entry as they connect/fail.
 */
export const backends: Record<string, BackendStatus> = {
  pi: 'unknown',
  helmraiser: 'unknown',
};

export function setBackend(name: string, status: BackendStatus): void {
  backends[name] = status;
}

/**
 * Keep a backend in the map only while the sidecar runs it: pi is present while
 * any chat slot is a pi slot. With none (a Claude `main` and no pi tab), pi is
 * never started, and its seeded `unknown` would sit in the status strip for
 * good. A backend coming back starts as `unknown`; a known status is kept.
 */
export function trackBackend(name: string, present: boolean): void {
  if (!present) delete backends[name];
  else if (!(name in backends)) backends[name] = 'unknown';
}

export type Probe = () => Promise<unknown>;

/**
 * Runs every probe once now and then every `intervalMs`. Rejections are swallowed —
 * a probe reports liveness by writing the backend map itself (setBackend), so a
 * throwing probe is just a `down` that has already been recorded. The timer is
 * unref'd so a dead backend cannot hold the process open. Returns a stop function.
 */
export function startHealthProbes(probes: readonly Probe[], intervalMs = 15_000): () => void {
  const runAll = (): void => {
    for (const probe of probes) {
      void probe().catch(() => undefined);
    }
  };
  runAll();
  const timer = setInterval(runAll, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
