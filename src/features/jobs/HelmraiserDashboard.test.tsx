import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HelmraiserReport, HelmraiserReportWindow, HelmraiserStats, HelmraiserStatsScoutRow, HelmraiserStatsWindow, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { HelmraiserDashboard } from './HelmraiserDashboard.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { makeHelmraiserReport, usageWindow } from './__fixtures__/helmraiser-report.ts';
import { makeHelmraiserStats, makeStatsScoutRow, makeWeeklyRow, statsWindow } from './__fixtures__/helmraiser-stats.ts';

// Deterministic local-time assertions (the report time renders as HH:MM).
beforeAll(() => { process.env.TZ = 'UTC'; });
afterEach(() => { vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Answers each window with the fixture report for that window, unless told otherwise. */
const byWindow = (since: HelmraiserReportWindow): Promise<HelmraiserReport> =>
  Promise.resolve(makeHelmraiserReport({ since }));

/** Answers each window with the fixture stats for that window, unless told otherwise. */
const statsByWindow = (since: HelmraiserStatsWindow): Promise<HelmraiserStats> =>
  Promise.resolve(makeHelmraiserStats([], { window: statsWindow(since) }));

/** Answers each window with the fixture stats, the given sections replaced. */
const statsWith = (overrides: Partial<HelmraiserStats>) => (since: HelmraiserStatsWindow): Promise<HelmraiserStats> =>
  Promise.resolve(makeHelmraiserStats([], { ...overrides, window: statsWindow(since) }));

function setup(
  status: HelmraiserStatus | null = makeHelmraiserStatus(),
  report: (since: HelmraiserReportWindow) => Promise<HelmraiserReport> = byWindow,
  stats: (since: HelmraiserStatsWindow) => Promise<HelmraiserStats> = statsByWindow,
) {
  const workflow = {
    report: vi.fn(report),
    stats: vi.fn(stats),
    log: vi.fn().mockResolvedValue({ events: [], truncated: false }),
  };
  const container = new Container();
  container.registerInstance(WORKFLOW, workflow as never);
  const view = (next: HelmraiserStatus | null) => (
    <ContainerProvider container={container}><HelmraiserDashboard status={next} /></ContainerProvider>
  );
  const rendered = render(view(status));
  return { workflow, rerender: (next: HelmraiserStatus | null) => rendered.rerender(view(next)) };
}

/** One health tile, found by its label. */
const tile = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement!;

describe('HelmraiserDashboard health tiles', () => {
  it('shows landed, failed, first pass, review rounds and spend for the window', async () => {
    setup();
    await screen.findByText('HEALTH · LAST 7D');
    expect(within(tile('landed')).getByText('50')).toHaveClass('text-ok');
    expect(within(tile('failed')).getByText('1')).toHaveClass('text-danger');
    // 29 + 22 first-pass runs out of 30 + 23; 51/53 is 96.2%.
    expect(tile('first pass')).toHaveTextContent('96%');
    expect(tile('first pass')).toHaveTextContent('51 of 53 runs');
    // report's first_pass is the first iteration passing verify, not the stricter first-time-right.
    expect(tile('first pass')).toHaveTextContent('first iteration passed verify');
    // 4 + 2 rounds across the same 53 runs.
    expect(within(tile('review rounds')).getByText('6')).toBeInTheDocument();
    expect(tile('review rounds')).toHaveTextContent('on 53 runs');
    // $45.50 over 50 landed runs.
    expect(within(tile('spend')).getByText('$45.50')).toBeInTheDocument();
    expect(tile('spend')).toHaveTextContent('$0.91 per landed run');
  });

  it('names the distinct failure reasons, before the colon, under the failed tile', async () => {
    const run = makeHelmraiserReport().failed[0]!;
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since,
      failed: [
        { ...run, run_id: 'a1', failure_reason: 'timeout: pi session exceeded its time limit' },
        { ...run, run_id: 'a2', failure_reason: 'verify failed: npm run verify exited 1' },
        { ...run, run_id: 'a3', failure_reason: 'timeout: no output for 10 minutes' },
        { ...run, run_id: 'a4', failure_reason: null },
        { ...run, run_id: 'a5', failure_reason: 'rejected' },
      ],
    })));
    await screen.findByText('HEALTH · LAST 7D');
    expect(within(tile('failed')).getByText('5')).toBeInTheDocument();
    expect(within(tile('failed')).getByText('timeout, verify failed, rejected')).toHaveClass('text-muted');
  });

  it('shows — and no danger when nothing ran, and no per-landed cost when nothing landed', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since, landed_count: 0, awaiting_count: 0, failed: [], models: [], cost: { total_usd: 0, by_model: {} },
    })));
    await screen.findByText('HEALTH · LAST 7D');
    expect(within(tile('failed')).getByText('0')).not.toHaveClass('text-danger');
    expect(tile('first pass')).toHaveTextContent('—');
    expect(tile('first pass')).toHaveTextContent('no runs');
    expect(within(tile('review rounds')).getByText('0')).toBeInTheDocument();
    expect(tile('spend')).toHaveTextContent('$0.00');
    expect(tile('spend')).toHaveTextContent('no landed runs');
  });
});

describe('HelmraiserDashboard subscription use', () => {
  const NOW = 1_790_000_000; // epoch seconds

  it('draws every provider window as a bar with its markers and a reset time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const status = makeHelmraiserStatus();
    status.usage = {
      'openai-codex': {
        '5h': usageWindow(0.2, { resets_at: NOW + 2 * 3600 + 40 * 60 }),
        week: usageWindow(0.63, { warn_at: 0.8, stop_at: 0.9, resets_at: NOW + 3 * 86400 + 20 * 3600 + 15 * 60 }),
        month: usageWindow(0.4, { resets_at: NOW + 20 * 86400 }),
      },
      'opencode-go': {
        '5h': usageWindow(0.11, { resets_at: NOW + 30 * 60 }),
        week: usageWindow(0.11, { resets_at: NOW + 86400 + 3600 }),
        month: usageWindow(0.05, { resets_at: NOW - 60 }),
      },
    };
    setup(status);
    await screen.findByText('HEALTH · LAST 7D');
    const bars = screen.getAllByRole('meter');
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['20', '63', '40', '11', '11', '5']);

    const row = (name: string) => within(screen.getByRole('meter', { name }).closest('li')!);
    expect(row('openai-codex week').getByText('resets in 3d 20h')).toHaveClass('text-muted');
    expect(row('openai-codex 5h').getByText('resets in 2h 40m')).toBeInTheDocument();
    expect(row('openai-codex month').getByText('resets in 20d 0h')).toBeInTheDocument();
    expect(row('opencode-go 5h').getByText('resets in 30m')).toBeInTheDocument();
    expect(row('opencode-go week').getByText('resets in 1d 1h')).toBeInTheDocument();
    expect(row('opencode-go month').getByText('resets now')).toBeInTheDocument();

    const week = screen.getByRole('meter', { name: 'openai-codex week' });
    expect(week.querySelector('[data-marker="warn"]')).toHaveStyle({ left: '80%' });
    expect(week.querySelector('[data-marker="stop"]')).toHaveStyle({ left: '90%' });
    expect(screen.getByRole('meter', { name: 'opencode-go week' }).querySelector('[data-marker="stop"]')).toBeNull();
  });

  it('draws only the windows a provider reports, as openai-codex reports week alone', async () => {
    const status = makeHelmraiserStatus();
    status.usage = { 'openai-codex': { week: usageWindow(0.18) } };
    setup(status);
    await screen.findByText('HEALTH · LAST 7D');
    expect(screen.getAllByRole('meter').map((meter) => meter.getAttribute('aria-labelledby') && meter.textContent)).toHaveLength(1);
    expect(screen.getByRole('meter', { name: 'openai-codex week' })).toHaveAttribute('aria-valuenow', '18');
  });

  it('says so when status has no usage to show', async () => {
    setup(null);
    await screen.findByText('HEALTH · LAST 7D');
    expect(tile('subscription use')).toHaveTextContent('no usage data');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard models', () => {
  // The dashboard has other tables (latency, the scout funnel): these are the Models section's own.
  const models = () => within(screen.getByRole('region', { name: 'Models' }));
  const row = (runs: number, overrides: Partial<HelmraiserReport['models'][number]> = {}): HelmraiserReport['models'][number] => ({
    model: 'opencode-go/small', runs, landed: runs, failed: 0, first_pass: runs, review_rounds: 0,
    avg_iterations: 1, avg_minutes: 5, cost_per_landed: 0.1, ...overrides,
  });

  it('lists each implementer model with its figures, the provider dim beside the name', async () => {
    setup();
    await screen.findByText('MODELS · implementer');
    expect(models().getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'model', 'runs', 'landed', '$ / landed', 'first pass', 'failed', 'review rounds', 'avg iter', 'avg min',
    ]);
    const rows = models().getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    const glm = within(rows[0]!).getAllByRole('cell');
    expect(within(glm[0]!).getByText('glm-5.2')).toBeInTheDocument();
    expect(within(glm[0]!).getByText('opencode-go')).toHaveClass('text-muted');
    // runs, landed, $ per landed, first pass (count and share of runs), failed, review rounds, avg iterations, avg minutes.
    expect(glm.slice(1).map((cell) => cell.textContent)).toEqual(['30', '28', '$0.71', '29 · 97%', '1', '4', '1.2', '11.5']);
    expect(glm[2]).toHaveClass('text-ok');
    expect(glm[5]).toHaveClass('text-danger');

    const codex = within(rows[1]!).getAllByRole('cell');
    expect(within(codex[0]!).getByText('gpt-5.5')).toBeInTheDocument();
    expect(within(codex[0]!).getByText('openai-codex')).toBeInTheDocument();
    expect(codex.slice(1).map((cell) => cell.textContent)).toEqual(['23', '22', '$1.16', '22 · 96%', '0', '2', '1.0', '8.0']);
    // Nothing failed there: zero is not danger.
    expect(codex[5]).not.toHaveClass('text-danger');
  });

  it('dims rows with fewer than 5 runs and leaves 5 alone', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since,
      models: [row(4, { model: 'opencode-go/four', failed: 1 }), row(5, { model: 'opencode-go/five' }), row(100, { model: 'opencode-go/hundred' })],
    })));
    await screen.findByText('MODELS · implementer');
    const rows = models().getAllByRole('row').slice(1);
    expect(rows[0]).toHaveClass('text-muted');
    expect(rows[1]).not.toHaveClass('text-muted');
    expect(rows[2]).not.toHaveClass('text-muted');
    // A dim row stays dim all through: its failures are not picked out in danger.
    expect(within(rows[0]!).getAllByRole('cell')[5]).not.toHaveClass('text-danger');
  });

  it('shows — for a model with no cost per landed run, and just the name when it has no provider', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since, models: [row(8, { model: 'local-model', landed: 0, cost_per_landed: null })],
    })));
    await screen.findByText('MODELS · implementer');
    const cells = within(models().getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent(/^local-model$/);
    expect(cells[3]).toHaveTextContent('—');
  });

  it('scrolls the table sideways inside its own box', async () => {
    setup();
    await screen.findByText('MODELS · implementer');
    expect(models().getByRole('table').parentElement).toHaveClass('overflow-x-auto');
  });
});

describe('HelmraiserDashboard failed runs', () => {
  const base = makeHelmraiserReport().failed[0]!;

  /** The stats' per-project run counts, which is where the dashboard learns the project paths. */
  const knownProjects = (...paths: string[]) => (since: HelmraiserStatsWindow): Promise<HelmraiserStats> => {
    const { runs } = makeHelmraiserStats();
    return Promise.resolve(makeHelmraiserStats([], {
      window: statsWindow(since),
      runs: { overall: runs.overall, by_project: paths.map((project) => ({ ...runs.by_project[0]!, project })) },
    }));
  };

  it('lists each failed run: reason in danger, project, title and the short run id', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since,
      failed: [
        { ...base, task_id: '-home-example-projects-acme-monorepo:app-sign-in-tagline' },
        {
          run_id: 'c0ffee00-1111-4222-8333-444455556666',
          task_id: '-home-example-projects-alpha:scout-preflight-evidence',
          title: 'Scout preflight evidence',
          failure_reason: 'verify failed: npm run verify exited 1',
          ended_at: '2026-11-22T10:00:00+00:00',
        },
      ],
    })), knownProjects('/home/example/projects/acme-monorepo', '/home/example/projects/alpha'));
    expect(await screen.findByText('FAILED RUNS (2)')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Failed runs' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]!).getByText('timeout: pi session exceeded its time limit')).toHaveClass('text-danger');
    // A hyphenated project keeps its whole name: it is read off the project paths the stats list.
    expect(within(rows[0]!).getByText('acme-monorepo')).toHaveClass('text-muted');
    expect(within(rows[0]!).getByText('App sign-in tagline')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('3b8cf951')).toBeInTheDocument();
    expect(rows[0]).not.toHaveTextContent('3b8cf951-3d8c');

    expect(within(rows[1]!).getByText('verify failed: npm run verify exited 1')).toHaveClass('text-danger');
    expect(within(rows[1]!).getByText('alpha')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('c0ffee00')).toBeInTheDocument();
  });

  it('names a project the stats do not list by its slug, and none when the task id has no project', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since,
      failed: [
        { ...base, run_id: 'aaaa1111-0', task_id: '-home-example-code-thing:fix', title: 'Elsewhere', failure_reason: 'timeout' },
        { ...base, run_id: 'bbbb2222-0', task_id: 'scope-approval', title: 'No project', failure_reason: null },
      ],
    })), knownProjects('/home/example/projects/alpha'));
    await screen.findByText('FAILED RUNS (2)');
    const rows = within(screen.getByRole('list', { name: 'Failed runs' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('home-example-code-thing')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('no reason recorded')).toHaveClass('text-danger');
    expect(rows[1]).toHaveTextContent('No project');
    expect(within(rows[1]!).queryByText(/scope/)).not.toBeInTheDocument();
  });

  it('opens the run log from a toggle, for the full run id', async () => {
    const { workflow } = setup();
    await screen.findByText('FAILED RUNS (1)');
    expect(workflow.log).not.toHaveBeenCalled();
    const toggle = screen.getByRole('button', { name: 'LOG' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(workflow.log).toHaveBeenCalledExactlyOnceWith('3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc'));
  });
});

describe('HelmraiserDashboard empty window', () => {
  it('says there were no runs, in place of the models and failed sections', async () => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({
      since, landed_count: 0, awaiting_count: 0, failed: [], models: [], cost: { total_usd: 0, by_model: {} },
    })));
    expect(await screen.findByText('No runs in this window')).toBeInTheDocument();
    expect(screen.queryByText('MODELS · implementer')).not.toBeInTheDocument();
    expect(screen.queryByText(/^FAILED RUNS/)).not.toBeInTheDocument();
    // The tiles are still there, at zero.
    expect(within(tile('landed')).getByText('0')).toBeInTheDocument();
  });

  it.each([
    ['only failed runs', { models: [] }],
    ['only model rows', { failed: [] }],
  ])('does not say there were no runs when there were %s', async (_name, override) => {
    setup(makeHelmraiserStatus(), (since) => Promise.resolve(makeHelmraiserReport({ since, ...override })));
    await screen.findByText('HEALTH · LAST 7D');
    expect(screen.queryByText('No runs in this window')).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard failures to load', () => {
  it('says why when the first read fails, and does not sit loading', async () => {
    setup(makeHelmraiserStatus(), () => Promise.reject(new WireCallError('helmraiser report timed out after 300 s', 'helmraiser_cli_error')));
    expect(await screen.findByRole('alert')).toHaveTextContent('helmraiser report timed out after 300 s');
    expect(screen.getByRole('alert')).toHaveClass('text-danger');
    expect(screen.queryByText('loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('HEALTH · LAST 7D')).not.toBeInTheDocument();
    // The controls still work: the reader can ask for another window.
    expect(screen.getByRole('button', { name: '24h' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
  });

  it('keeps the previous numbers when a later read fails, and drops the message when one succeeds', async () => {
    const answers: Array<(since: HelmraiserReportWindow) => Promise<HelmraiserReport>> = [
      byWindow,
      () => Promise.reject(new WireCallError('helmraiser report timed out after 300 s', 'helmraiser_cli_error')),
      (since) => Promise.resolve(makeHelmraiserReport({ since, landed_count: 77 })),
    ];
    setup(makeHelmraiserStatus(), (since) => answers.shift()!(since));
    await screen.findByText('HEALTH · LAST 7D');

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('timed out');
    expect(screen.getByText('HEALTH · LAST 7D')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('50')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
    await waitFor(() => expect(within(tile('landed')).getByText('77')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('HEALTH · LAST 30D')).toBeInTheDocument();
  });
});

describe('HelmraiserDashboard controls', () => {
  it('asks for the 7d report, says loading until it lands, then names its window and time', async () => {
    const pending = deferred<HelmraiserReport>();
    const { workflow } = setup(makeHelmraiserStatus(), () => pending.promise);
    expect(workflow.report).toHaveBeenCalledExactlyOnceWith('7d');
    const group = screen.getByRole('group', { name: 'Report window' });
    expect(within(group).getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('loading…')).toBeInTheDocument();
    expect(screen.queryByText(/^report \d\d:\d\d$/)).not.toBeInTheDocument();

    await act(async () => { pending.resolve(makeHelmraiserReport({ since: '7d' })); await pending.promise; });
    expect(screen.getByText('report 16:05')).toBeInTheDocument();
    expect(screen.queryByText('loading…')).not.toBeInTheDocument();
    expect(screen.getByText('HEALTH · LAST 7D')).toBeInTheDocument();
  });

  it('asks for the 30d report on its button and keeps the 7d numbers under a loading label until it lands', async () => {
    const month = deferred<HelmraiserReport>();
    const { workflow } = setup(makeHelmraiserStatus(), (since) => (since === '30d' ? month.promise : byWindow(since)));
    await screen.findByText('HEALTH · LAST 7D');
    expect(screen.getByText('report 16:05')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(workflow.report).toHaveBeenLastCalledWith('30d');
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'false');
    // Still the 7d report on screen, and honestly labelled as such, with the loading label beside it.
    expect(screen.getByText('loading…')).toBeInTheDocument();
    expect(screen.queryByText(/^report \d\d:\d\d$/)).not.toBeInTheDocument();
    expect(screen.getByText('HEALTH · LAST 7D')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('50')).toBeInTheDocument();

    await act(async () => {
      month.resolve(makeHelmraiserReport({ since: '30d', landed_count: 212, generated_at: '2026-11-22T16:09:00+00:00' }));
      await month.promise;
    });
    expect(screen.getByText('HEALTH · LAST 30D')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('212')).toBeInTheDocument();
    expect(screen.getByText('report 16:09')).toBeInTheDocument();
    expect(screen.queryByText('loading…')).not.toBeInTheDocument();
  });

  it('ignores a slow answer for a window the reader has already left', async () => {
    const week = deferred<HelmraiserReport>();
    let weekReads = 0;
    setup(makeHelmraiserStatus(), (since) => {
      if (since !== '7d') return byWindow(since);
      weekReads += 1;
      return weekReads === 1 ? week.promise : byWindow(since);
    });
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await screen.findByText('HEALTH · LAST 24H');
    await act(async () => { week.resolve(makeHelmraiserReport({ since: '7d', landed_count: 999 })); await week.promise; });
    expect(screen.getByText('HEALTH · LAST 24H')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('50')).toBeInTheDocument();
  });

  it('refreshes the same window on ↻, and cannot be pressed twice while it loads', async () => {
    const again = deferred<HelmraiserReport>();
    let reads = 0;
    const { workflow } = setup(makeHelmraiserStatus(), (since) => {
      reads += 1;
      return reads === 1 ? byWindow(since) : again.promise;
    });
    await screen.findByText('HEALTH · LAST 7D');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
    expect(workflow.report).toHaveBeenCalledTimes(2);
    expect(workflow.report).toHaveBeenLastCalledWith('7d');
    expect(screen.getByText('loading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh report' })).toBeDisabled();
    await act(async () => { again.resolve(makeHelmraiserReport({ since: '7d', landed_count: 51, generated_at: '2026-11-22T16:20:00+00:00' })); await again.promise; });
    expect(screen.getByText('report 16:20')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('51')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
  });
});

describe('HelmraiserDashboard stats fetching', () => {
  it('reads the window\'s stats beside its report, and the whole ledger once, on mount', async () => {
    const { workflow } = setup();
    await screen.findByText('HEALTH · LAST 7D');
    expect(workflow.stats).toHaveBeenCalledTimes(2);
    expect(workflow.stats).toHaveBeenCalledWith('7d');
    expect(workflow.stats).toHaveBeenCalledWith('all');
  });

  it('asks for the new window\'s stats on a window change, and not for the whole ledger again', async () => {
    const { workflow } = setup();
    await screen.findByText('HEALTH · LAST 7D');
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    expect(workflow.stats).toHaveBeenLastCalledWith('24h');
    await screen.findByText('HEALTH · LAST 24H');
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(workflow.stats).toHaveBeenLastCalledWith('30d');
    await screen.findByText('HEALTH · LAST 30D');
    expect(workflow.stats.mock.calls.filter(([since]) => since === 'all')).toHaveLength(1);
    expect(workflow.stats).toHaveBeenCalledTimes(4);
  });

  it('asks for the window and the whole ledger again on ↻', async () => {
    const { workflow } = setup();
    await screen.findByText('HEALTH · LAST 7D');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
    expect(workflow.stats).toHaveBeenCalledTimes(4);
    expect(workflow.stats.mock.calls.slice(2).map(([since]) => since).sort()).toEqual(['7d', 'all']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh report' })).toBeEnabled());
  });
});

describe('HelmraiserDashboard stats failures', () => {
  it('says so in a dim line, and leaves every report section as it was', async () => {
    setup(makeHelmraiserStatus(), byWindow, (since) => (
      since === 'all' ? statsByWindow(since) : Promise.reject(new WireCallError('helmraiser stats timed out after 60 s', 'helmraiser_cli_error'))
    ));
    const line = await screen.findByText('stats unavailable — helmraiser stats timed out after 60 s');
    expect(line).toHaveClass('text-muted');
    // It is a note, not the report's danger alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('loading…')).not.toBeInTheDocument();
    expect(screen.getByText('HEALTH · LAST 7D')).toBeInTheDocument();
    expect(within(tile('landed')).getByText('50')).toBeInTheDocument();
    expect(screen.getByText('MODELS · implementer')).toBeInTheDocument();
    expect(screen.getByText('FAILED RUNS (1)')).toBeInTheDocument();
  });
});

describe('HelmraiserDashboard quality tiles', () => {
  it('shows first-time-right, rework, scope-request and retried tasks for the window, each with its definition', async () => {
    setup();
    await screen.findByText('QUALITY · LAST 7D');
    // 515 of the window's 807 landed runs; the rate is the CLI's 0.638.
    expect(within(tile('first-time-right')).getByText('64%')).toBeInTheDocument();
    expect(tile('first-time-right')).toHaveTextContent('515 of 807 landed');
    expect(within(tile('first-time-right')).getByText('landed with one iteration, no rework, no scope request, no retry')).toHaveClass('text-muted');
    expect(within(tile('rework rate')).getByText('12%')).toBeInTheDocument();
    expect(within(tile('rework rate')).getByText('runs reworked at merge, of runs with a merge decision')).toHaveClass('text-muted');
    expect(within(tile('scope-request rate')).getByText('10%')).toBeInTheDocument();
    expect(within(tile('scope-request rate')).getByText('runs that asked for scope approval, of all runs')).toHaveClass('text-muted');
    expect(within(tile('retried tasks')).getByText('37')).toBeInTheDocument();
    expect(within(tile('retried tasks')).getByText('tasks with more than one run in the window')).toHaveClass('text-muted');
  });

  it('shows — for a rate with no runs behind it', async () => {
    const empty = makeHelmraiserStats([], {
      quality: {
        first_time_right: { count: 0, rate: null }, rework_rate: null, scope_request_rate: null, retried_tasks: 0,
        review_verdicts: { pass: 0, concerns: 0, uncertain: 0, none: 0 },
      },
      runs: { overall: { landed: 0, failed: 0, aborted: 0, awaiting_approval: 0, active: 0 }, by_project: [] },
    });
    setup(makeHelmraiserStatus(), byWindow, (since) => Promise.resolve({ ...empty, window: statsWindow(since) }));
    await screen.findByText('QUALITY · LAST 7D');
    expect(tile('first-time-right')).toHaveTextContent('—');
    expect(tile('first-time-right')).toHaveTextContent('0 of 0 landed');
    expect(tile('rework rate')).toHaveTextContent('—');
    expect(tile('scope-request rate')).toHaveTextContent('—');
    // A count of none is a real 0.
    expect(within(tile('retried tasks')).getByText('0')).toBeInTheDocument();
  });
});

describe('HelmraiserDashboard review verdicts', () => {
  const withVerdicts = (review_verdicts: HelmraiserStats['quality']['review_verdicts']) => (since: HelmraiserStatsWindow) => {
    const stats = makeHelmraiserStats();
    return Promise.resolve({ ...stats, window: statsWindow(since), quality: { ...stats.quality, review_verdicts } });
  };

  it('draws one thin stacked bar, each verdict sized by its count and named in a legend', async () => {
    setup(makeHelmraiserStatus(), byWindow, withVerdicts({ pass: 60, concerns: 20, uncertain: 15, none: 5 }));
    await screen.findByText('QUALITY · LAST 7D');
    const verdicts = tile('review verdicts');
    expect(within(verdicts).getByText('review verdict per run; none = no verdict recorded')).toHaveClass('text-muted');
    const bar = within(verdicts).getByRole('img', { name: 'review verdicts: pass 60, concerns 20, uncertain 15, none 5' });
    const segment = (name: string) => bar.querySelector(`[data-verdict="${name}"]`);
    expect(segment('pass')).toHaveStyle({ width: '60%' });
    expect(segment('concerns')).toHaveStyle({ width: '20%' });
    expect(segment('uncertain')).toHaveStyle({ width: '15%' });
    expect(segment('none')).toHaveStyle({ width: '5%' });
    expect(segment('pass')).toHaveClass('bg-ok');
    expect(segment('concerns')).toHaveClass('bg-attention');
    expect(segment('uncertain')).toHaveClass('bg-info');
    expect(segment('none')).toHaveClass('bg-muted');
    // Colour is never the only cue: every verdict is named, with its count, in text.
    const legend = within(within(verdicts).getByRole('list', { name: 'Review verdicts' })).getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual(['pass 60', 'concerns 20', 'uncertain 15', 'none 5']);
  });

  it('keeps a verdict nobody got in the legend at 0, with no sliver in the bar', async () => {
    setup(makeHelmraiserStatus(), byWindow, withVerdicts({ pass: 4, concerns: 0, uncertain: 0, none: 0 }));
    await screen.findByText('QUALITY · LAST 7D');
    const verdicts = tile('review verdicts');
    expect(verdicts.querySelector('[data-verdict="pass"]')).toHaveStyle({ width: '100%' });
    expect(verdicts.querySelector('[data-verdict="concerns"]')).toBeNull();
    expect(within(verdicts).getByText('concerns 0')).toBeInTheDocument();
  });

  it('says there were no reviews instead of drawing an empty bar', async () => {
    setup(makeHelmraiserStatus(), byWindow, withVerdicts({ pass: 0, concerns: 0, uncertain: 0, none: 0 }));
    await screen.findByText('QUALITY · LAST 7D');
    expect(tile('review verdicts')).toHaveTextContent('no reviews');
    expect(screen.queryByRole('img', { name: /^review verdicts/ })).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard stats controls', () => {
  const retried = (since: HelmraiserStatsWindow, retried_tasks: number) => {
    const stats = makeHelmraiserStats();
    return { ...stats, window: statsWindow(since), quality: { ...stats.quality, retried_tasks } };
  };

  it('ignores a slow stats answer for a window the reader has already left', async () => {
    const week = deferred<HelmraiserStats>();
    let weekReads = 0;
    setup(makeHelmraiserStatus(), byWindow, (since) => {
      if (since === 'all') return statsByWindow(since);
      if (since !== '7d') return Promise.resolve(retried(since, 24));
      weekReads += 1;
      return weekReads === 1 ? week.promise : Promise.resolve(retried(since, 7));
    });
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await screen.findByText('QUALITY · LAST 24H');
    await act(async () => { week.resolve(retried('7d', 999)); await week.promise; });
    expect(screen.getByText('QUALITY · LAST 24H')).toBeInTheDocument();
    expect(within(tile('retried tasks')).getByText('24')).toBeInTheDocument();
    expect(screen.queryByText('999')).not.toBeInTheDocument();
  });

  it('keeps the previous window\'s numbers, under their own label, until the new window\'s stats land', async () => {
    const month = deferred<HelmraiserStats>();
    setup(makeHelmraiserStatus(), byWindow, (since) => (since === '30d' ? month.promise : Promise.resolve(retried(since, 7))));
    await screen.findByText('QUALITY · LAST 7D');
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    await screen.findByText('HEALTH · LAST 30D');
    // The report is in; the stats are not, so the 7d figures stay, labelled as 7d, under the loading label.
    expect(screen.getByText('loading…')).toBeInTheDocument();
    expect(screen.getByText('QUALITY · LAST 7D')).toBeInTheDocument();
    expect(within(tile('retried tasks')).getByText('7')).toBeInTheDocument();

    await act(async () => { month.resolve(retried('30d', 31)); await month.promise; });
    expect(screen.getByText('QUALITY · LAST 30D')).toBeInTheDocument();
    expect(within(tile('retried tasks')).getByText('31')).toBeInTheDocument();
    expect(screen.queryByText('loading…')).not.toBeInTheDocument();
  });

  it('keeps the quality figures when only the report fails, as it keeps the report\'s when only the stats fail', async () => {
    setup(makeHelmraiserStatus(), () => Promise.reject(new WireCallError('helmraiser report timed out after 300 s', 'helmraiser_cli_error')));
    expect(await screen.findByRole('alert')).toHaveTextContent('helmraiser report timed out after 300 s');
    await screen.findByText('QUALITY · LAST 7D');
    expect(within(tile('retried tasks')).getByText('37')).toBeInTheDocument();
    expect(screen.queryByText(/stats unavailable/)).not.toBeInTheDocument();
  });

  it('keeps the last good stats when a later read fails, and drops the note when one succeeds', async () => {
    const answers: Array<(since: HelmraiserStatsWindow) => Promise<HelmraiserStats>> = [
      (since) => Promise.resolve(retried(since, 7)),
      () => Promise.reject(new WireCallError('helmraiser stats timed out after 60 s', 'helmraiser_cli_error')),
      (since) => Promise.resolve(retried(since, 8)),
    ];
    setup(makeHelmraiserStatus(), byWindow, (since) => (since === 'all' ? statsByWindow(since) : answers.shift()!(since)));
    await screen.findByText('QUALITY · LAST 7D');

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(await screen.findByText('stats unavailable — helmraiser stats timed out after 60 s')).toBeInTheDocument();
    expect(within(tile('retried tasks')).getByText('7')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
    await waitFor(() => expect(within(tile('retried tasks')).getByText('8')).toBeInTheDocument());
    expect(screen.queryByText(/stats unavailable/)).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard weekly trends', () => {
  const WEEKS = [
    makeWeeklyRow('2026-W44', { landed: 100, failed: 4, first_time_right_rate: 0.5 }),
    makeWeeklyRow('2026-W45', { landed: 50, failed: 0, first_time_right_rate: null }),
    makeWeeklyRow('2026-W46', { landed: 0, failed: 2, first_time_right_rate: 0.7, drafts_written: 20, drafts_landed: 10 }),
    makeWeeklyRow('2026-W47', { landed: 25, failed: 2, first_time_right_rate: 0.625, drafts_written: 40, drafts_landed: 30 }),
  ];
  /** The whole ledger answers with these weeks; every window's stats keep the fixture's two. */
  const withWeeks = (weekly: HelmraiserStats['weekly']) => (since: HelmraiserStatsWindow): Promise<HelmraiserStats> => (
    since === 'all' ? Promise.resolve(makeHelmraiserStats([], { window: statsWindow(since), weekly })) : statsByWindow(since)
  );
  const chart = (title: string) => screen.getByRole('heading', { name: title }).parentElement!;
  const plot = (title: string) => within(chart(title)).getByRole('img');
  const heights = (svg: Element, series?: string) =>
    [...svg.querySelectorAll(series ? `rect[data-series="${series}"]` : 'rect')].map((bar) => bar.getAttribute('height'));

  it('draws four small multiples from the whole ledger\'s weeks, under an all-time heading', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    expect(await screen.findByText('TRENDS · weekly, all time')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual([
      'landed per week', 'failed per week', 'first-time-right rate per week', 'drafts written vs landed per week',
    ]);
  });

  it('shows landed per week as ok bars, the latest week big and the week range dim', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    await screen.findByText('TRENDS · weekly, all time');
    const landed = chart('landed per week');
    expect(within(landed).getByText('25')).toHaveClass('text-xl');
    expect(within(landed).getByText('W44 – W47')).toHaveClass('text-muted');
    // The big number is the newest week, and says so, as there is no axis.
    expect(within(landed).getByText('W47', { selector: 'span' })).toHaveClass('text-muted');
    expect(plot('landed per week')).toHaveAccessibleName('landed per week: W44 100, W45 50, W46 0, W47 25');
    // The tallest week fills the 54-unit plot, the rest are in proportion.
    expect(heights(plot('landed per week'))).toEqual(['54', '27', '0', '13.5']);
    expect([...plot('landed per week').querySelectorAll('rect')].every((bar) => bar.classList.contains('fill-ok'))).toBe(true);
    expect(plot('landed per week').querySelector('line')).toHaveClass('stroke-faint');
  });

  it('shows failed per week as danger bars', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    await screen.findByText('TRENDS · weekly, all time');
    const failed = chart('failed per week');
    expect(within(failed).getByText('2')).toHaveClass('text-xl');
    expect(plot('failed per week')).toHaveAccessibleName('failed per week: W44 4, W45 0, W46 2, W47 2');
    expect(heights(plot('failed per week'))).toEqual(['54', '0', '27', '27']);
    expect([...plot('failed per week').querySelectorAll('rect')].every((bar) => bar.classList.contains('fill-danger'))).toBe(true);
  });

  it('draws the first-time-right rate as a line on 0-100%, a week with no rate a gap in it', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    await screen.findByText('TRENDS · weekly, all time');
    expect(within(chart('first-time-right rate per week')).getByText('63%')).toHaveClass('text-xl');
    expect(plot('first-time-right rate per week')).toHaveAccessibleName('first-time-right rate per week: W44 50%, W45 no data, W46 70%, W47 63%');
    const svg = plot('first-time-right rate per week');
    // Slots are 55 wide, so the weeks sit at 27.5, 82.5, 137.5 and 192.5; y runs 54 (0%) to 2 (100%).
    // W45 has no rate, so no stroke crosses it: W44 stands alone as a dot, W46 to W47 is one stroke.
    const paths = svg.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveAttribute('d', 'M137.5 17.6 L192.5 21.5');
    expect(paths[0]).toHaveClass('stroke-info');
    const dots = svg.querySelectorAll('circle');
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute('cx', '27.5');
    expect(dots[0]).toHaveAttribute('cy', '28');
  });

  it('draws drafts written and drafts landed as paired bars on one scale, with a legend', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    await screen.findByText('TRENDS · weekly, all time');
    const drafts = chart('drafts written vs landed per week');
    expect(within(drafts).getByText('40 / 30')).toHaveClass('text-xl');
    expect(plot('drafts written vs landed per week')).toHaveAccessibleName(
      'drafts written vs landed per week: W44 written 0 landed 0, W45 written 0 landed 0, W46 written 20 landed 10, W47 written 40 landed 30',
    );
    const svg = plot('drafts written vs landed per week');
    expect(heights(svg, 'written')).toEqual(['0', '0', '27', '54']);
    expect(heights(svg, 'landed')).toEqual(['0', '0', '13.5', '40.5']);
    expect(svg.querySelector('rect[data-series="written"]')).toHaveClass('fill-muted');
    expect(svg.querySelector('rect[data-series="landed"]')).toHaveClass('fill-ok');
    // Colour is never the only cue.
    expect(within(drafts).getByText('written')).toBeInTheDocument();
    expect(within(drafts).getByText('landed')).toBeInTheDocument();
  });

  it('takes its weeks from the whole ledger\'s stats, not the window\'s', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks(WEEKS));
    await screen.findByText('TRENDS · weekly, all time');
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await screen.findByText('QUALITY · LAST 24H');
    // The 24h stats carry the fixture's two weeks; the charts still show the four.
    expect(within(chart('landed per week')).getByText('W44 – W47')).toBeInTheDocument();
  });

  it('shows a lone week without a range, and a latest week with no rate as —', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks([makeWeeklyRow('2026-W47', { landed: 3, first_time_right_rate: null })]));
    await screen.findByText('TRENDS · weekly, all time');
    expect(within(chart('landed per week')).getByText('W47')).toHaveClass('text-muted');
    expect(within(chart('first-time-right rate per week')).getByText('—')).toHaveClass('text-xl');
    expect(plot('first-time-right rate per week').querySelector('path')).toBeNull();
    expect(plot('first-time-right rate per week').querySelector('circle')).toBeNull();
  });

  it('says there are no weeks when the ledger has none', async () => {
    setup(makeHelmraiserStatus(), byWindow, withWeeks([]));
    expect(await screen.findByText('no weekly data')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument();
  });

  it('puts the stats note in place of the trends when the whole ledger cannot be read, the window\'s sections intact', async () => {
    setup(makeHelmraiserStatus(), byWindow, (since) => (
      since === 'all' ? Promise.reject(new WireCallError('helmraiser stats timed out after 60 s', 'helmraiser_cli_error')) : statsByWindow(since)
    ));
    expect(await screen.findByText('stats unavailable — helmraiser stats timed out after 60 s')).toBeInTheDocument();
    expect(screen.queryByText('TRENDS · weekly, all time')).not.toBeInTheDocument();
    expect(screen.getByText('QUALITY · LAST 7D')).toBeInTheDocument();
    expect(screen.getByText('HEALTH · LAST 7D')).toBeInTheDocument();
  });
});

describe('HelmraiserDashboard cost split', () => {
  const costs = (plan_usd: number, implement_usd: number, other_usd: number, per_landed_usd: number | null = 1): Partial<HelmraiserStats> => ({
    cost: { total_usd: plan_usd + implement_usd + other_usd, plan_usd, implement_usd, other_usd, per_landed_usd },
  });
  const cost = () => within(screen.getByRole('region', { name: 'Cost and time' }));

  it('splits the window\'s spend into plan, implement and other, each with its dollars and share, beside the total and the cost per landed run', async () => {
    setup();
    expect(await screen.findByText('COST & TIME · LAST 7D')).toBeInTheDocument();
    const legend = within(cost().getByRole('list', { name: 'Cost split' })).getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual(['plan $151.01 · 10%', 'implement $624.02 · 43%', 'other $686.33 · 47%']);
    expect(cost().getByText('$1461.36')).toBeInTheDocument();
    expect(cost().getByText('$1.81 per landed run')).toBeInTheDocument();
    expect(cost().getByText('other = review and anything not recorded separately')).toHaveClass('text-muted');
  });

  it('draws one stacked bar, each part sized by its share and coloured', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith(costs(10, 40, 50)));
    await screen.findByText('COST & TIME · LAST 7D');
    const bar = cost().getByRole('img', { name: 'cost split: plan $10.00 10%, implement $40.00 40%, other $50.00 50%' });
    const part = (name: string) => bar.querySelector(`[data-part="${name}"]`);
    expect(part('plan')).toHaveStyle({ width: '10%' });
    expect(part('implement')).toHaveStyle({ width: '40%' });
    expect(part('other')).toHaveStyle({ width: '50%' });
    expect(part('plan')).toHaveClass('bg-info');
    expect(part('implement')).toHaveClass('bg-special');
    expect(part('other')).toHaveClass('bg-muted');
  });

  it('makes the three shares add up to 100% when plain rounding would say 99', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith(costs(334, 333, 333)));
    await screen.findByText('COST & TIME · LAST 7D');
    // 33.4, 33.3 and 33.3: each rounds to 33, so the part with the largest remainder takes the spare point.
    const legend = within(cost().getByRole('list', { name: 'Cost split' })).getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual(['plan $334.00 · 34%', 'implement $333.00 · 33%', 'other $333.00 · 33%']);
  });

  it('says there was no spend, and no landed runs to divide it by, instead of drawing an empty bar', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith(costs(0, 0, 0, null)));
    await screen.findByText('COST & TIME · LAST 7D');
    expect(cost().getByText('no spend')).toBeInTheDocument();
    expect(cost().getByText('no landed runs')).toBeInTheDocument();
    expect(cost().getByText('$0.00')).toBeInTheDocument();
    expect(cost().queryByRole('img')).not.toBeInTheDocument();
    expect(cost().queryByRole('list', { name: 'Cost split' })).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard latency', () => {
  const latency = (overrides: Partial<HelmraiserStats['latency']> = {}): Partial<HelmraiserStats> => ({
    latency: {
      active_minutes: { median: 14.597658812999725, p90: 34.48408429145814 },
      approval_wait_minutes: {
        plan: { median: 0.7573293050130209, p90: 14.807255144913992 },
        scope: { median: 0.7246033946673075, p90: 16.784902226924896 },
        merge: { median: 0.9178614219029745, p90: 16.776560032367705 },
      },
      ...overrides,
    },
  });
  /** One latency row's cells after its label: median, then p90. */
  const row = (label: string) => {
    const cells = within(within(screen.getByRole('table', { name: 'Latency' })).getByRole('rowheader', { name: label }).closest('tr')!).getAllByRole('cell');
    return cells.map((cell) => cell.textContent);
  };

  it('shows active time per landed run and each approval wait as median and p90, in minutes under an hour', async () => {
    setup();
    await screen.findByText('COST & TIME · LAST 7D');
    const table = within(screen.getByRole('table', { name: 'Latency' }));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['latency', 'median', 'p90']);
    expect(row('active time per landed run')).toEqual(['14.6 min', '34.5 min']);
    expect(row('plan approval wait')).toEqual(['0.8 min', '14.8 min']);
    expect(row('scope approval wait')).toEqual(['0.7 min', '16.8 min']);
    expect(row('merge approval wait')).toEqual(['0.9 min', '16.8 min']);
    expect(screen.getByText('active = working time summed per landed run, not wall-clock; wait = time parked for that approval')).toHaveClass('text-muted');
  });

  it('shows hours from an hour up, and — for a figure with no samples', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith(latency({
      active_minutes: { median: 59.9, p90: 59.96 },
      approval_wait_minutes: {
        plan: { median: 60, p90: 70.26 },
        scope: { median: 125.4, p90: null },
        merge: { median: null, p90: null },
      },
    })));
    await screen.findByText('COST & TIME · LAST 7D');
    // 59.96 min rounds to 60.0, which reads as an hour, not as 60.0 min.
    expect(row('active time per landed run')).toEqual(['59.9 min', '1.0 h']);
    expect(row('plan approval wait')).toEqual(['1.0 h', '1.2 h']);
    expect(row('scope approval wait')).toEqual(['2.1 h', '—']);
    expect(row('merge approval wait')).toEqual(['—', '—']);
  });
});

describe('HelmraiserDashboard failure classes', () => {
  const ids = (...runs: string[]) => runs;
  const classes = () => within(screen.getByRole('list', { name: 'Failure classes' })).getAllByRole('listitem');

  it('lists each class with its count and its newest run ids, the commonest class first', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith({
      failures: {
        budget: { count: 5, run_ids: ids('5c31e561-b816-4dcb-b366-f75d170c1e19') },
        blocked: { count: 33, run_ids: ids('d862c453-27d1-4756-9d43-87115f8be616', '1d517854-2e50-4335-a620-7d0fd8a015c5', '142d660e-8ed6-4338-9413-5ad16510baaa') },
        aborted: { count: 7, run_ids: ids('a766c8bf-c60a-41a1-b3b5-e3916a061d8a', '0123abcd-0000-4000-8000-000000000000') },
        unknown: { count: 1, run_ids: [] },
      },
    }));
    expect(await screen.findByText('FAILURES BY CLASS · LAST 7D')).toBeInTheDocument();
    expect(classes().map((item) => item.firstElementChild?.textContent)).toEqual(['blocked', 'aborted', 'budget', 'unknown']);
    const blocked = within(classes()[0]!);
    expect(blocked.getByText('33')).toHaveClass('text-danger');
    // Eight characters of each id, dim, in the order the CLI gives them (newest first).
    expect(blocked.getAllByText(/^[0-9a-f]{8}$/).map((id) => id.textContent)).toEqual(['d862c453', '1d517854', '142d660e']);
    expect(blocked.getByText('d862c453')).toHaveClass('text-muted');
    expect(classes()[0]).not.toHaveTextContent('d862c453-27d1');
    expect(within(classes()[1]!).getAllByText(/^[0-9a-f]{8}$/).map((id) => id.textContent)).toEqual(['a766c8bf', '0123abcd']);
    expect(within(classes()[3]!).queryByText(/^[0-9a-f]{8}$/)).not.toBeInTheDocument();
  });

  it('puts classes with the same count in name order', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith({
      failures: { timeout: { count: 2, run_ids: [] }, blocked: { count: 2, run_ids: [] }, budget: { count: 9, run_ids: [] } },
    }));
    await screen.findByText('FAILURES BY CLASS · LAST 7D');
    expect(classes().map((item) => item.firstElementChild?.textContent)).toEqual(['budget', 'blocked', 'timeout']);
  });

  it('says there were no failures', async () => {
    setup(makeHelmraiserStatus(), byWindow, statsWith({ failures: {} }));
    await screen.findByText('FAILURES BY CLASS · LAST 7D');
    expect(screen.getByText('no failures')).toHaveClass('text-muted');
    expect(screen.queryByRole('list', { name: 'Failure classes' })).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard scout funnel', () => {
  const ALPHA = '/work/alpha';
  const BETA = '/work/beta';
  // Docs comes first, so lenses read in the order the rows give them, not a fixed one.
  const ROWS = [
    makeStatsScoutRow(ALPHA, 'docs', { scouts: 1, succeeded: 1, failed: 0, drafts_written: 2, pending: 2, cost_usd: 0.1 }),
    makeStatsScoutRow(ALPHA, 'state', {
      scouts: 2, succeeded: 1, failed: 1, drafts_written: 5, pending: 1, queued: 1, landed: 2, dropped: 1, failed_drafts: 0,
      queued_unchanged: 1, queued_changed: 1, queued_unknown: 1, cost_usd: 0.5,
    }),
    makeStatsScoutRow(ALPHA, 'guardrails'),
    makeStatsScoutRow(BETA, 'state', {
      scouts: 1, succeeded: 1, failed: 0, drafts_written: 3, pending: 0, queued: 0, landed: 2, dropped: 0, failed_drafts: 1,
      queued_unchanged: 0, queued_changed: 1, queued_unknown: 2, cost_usd: 0.25,
    }),
    makeStatsScoutRow(BETA, 'docs', {
      scouts: 2, succeeded: 1, failed: 1, drafts_written: 4, pending: 0, queued: 1, landed: 1, dropped: 2, failed_drafts: 0,
      queued_unchanged: 1, queued_changed: 0, queued_unknown: 0, cost_usd: 0.2,
    }),
    makeStatsScoutRow(BETA, 'guardrails'),
  ];
  const withRows = (rows: HelmraiserStatsScoutRow[]) => (since: HelmraiserStatsWindow): Promise<HelmraiserStats> =>
    Promise.resolve(makeHelmraiserStats(rows, { window: statsWindow(since) }));
  const table = () => within(screen.getByRole('table', { name: 'Scout funnel by lens' }));
  const rowOf = (name: string) => table().getByRole('rowheader', { name }).closest('tr')!;
  const cellsOf = (name: string) => within(rowOf(name)).getAllByRole('cell').map((cell) => cell.textContent);

  it('adds every project\'s rows up by lens, lenses in first-appearance order, then a total', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows(ROWS));
    expect(await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D')).toBeInTheDocument();
    expect(table().getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'lens', 'scouts (ok/failed)', 'drafts written', 'pending', 'queued', 'landed', 'dropped', 'failed drafts',
      'as written', 'cost',
    ]);
    expect(table().getAllByRole('rowheader').map((header) => header.textContent)).toEqual(['docs', 'state', 'guardrails', 'total']);
    // scouts (ok/failed), written, pending, queued, landed, dropped, failed drafts, as written (unchanged / changed / unknown), cost.
    expect(cellsOf('docs')).toEqual(['3 (2/1)', '6', '2', '1', '1', '2', '0', '1 / 0 / 0', '$0.30']);
    expect(cellsOf('state')).toEqual(['3 (2/1)', '8', '1', '1', '4', '1', '1', '1 / 2 / 3', '$0.75']);
    expect(cellsOf('guardrails')).toEqual(['0 (0/0)', '0', '0', '0', '0', '0', '0', '0 / 0 / 0', '$0.00']);
    expect(cellsOf('total')).toEqual(['6 (4/2)', '14', '3', '2', '5', '3', '1', '2 / 2 / 3', '$1.05']);
  });

  it('names running scouts in the scouts cell only while some are running, adding them up by lens and in the total', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows([
      makeStatsScoutRow(ALPHA, 'state', { scouts: 4, succeeded: 0, failed: 2, running: 2 }),
      makeStatsScoutRow(BETA, 'state', { scouts: 1, succeeded: 0, failed: 0, running: 1 }),
      makeStatsScoutRow(ALPHA, 'docs', { scouts: 2, succeeded: 2, failed: 0, running: 0 }),
      makeStatsScoutRow(ALPHA, 'guardrails'),
    ]));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(cellsOf('state')[0]).toBe('5 (0/2, 3 running)');
    expect(cellsOf('docs')[0]).toBe('2 (2/0)');
    expect(cellsOf('guardrails')[0]).toBe('0 (0/0)');
    expect(cellsOf('total')[0]).toBe('7 (2/2, 3 running)');
    expect(table().getAllByRole('columnheader')[1]).toHaveTextContent('scouts (ok/failed)');
  });

  it('lists the total\'s drops by class under the table, the classes that have any, in the contract\'s order, dim', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows([
      makeStatsScoutRow(ALPHA, 'docs', { scouts: 1, succeeded: 1, dropped: 3, dropped_by_class: { wrong: 2, unwanted: 1, duplicate: 0, unusable: 0, unclassified: 0 } }),
      makeStatsScoutRow(BETA, 'state', { scouts: 1, succeeded: 1, dropped: 6, dropped_by_class: { wrong: 0, unwanted: 4, duplicate: 0, unusable: 0, unclassified: 2 } }),
      makeStatsScoutRow(BETA, 'guardrails'),
    ]));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    const line = screen.getByText(/^dropped by class:/);
    expect(line).toHaveTextContent('dropped by class: wrong 2 · unwanted 5 · unclassified 2');
    expect(line).toHaveClass('text-muted');
    // Under the table, not inside it.
    expect(screen.getByRole('table', { name: 'Scout funnel by lens' })).not.toContainElement(line);
    expect(screen.getByRole('table', { name: 'Scout funnel by lens' }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads all five classes in the order wrong, unwanted, duplicate, unusable, unclassified', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows([
      makeStatsScoutRow(ALPHA, 'state', { scouts: 1, succeeded: 1, dropped: 15, dropped_by_class: { wrong: 1, unwanted: 2, duplicate: 3, unusable: 4, unclassified: 5 } }),
    ]));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(screen.getByText(/^dropped by class:/)).toHaveTextContent('dropped by class: wrong 1 · unwanted 2 · duplicate 3 · unusable 4 · unclassified 5');
  });

  it('leaves the dropped-by-class line out when nothing was dropped', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows([
      makeStatsScoutRow(ALPHA, 'state', { scouts: 2, succeeded: 2, drafts_written: 3, pending: 3 }),
    ]));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(screen.queryByText(/dropped by class/)).not.toBeInTheDocument();
  });

  it('keeps a zero landed plain in a lens that did scout, as ok means something landed', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows([
      makeStatsScoutRow(ALPHA, 'guardrails', { scouts: 4, succeeded: 0, failed: 2, landed: 0 }),
    ]));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(rowOf('guardrails')).not.toHaveClass('text-muted');
    expect(within(rowOf('guardrails')).getAllByRole('cell')[4]).not.toHaveClass('text-ok');
  });

  it('dims the whole row of a lens that had no scouts in the window, and picks out the rest in colour', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows(ROWS));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(rowOf('guardrails')).toHaveClass('text-muted');
    expect(rowOf('docs')).not.toHaveClass('text-muted');
    expect(rowOf('state')).not.toHaveClass('text-muted');
    expect(rowOf('total')).not.toHaveClass('text-muted');
    const state = within(rowOf('state')).getAllByRole('cell');
    // landed ok, dropped dim, failed drafts danger.
    expect(state[4]).toHaveClass('text-ok');
    expect(state[5]).toHaveClass('text-muted');
    expect(state[6]).toHaveClass('text-danger');
    // Nothing failed in docs: zero is not danger.
    expect(within(rowOf('docs')).getAllByRole('cell')[6]).not.toHaveClass('text-danger');
    // A dim row stays dim all through.
    expect(within(rowOf('guardrails')).getAllByRole('cell')[4]).not.toHaveClass('text-ok');
  });

  it('scrolls sideways inside its own box, its cells on one line, and says what unchanged and unknown mean', async () => {
    setup(makeHelmraiserStatus(), byWindow, withRows(ROWS));
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(screen.getByRole('table', { name: 'Scout funnel by lens' }).parentElement).toHaveClass('overflow-x-auto');
    for (const cell of [...table().getAllByRole('columnheader'), ...within(rowOf('state')).getAllByRole('cell')]) {
      expect(cell).toHaveClass('whitespace-nowrap');
    }
    expect(screen.getByText('as written = queued drafts unchanged / changed / unknown, where unchanged is exactly as the scout wrote it and unknown is a draft from before fingerprints')).toHaveClass('text-muted');
  });

  it('says so when there are no scout rows at all', async () => {
    setup();
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    expect(screen.getByText('no scout data')).toHaveClass('text-muted');
    expect(screen.queryByRole('table', { name: 'Scout funnel by lens' })).not.toBeInTheDocument();
  });
});

describe('HelmraiserDashboard section order', () => {
  it('puts the flywheel sections after health and before the models and the failed runs', async () => {
    setup();
    await screen.findByText('SCOUT FUNNEL · by lens · LAST 7D');
    await screen.findByText('FAILED RUNS (1)');
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'HEALTH · LAST 7D',
      'QUALITY · LAST 7D',
      'TRENDS · weekly, all time',
      'COST & TIME · LAST 7D',
      'FAILURES BY CLASS · LAST 7D',
      'SCOUT FUNNEL · by lens · LAST 7D',
      'MODELS · implementer',
      'FAILED RUNS (1)',
    ]);
  });
});
