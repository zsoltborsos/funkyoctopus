import type { HelmraiserReport, HelmraiserUsageWindow } from '@shared/transport/protocol.ts';

/**
 * A `helmraiser report` wire fixture. The figures are chosen so the headline
 * numbers are easy to check by hand: 51 of 53 runs passed first time, 50 runs
 * landed for $45.50 in all, which is $0.91 each, and 6 review rounds in total.
 * Each call returns a fresh object so tests can override values.
 */
export function makeHelmraiserReport(overrides: Partial<HelmraiserReport> = {}): HelmraiserReport {
  return {
    since: '24h',
    generated_at: '2026-11-22T16:05:00+00:00',
    landed_count: 50,
    awaiting_count: 2,
    failed: [{
      run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
      task_id: '-home-example-projects-acme-monorepo:app-sign-in-tagline',
      title: 'App sign-in tagline',
      failure_reason: 'timeout: pi session exceeded its time limit',
      ended_at: '2026-11-22T09:12:13+00:00',
    }],
    cost: { total_usd: 45.5, by_model: { 'opencode-go/glm-5.2': 20, 'openai-codex/gpt-5.5': 25.5 } },
    models: [
      { model: 'opencode-go/glm-5.2', runs: 30, landed: 28, failed: 1, first_pass: 29, review_rounds: 4, avg_iterations: 1.2, avg_minutes: 11.5, cost_per_landed: 0.7143 },
      { model: 'openai-codex/gpt-5.5', runs: 23, landed: 22, failed: 0, first_pass: 22, review_rounds: 2, avg_iterations: 1, avg_minutes: 8, cost_per_landed: 1.1591 },
    ],
    ...overrides,
  };
}

/** One provider window of the status `usage` map, with the fields a bar needs. */
export function usageWindow(fraction: number, overrides: Partial<HelmraiserUsageWindow> = {}): HelmraiserUsageWindow {
  return {
    fraction, spend_usd: 1, resets_at: 1_800_000_000, warn_at: 0.8, stop_at: null,
    source: 'live', live_fraction: fraction, estimate_fraction: fraction,
    ...overrides,
  };
}
