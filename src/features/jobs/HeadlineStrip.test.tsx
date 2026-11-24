import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HelmraiserReport, HelmraiserReportWindow, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { HeadlineStrip } from './HeadlineStrip.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { makeHelmraiserReport, usageWindow } from './__fixtures__/helmraiser-report.ts';

// Deterministic local-time assertions (the report time renders as HH:MM).
beforeAll(() => { process.env.TZ = 'UTC'; });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(
  status: HelmraiserStatus | null = makeHelmraiserStatus(),
  report: (since: HelmraiserReportWindow) => Promise<HelmraiserReport> = () => Promise.resolve(makeHelmraiserReport()),
) {
  const workflow = { report: vi.fn(report) };
  const container = new Container();
  container.registerInstance(WORKFLOW, workflow as never);
  const onOpenDashboard = vi.fn();
  const view = (next: HelmraiserStatus | null) => (
    <ContainerProvider container={container}>
      <HeadlineStrip status={next} onOpenDashboard={onOpenDashboard} />
    </ContainerProvider>
  );
  const rendered = render(view(status));
  return { workflow, onOpenDashboard, rerender: (next: HelmraiserStatus | null) => rendered.rerender(view(next)) };
}

/** The value text of one headline figure, found by its label. */
const figure = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement!;

describe('HeadlineStrip', () => {
  it('asks for the 24h report once, says it is loading, and still offers the dashboard', async () => {
    const pending = deferred<HelmraiserReport>();
    const { workflow, onOpenDashboard } = setup(makeHelmraiserStatus(), () => pending.promise);
    expect(workflow.report).toHaveBeenCalledExactlyOnceWith('24h');
    expect(screen.getByText('loading report…')).toHaveClass('text-muted');
    fireEvent.click(screen.getByRole('button', { name: 'dashboard →' }));
    expect(onOpenDashboard).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(makeHelmraiserReport()); await pending.promise; });
    expect(screen.queryByText('loading report…')).not.toBeInTheDocument();
  });

  it('shows the last 24h figures: landed, failed, awaiting you, first pass and cost per landed run', async () => {
    setup();
    expect(await screen.findByText('LAST 24H · 16:05')).toBeInTheDocument();
    expect(figure('landed')).toHaveTextContent('50');
    expect(within(figure('landed')).getByText('50')).toHaveClass('text-ok');
    expect(figure('failed')).toHaveTextContent('1');
    expect(within(figure('failed')).getByText('1')).toHaveClass('text-danger');
    expect(figure('awaiting you')).toHaveTextContent('2');
    // 29 + 22 of 30 + 23 runs; 51/53 is 96.2%.
    expect(figure('first pass')).toHaveTextContent('51/53 · 96%');
    // $45.50 over 50 landed runs.
    expect(figure('cost / landed run')).toHaveTextContent('$0.91');
    expect(within(figure('cost / landed run')).getByText('$45.50 total')).toHaveClass('text-muted');
  });

  it('draws one usage bar per provider at its busiest window, ties to the shorter one, with warn and stop markers', async () => {
    const status = makeHelmraiserStatus();
    status.usage = {
      'openai-codex': {
        '5h': usageWindow(0.2),
        week: usageWindow(0.63, { warn_at: 0.8, stop_at: 0.9 }),
        month: usageWindow(0.4),
      },
      // 5h and week tie at 11%: the shorter window is the one shown.
      'opencode-go': { '5h': usageWindow(0.11), week: usageWindow(0.11), month: usageWindow(0.05) },
    };
    setup(status);
    await screen.findByText('LAST 24H · 16:05');
    expect(screen.getAllByRole('meter')).toHaveLength(2);

    const codex = screen.getByRole('meter', { name: 'openai-codex week' });
    expect(codex).toHaveAttribute('aria-valuenow', '63');
    expect(codex.querySelector('[data-fill]')).toHaveStyle({ width: '63%' });
    expect(codex.querySelector('[data-fill]')).toHaveClass('bg-info');
    expect(codex.querySelector('[data-marker="warn"]')).toHaveStyle({ left: '80%' });
    expect(codex.querySelector('[data-marker="warn"]')).toHaveClass('bg-attention');
    expect(codex.querySelector('[data-marker="stop"]')).toHaveStyle({ left: '90%' });
    expect(codex.querySelector('[data-marker="stop"]')).toHaveClass('bg-danger');
    expect(screen.getByText('63%')).toBeInTheDocument();

    const go = screen.getByRole('meter', { name: 'opencode-go 5h' });
    expect(go).toHaveAttribute('aria-valuenow', '11');
    expect(go.querySelector('[data-marker="warn"]')).toHaveStyle({ left: '80%' });
    expect(go.querySelector('[data-marker="stop"]')).toBeNull();
    expect(screen.getByText('11%')).toBeInTheDocument();
  });

  it('draws a provider that reports only some windows, as openai-codex reports week alone', async () => {
    const status = makeHelmraiserStatus();
    status.usage = { 'openai-codex': { week: usageWindow(0.18) }, 'opencode-go': {} };
    setup(status);
    await screen.findByText('LAST 24H · 16:05');
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    expect(screen.getByRole('meter', { name: 'openai-codex week' })).toHaveAttribute('aria-valuenow', '18');
  });

  it('shows no usage bars when status has not arrived, and still shows the report', async () => {
    setup(null);
    await screen.findByText('LAST 24H · 16:05');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(figure('landed')).toHaveTextContent('50');
  });

  it('asks again when the landed or failed count changes, not on any other status change, and keeps the old figures meanwhile', async () => {
    const status = makeHelmraiserStatus(); // queue.landed 40, queue.failed 16
    const next = deferred<HelmraiserReport>();
    const answers = [Promise.resolve(makeHelmraiserReport()), next.promise];
    const { workflow, rerender } = setup(status, () => answers.shift() ?? Promise.resolve(makeHelmraiserReport()));
    await screen.findByText('LAST 24H · 16:05');
    expect(workflow.report).toHaveBeenCalledTimes(1);

    // A status poll that moved other things only (queue size, a fresh timestamp, a new object): no new report.
    rerender({ ...status, updated_at: '2026-11-22T16:06:00+00:00', queued_count: 5, queue: { ...status.queue, queued: 5 } });
    rerender({ ...status, queue: { ...status.queue } });
    expect(workflow.report).toHaveBeenCalledTimes(1);

    // One more run landed: ask again, and the figures on screen stay until the answer comes.
    rerender({ ...status, queue: { ...status.queue, landed: 41 } });
    await waitFor(() => expect(workflow.report).toHaveBeenCalledTimes(2));
    expect(figure('landed')).toHaveTextContent('50');
    expect(screen.queryByText('loading report…')).not.toBeInTheDocument();
    await act(async () => { next.resolve(makeHelmraiserReport({ landed_count: 51 })); await next.promise; });
    expect(figure('landed')).toHaveTextContent('51');

    rerender({ ...status, queue: { ...status.queue, landed: 41, failed: 17 } });
    await waitFor(() => expect(workflow.report).toHaveBeenCalledTimes(3));
    expect(workflow.report.mock.calls.every(([since]) => since === '24h')).toBe(true);
  });

  it('says in dim text why there is no report, without blocking the dashboard link', async () => {
    const { onOpenDashboard } = setup(makeHelmraiserStatus(), () => Promise.reject(
      new WireCallError('helmraiser report timed out after 300 s', 'helmraiser_cli_error'),
    ));
    const message = await screen.findByText('report failed — helmraiser report timed out after 300 s');
    expect(message).toHaveClass('text-muted');
    expect(screen.queryByText('loading report…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dashboard →' }));
    expect(onOpenDashboard).toHaveBeenCalledOnce();
  });

  it('keeps the last good figures when a later read fails, and drops the message when one succeeds again', async () => {
    const status = makeHelmraiserStatus();
    const answers: Array<() => Promise<HelmraiserReport>> = [
      () => Promise.resolve(makeHelmraiserReport()),
      () => Promise.reject(new WireCallError('Helmraiser CLI not found — install it or set HELMRAISER_BIN', 'helmraiser_unavailable')),
      () => Promise.resolve(makeHelmraiserReport({ landed_count: 52 })),
    ];
    const { rerender } = setup(status, () => answers.shift()!());
    await screen.findByText('LAST 24H · 16:05');

    rerender({ ...status, queue: { ...status.queue, landed: 41 } });
    expect(await screen.findByText('report failed — Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net')).toHaveClass('text-muted');
    expect(figure('landed')).toHaveTextContent('50');
    expect(figure('first pass')).toHaveTextContent('51/53 · 96%');

    rerender({ ...status, queue: { ...status.queue, landed: 42 } });
    await waitFor(() => expect(figure('landed')).toHaveTextContent('52'));
    expect(screen.queryByText(/report failed/)).not.toBeInTheDocument();
  });

  it('shows — for first pass and cost per landed run when there were no runs, and no danger for zero failures', async () => {
    setup(makeHelmraiserStatus(), () => Promise.resolve(makeHelmraiserReport({
      landed_count: 0, awaiting_count: 0, failed: [], models: [], cost: { total_usd: 0, by_model: {} },
    })));
    await screen.findByText('LAST 24H · 16:05');
    expect(figure('first pass')).toHaveTextContent('—');
    expect(figure('cost / landed run')).toHaveTextContent('—');
    expect(figure('cost / landed run')).not.toHaveTextContent('total');
    expect(within(figure('failed')).getByText('0')).not.toHaveClass('text-danger');
  });
});
