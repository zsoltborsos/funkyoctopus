import { useEffect, useState } from 'react';
import type { HelmraiserReport, HelmraiserReportWindow, HelmraiserStats, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { useService } from '@core/container/useService.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { WORKFLOW } from './workflow.client.ts';
import { USAGE_WINDOWS, clock, costPerLanded, failureKinds, firstPass, projectOfTask, resetsIn, splitModel, usd } from './report-figures.ts';
import { CostAndTime, FailureClasses, Quality, ScoutFunnel, Trends } from './FlywheelSections.tsx';
import { RunLog } from './RunLog.tsx';
import { Tile } from './Tile.tsx';
import { UsageBar } from './UsageBar.tsx';

const WINDOWS: HelmraiserReportWindow[] = ['24h', '7d', '30d'];

/**
 * The Helmraiser tab's dashboard: how the chosen window went, from
 * `helmraiser report`. A big window can take minutes, so the previous numbers
 * stay on screen under a loading label until the new ones arrive.
 */
export function HelmraiserDashboard({ status }: { status: HelmraiserStatus | null }) {
  const workflow = useService(WORKFLOW);
  const [since, setSince] = useState<HelmraiserReportWindow>('7d');
  // Counts presses of ↻, so the same window can be asked for again.
  const [refreshes, setRefreshes] = useState(0);
  const [report, setReport] = useState<HelmraiserReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The window's stats and the whole ledger's (for the weekly trends), each with
  // the failure of its last read; a failure leaves the last good answer on screen.
  const [stats, setStats] = useState<HelmraiserStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [trends, setTrends] = useState<HelmraiserStats | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  // The request each answer on screen (or its failure) answers; loading is any other one.
  const [settled, setSettled] = useState<string | null>(null);
  const [statsSettled, setStatsSettled] = useState<string | null>(null);
  const [trendsSettled, setTrendsSettled] = useState<number | null>(null);
  const request = `${since}#${refreshes}`;
  const loading = settled !== request || statsSettled !== request || trendsSettled !== refreshes;
  // Reset times read to the minute, so a minute's tick keeps them current.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await workflow.report(since);
        if (!live) return;
        setReport(next);
        setError(null);
      } catch (failure) {
        if (!live) return;
        setError(humaneError(failure, 'the report could not be read').message);
      }
      setSettled(request);
    })();
    return () => {
      live = false;
    };
  }, [workflow, since, request]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await workflow.stats(since);
        if (!live) return;
        setStats(next);
        setStatsError(null);
      } catch (failure) {
        if (!live) return;
        setStatsError(humaneError(failure, 'the stats could not be read').message);
      }
      setStatsSettled(request);
    })();
    return () => {
      live = false;
    };
  }, [workflow, since, request]);

  // Only ↻ asks again: a window has no weekly series of its own to wait for.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await workflow.stats('all');
        if (!live) return;
        setTrends(next);
        setTrendsError(null);
      } catch (failure) {
        if (!live) return;
        setTrendsError(humaneError(failure, 'the stats could not be read').message);
      }
      setTrendsSettled(refreshes);
    })();
    return () => {
      live = false;
    };
  }, [workflow, refreshes]);

  return (
    <div className="flex flex-col gap-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Report window" className="flex overflow-hidden rounded border border-border">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={since === option}
              onClick={() => setSince(option)}
              className={`px-2 py-1 ${since === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'}`}
            >
              {option}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Refresh report"
          disabled={loading}
          onClick={() => setRefreshes((count) => count + 1)}
          className="rounded border border-border px-2 py-1 text-muted hover:text-text disabled:opacity-40"
        >
          ↻
        </button>
        <span className="text-muted">{loading ? 'loading…' : report && `report ${clock(report.generated_at)}`}</span>
      </div>
      {error !== null && <p role="alert" className="text-danger">⚠ {error}</p>}
      {report && <Health report={report} status={status} now={now} />}
      {statsError !== null && <p className="text-muted wrap-anywhere">{`stats unavailable — ${statsError}`}</p>}
      {stats && <Quality stats={stats} />}
      {trendsError !== null && <p className="text-muted wrap-anywhere">{`stats unavailable — ${trendsError}`}</p>}
      {trends && <Trends stats={trends} />}
      {stats && <CostAndTime stats={stats} />}
      {stats && <FailureClasses stats={stats} />}
      {stats && <ScoutFunnel stats={stats} />}
      {report && report.models.length === 0 && report.failed.length === 0 && (
        <p className="text-muted">No runs in this window</p>
      )}
      {report && report.models.length > 0 && <Models models={report.models} />}
      {report && report.failed.length > 0 && (
        <FailedRuns
          failed={report.failed}
          projects={[stats, trends].flatMap((figures) => figures?.runs.by_project.map(({ project }) => project) ?? [])}
        />
      )}
    </div>
  );
}

function Health({ report, status, now }: { report: HelmraiserReport; status: HelmraiserStatus | null; now: number }) {
  const pass = firstPass(report.models);
  const runs = report.models.reduce((sum, row) => sum + row.runs, 0);
  const rounds = report.models.reduce((sum, row) => sum + row.review_rounds, 0);
  const perLanded = costPerLanded(report);
  const kinds = failureKinds(report.failed);
  const windows = Object.entries(status?.usage ?? {}).flatMap(([provider, byWindow]) =>
    USAGE_WINDOWS.flatMap((name) => {
      const usage = byWindow[name];
      return usage ? [{ key: `${provider} ${name}`, usage }] : [];
    }));
  return (
    <section aria-label="Health" className="flex flex-col gap-2">
      <h3 className="text-muted">HEALTH · LAST {report.since.toUpperCase()}</h3>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
        <Tile label="landed"><span className="text-ok">{report.landed_count}</span></Tile>
        <Tile label="failed" sub={kinds.length > 0 ? kinds.join(', ') : undefined}>
          <span className={report.failed.length > 0 ? 'text-danger' : undefined}>{report.failed.length}</span>
        </Tile>
        <Tile label="first pass" sub={pass ? `${pass.passed} of ${pass.runs} runs` : 'no runs'} caption="first iteration passed verify">
          {pass ? `${pass.percent}%` : '—'}
        </Tile>
        <Tile label="review rounds" sub={`on ${runs} runs`}>{rounds}</Tile>
        <Tile label="spend" sub={perLanded === null ? 'no landed runs' : `${usd(perLanded)} per landed run`}>
          {usd(report.cost.total_usd)}
        </Tile>
        <div className="col-span-full rounded border border-border p-3">
          <dt className="flex flex-wrap items-center gap-x-3 text-muted">
            subscription use
            <span aria-hidden="true" className="flex items-center gap-1"><span className="inline-block h-2 w-px bg-attention" />warn</span>
            <span aria-hidden="true" className="flex items-center gap-1"><span className="inline-block h-2 w-px bg-danger" />stop</span>
          </dt>
          <dd className="mt-1">
            {windows.length === 0 ? <span className="text-muted">no usage data</span> : (
              <ul className="flex flex-col gap-1">
                {windows.map(({ key, usage }) => (
                  <li key={key} className="flex flex-wrap items-center gap-x-3">
                    <UsageBar label={key} usage={usage} labelClassName="w-36 shrink-0" />
                    <span className="text-muted">{resetsIn(usage.resets_at, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Runs under this are too few for a model's averages to say much, so the row recedes. */
const FEW_RUNS = 5;
// Cost per landed run sits by landed, so a narrow panel still shows it before the table scrolls.
const MODEL_COLUMNS = ['model', 'runs', 'landed', '$ / landed', 'first pass', 'failed', 'review rounds', 'avg iter', 'avg min'];

function Models({ models }: { models: HelmraiserReport['models'] }) {
  return (
    <section aria-label="Models" className="flex flex-col gap-2">
      <h3 className="text-muted">MODELS · implementer</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-right">
          <thead>
            <tr className="text-muted">
              {MODEL_COLUMNS.map((column, index) => (
                <th key={column} scope="col" className={`px-2 py-1 font-normal whitespace-nowrap ${index === 0 ? 'text-left' : ''}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((row) => {
              const dim = row.runs < FEW_RUNS;
              const { provider, name } = splitModel(row.model);
              return (
                <tr key={row.model} className={`border-t border-border ${dim ? 'text-muted' : ''}`}>
                  <td className="px-2 py-1 text-left whitespace-nowrap">
                    {name}
                    {provider !== null && <span className="ml-2 text-muted">{provider}</span>}
                  </td>
                  <td className="px-2 py-1">{row.runs}</td>
                  <td className={`px-2 py-1 ${dim ? '' : 'text-ok'}`}>{row.landed}</td>
                  <td className="px-2 py-1">{row.cost_per_landed === null ? '—' : usd(row.cost_per_landed)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {row.first_pass} · {Math.round((row.first_pass / row.runs) * 100)}%
                  </td>
                  <td className={`px-2 py-1 ${!dim && row.failed > 0 ? 'text-danger' : ''}`}>{row.failed}</td>
                  <td className="px-2 py-1">{row.review_rounds}</td>
                  <td className="px-2 py-1">{row.avg_iterations.toFixed(1)}</td>
                  <td className="px-2 py-1">{row.avg_minutes.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** `projects` are the project paths Helmraiser's stats list: the only way to turn a task id's slug back into a name. */
function FailedRuns({ failed, projects }: { failed: HelmraiserReport['failed']; projects: readonly string[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted">FAILED RUNS ({failed.length})</h3>
      <ul aria-label="Failed runs" className="flex flex-col gap-2">
        {failed.map((run) => {
          const project = projectOfTask(run.task_id, projects);
          return (
            <li key={run.run_id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-danger">{run.failure_reason ?? 'no reason recorded'}</span>
                {project !== null && <span className="text-muted">{project}</span>}
                <strong className="text-text">{run.title}</strong>
                <span className="text-muted">{run.run_id.slice(0, 8)}</span>
              </div>
              <RunLog runId={run.run_id} follow={false} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
