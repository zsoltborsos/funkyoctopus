import { describe, expect, it } from 'vitest';
import type { HelmraiserHold, HelmraiserNeverStartable } from '@shared/transport/protocol.ts';
import { holdText, neverStartableText } from './queue-hold.ts';

const RUN = '0f6b2c1e-8d0a-4b8e-9c55-1f2f3a4b5c6d';

describe('holdText', () => {
  it.each<[string, HelmraiserHold, string]>([
    ['paths_overlap on a run parked for merge (the live shape)',
      { run_id: RUN, status: 'awaiting_approval', pending: 'merge', reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for the merge of access-policy — same files'],
    ['paths_overlap on a run parked for plan approval',
      { run_id: RUN, status: 'awaiting_approval', pending: 'plan', reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for the plan approval of access-policy — same files'],
    ['paths_overlap on a run parked for scope approval',
      { run_id: RUN, status: 'awaiting_approval', pending: 'scope', reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for the scope approval of access-policy — same files'],
    ['paths_overlap on a run still running',
      { run_id: RUN, status: 'running', pending: null, reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for access-policy to finish — same files'],
    ['paths_overlap on a resuming run',
      { run_id: RUN, status: 'resuming', pending: null, reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for access-policy to resume and finish — same files'],
    ['project_busy',
      { run_id: RUN, status: 'running', pending: null, reason: 'project_busy', other_task_id: 'access-policy' },
      'waits for access-policy to finish — the project is busy'],
    ['project_busy with helmraiser\'s detail',
      { run_id: RUN, status: 'running', pending: null, reason: 'project_busy', other_task_id: 'access-policy', detail: 'paths required on both tasks: missing holder task snapshot' },
      'waits for access-policy to finish — the project is busy: paths required on both tasks: missing holder task snapshot'],
    ['a run hold with no reason names the run itself',
      { run_id: RUN, status: 'running', pending: null },
      'waits for run 0f6b2c1e to finish'],
    ['a run hold with no reason, parked for merge',
      { run_id: RUN, status: 'awaiting_approval', pending: 'merge' },
      'waits for the merge of run 0f6b2c1e'],
    ['an unknown approval kind keeps its name',
      { run_id: RUN, status: 'awaiting_approval', pending: 'landing', reason: 'paths_overlap', other_task_id: 'access-policy' },
      'waits for the landing approval of access-policy — same files'],
    ['an unknown reason shows its raw code',
      { run_id: RUN, status: 'awaiting_approval', pending: 'merge', reason: 'queue_full', other_task_id: 'access-policy' },
      'waits for the merge of access-policy — queue_full'],
    ['an unknown reason with no run shows its raw code',
      { reason: 'queue_full' },
      'held — queue_full'],
    ['one unmet dependency, in helmraiser\'s words',
      { reason: 'depends_on', unmet: [{ id: 'access-policy', reason: 'not_landed', text: 'access-policy: not landed (running)' }] },
      'depends on access-policy: not landed (running)'],
    ['several unmet dependencies',
      { reason: 'depends_on', unmet: [
        { id: 'access-policy', reason: 'not_landed', text: 'access-policy: not landed (queued)' },
        { id: 'board-schema', reason: 'failed', text: 'board-schema: latest run 142d660e failed' },
      ] },
      'depends on access-policy: not landed (queued); board-schema: latest run 142d660e failed'],
    ['a run hold merged with a dependency hold says both',
      { run_id: RUN, status: 'awaiting_approval', pending: 'merge', reason: 'depends_on', other_task_id: 'access-policy',
        unmet: [{ id: 'board-schema', reason: 'not_landed', text: 'board-schema: not landed (queued)' }] },
      'waits for the merge of access-policy; depends on board-schema: not landed (queued)'],
    ['nothing to go on',
      {},
      'held'],
  ])('%s', (_name, hold, words) => {
    expect(holdText(hold)).toBe(words);
  });
});

describe('neverStartableText', () => {
  const row: HelmraiserNeverStartable = {
    task_id: '-mnt-data-projects-personal-helmraiser:rewrite-the-loop',
    reason: 'never_startable:opencode-go:5h',
    text: 'will never start: projected $5 on opencode-go/unlisted is 167% of the opencode-go 5h window, at or over stop_at 70%; lower budget.max_cost_usd or opencode-go projection_usd, raise stop_at, or pick a model with a larger monthly limit',
  };

  it('says the task cannot start, then helmraiser\'s explanation', () => {
    expect(neverStartableText(row)).toBe(
      'cannot start — projected $5 on opencode-go/unlisted is 167% of the opencode-go 5h window, at or over stop_at 70%; lower budget.max_cost_usd or opencode-go projection_usd, raise stop_at, or pick a model with a larger monthly limit',
    );
  });

  it('falls back to the raw reason code when helmraiser sent no text', () => {
    expect(neverStartableText({ task_id: row.task_id, reason: row.reason })).toBe('cannot start — never_startable:opencode-go:5h');
  });
});
