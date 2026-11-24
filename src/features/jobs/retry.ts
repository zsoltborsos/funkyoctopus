import type { HelmraiserRetryResult, HelmraiserWorker } from '@shared/transport/protocol.ts';

/**
 * Whether a running worker would pick up a run of `project`: helmraiser's own rule
 * (`worker_serves`), read off `status.worker`. A row from an older build has no
 * project, so only the worker running can be told. A worker whose status carries
 * no scope is taken to serve every project.
 */
export function workerServes(worker: HelmraiserWorker, project: string | undefined): boolean {
  if (worker.state !== 'running') return false;
  if (project === undefined) return true;
  const included = worker.projects == null || worker.projects.includes(project);
  return included && !(worker.exclude_projects ?? []).includes(project);
}

/** Why a retry would wait, or null when a running worker serves the project. */
export function noWorkerHint(worker: HelmraiserWorker, project: string | undefined): string | null {
  if (workerServes(worker, project)) return null;
  return worker.state === 'running'
    ? 'no worker serves this project — the running worker is scoped to other projects'
    : 'no worker serves this project — START the worker to resume it';
}

/** The panel's line after a retry, from the CLI's own `worker` and `worker_serves_project`. */
export function retriedNote(result: Pick<HelmraiserRetryResult, 'worker' | 'worker_serves_project'>): string {
  if (result.worker_serves_project) return 'run retried — the worker resumes it';
  return result.worker === 'running'
    ? 'run retried — no worker serves its project'
    : 'run retried — start the worker to resume it';
}
