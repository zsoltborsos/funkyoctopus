import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import type {
  HelmraiserScoutLens,
  HelmraiserScouts,
  HelmraiserStats,
  HelmraiserStatsScoutRow,
  HelmraiserStatus,
} from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { WORKFLOW } from './workflow.client.ts';
import { ScoutGrid, type ScoutCellError } from './ScoutGrid.tsx';
import { makeHelmraiserStats, makeStatsScoutRow } from './__fixtures__/helmraiser-stats.ts';

const A = '/work/alpha';
const B = '/work/repo two';
const LENSES: HelmraiserScoutLens[] = ['state', 'docs', 'tests', 'guardrails'];
const QUEUE: HelmraiserStatus['queue'] = { failed: 0, landed: 0, queued: 0, running: 0, awaiting_approval: 0 };

/** Every real lens for a project, in the order Helmraiser reports them. */
const allLenses = (project: string, overrides: Partial<HelmraiserStatsScoutRow> = {}) =>
  LENSES.map((lens) => makeStatsScoutRow(project, lens, overrides));

function makeScouts(overrides: Partial<HelmraiserScouts> = {}): HelmraiserScouts {
  return { focus_projects: [A, B], paused_projects: [], pending: [], running: [], recent: [], ...overrides };
}

interface GridProps {
  scouts: HelmraiserScouts;
  queue: HelmraiserStatus['queue'];
  blocked: boolean;
  errors: ScoutCellError[];
}

function setup(options: {
  stats?: HelmraiserStats | ((...args: unknown[]) => Promise<HelmraiserStats>);
  scouts?: HelmraiserScouts;
  queue?: HelmraiserStatus['queue'];
  blocked?: boolean;
  errors?: ScoutCellError[];
} = {}) {
  const answer = options.stats ?? makeHelmraiserStats([...allLenses(A), ...allLenses(B)]);
  const stats = vi.fn(typeof answer === 'function' ? answer : () => Promise.resolve(answer));
  const onRequest = vi.fn();
  const onCancel = vi.fn();
  const container = new Container();
  container.registerInstance(WORKFLOW, { stats } as never);
  const view = (props: GridProps) => (
    <ContainerProvider container={container}>
      <ScoutGrid {...props} onRequest={onRequest} onCancel={onCancel} />
    </ContainerProvider>
  );
  const initial: GridProps = { scouts: options.scouts ?? makeScouts(), queue: options.queue ?? QUEUE, blocked: options.blocked ?? false, errors: options.errors ?? [] };
  const rendered = render(view(initial));
  return {
    stats, onRequest, onCancel,
    update: (next: Partial<GridProps>) => rendered.rerender(view({ ...initial, ...next })),
    unmount: rendered.unmount,
  };
}

/** Ages and countdowns are relative to this instant; every timestamp below is a literal against it. */
const NOW = new Date('2026-11-22T18:00:00Z');
const freezeClock = () => {
  // Only the clock and intervals: promises and testing-library's waiting keep running for real.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
};

/** The cell for one project and lens, found by its accessible name. */
const cell = (project: string, lens: string) => screen.getByRole('cell', { name: `${lens} cell for ${project}` });
const rowNames = () => screen.getAllByRole('rowheader').map((header) => header.textContent);
const columnNames = () => screen.getAllByRole('columnheader').slice(1).map((header) => header.textContent);

afterEach(() => vi.useRealTimers());

describe('ScoutGrid rows and columns', () => {
  it('reads the whole ledger on mount, shows only focus projects in focus order, and takes its lenses from the data', async () => {
    const zulu = '/a/zulu';
    const alpine = '/z/alpine';
    const otherProject = '/work/other-project';
    const { stats } = setup({
      scouts: makeScouts({ focus_projects: [B, A] }),
      stats: makeHelmraiserStats([
        ...allLenses(otherProject, { in_focus: false }),
        ...allLenses(A), ...allLenses(zulu), ...allLenses(alpine), ...allLenses(B),
      ]),
    });
    await screen.findByRole('table');
    expect(stats).toHaveBeenCalledExactlyOnceWith('all');
    // Focus order first; focus projects missing from the list last, by name (not by path); non-focus never.
    expect(rowNames()).toEqual(['repo two', 'alpha', 'alpine', 'zulu']);
    expect(screen.getByRole('rowheader', { name: 'repo two' })).toHaveAttribute('title', B);
    expect(screen.getByRole('rowheader', { name: 'alpine' })).toHaveAttribute('title', alpine);
    expect(columnNames()).toEqual(['state', 'docs', 'tests', 'guardrails']);
    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto');
    expect(cell(A, 'guardrails')).toBeInTheDocument();
  });

  it('explains what a cell shows in one dim line under the table, and only with a table', async () => {
    const { unmount } = setup();
    const table = await screen.findByRole('table');
    const legend = screen.getByText('per lens: last scout · drafts it wrote; below: all-time drafts landed / queued / pending / dropped / failed. Scouting is manual unless a cell says ready (auto).');
    expect(legend).toHaveClass('text-muted');
    expect(table.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    setup({ stats: makeHelmraiserStats() });
    await screen.findByText('No focus projects available');
    expect(screen.queryByText(/per lens: last scout/)).not.toBeInTheDocument();
  });

  it('takes the column order from the first appearance of each lens in the data', async () => {
    setup({ stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'guardrails'), makeStatsScoutRow(A, 'state'),
      makeStatsScoutRow(B, 'docs'), makeStatsScoutRow(B, 'guardrails'),
    ]) });
    await screen.findByRole('table');
    expect(columnNames()).toEqual(['guardrails', 'state', 'docs']);
  });
});

describe('ScoutGrid cells at rest', () => {
  it('shows a failed scout\'s age and its error in danger, cut to fit with the whole text in the title, as plain text', async () => {
    freezeClock();
    const error = 'candidate verify_hints must contain non-empty strings';
    const failed = { last_scout_ok: false, last_scout_drafts: 0 } as const;
    setup({ stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'guardrails', { ...failed, last_scout_ended_at: '2026-11-22T16:45:50Z', last_scout_error: error }),
      makeStatsScoutRow(A, 'state', { ...failed, last_scout_ended_at: '2026-11-22T17:30:00Z', last_scout_error: '<b>scout crashed</b>' }),
      makeStatsScoutRow(A, 'docs', { ...failed, last_scout_ended_at: '2026-11-21T18:00:00Z', last_scout_error: null }),
    ]) });
    await screen.findByRole('table');
    const guardrails = within(cell(A, 'guardrails'));
    expect(guardrails.getByText('1h ago')).toBeInTheDocument();
    const shown = guardrails.getByText(error);
    // It wraps to two lines, not one truncated line; the title keeps the whole text.
    expect(shown).toHaveClass('text-danger', 'line-clamp-2', 'whitespace-normal');
    expect(shown).toHaveAttribute('title', error);
    expect(guardrails.queryByText(/drafts?$/)).not.toBeInTheDocument();
    // The error is text, never markup.
    const state = within(cell(A, 'state'));
    expect(state.getByText('30m ago')).toBeInTheDocument();
    expect(state.getByText('<b>scout crashed</b>')).toHaveClass('text-danger');
    expect(cell(A, 'state').querySelector('b')).toBeNull();
    // A failure with no message still says so.
    const docs = within(cell(A, 'docs'));
    expect(docs.getByText('1d ago')).toBeInTheDocument();
    expect(docs.getByText('scout failed')).toHaveClass('text-danger');
  });

  it('shows the last scout\'s age and drafts, then when the lens is next eligible', async () => {
    freezeClock();
    const ok = { last_scout_ok: true } as const;
    setup({ stats: makeHelmraiserStats([
      // 35 minutes ago; cooldown over at 23:00, five hours from now.
      makeStatsScoutRow(A, 'state', { ...ok, last_scout_ended_at: '2026-11-22T17:25:00Z', last_scout_drafts: 2, next_eligible_at: '2026-11-22T23:00:00Z' }),
      // 14 hours ago; eligibility date long past, and the lens runs by itself.
      makeStatsScoutRow(A, 'docs', { ...ok, auto: true, last_scout_ended_at: '2026-11-22T04:00:00Z', last_scout_drafts: 1, next_eligible_at: '2026-11-22T04:00:00Z' }),
      // 2 days ago, no drafts; 25 minutes of cooldown left.
      makeStatsScoutRow(A, 'tests', { ...ok, last_scout_ended_at: '2026-11-20T18:00:00Z', last_scout_drafts: 0, next_eligible_at: '2026-11-22T18:25:00Z' }),
      // Twenty seconds ago, three drafts, a cooldown date already past.
      makeStatsScoutRow(A, 'guardrails', { ...ok, last_scout_ended_at: '2026-11-22T17:59:40Z', last_scout_drafts: 3, next_eligible_at: '2026-11-22T17:59:40Z' }),
    ]) });
    await screen.findByRole('table');
    const state = within(cell(A, 'state'));
    expect(state.getByText('35m ago · 2 drafts')).toHaveClass('text-text');
    expect(state.getByText('next in 5h')).toHaveClass('text-muted');
    expect(state.queryByText(/ready/)).not.toBeInTheDocument();
    expect(state.queryByText('never scouted')).not.toBeInTheDocument();
    const docs = within(cell(A, 'docs'));
    expect(docs.getByText('14h ago · 1 draft')).toBeInTheDocument();
    expect(docs.getByText('ready (auto)')).toBeInTheDocument();
    const tests = within(cell(A, 'tests'));
    expect(tests.getByText('2d ago · 0 drafts')).toBeInTheDocument();
    expect(tests.getByText('next in 25m')).toBeInTheDocument();
    const guardrails = within(cell(A, 'guardrails'));
    expect(guardrails.getByText('just now · 3 drafts')).toBeInTheDocument();
    // A manual lens that is eligible is the usual case: no readiness line.
    expect(guardrails.queryByText(/ready/)).not.toBeInTheDocument();
  });

  it('says never scouted, and whether a scout would start by itself, for a lens with no scout yet', async () => {
    freezeClock();
    setup({ stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'state'),
      makeStatsScoutRow(A, 'docs', { auto: true }),
    ]) });
    await screen.findByRole('table');
    const manual = within(cell(A, 'state'));
    expect(manual.getByText('never scouted')).toHaveClass('text-muted');
    expect(manual.queryByText(/ready/)).not.toBeInTheDocument();
    const automatic = within(cell(A, 'docs'));
    expect(automatic.getByText('never scouted')).toBeInTheDocument();
    expect(automatic.getByText('ready (auto)')).toHaveClass('text-muted');
  });
});

describe('ScoutGrid scheduling errors and gaps', () => {
  it('shows a scheduling error in small danger text and leaves a pair the stats lack as a dash', async () => {
    freezeClock();
    const unavailable = "repository unavailable: git rev-parse HEAD failed: [Errno 2] No such file or directory: PosixPath('/work/alpha')";
    setup({ stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'state', { scheduling_error: unavailable }),
      makeStatsScoutRow(B, 'state'),
      makeStatsScoutRow(B, 'docs'),
    ]) });
    await screen.findByRole('table');
    const error = within(cell(A, 'state')).getByText(unavailable);
    expect(error).toHaveClass('text-danger', 'text-[11px]');
    expect(within(cell(B, 'state')).queryByText(/repository unavailable/)).not.toBeInTheDocument();
    const gap = within(cell(A, 'docs')).getByText('—');
    expect(gap).toHaveClass('text-muted');
    expect(within(cell(A, 'docs')).queryByText(/ready|never/)).not.toBeInTheDocument();
  });
});

describe('ScoutGrid draft outcomes', () => {
  it('lists the all-time draft outcomes in their colours, non-zero parts only, failed drafts not failed scouts', async () => {
    freezeClock();
    setup({ stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'state', { landed: 2, queued: 1, pending: 3, dropped: 4, failed_drafts: 5, failed: 9 }),
      makeStatsScoutRow(A, 'docs', { landed: 7, dropped: 1 }),
      makeStatsScoutRow(A, 'tests'),
    ]) });
    await screen.findByRole('table');
    const outcomes = (lens: string) => within(cell(A, lens)).queryByRole('list', { name: 'Draft outcomes' });
    const parts = (lens: string) => within(outcomes(lens)!).getAllByRole('listitem');
    expect(parts('state').map((part) => part.textContent)).toEqual(['2 landed', '1 queued', '3 pending', '4 dropped', '5 failed']);
    expect(parts('state').map((part) => (/text-(ok|info|attention|muted|danger)/.exec(part.className) ?? [])[1])).toEqual(['ok', 'info', 'attention', 'muted', 'danger']);
    expect(parts('docs').map((part) => part.textContent)).toEqual(['7 landed', '1 dropped']);
    expect(outcomes('tests')).toBeNull();
  });
});

const pendingRow = (project: string, lens?: HelmraiserScoutLens, wait_reason: HelmraiserScouts['pending'][number]['wait_reason'] = null) => ({
  project, ...(lens ? { lens } : {}), requested_at: '2026-11-22T17:59:00Z', wait_reason,
});
const cancelButton = (project: string, lens: string) => screen.getByRole('button', { name: `Cancel ${lens} scout for ${project}` });

describe('ScoutGrid pending scouts', () => {
  it('lays a waiting scout over its own cell with a Cancel for that lens, a missing lens meaning state', async () => {
    freezeClock();
    const { onCancel } = setup({ scouts: makeScouts({ pending: [pendingRow(A), pendingRow(A, 'docs', 'project busy')] }) });
    await screen.findByRole('table');
    const state = within(cell(A, 'state'));
    expect(state.getByText('waiting')).toHaveClass('text-attention');
    expect(state.queryByText(/never scouted|ready/)).not.toBeInTheDocument();
    expect(state.queryByRole('button', { name: /^Scout / })).not.toBeInTheDocument();
    const docs = within(cell(A, 'docs'));
    expect(docs.getByText('waiting: project busy')).toHaveClass('text-attention');
    // Siblings and other projects are untouched.
    expect(within(cell(A, 'tests')).getByText('never scouted')).toBeInTheDocument();
    expect(within(cell(B, 'state')).queryByText(/waiting/)).not.toBeInTheDocument();

    fireEvent.click(cancelButton(A, 'docs'));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(A, 'docs');
    fireEvent.click(cancelButton(A, 'state'));
    expect(onCancel).toHaveBeenLastCalledWith(A, 'state');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it.each(['queue paused', 'project busy', 'draft cap', 'no headroom', 'slots busy', null] as const)(
    'renders the wait reason %s in plain words', async (reason) => {
      setup({ scouts: makeScouts({ pending: [pendingRow(B, 'guardrails', reason)] }) });
      await screen.findByRole('table');
      expect(within(cell(B, 'guardrails')).getByText(reason ? `waiting: ${reason}` : 'waiting')).toBeInTheDocument();
      expect(cancelButton(B, 'guardrails')).toBeEnabled();
    },
  );

  it('disables Cancel while something is in flight', async () => {
    setup({ blocked: true, scouts: makeScouts({ pending: [pendingRow(A)] }) });
    await screen.findByRole('table');
    expect(cancelButton(A, 'state')).toBeDisabled();
  });
});

const runningRow = (project: string, started_at: string, lens?: HelmraiserScoutLens, scout_id = `${project}-${lens ?? 'state'}`) => ({
  project, ...(lens ? { lens } : {}), scout_id, started_at,
});

describe('ScoutGrid running scouts', () => {
  it('lays a running scout over its own cell, info with its elapsed time and no Cancel, a missing lens meaning state', async () => {
    freezeClock();
    setup({ scouts: makeScouts({ running: [
      runningRow(A, '2026-11-22T17:57:54Z'),
      runningRow(B, '2026-11-22T17:57:54Z', 'tests'),
    ] }) });
    await screen.findByRole('table');
    for (const [project, lens] of [[A, 'state'], [B, 'tests']] as const) {
      const running = within(cell(project, lens));
      expect(running.getByText('running · elapsed 2m 6s')).toHaveClass('text-info');
      expect(running.queryByRole('button')).not.toBeInTheDocument();
      expect(running.queryByText(/never scouted|ready/)).not.toBeInTheDocument();
    }
    expect(within(cell(A, 'docs')).getByText('never scouted')).toBeInTheDocument();
    expect(within(cell(B, 'state')).queryByText(/running/)).not.toBeInTheDocument();
  });

  it('ticks the elapsed time each second, formats and clamps it, and cleans up its clock', async () => {
    freezeClock();
    const running = [
      runningRow(A, '2026-11-22T17:59:01Z', 'state'),
      runningRow(A, '2026-11-22T16:58:00Z', 'docs'),
      runningRow(A, '2026-11-22T19:00:00Z', 'tests'),
      runningRow(A, 'invalid', 'guardrails'),
    ];
    const { unmount } = setup({ scouts: makeScouts({ running }),
      stats: makeHelmraiserStats(allLenses(A)) });
    await screen.findByRole('table');
    expect(within(cell(A, 'state')).getByText('running · elapsed 59s')).toBeInTheDocument();
    expect(within(cell(A, 'docs')).getByText('running · elapsed 1h 2m')).toBeInTheDocument();
    expect(within(cell(A, 'tests')).getByText('running · elapsed 0s')).toBeInTheDocument();
    expect(within(cell(A, 'guardrails')).getByText('running · elapsed unavailable')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(within(cell(A, 'state')).getByText('running · elapsed 1m 1s')).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('slows its clock to a minute once nothing runs, which keeps ages and countdowns current', async () => {
    freezeClock();
    const running = [runningRow(A, '2026-11-22T17:59:00Z', 'tests')];
    const { update } = setup({ scouts: makeScouts({ running }), stats: makeHelmraiserStats([
      makeStatsScoutRow(A, 'state', { last_scout_ok: true, last_scout_ended_at: '2026-11-22T17:25:00Z', last_scout_drafts: 2, next_eligible_at: '2026-11-22T18:40:00Z' }),
      makeStatsScoutRow(A, 'tests'),
    ]) });
    await screen.findByRole('table');
    expect(within(cell(A, 'state')).getByText('35m ago · 2 drafts')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(within(cell(A, 'tests')).getByText('running · elapsed 1m 1s')).toBeInTheDocument();

    update({ scouts: makeScouts() });
    expect(vi.getTimerCount()).toBe(1);
    // A second no longer moves anything; five minutes do.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(within(cell(A, 'state')).getByText('35m ago · 2 drafts')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5 * 60_000 - 1000); });
    expect(within(cell(A, 'state')).getByText('40m ago · 2 drafts')).toBeInTheDocument();
    expect(within(cell(A, 'state')).getByText('next in 35m')).toBeInTheDocument();
  });
});

const scoutButton = (project: string, lens: string) => screen.getByRole('button', { name: `Scout ${lens} for ${project}` });
const scoutButtons = () => screen.getAllByRole('button', { name: /^Scout / });

describe('ScoutGrid requests', () => {
  it('puts a Scout button on each idle cell that asks for exactly its project and lens', async () => {
    freezeClock();
    const { onRequest } = setup({ scouts: makeScouts({
      pending: [pendingRow(A, 'docs')],
      running: [runningRow(A, '2026-11-22T17:57:54Z', 'tests')],
    }) });
    await screen.findByRole('table');
    // Eight cells, two of them busy; a gap in the stats still offers one.
    expect(scoutButtons()).toHaveLength(6);
    expect(within(cell(A, 'docs')).queryByRole('button', { name: /^Scout / })).not.toBeInTheDocument();
    expect(within(cell(A, 'tests')).queryByRole('button', { name: /^Scout / })).not.toBeInTheDocument();

    fireEvent.click(scoutButton(B, 'guardrails'));
    expect(onRequest).toHaveBeenCalledExactlyOnceWith(B, 'guardrails');
    fireEvent.click(scoutButton(A, 'state'));
    expect(onRequest).toHaveBeenLastCalledWith(A, 'state');
    fireEvent.click(scoutButton(B, 'docs'));
    expect(onRequest).toHaveBeenLastCalledWith(B, 'docs');
    expect(onRequest).toHaveBeenCalledTimes(3);
  });

  it('offers a Scout on a pair the stats lack', async () => {
    setup({ stats: makeHelmraiserStats([makeStatsScoutRow(A, 'state'), makeStatsScoutRow(B, 'state'), makeStatsScoutRow(B, 'docs')]) });
    await screen.findByRole('table');
    expect(within(cell(A, 'docs')).getByText('—')).toBeInTheDocument();
    expect(scoutButton(A, 'docs')).toBeEnabled();
  });

  it('disables a paused project\'s buttons, and every button while a request or cancel is in flight', async () => {
    const { onRequest, update } = setup({ scouts: makeScouts({ paused_projects: [B] }) });
    await screen.findByRole('table');
    for (const lens of LENSES) {
      expect(scoutButton(B, lens)).toBeDisabled();
      expect(scoutButton(A, lens)).toBeEnabled();
    }
    expect(scoutButton(B, 'state')).toHaveAttribute('title', 'project paused');
    fireEvent.click(scoutButton(B, 'state'));
    expect(onRequest).not.toHaveBeenCalled();
    update({ scouts: makeScouts({ paused_projects: [B] }), blocked: true });
    for (const button of scoutButtons()) expect(button).toBeDisabled();
  });
});

const recentRow = (scout_id: string): HelmraiserScouts['recent'][number] => ({
  project: A, scout_id, ended_at: '2026-11-22T17:00:00Z', ok: true, drafts: 1, report: null, error: null,
});

describe('ScoutGrid refetching', () => {
  it('reads the stats again when a scout is requested, cancelled, starts or ends, or a run lands or fails, and not otherwise', async () => {
    const { stats, update } = setup();
    await screen.findByRole('table');
    expect(stats).toHaveBeenCalledTimes(1);
    const settle = () => act(async () => { await Promise.resolve(); });
    const reads = async (count: number) => { await settle(); expect(stats).toHaveBeenCalledTimes(count); };

    // Nothing the stats cannot have changed on: paused projects, the rest of the queue, the panel's own state, the same snapshot again.
    update({ scouts: makeScouts({ paused_projects: [B], focus_projects: [B, A] }), queue: { ...QUEUE, queued: 3, running: 1, awaiting_approval: 2 }, blocked: true });
    update({});
    await reads(1);

    // A scout asked for (a pending pair appears), then the same pending set in another order and with other timestamps.
    update({ scouts: makeScouts({ pending: [pendingRow(A), pendingRow(B, 'docs')] }) });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
    update({ scouts: makeScouts({ pending: [{ ...pendingRow(B, 'docs'), requested_at: '2026-11-22T17:59:30Z' }, pendingRow(A)] }) });
    await reads(2);
    // Another lens of the same project is another pair; so is a missing lens turning explicit state.
    update({ scouts: makeScouts({ pending: [pendingRow(A, 'tests'), pendingRow(B, 'docs')] }) });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(3));
    update({ scouts: makeScouts({ pending: [pendingRow(A, 'tests'), pendingRow(B, 'docs')], running: [runningRow(A, '2026-11-22T17:59:00Z', 'state', 'scout-1')] }) });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(4));
    // The same scout running longer is not news; a different scout is.
    update({ scouts: makeScouts({ pending: [pendingRow(A, 'tests'), pendingRow(B, 'docs')], running: [runningRow(A, '2026-11-22T17:50:00Z', 'state', 'scout-1')] }) });
    await reads(4);
    update({ scouts: makeScouts({ running: [runningRow(A, '2026-11-22T17:59:00Z', 'state', 'scout-2')] }) });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(5));
    // A scout ends: the newest recent scout changes.
    update({ scouts: makeScouts({ recent: [recentRow('scout-2'), recentRow('scout-1')] }) });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(6));
    update({ scouts: makeScouts({ recent: [recentRow('scout-2'), recentRow('scout-0')] }) });
    await reads(6);
    // A run lands or fails, so draft outcomes moved.
    update({ scouts: makeScouts({ recent: [recentRow('scout-2')] }), queue: { ...QUEUE, landed: 1 } });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(7));
    update({ scouts: makeScouts({ recent: [recentRow('scout-2')] }), queue: { ...QUEUE, landed: 1, failed: 1 } });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(8));
    expect(stats.mock.calls.every((args) => args.length === 1 && args[0] === 'all')).toBe(true);
  });

  it('shows the answer to the latest read when an earlier one arrives late', async () => {
    freezeClock();
    const answers: Array<(stats: HelmraiserStats) => void> = [];
    const { update } = setup({ stats: () => new Promise<HelmraiserStats>((resolve) => { answers.push(resolve); }) });
    update({ queue: { ...QUEUE, landed: 1 } });
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => { answers[1]!(makeHelmraiserStats([makeStatsScoutRow(B, 'state', { last_scout_ended_at: '2026-11-22T17:25:00Z', last_scout_ok: true, last_scout_drafts: 2 })])); await Promise.resolve(); });
    await act(async () => { answers[0]!(makeHelmraiserStats([makeStatsScoutRow(A, 'state')])); await Promise.resolve(); });
    expect(rowNames()).toEqual(['repo two']);
    expect(within(cell(B, 'state')).getByText('35m ago · 2 drafts')).toBeInTheDocument();
  });
});

describe('ScoutGrid when the stats cannot be read', () => {
  const unavailable = 'scout stats unavailable — helmraiser stats failed: ledger is locked';

  it('keeps the last good stats under a dim line, with the live pending and running scouts still laid over them', async () => {
    freezeClock();
    const locked = () => Promise.reject(new WireCallError('helmraiser stats failed: ledger is locked', 'helmraiser_cli_error'));
    const answers = [
      () => Promise.resolve(makeHelmraiserStats([makeStatsScoutRow(A, 'state', { last_scout_ended_at: '2026-11-22T17:25:00Z', last_scout_ok: true, last_scout_drafts: 2 }), makeStatsScoutRow(A, 'docs')])),
      locked,
      locked,
      () => Promise.resolve(makeHelmraiserStats([makeStatsScoutRow(A, 'state', { last_scout_ended_at: '2026-11-22T17:58:00Z', last_scout_ok: true, last_scout_drafts: 4 }), makeStatsScoutRow(A, 'docs')])),
    ];
    let call = 0;
    const { update } = setup({ stats: () => answers[call++]!() });
    await screen.findByRole('table');
    expect(screen.queryByText(/scout stats unavailable/)).not.toBeInTheDocument();

    update({ scouts: makeScouts({ pending: [pendingRow(A, 'docs')] }) });
    expect(await screen.findByText(unavailable)).toHaveClass('text-muted');
    // The old figures stay, and the new pending scout shows over its cell.
    expect(within(cell(A, 'state')).getByText('35m ago · 2 drafts')).toBeInTheDocument();
    expect(within(cell(A, 'docs')).getByText('waiting')).toBeInTheDocument();
    update({ scouts: makeScouts({ pending: [], running: [runningRow(A, '2026-11-22T17:59:00Z', 'docs')] }) });
    expect(within(cell(A, 'docs')).getByText('running · elapsed 1m 0s')).toBeInTheDocument();

    // The next good read replaces the figures and clears the line.
    update({ scouts: makeScouts({ recent: [recentRow('scout-9')] }) });
    expect(await within(cell(A, 'state')).findByText('2m ago · 4 drafts')).toBeInTheDocument();
    expect(screen.queryByText(/scout stats unavailable/)).not.toBeInTheDocument();
  });

  it('shows only the line when the very first read fails', async () => {
    setup({ stats: () => Promise.reject(new WireCallError('helmraiser stats failed: ledger is locked', 'helmraiser_cli_error')) });
    expect(await screen.findByText(unavailable)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows no focus projects, rather than an empty table, when the stats have none', async () => {
    setup({ stats: makeHelmraiserStats(allLenses('/work/other-project', { in_focus: false })) });
    expect(await screen.findByText('No focus projects available')).toHaveClass('text-muted');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('ScoutGrid cell errors', () => {
  it('shows a request refusal in its idle cell and a cancel refusal in its pending cell, as alerts, and nowhere else', async () => {
    freezeClock();
    setup({
      scouts: makeScouts({ pending: [pendingRow(A)] }),
      errors: [
        { project: A, lens: 'docs', action: 'request', message: 'project is paused: /work/alpha' },
        { project: A, lens: 'state', action: 'cancel', message: 'denied' },
        // Each belongs to the other kind of cell, so it has nothing to say there now.
        { project: A, lens: 'state', action: 'request', message: 'stale request refusal' },
        { project: B, lens: 'state', action: 'cancel', message: 'stale cancel refusal' },
      ],
    });
    await screen.findByRole('table');
    const refusal = within(cell(A, 'docs')).getByRole('alert');
    expect(refusal).toHaveTextContent('project is paused: /work/alpha');
    expect(refusal).toHaveClass('text-danger');
    expect(within(cell(A, 'state')).getByRole('alert')).toHaveTextContent('denied');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });
});
