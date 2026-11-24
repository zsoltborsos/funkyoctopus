import { describe, expect, it } from 'vitest';
import { reworkedNote } from './rework.ts';

// Same worker facts as retry: `worker` and `worker_serves_project` come from helmraiser's `_hand_back`.
describe('reworkedNote', () => {
  it.each<[string, { worker: string; worker_serves_project: boolean }, string]>([
    ['a running worker serves the project', { worker: 'running', worker_serves_project: true }, 'run sent back for rework — the worker resumes it'],
    ['no worker is recorded', { worker: 'none', worker_serves_project: false }, 'run sent back for rework — start the worker to resume it'],
    ['the worker has exited', { worker: 'exited', worker_serves_project: false }, 'run sent back for rework — start the worker to resume it'],
    ['the running worker is scoped elsewhere', { worker: 'running', worker_serves_project: false }, 'run sent back for rework — no worker serves its project'],
  ])('when %s', (_name, result, expected) => {
    expect(reworkedNote(result)).toBe(expected);
  });
});
