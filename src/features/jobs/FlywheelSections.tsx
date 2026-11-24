import type { HelmraiserStats } from '@shared/transport/protocol.ts';
import { usd } from './report-figures.ts';
import { DROP_BUCKETS, duration, failureClasses, percent, scoutFunnel, wholeShares, type FunnelCounts } from './stats-figures.ts';
import { Tile } from './Tile.tsx';
import { TrendCharts } from './TrendChart.tsx';

/** The review verdicts, in the order they read: best first. Each gets a colour and a name, so neither carries it alone. */
const VERDICTS = [
  ['pass', 'bg-ok'],
  ['concerns', 'bg-attention'],
  ['uncertain', 'bg-info'],
  ['none', 'bg-muted'],
] as const;

/** A fraction as a CSS percentage, to a tenth of a percent. */
const pct = (fraction: number): string => `${+(fraction * 100).toFixed(1)}%`;

function Verdicts({ counts }: { counts: HelmraiserStats['quality']['review_verdicts'] }) {
  const total = VERDICTS.reduce((sum, [name]) => sum + counts[name], 0);
  const named = VERDICTS.map(([name]) => `${name} ${counts[name]}`);
  return (
    <div className="col-span-full rounded border border-border p-3">
      <dt className="text-muted">review verdicts</dt>
      <dd className="mt-1">
        {total === 0 ? <span className="text-muted">no reviews</span> : (
          <>
            <div role="img" aria-label={`review verdicts: ${named.join(', ')}`} className="flex h-2 overflow-hidden rounded-sm bg-border">
              {VERDICTS.filter(([name]) => counts[name] > 0).map(([name, color]) => (
                <span key={name} data-verdict={name} title={`${name} ${counts[name]}`} className={color} style={{ width: pct(counts[name] / total) }} />
              ))}
            </div>
            <ul aria-label="Review verdicts" className="mt-2 flex flex-wrap gap-x-4">
              {VERDICTS.map(([name, color]) => (
                <li key={name} className="flex items-center gap-1">
                  <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-sm ${color}`} />
                  {`${name} ${counts[name]}`}
                </li>
              ))}
            </ul>
          </>
        )}
      </dd>
      <dd className="mt-1 text-[11px] text-muted">review verdict per run; none = no verdict recorded</dd>
    </div>
  );
}

/** How the window's runs went: the CLI's quality rates, each defined under its figure. */
export function Quality({ stats }: { stats: HelmraiserStats }) {
  const { quality } = stats;
  return (
    <section aria-label="Quality" className="flex flex-col gap-2">
      <h3 className="text-muted">QUALITY · LAST {stats.window.since.toUpperCase()}</h3>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
        <Tile
          label="first-time-right"
          sub={`${quality.first_time_right.count} of ${stats.runs.overall.landed} landed`}
          caption="landed with one iteration, no rework, no scope request, no retry"
        >
          {percent(quality.first_time_right.rate)}
        </Tile>
        <Tile label="rework rate" caption="runs reworked at merge, of runs with a merge decision">
          {percent(quality.rework_rate)}
        </Tile>
        <Tile label="scope-request rate" caption="runs that asked for scope approval, of all runs">
          {percent(quality.scope_request_rate)}
        </Tile>
        <Tile label="retried tasks" caption="tasks with more than one run in the window">
          {quality.retried_tasks}
        </Tile>
        <Verdicts counts={quality.review_verdicts} />
      </dl>
    </section>
  );
}

/** The ledger's weeks, oldest first: how the flywheel has moved, which no short window can show. */
export function Trends({ stats }: { stats: HelmraiserStats }) {
  return (
    <section aria-label="Trends" className="flex flex-col gap-2">
      <h3 className="text-muted">TRENDS · weekly, all time</h3>
      {stats.weekly.length === 0 ? <p className="text-muted">no weekly data</p> : <TrendCharts weekly={stats.weekly} />}
    </section>
  );
}

/** What the window's spend went on. Other is review and whatever the ledger does not record apart, so it can be most of it. */
const COST_PARTS = [
  ['plan', 'bg-info'],
  ['implement', 'bg-special'],
  ['other', 'bg-muted'],
] as const;

function CostSplit({ cost }: { cost: HelmraiserStats['cost'] }) {
  const dollars = COST_PARTS.map(([name]) => cost[`${name}_usd`]);
  const shares = wholeShares(dollars);
  const sum = dollars.reduce((total, value) => total + value, 0);
  const parts = COST_PARTS.map(([name, color], index) => ({ name, color, dollars: dollars[index]!, share: shares[index]! }));
  return (
    <div className="rounded border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-muted">cost split</span>
        <span className="flex items-baseline gap-2"><span className="text-muted">total</span><span className="text-xl">{usd(cost.total_usd)}</span></span>
        <span className="text-muted">{cost.per_landed_usd === null ? 'no landed runs' : `${usd(cost.per_landed_usd)} per landed run`}</span>
      </div>
      {sum <= 0 ? <p className="mt-2 text-muted">no spend</p> : (
        <>
          <div
            role="img"
            aria-label={`cost split: ${parts.map((part) => `${part.name} ${usd(part.dollars)} ${part.share}%`).join(', ')}`}
            className="mt-2 flex h-2 overflow-hidden rounded-sm bg-border"
          >
            {parts.filter((part) => part.dollars > 0).map((part) => (
              <span key={part.name} data-part={part.name} className={part.color} style={{ width: `${+((part.dollars / sum) * 100).toFixed(1)}%` }} />
            ))}
          </div>
          <ul aria-label="Cost split" className="mt-2 flex flex-wrap gap-x-4">
            {parts.map((part) => (
              <li key={part.name} className="flex items-center gap-1">
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-sm ${part.color}`} />
                {`${part.name} ${usd(part.dollars)} · ${part.share}%`}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-[11px] text-muted">other = review and anything not recorded separately</p>
    </div>
  );
}

function Latency({ latency }: { latency: HelmraiserStats['latency'] }) {
  const rows = [
    ['active time per landed run', latency.active_minutes],
    ['plan approval wait', latency.approval_wait_minutes.plan],
    ['scope approval wait', latency.approval_wait_minutes.scope],
    ['merge approval wait', latency.approval_wait_minutes.merge],
  ] as const;
  return (
    <>
      <div className="max-w-xl overflow-x-auto rounded border border-border p-1">
        <table aria-label="Latency" className="w-full border-collapse text-right">
          <thead>
            <tr className="text-muted">
              {['latency', 'median', 'p90'].map((column, index) => (
                <th key={column} scope="col" className={`px-2 py-1 font-normal whitespace-nowrap ${index === 0 ? 'text-left' : ''}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, figures]) => (
              <tr key={label} className="border-t border-border">
                <th scope="row" className="px-2 py-1 text-left font-normal whitespace-nowrap">{label}</th>
                <td className="px-2 py-1 whitespace-nowrap">{duration(figures.median)}</td>
                <td className="px-2 py-1 whitespace-nowrap">{duration(figures.p90)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted">active = working time summed per landed run, not wall-clock; wait = time parked for that approval</p>
    </>
  );
}

/** Where the money and the time went in the window. */
export function CostAndTime({ stats }: { stats: HelmraiserStats }) {
  return (
    <section aria-label="Cost and time" className="flex flex-col gap-2">
      <h3 className="text-muted">COST & TIME · LAST {stats.window.since.toUpperCase()}</h3>
      <CostSplit cost={stats.cost} />
      <Latency latency={stats.latency} />
    </section>
  );
}

/** Failed and aborted runs by class, with the newest run ids of each to look up. */
export function FailureClasses({ stats }: { stats: HelmraiserStats }) {
  const classes = failureClasses(stats.failures);
  return (
    <section aria-label="Failures by class" className="flex flex-col gap-2">
      <h3 className="text-muted">FAILURES BY CLASS · LAST {stats.window.since.toUpperCase()}</h3>
      {classes.length === 0 ? <p className="text-muted">no failures</p> : (
        <ul aria-label="Failure classes" className="flex flex-col gap-1">
          {classes.map(({ name, count, runIds }) => (
            <li key={name} className="flex flex-wrap items-center gap-x-3">
              <span>{name}</span>
              <span className="text-danger">{count}</span>
              {runIds.map((id) => <span key={id} className="text-muted">{id.slice(0, 8)}</span>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Drafts read left to right as they move: written, then not yet queued, queued, and how they ended.
const FUNNEL_COLUMNS: Array<{ header: string; text: (counts: FunnelCounts) => string; tone?: (counts: FunnelCounts) => string }> = [
  // Scouts still running are neither ok nor failed: named only while there are some.
  { header: 'scouts (ok/failed)', text: (c) => `${c.scouts} (${c.succeeded}/${c.failed}${c.running > 0 ? `, ${c.running} running` : ''})` },
  { header: 'drafts written', text: (c) => String(c.drafts_written) },
  { header: 'pending', text: (c) => String(c.pending) },
  { header: 'queued', text: (c) => String(c.queued) },
  // Ok means something landed; a zero stays plain.
  { header: 'landed', text: (c) => String(c.landed), tone: (c) => (c.landed > 0 ? 'text-ok' : '') },
  // Dropping a draft is an owner decision, not a fault: dim, not danger.
  { header: 'dropped', text: (c) => String(c.dropped), tone: () => 'text-muted' },
  { header: 'failed drafts', text: (c) => String(c.failed_drafts), tone: (c) => (c.failed_drafts > 0 ? 'text-danger' : '') },
  // One column, so the table fits a normal panel: unchanged / changed / unknown.
  { header: 'as written', text: (c) => `${c.queued_unchanged} / ${c.queued_changed} / ${c.queued_unknown}` },
  { header: 'cost', text: (c) => usd(c.cost_usd) },
];

function FunnelRow({ label, counts, dim = false, bold = false }: { label: string; counts: FunnelCounts; dim?: boolean; bold?: boolean }) {
  return (
    <tr className={`border-t border-border ${dim ? 'text-muted' : ''} ${bold ? 'font-semibold' : ''}`}>
      <th scope="row" className="px-2 py-1 text-left font-normal whitespace-nowrap">{label}</th>
      {FUNNEL_COLUMNS.map(({ header, text, tone }) => (
        // A dim row stays dim all through, as in the models table.
        <td key={header} className={`px-2 py-1 whitespace-nowrap ${dim ? '' : (tone?.(counts) ?? '')}`}>{text(counts)}</td>
      ))}
    </tr>
  );
}

/** What the window's scouts led to, by lens: drafts written, where they stand, and whether the owner changed them. */
export function ScoutFunnel({ stats }: { stats: HelmraiserStats }) {
  const { lenses, total } = scoutFunnel(stats.scouts);
  // Only the classes that have drops, in the CLI's order.
  const drops = DROP_BUCKETS.filter((bucket) => total.dropped_by_class[bucket] > 0).map((bucket) => `${bucket} ${total.dropped_by_class[bucket]}`);
  return (
    <section aria-label="Scout funnel" className="flex flex-col gap-2">
      <h3 className="text-muted">SCOUT FUNNEL · by lens · LAST {stats.window.since.toUpperCase()}</h3>
      {lenses.length === 0 ? <p className="text-muted">no scout data</p> : (
        <div className="overflow-x-auto">
          <table aria-label="Scout funnel by lens" className="w-full border-collapse text-right">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="px-2 py-1 text-left font-normal whitespace-nowrap">lens</th>
                {FUNNEL_COLUMNS.map(({ header }) => <th key={header} scope="col" className="px-2 py-1 font-normal whitespace-nowrap">{header}</th>)}
              </tr>
            </thead>
            <tbody>
              {lenses.map(({ lens, counts }) => <FunnelRow key={lens} label={lens} counts={counts} dim={counts.scouts === 0} />)}
              <FunnelRow label="total" counts={total} bold />
            </tbody>
          </table>
        </div>
      )}
      {drops.length > 0 && <p className="text-xs text-muted">{`dropped by class: ${drops.join(' · ')}`}</p>}
      {lenses.length > 0 && <p className="text-[11px] text-muted">as written = queued drafts unchanged / changed / unknown, where unchanged is exactly as the scout wrote it and unknown is a draft from before fingerprints</p>}
    </section>
  );
}
