import type { HelmraiserReport, HelmraiserUsageWindow } from '@shared/transport/protocol.ts';

/** The subscription windows, shortest first. */
export const USAGE_WINDOWS = ['5h', 'week', 'month'] as const;
export type UsageWindowName = (typeof USAGE_WINDOWS)[number];

/** Local two-digit `HH:MM` of an ISO timestamp. */
export function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Dollars to the cent, as `$0.91`. */
export const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** First-pass runs over all runs across the model rows; `null` when there were none. */
export function firstPass(models: HelmraiserReport['models']): { passed: number; runs: number; percent: number } | null {
  const runs = models.reduce((sum, row) => sum + row.runs, 0);
  if (runs === 0) return null;
  const passed = models.reduce((sum, row) => sum + row.first_pass, 0);
  return { passed, runs, percent: Math.round((passed / runs) * 100) };
}

/** The provider's busiest window, a tie going to the shorter one; `null` when it reports none. */
export function busiestWindow(
  windows: Partial<Record<UsageWindowName, HelmraiserUsageWindow>>,
): { name: UsageWindowName; usage: HelmraiserUsageWindow } | null {
  let best: { name: UsageWindowName; usage: HelmraiserUsageWindow } | null = null;
  for (const name of USAGE_WINDOWS) {
    const usage = windows[name];
    if (usage && (!best || usage.fraction > best.usage.fraction)) best = { name, usage };
  }
  return best;
}

/** How long until a window resets, from its epoch-seconds `resets_at`, e.g. `resets in 3d 20h`. */
export function resetsIn(resetsAt: number, nowMs: number): string {
  const seconds = Math.floor(resetsAt - nowMs / 1000);
  if (seconds <= 0) return 'resets now';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

/** `openai-codex/gpt-5.5` is provider `openai-codex`, name `gpt-5.5`; with no slash there is no provider. */
export function splitModel(model: string): { provider: string | null; name: string } {
  const slash = model.indexOf('/');
  return slash === -1 ? { provider: null, name: model } : { provider: model.slice(0, slash), name: model.slice(slash + 1) };
}

/** Helmraiser's task-id slug of a project path: every `/` made a `-` (`project_slug` in its task model). */
const slugOf = (path: string): string => path.replaceAll('/', '-');

/**
 * The project a task id (`<project-slug>:<id>`) names, or `null` when it names
 * none. The slug is the project's path with every `/` made a `-`, which cannot
 * be undone in general (`acme-monorepo` is not `acme/monorepo`), so the slug
 * is matched against the paths of the `projects` Helmraiser knows and a match
 * is named by the last segment of its path. Any other slug is shown as it is,
 * less its leading dash.
 */
export function projectOfTask(taskId: string, projects: readonly string[]): string | null {
  const colon = taskId.indexOf(':');
  if (colon === -1) return null;
  const slug = taskId.slice(0, colon);
  const known = projects.find((path) => slugOf(path) === slug);
  const name = known?.slice(known.lastIndexOf('/') + 1);
  const project = name ? name : slug.replace(/^-/, '');
  return project === '' ? null : project;
}

/** The distinct failure reasons, cut at the first colon, in the order they first appear. */
export function failureKinds(failed: HelmraiserReport['failed']): string[] {
  const kinds = failed.flatMap((run) => {
    const kind = run.failure_reason?.split(':', 1)[0]?.trim();
    return kind ? [kind] : [];
  });
  return [...new Set(kinds)];
}

/** Total spend over landed runs; `null` when nothing landed. */
export function costPerLanded(report: HelmraiserReport): number | null {
  return report.landed_count === 0 ? null : report.cost.total_usd / report.landed_count;
}
