import type { HelmraiserReworkResult } from '@shared/transport/protocol.ts';

/** The panel's line after a rework, from the CLI's own `worker` and `worker_serves_project`. */
export function reworkedNote(result: Pick<HelmraiserReworkResult, 'worker' | 'worker_serves_project'>): string {
  if (result.worker_serves_project) return 'run sent back for rework — the worker resumes it';
  return result.worker === 'running'
    ? 'run sent back for rework — no worker serves its project'
    : 'run sent back for rework — start the worker to resume it';
}
