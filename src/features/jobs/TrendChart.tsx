import type { ReactNode } from 'react';
import type { HelmraiserStats } from '@shared/transport/protocol.ts';
import { percent, weekLabel } from './stats-figures.ts';

type Week = HelmraiserStats['weekly'][number];

// The plot, in SVG units: a bar chart's bars stand on BASELINE, a line chart's
// 0% and 100% sit a little inside the edges so the stroke is not clipped.
const WIDTH = 220;
const HEIGHT = 56;
const BASELINE = 55;
const BAR_MAX = 54;
const LINE_TOP = 2;
const LINE_BOTTOM = 54;

/** An SVG coordinate to two decimals, so a sum of floats prints as the number it means. */
const num = (value: number): number => +value.toFixed(2);

interface Series { name: string; values: number[]; className: string }

/** One slot per week, a bar (or a pair) in it, every bar on one scale from zero. */
function Bars({ series }: { series: Series[] }) {
  const weeks = series[0]?.values.length ?? 0;
  const max = Math.max(1, ...series.flatMap((one) => one.values));
  const slot = WIDTH / weeks;
  const group = Math.min(slot * 0.8, 12 * series.length);
  const bar = group / series.length;
  return series.map((one, index) => one.values.map((value, week) => {
    const height = (value / max) * BAR_MAX;
    return (
      <rect
        key={`${one.name}${week}`}
        data-series={one.name}
        x={num(week * slot + (slot - group) / 2 + index * bar)}
        y={num(BASELINE - height)}
        width={num(bar)}
        height={num(height)}
        className={one.className}
      />
    );
  }));
}

interface Point { x: number; y: number }

/**
 * Rates from 0 to 1 as a line. A week with no rate breaks it: runs of weeks
 * with one are strokes, and a run of one week (nothing to join) is a dot.
 */
function Line({ rates }: { rates: Array<number | null> }) {
  const slot = WIDTH / rates.length;
  const runs: Point[][] = [];
  let run: Point[] = [];
  rates.forEach((rate, week) => {
    if (rate === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    const clamped = Math.min(Math.max(rate, 0), 1);
    run.push({ x: num(week * slot + slot / 2), y: num(LINE_BOTTOM - clamped * (LINE_BOTTOM - LINE_TOP)) });
  });
  if (run.length > 0) runs.push(run);
  const strokes = runs.filter((points) => points.length > 1);
  const dots = runs.filter((points) => points.length === 1);
  return (
    <>
      {strokes.length > 0 && (
        <path
          d={strokes.map(([first, ...rest]) => `M${first!.x} ${first!.y} ${rest.map((point) => `L${point.x} ${point.y}`).join(' ')}`).join(' ')}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          className="stroke-info"
        />
      )}
      {dots.map(([point]) => <circle key={point!.x} cx={point!.x} cy={point!.y} r={1.5} className="fill-info" />)}
    </>
  );
}

/** One small multiple: title, the latest week's figure big, the plot (no axes), the weeks it spans. */
function Frame({ title, latest, weeks, label, legend, children }: {
  title: string;
  latest: ReactNode;
  weeks: Week[];
  /** What the plot says, week by week, for a reader who cannot see it. */
  label: string;
  legend?: ReactNode;
  children: ReactNode;
}) {
  const first = weekLabel(weeks[0]!.week);
  const last = weekLabel(weeks.at(-1)!.week);
  return (
    <div className="rounded border border-border p-3">
      <h4 className="text-muted">{title}</h4>
      {/* The headline is the newest week, not the window: say so, as there is no axis to read. */}
      <p className="mt-1"><span className="text-xl">{latest}</span> <span className="text-muted">{last}</span></p>
      <svg role="img" aria-label={`${title}: ${label}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-2 block h-auto w-full max-w-[220px]">
        <line x1={0} x2={WIDTH} y1={BASELINE + 0.5} y2={BASELINE + 0.5} strokeWidth={1} className="stroke-faint" />
        {children}
      </svg>
      {legend}
      {/* One week is already named by the headline. */}
      {first !== last && <p className="mt-1 text-[11px] text-muted">{`${first} – ${last}`}</p>}
    </div>
  );
}

/** Weekly figures from `stats.weekly` (oldest first) as four small multiples, in a grid that wraps to the panel. */
export function TrendCharts({ weekly }: { weekly: Week[] }) {
  const latest = weekly.at(-1)!;
  const list = (value: (week: Week) => string) => weekly.map((week) => `${weekLabel(week.week)} ${value(week)}`).join(', ');
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2">
      <Frame title="landed per week" latest={latest.landed} weeks={weekly} label={list((week) => String(week.landed))}>
        <Bars series={[{ name: 'landed', values: weekly.map((week) => week.landed), className: 'fill-ok' }]} />
      </Frame>
      <Frame title="failed per week" latest={latest.failed} weeks={weekly} label={list((week) => String(week.failed))}>
        <Bars series={[{ name: 'failed', values: weekly.map((week) => week.failed), className: 'fill-danger' }]} />
      </Frame>
      <Frame
        title="first-time-right rate per week"
        latest={percent(latest.first_time_right_rate)}
        weeks={weekly}
        label={list((week) => (week.first_time_right_rate === null ? 'no data' : percent(week.first_time_right_rate)))}
      >
        <Line rates={weekly.map((week) => week.first_time_right_rate)} />
      </Frame>
      <Frame
        title="drafts written vs landed per week"
        latest={`${latest.drafts_written} / ${latest.drafts_landed}`}
        weeks={weekly}
        label={list((week) => `written ${week.drafts_written} landed ${week.drafts_landed}`)}
        legend={(
          <p className="mt-1 flex gap-x-3 text-[11px]">
            <span className="flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-muted" />written</span>
            <span className="flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-ok" />landed</span>
          </p>
        )}
      >
        <Bars series={[
          { name: 'written', values: weekly.map((week) => week.drafts_written), className: 'fill-muted' },
          { name: 'landed', values: weekly.map((week) => week.drafts_landed), className: 'fill-ok' },
        ]} />
      </Frame>
    </div>
  );
}
