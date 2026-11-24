import { useEffect, useState } from 'react';
import { useNow } from '@core/clock/useNow.ts';
import { useService } from '@core/container/useService.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import type {
  HelmraiserScoutLens,
  HelmraiserScouts,
  HelmraiserStats,
  HelmraiserStatsScoutRow,
  HelmraiserStatus,
} from '@shared/transport/protocol.ts';
import { WORKFLOW } from './workflow.client.ts';

const projectName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

/** Focus projects of the stats, in the order status lists them; any it does not list go last, by name. */
function focusProjects(stats: HelmraiserStats, focusOrder: string[]): string[] {
  const place = (project: string): number => {
    const index = focusOrder.indexOf(project);
    return index === -1 ? focusOrder.length : index;
  };
  const projects = [...new Set(stats.scouts.filter((row) => row.in_focus).map((row) => row.project))];
  return projects.sort((a, b) => place(a) - place(b) || projectName(a).localeCompare(projectName(b)) || a.localeCompare(b));
}

/** Lenses in order of first appearance, so a lens Helmraiser adds shows up without a code change. */
const lensesOf = (stats: HelmraiserStats): HelmraiserScoutLens[] => [...new Set(stats.scouts.map((row) => row.lens))];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, to one unit: `35m ago`, `14h ago`, `2d ago`. */
function ago(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

/**
 * What a lens does next: wait out its cooldown, or be eligible now. A manual
 * lens that is eligible is the usual case, so it says nothing (the legend
 * says "manual unless noted"); `null` means no line.
 */
function readiness(row: HelmraiserStatsScoutRow, now: number): string | null {
  const wait = row.next_eligible_at === null ? 0 : Date.parse(row.next_eligible_at) - now;
  if (wait > 0) {
    if (wait < HOUR) return `next in ${Math.ceil(wait / MINUTE)}m`;
    if (wait < DAY) return `next in ${Math.ceil(wait / HOUR)}h`;
    return `next in ${Math.ceil(wait / DAY)}d`;
  }
  return row.auto ? 'ready (auto)' : null;
}

/** Every draft the lens ever wrote, by where it stands now. `failed` here is drafts whose run failed, not failed scouts. */
const OUTCOMES = [
  ['landed', 'landed', 'text-ok'],
  ['queued', 'queued', 'text-info'],
  ['pending', 'pending', 'text-attention'],
  // Dropping a draft is an owner decision, not a fault: dim, not danger.
  ['dropped', 'dropped', 'text-muted'],
  ['failed_drafts', 'failed', 'text-danger'],
] as const;

function formatElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 'elapsed unavailable';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `elapsed ${seconds}s`;
  if (seconds < 3600) return `elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `elapsed ${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

const draftCount = (count: number): string => `${count} ${count === 1 ? 'draft' : 'drafts'}`;

function RestingCell({ row, now }: { row: HelmraiserStatsScoutRow; now: number }) {
  const endedAt = row.last_scout_ended_at;
  const error = row.last_scout_error || 'scout failed';
  const outcomes = OUTCOMES.filter(([field]) => row[field] > 0);
  const ready = readiness(row, now);
  return (
    <div className="flex flex-col gap-0.5">
      {endedAt === null && <span className="text-muted">never scouted</span>}
      {endedAt !== null && row.last_scout_ok === false && (
        <>
          <span className="text-text">{ago(endedAt, now)}</span>
          <span className="line-clamp-2 max-w-52 whitespace-normal text-danger wrap-anywhere" title={error}>{error}</span>
        </>
      )}
      {endedAt !== null && row.last_scout_ok !== false && (
        <span className="text-text">{`${ago(endedAt, now)} · ${draftCount(row.last_scout_drafts ?? 0)}`}</span>
      )}
      {ready !== null && <span className="text-muted">{ready}</span>}
      {outcomes.length > 0 && (
        <ul aria-label="Draft outcomes" className="flex flex-wrap gap-x-2">
          {outcomes.map(([field, label, color]) => <li key={field} className={color}>{`${row[field]} ${label}`}</li>)}
        </ul>
      )}
      {row.scheduling_error !== null && <span className="max-w-52 whitespace-normal text-[11px] text-danger wrap-anywhere">{row.scheduling_error}</span>}
    </div>
  );
}

const buttonClass = 'rounded border border-border px-2 py-0.5 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40';

type PendingScout = HelmraiserScouts['pending'][number];
type RunningScout = HelmraiserScouts['running'][number];

interface CellProps {
  project: string;
  lens: HelmraiserScoutLens;
  row: HelmraiserStatsScoutRow | undefined;
  pending: PendingScout | undefined;
  running: RunningScout | undefined;
  /** The refusal to show in this cell, if any. */
  error: string | undefined;
  now: number;
  paused: boolean;
  blocked: boolean;
  onRequest: ScoutGridProps['onRequest'];
  onCancel: ScoutGridProps['onCancel'];
}

/** A scout waiting or running shows over what the stats last said, for that cell only. */
function Cell({ project, lens, row, pending, running, error, now, paused, blocked, onRequest, onCancel }: CellProps) {
  if (pending) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="text-attention">{pending.wait_reason ? `waiting: ${pending.wait_reason}` : 'waiting'}</span>
        <button type="button" className={buttonClass} aria-label={`Cancel ${lens} scout for ${project}`} disabled={blocked}
          onClick={() => onCancel(project, lens)}>Cancel</button>
        {error !== undefined && <p role="alert" className="max-w-52 whitespace-normal text-danger wrap-anywhere">{error}</p>}
      </div>
    );
  }
  if (running) {
    return <span className="text-info">{`running · ${formatElapsed(running.started_at, now)}`}</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {row ? <RestingCell row={row} now={now} /> : <span className="text-muted">—</span>}
      <button type="button" className={buttonClass} aria-label={`Scout ${lens} for ${project}`} disabled={blocked || paused}
        {...(paused ? { title: 'project paused' } : {})} onClick={() => onRequest(project, lens)}>Scout</button>
      {error !== undefined && <p role="alert" className="max-w-52 whitespace-normal text-danger wrap-anywhere">{error}</p>}
    </div>
  );
}

/**
 * What the stats can have changed on: which scouts are asked for or running, the
 * newest finished scout, and runs that landed or failed (draft outcomes follow
 * them). Anything else in a status poll leaves the stats as they are.
 */
function statsKey(scouts: HelmraiserScouts, queue: HelmraiserStatus['queue']): string {
  return JSON.stringify([
    scouts.pending.map((pending) => JSON.stringify([pending.project, pending.lens ?? 'state'])).sort(),
    scouts.running.map((running) => running.scout_id).sort(),
    scouts.recent[0]?.scout_id ?? null,
    queue.landed,
    queue.failed,
  ]);
}

/** A refusal of one cell's own action, shown in that cell: a refused Scout in an idle cell, a refused Cancel in a pending one. */
export interface ScoutCellError {
  project: string;
  lens: HelmraiserScoutLens;
  action: 'request' | 'cancel';
  message: string;
}

export interface ScoutGridProps {
  scouts: HelmraiserScouts;
  queue: HelmraiserStatus['queue'];
  /** Any request or cancel in flight, or the whole panel disabled. */
  blocked: boolean;
  errors: ScoutCellError[];
  onRequest: (project: string, lens: HelmraiserScoutLens) => void;
  onCancel: (project: string, lens: HelmraiserScoutLens) => void;
}

/**
 * Project x lens grid of the scouts: what each lens last did and what is waiting
 * to be decided, from `helmraiser stats`, with the live pending and running
 * scouts from status laid over their cells.
 */
export function ScoutGrid({ scouts, queue, blocked, errors, onRequest, onCancel }: ScoutGridProps) {
  const workflow = useService(WORKFLOW);
  const [stats, setStats] = useState<HelmraiserStats | null>(null);
  // The last read failed; the stats on screen, if any, are the last good ones.
  const [error, setError] = useState<string | null>(null);
  // Elapsed time ticks each second, but only while a scout runs; ages and countdowns read to the minute.
  const now = useNow(scouts.running.length > 0 ? 1_000 : 60_000);

  const key = statsKey(scouts, queue);
  useEffect(() => {
    let live = true;
    void workflow.stats('all').then(
      (next) => {
        if (!live) return;
        setStats(next);
        setError(null);
      },
      (failure: unknown) => { if (live) setError(humaneError(failure, 'the stats could not be read').message); },
    );
    return () => { live = false; };
  }, [workflow, key]);

  const cellKey = (project: string, lens: HelmraiserScoutLens): string => JSON.stringify([project, lens]);
  const projects = stats ? focusProjects(stats, scouts.focus_projects) : [];
  const lenses = stats ? lensesOf(stats) : [];
  const rows = new Map(stats?.scouts.map((row) => [cellKey(row.project, row.lens), row]));
  // Older status rows carry no lens: that means state.
  const waiting = new Map(scouts.pending.map((pending) => [cellKey(pending.project, pending.lens ?? 'state'), pending]));
  const running = new Map(scouts.running.flatMap((scout) => scout.project === undefined ? [] : [[cellKey(scout.project, scout.lens ?? 'state'), scout] as const]));
  /** A cancel refusal belongs to a waiting scout, a request refusal to a cell with nothing waiting or running. */
  const refusalFor = (project: string, lens: HelmraiserScoutLens): string | undefined => errors.find((refusal) =>
    refusal.project === project && refusal.lens === lens && (refusal.action === 'cancel'
      ? waiting.has(cellKey(project, lens))
      : !waiting.has(cellKey(project, lens)) && !running.has(cellKey(project, lens))))?.message;
  return (
    <div className="flex flex-col gap-2">
      {error !== null && <p className="text-muted wrap-anywhere">{`scout stats unavailable — ${error}`}</p>}
      {stats && projects.length === 0 && <p className="text-muted">No focus projects available</p>}
      {projects.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="sticky left-0 z-10 bg-surface px-2 py-1 font-normal">project</th>
                {lenses.map((lens) => <th key={lens} scope="col" className="px-2 py-1 font-normal">{lens}</th>)}
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project} className="border-t border-border align-top">
                  <th scope="row" title={project} className="sticky left-0 z-10 bg-surface px-2 py-1 font-normal whitespace-nowrap">{projectName(project)}</th>
                  {lenses.map((lens) => (
                    <td key={lens} aria-label={`${lens} cell for ${project}`} className="px-2 py-1 whitespace-nowrap">
                      <Cell project={project} lens={lens} row={rows.get(cellKey(project, lens))}
                        pending={waiting.get(cellKey(project, lens))} running={running.get(cellKey(project, lens))}
                        error={refusalFor(project, lens)} now={now}
                        paused={scouts.paused_projects.includes(project)} blocked={blocked} onRequest={onRequest} onCancel={onCancel} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {projects.length > 0 && (
        <p className="text-xs text-muted">per lens: last scout · drafts it wrote; below: all-time drafts landed / queued / pending / dropped / failed. Scouting is manual unless a cell says ready (auto).</p>
      )}
    </div>
  );
}
