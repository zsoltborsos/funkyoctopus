import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { HelmraiserEvent } from '../../../src/shared/transport/protocol.ts';

/** Injectable spawn so tests never run a real `notify-send`. */
export type SpawnLike = typeof spawn;

/** Injectable error logger (missing binary); defaults to console.error. */
export type ErrorLogger = (message: string) => void;

const SUMMARY: Record<HelmraiserEvent['event'], string> = {
  awaiting: 'Helmraiser: approval needed',
  failed: 'Helmraiser: run failed',
  landed: 'Helmraiser: run landed',
};

/**
 * Optional desktop notifications over `notify-send`, driven by the sidecar's
 * Helmraiser watcher so a run is reported even with no browser tab open. The
 * environment gates the class (FUNKYOCTOPUS_DESKTOP_NOTIFY=1): a disabled
 * notifier does nothing. A missing binary logs once per instance and is then
 * ignored — desktop delivery is best-effort and must never become an error
 * surface. Arguments go to spawn directly; nothing is built through a shell,
 * and task data never reaches the body.
 */
export class HelmraiserDesktopNotifier {
  private missingLogged = false;

  constructor(
    private readonly enabled: boolean,
    private readonly spawnFn: SpawnLike = spawn,
    private readonly logError: ErrorLogger = console.error,
  ) {}

  /** Best-effort delivery; every failure path stays silent after one log. */
  notify(event: HelmraiserEvent): void {
    if (!this.enabled) return;
    try {
      const child: ChildProcess = this.spawnFn('notify-send', [
        '--app-name',
        'FunkyOctopus',
        SUMMARY[event.event],
        event.title,
      ], { stdio: 'ignore' });
      // A spawn failure usually surfaces as an 'error' event; without a
      // listener Node would crash the sidecar, so one is always attached.
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') this.onMissing();
      });
    } catch (error) {
      // Some environments throw synchronously instead of emitting 'error'.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.onMissing();
    }
  }

  private onMissing(): void {
    if (this.missingLogged) return;
    this.missingLogged = true;
    this.logError('funkyoctopus — notify-send is not available; desktop notifications are off');
  }
}
