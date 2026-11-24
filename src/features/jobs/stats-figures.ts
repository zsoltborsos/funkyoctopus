import { HELMRAISER_DROP_CLASSES, type HelmraiserScoutLens, type HelmraiserStats, type HelmraiserStatsDroppedByClass, type HelmraiserStatsScoutRow } from '@shared/transport/protocol.ts';

/** A fraction as a whole percentage, `64%`; `—` when the CLI had nothing to divide by. */
export const percent = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/** `2026-W47` as `W47`: a trend spans at most 26 weeks, so the year is noise. */
export const weekLabel = (week: string): string => week.replace(/^\d{4}-/, '');

/** Minutes as `14.6 min`, or hours from an hour up (`1.2 h`); `—` for a figure with no samples. */
export function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  const tenths = Math.round(minutes * 10) / 10;
  return tenths < 60 ? `${tenths.toFixed(1)} min` : `${(minutes / 60).toFixed(1)} h`;
}

/**
 * Each value's whole-percent share of their sum, made to add up to 100: the
 * parts with the largest remainders take the points plain rounding loses or
 * adds. All zeros when there is nothing to share.
 */
export function wholeShares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const shares = exact.map(Math.floor);
  const byRemainder = exact.map((_, index) => index).sort((a, b) => exact[b]! - shares[b]! - (exact[a]! - shares[a]!) || a - b);
  let spare = 100 - shares.reduce((sum, share) => sum + share, 0);
  for (const index of byRemainder) {
    if (spare <= 0) break;
    shares[index]! += 1;
    spare -= 1;
  }
  return shares;
}

/** The failure classes, the commonest first, equal counts in name order. */
export function failureClasses(failures: HelmraiserStats['failures']): Array<{ name: string; count: number; runIds: string[] }> {
  return Object.entries(failures)
    .map(([name, { count, run_ids }]) => ({ name, count, runIds: run_ids }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const FUNNEL_FIELDS = [
  'scouts', 'succeeded', 'failed', 'running', 'drafts_written', 'pending', 'queued', 'landed', 'dropped', 'failed_drafts',
  'queued_unchanged', 'queued_changed', 'queued_unknown', 'cost_usd',
] as const;

/** The ways a drop is classed, in the order the CLI lists them; `unclassified` last. */
export const DROP_BUCKETS = [...HELMRAISER_DROP_CLASSES, 'unclassified'] as const;

/** The figures of a scout row that add up across projects. */
export type FunnelCounts = Pick<HelmraiserStatsScoutRow, (typeof FUNNEL_FIELDS)[number] | 'dropped_by_class'>;

const noDrops = (): HelmraiserStatsDroppedByClass => ({ wrong: 0, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 0 });

const noCounts = (): FunnelCounts => ({
  scouts: 0, succeeded: 0, failed: 0, running: 0, drafts_written: 0, pending: 0, queued: 0, landed: 0, dropped: 0, dropped_by_class: noDrops(),
  failed_drafts: 0, queued_unchanged: 0, queued_changed: 0, queued_unknown: 0, cost_usd: 0,
});

/** The scout rows added up over every project, per lens in order of first appearance, and over everything. */
export function scoutFunnel(rows: HelmraiserStatsScoutRow[]): { lenses: Array<{ lens: HelmraiserScoutLens; counts: FunnelCounts }>; total: FunnelCounts } {
  const byLens = new Map<HelmraiserScoutLens, FunnelCounts>();
  const total = noCounts();
  for (const row of rows) {
    const counts = byLens.get(row.lens) ?? noCounts();
    byLens.set(row.lens, counts);
    for (const field of FUNNEL_FIELDS) {
      counts[field] += row[field];
      total[field] += row[field];
    }
    for (const bucket of DROP_BUCKETS) {
      counts.dropped_by_class[bucket] += row.dropped_by_class[bucket];
      total.dropped_by_class[bucket] += row.dropped_by_class[bucket];
    }
  }
  return { lenses: [...byLens].map(([lens, counts]) => ({ lens, counts })), total };
}
