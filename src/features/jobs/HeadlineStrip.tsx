import { useEffect, useState, type ReactNode } from 'react';
import type { HelmraiserReport, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { useService } from '@core/container/useService.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { WORKFLOW } from './workflow.client.ts';
import { busiestWindow, clock, costPerLanded, firstPass, usd } from './report-figures.ts';
import { UsageBar } from './UsageBar.tsx';

/**
 * The queue view's headline: the last 24 hours at a glance, from
 * `helmraiser report`, with a way into the dashboard. It never blocks the queue
 * beneath it: the report can take minutes, so it reads as dim text until it lands.
 */
export function HeadlineStrip({ status, onOpenDashboard }: {
  status: HelmraiserStatus | null;
  onOpenDashboard: () => void;
}) {
  const workflow = useService(WORKFLOW);
  // The last good report stays on screen through a later failure.
  const [report, setReport] = useState<HelmraiserReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only these two counts say a run finished; the status polls every few
  // seconds and the report can take minutes, so nothing else asks again.
  const landed = status?.queue.landed;
  const failed = status?.queue.failed;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await workflow.report('24h');
        if (!live) return;
        setReport(next);
        setError(null);
      } catch (failure) {
        if (live) setError(humaneError(failure, 'the report could not be read').message);
      }
    })();
    return () => {
      live = false;
    };
  }, [workflow, landed, failed]);

  const pass = report && firstPass(report.models);
  const perLanded = report && costPerLanded(report);

  return (
    <section aria-label="Last 24 hours" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 font-mono text-xs">
      <span className="text-muted">LAST 24H{report && ` · ${clock(report.generated_at)}`}</span>
      {report === null && error === null && <span className="text-muted">loading report…</span>}
      {error !== null && <span className="text-muted">report failed — {error}</span>}
      {report && (
        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Figure label="landed"><span className="text-ok">{report.landed_count}</span></Figure>
          <Figure label="failed">
            <span className={report.failed.length > 0 ? 'text-danger' : undefined}>{report.failed.length}</span>
          </Figure>
          <Figure label="awaiting you">{report.awaiting_count}</Figure>
          <Figure label="first pass">{pass ? `${pass.passed}/${pass.runs} · ${pass.percent}%` : '—'}</Figure>
          <Figure label="cost / landed run">
            {perLanded === null ? '—' : <>{usd(perLanded)} <span className="text-muted">{usd(report.cost.total_usd)} total</span></>}
          </Figure>
        </dl>
      )}
      {status && Object.entries(status.usage).map(([provider, windows]) => {
        const busiest = busiestWindow(windows);
        return busiest && <UsageBar key={provider} label={`${provider} ${busiest.name}`} usage={busiest.usage} />;
      })}
      <button type="button" onClick={onOpenDashboard} className="ml-auto rounded border border-border px-2 py-1 text-muted hover:text-text">
        dashboard →
      </button>
    </section>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
