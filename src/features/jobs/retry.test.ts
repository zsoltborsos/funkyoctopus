import { describe, expect, it } from 'vitest';
import type { HelmraiserWorker } from '@shared/transport/protocol.ts';
import { noWorkerHint, retriedNote, workerServes } from './retry.ts';

// Helmraiser's own rule (`worker_serves`, worker_commands.py): a running worker whose
// scope is every project (`projects: null`) or names this one, and does not exclude it.
describe('workerServes', () => {
  const REPO = '/work/repo';
  const OTHER = '/work/other';

  it.each<[string, HelmraiserWorker, string | undefined, boolean]>([
    ['a stopped worker', { state: 'stopped' }, REPO, false],
    ['an exited worker', { state: 'exited', projects: null, exclude_projects: [] }, REPO, false],
    ['a running worker scoped to every project', { state: 'running', projects: null, exclude_projects: [] }, REPO, true],
    ['a running worker whose status carries no scope', { state: 'running', pid: 7 }, REPO, true],
    ['a running worker scoped to this project', { state: 'running', projects: [REPO], exclude_projects: [] }, REPO, true],
    ['a running worker scoped to another project', { state: 'running', projects: [OTHER], exclude_projects: [] }, REPO, false],
    ['a running worker scoped to several projects', { state: 'running', projects: [OTHER, REPO], exclude_projects: [] }, REPO, true],
    ['a running worker that excludes this project', { state: 'running', projects: null, exclude_projects: [REPO] }, REPO, false],
    ['a running worker that excludes another project', { state: 'running', projects: null, exclude_projects: [OTHER] }, REPO, true],
    ['a running worker for a row with no project (older status)', { state: 'running', projects: [OTHER], exclude_projects: [] }, undefined, true],
    ['a stopped worker for a row with no project (older status)', { state: 'stopped' }, undefined, false],
  ])('%s', (_name, worker, project, expected) => {
    expect(workerServes(worker, project)).toBe(expected);
  });
});

describe('noWorkerHint', () => {
  const REPO = '/work/repo';

  it('is nothing while a running worker serves the project', () => {
    expect(noWorkerHint({ state: 'running', projects: null, exclude_projects: [] }, REPO)).toBeNull();
  });

  it.each<[string, HelmraiserWorker]>([
    ['stopped', { state: 'stopped' }],
    ['exited', { state: 'exited' }],
  ])('says to start the worker when it is %s', (_name, worker) => {
    expect(noWorkerHint(worker, REPO)).toBe('no worker serves this project — START the worker to resume it');
  });

  it('does not tell START for a worker that runs but covers other projects', () => {
    expect(noWorkerHint({ state: 'running', projects: ['/work/other'], exclude_projects: [] }, REPO))
      .toBe('no worker serves this project — the running worker is scoped to other projects');
  });
});

describe('retriedNote', () => {
  it.each<[string, { worker: string; worker_serves_project: boolean }, string]>([
    ['a running worker serves the project', { worker: 'running', worker_serves_project: true }, 'run retried — the worker resumes it'],
    ['no worker is recorded', { worker: 'none', worker_serves_project: false }, 'run retried — start the worker to resume it'],
    ['the worker has exited', { worker: 'exited', worker_serves_project: false }, 'run retried — start the worker to resume it'],
    ['the running worker is scoped elsewhere', { worker: 'running', worker_serves_project: false }, 'run retried — no worker serves its project'],
  ])('when %s', (_name, result, expected) => {
    expect(retriedNote(result)).toBe(expected);
  });
});
