import type { HelmraiserStatus } from '@shared/transport/protocol.ts';

/**
 * A historical status ledger fixture adapted to Helmraiser's shape
 * (see `server/src/helmraiser/fixtures/status.json`), typed against the wire
 * contract. The default retains that ledger fixture; the opt-in scope row
 * represents the supplied newer contract, not a live recording. Each call
 * returns a fresh object so tests can override values without leaking mutations.
 */
export function makeHelmraiserStatus(options: { includeScope?: boolean } = {}): HelmraiserStatus {
  const status: HelmraiserStatus = {
    updated_at: '2026-09-24T19:26:01.881383+00:00',
    queued_count: 1,
    queue_next: [
      {
        task_id: '-home-example-projects-helmraiser:status-row-identity',
        id: 'status-row-identity',
        priority: 'high',
        project: '/home/example/projects/helmraiser',
        title: 'Status rows name their project, id and title',
        origin: { kind: 'fo', session: '/home/example/.pi/agent/sessions/fixture.jsonl' },
      },
    ],
    running: [
      {
        run_id: 'e1fba81e-9ac9-4421-af2c-9a28dc79da8e',
        task: '-home-example-projects-helmraiser:planned-runs',
        stage: 'implement',
        iteration: 1,
        cost_usd: 2.0657,
        minutes: 7,
        project: '/home/example/projects/helmraiser',
        id: 'planned-runs',
        title: 'Planned runs: a strong model plans, the cheap implementer follows the plan',
        origin: null,
      },
    ],
    awaiting_count: 1,
    failed_24h_count: 1,
    spend: {
      'openai-codex': { '5h': 8.2382, '7d': 47.0578, '30d': 47.0578 },
      'opencode-go': { '5h': 1.4269, '7d': 2.9648, '30d': 2.9648 },
    },
    usage: {
      'opencode-go': {
        '5h': { fraction: 0.11, spend_usd: 1.4269, resets_at: 1790278146.086, warn_at: 0.8, stop_at: null, source: 'live', live_fraction: 0.11, estimate_fraction: 0.118911 },
        week: { fraction: 0.11, spend_usd: 2.9648, resets_at: 1790553600.0, warn_at: 0.8, stop_at: null, source: 'live', live_fraction: 0.11, estimate_fraction: 0.113761 },
        month: { fraction: 0.05, spend_usd: 2.9648, resets_at: 1792257625.0, warn_at: 0.8, stop_at: null, source: 'live', live_fraction: 0.05, estimate_fraction: 0.056881 },
      },
    },
    caps_enforced: true,
    paused: null,
    held_providers: {},
    worker: {
      pid: 1073641,
      started_at: '2026-09-24T19:18:19.947510+00:00',
      argv: ['python3', '-m', 'helmraiser', 'work', '--json'],
      log: '/home/example/.helmraiser/worker.log',
      state: 'running',
    },
    queue: { failed: 16, landed: 40, queued: 1, running: 1, awaiting_approval: 1 },
    awaiting: [
      {
        run_id: '865c36b8-a39d-433a-bc6c-87b1715d14e2',
        task: '-home-example-projects-helmraiser:report-rejected-split',
        pending: 'merge',
        verdict: 'pass',
        cost_usd: 0.1138,
        project: '/home/example/projects/helmraiser',
        id: 'report-rejected-split',
        title: 'Count rejected runs separately',
        worktree: '/home/example/projects/helmraiser/.helmraiser/worktrees/report-rejected-split',
        branch: 'feature/report-rejected-split',
        base_commit: 'abc1234',
        origin: { kind: 'claude-code', session: 'review-session' },
      },
    ],
    resuming: [],
    failed: [
      {
        run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
        task: '-home-example-projects-helmraiser:live-subscription-usage',
        reason: 'timeout: pi session exceeded its time limit',
        ended_at: '2026-09-24T15:12:13.750020+00:00',
        project: '/home/example/projects/helmraiser',
        id: 'live-subscription-usage',
        title: 'Live subscription usage',
      },
    ],
    scouts: {
      focus_projects: ['/home/example/projects/helmraiser'],
      paused_projects: ['/home/example/projects/funkyoctopus'],
      pending: [{
        project: '/home/example/projects/helmraiser',
        requested_at: '2026-10-02T10:00:00Z',
        wait_reason: 'slots busy',
      }],
      running: [{
        project: '/home/example/projects/funkyoctopus',
        scout_id: 'scout-1',
        started_at: '2026-10-02T10:01:00Z',
      }],
      recent: [{
        project: '/home/example/projects/helmraiser',
        scout_id: 'scout-0',
        ended_at: '2026-10-02T09:00:00Z',
        ok: true,
        drafts: 2,
        report: 'two candidates',
        error: null,
      }],
    },
    status_path: '/run/user/1000/helmraiser/status.json',
  };
  if (options.includeScope) {
    status.awaiting.push({
      run_id: '29b93551-f7c2-44c6-9393-42970544e4cb',
      task: 'scope-approval',
      id: 'scope-approval',
      title: 'Approve additional implementation paths',
      pending: 'scope',
      verdict: 'pass',
      cost_usd: 0.42,
      project: '/home/example/projects/funkyoctopus',
      origin: null,
      scope_request: {
        paths: ['src/a.ts', 'src/b.ts'],
        reason: 'These files are needed to complete the implementation.',
      },
    });
    status.awaiting_count += 1;
    status.queue.awaiting_approval += 1;
  }
  return status;
}

/**
 * The hold a queued task carries (`queue_next[].held_by`, repeated in `held[]`):
 * the live 2026-10-19 shape, demo-api `board-sync` waiting on the merge of
 * `access-policy`.
 */
export const BOARD_SYNC_HOLD = {
  run_id: '0f6b2c1e-8d0a-4b8e-9c55-1f2f3a4b5c6d',
  status: 'awaiting_approval',
  pending: 'merge',
  reason: 'paths_overlap',
  other_task_id: 'access-policy',
} as const;

/**
 * Adds a held queued task (live `queue_next` + `held` shape) and a
 * `never_startable` row (helmraiser `status.py`; `text` is helmraiser's own
 * `never_startable_text` output) to a status.
 */
export function addQueueHolds(status: HelmraiserStatus): void {
  const boardSync = {
    task_id: '-home-example-projects-demo-api:board-sync',
    id: 'board-sync',
    title: 'Sync the board with the access policy',
    project: '/home/example/projects/demo-api',
    origin: null,
  };
  status.queue_next.push({ ...boardSync, priority: 'normal', held_by: { ...BOARD_SYNC_HOLD } });
  status.held = [{ ...boardSync, ...BOARD_SYNC_HOLD }];
  status.never_startable = [{
    task_id: '-home-example-projects-helmraiser:rewrite-the-loop',
    id: 'rewrite-the-loop',
    title: 'Rewrite the loop',
    project: '/home/example/projects/helmraiser',
    origin: null,
    reason: 'never_startable:opencode-go:5h',
    model: 'opencode-go/unlisted',
    projected: 1.6667,
    stop_at: 0.7,
    projection_usd: 5,
    text: 'will never start: projected $5 on opencode-go/unlisted is 167% of the opencode-go 5h window, at or over stop_at 70%; lower budget.max_cost_usd or opencode-go projection_usd, raise stop_at, or pick a model with a larger monthly limit',
  }];
  status.queued_count += 2;
}
