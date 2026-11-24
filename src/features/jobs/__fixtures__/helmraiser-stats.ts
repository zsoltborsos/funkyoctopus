import type { HelmraiserScoutLens, HelmraiserStats, HelmraiserStatsScoutRow, HelmraiserStatsWindow } from '@shared/transport/protocol.ts';

/**
 * One `scouts` row of `helmraiser stats --json`. The defaults are a focus
 * project's never-scouted lens, as the real ledger reports it; each test
 * overrides what its cell needs. Each call returns a fresh object.
 */
export function makeStatsScoutRow(
  project: string,
  lens: HelmraiserScoutLens,
  overrides: Partial<HelmraiserStatsScoutRow> = {},
): HelmraiserStatsScoutRow {
  return {
    project, lens, in_focus: true, auto: false, cooldown_hours: 24,
    scouts: 0, succeeded: 0, failed: 0, running: 0, drafts_written: 0, cost_usd: 0,
    pending: 0, queued: 0, landed: 0, dropped: 0,
    dropped_by_class: { wrong: 0, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 0 },
    failed_drafts: 0,
    queued_unchanged: 0, queued_changed: 0, queued_unknown: 0,
    last_scout_ended_at: null, last_scout_ok: null, last_scout_error: null, last_scout_drafts: null,
    next_eligible_at: null, scheduling_error: null,
    ...overrides,
  };
}

/**
 * A `helmraiser stats --since all --json` answer, trimmed from a real ledger
 * (the top-level figures are real, the weekly list is cut to two weeks).
 * `scouts` is whatever the test supplies. Each call returns a fresh object.
 */
export function makeHelmraiserStats(
  scouts: HelmraiserStatsScoutRow[] = [],
  overrides: Partial<HelmraiserStats> = {},
): HelmraiserStats {
  return {
    window: { since: 'all', since_seconds: null, generated_at: '2026-11-22T17:58:24.417553+00:00', project: null },
    runs: {
      overall: { landed: 807, failed: 86, aborted: 7, awaiting_approval: 0, active: 1 },
      by_project: [
        { project: '/home/example/projects/funkyoctopus', landed: 52, failed: 2, aborted: 1, awaiting_approval: 0, active: 0 },
        { project: '/home/example/projects/helmraiser', landed: 33, failed: 1, aborted: 0, awaiting_approval: 0, active: 1 },
      ],
    },
    quality: {
      first_time_right: { count: 515, rate: 0.638 },
      rework_rate: 0.117,
      scope_request_rate: 0.097,
      retried_tasks: 37,
      review_verdicts: { pass: 692, concerns: 123, uncertain: 28, none: 58 },
    },
    failures: {
      blocked: { count: 32, run_ids: ['d862c453-27d1-4756-9d43-87115f8be616', '1d517854-2e50-4335-a620-7d0fd8a015c5', '142d660e-8ed6-4338-9413-5ad16510baaa'] },
      timeout: { count: 3, run_ids: ['ac0e658b-c3cf-4d67-a748-234e920f422b', '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc', '249e2605-a50d-405b-ae93-2c9b61a424be'] },
    },
    cost: { total_usd: 1461.362708144, plan_usd: 151.006526, implement_usd: 624.0222188500001, other_usd: 686.3339632939998, per_landed_usd: 1.8108583744039652 },
    latency: {
      active_minutes: { median: 14.597658812999725, p90: 34.48408429145814 },
      approval_wait_minutes: {
        plan: { median: 0.7573293050130209, p90: 14.807255144913992 },
        scope: { median: 0.7246033946673075, p90: 16.784902226924896 },
        merge: { median: 0.9178614219029745, p90: 16.776560032367705 },
      },
    },
    scouts,
    weekly: [
      { week: '2026-W46', landed: 108, failed: 0, first_time_right_rate: 0.639, drafts_written: 0, drafts_landed: 0 },
      { week: '2026-W47', landed: 87, failed: 1, first_time_right_rate: 0.632, drafts_written: 41, drafts_landed: 32 },
    ],
    ...overrides,
  };
}

const WINDOW_SECONDS: Record<HelmraiserStatsWindow, number | null> = {
  '24h': 86_400, '7d': 604_800, '30d': 2_592_000, '90d': 7_776_000, all: null,
};

/** The `window` of a stats answer for `since`, as the CLI reports it. */
export function statsWindow(since: HelmraiserStatsWindow): HelmraiserStats['window'] {
  return { since, since_seconds: WINDOW_SECONDS[since], generated_at: '2026-11-22T17:58:24.417553+00:00', project: null };
}

/** One `weekly` bucket; the defaults are a quiet week with nothing scouted. Each call returns a fresh object. */
export function makeWeeklyRow(week: string, overrides: Partial<HelmraiserStats['weekly'][number]> = {}): HelmraiserStats['weekly'][number] {
  return { week, landed: 0, failed: 0, first_time_right_rate: null, drafts_written: 0, drafts_landed: 0, ...overrides };
}
