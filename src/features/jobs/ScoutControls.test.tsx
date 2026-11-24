import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import type { HelmraiserScoutLens, HelmraiserScouts, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { WORKFLOW } from './workflow.client.ts';
import { scoutSettingsFixture } from './scout-settings.fixture.ts';
import { ScoutControls } from './ScoutControls.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { makeHelmraiserStats, makeStatsScoutRow } from './__fixtures__/helmraiser-stats.ts';

const A = '/work/alpha';
const B = '/work/repo two';
const PAUSED = '/work/paused';
const LENSES: HelmraiserScoutLens[] = ['state', 'docs', 'tests', 'guardrails'];
function makeScouts(overrides: Partial<HelmraiserScouts> = {}): HelmraiserScouts {
  return { focus_projects: [A, B, PAUSED], paused_projects: [PAUSED], pending: [], running: [], recent: [], ...overrides };
}
function statusWith(scouts: HelmraiserScouts): HelmraiserStatus {
  return { ...makeHelmraiserStatus(), scouts };
}
function setup(options: {
  status?: HelmraiserStatus | null;
  disabled?: boolean;
  requestScouts?: ReturnType<typeof vi.fn>;
  cancelScouts?: ReturnType<typeof vi.fn>;
  refresh?: Mock<() => Promise<void>>;
} = {}) {
  const requestScouts = options.requestScouts ?? vi.fn().mockResolvedValue({ requested: [A], already_pending: [B] });
  const cancelScouts = options.cancelScouts ?? vi.fn().mockResolvedValue({ cancelled: [A], not_pending: [] });
  const refresh = options.refresh ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const stats = vi.fn().mockResolvedValue(makeHelmraiserStats(
    [A, B, PAUSED].flatMap((project) => LENSES.map((lens) => makeStatsScoutRow(project, lens))),
  ));
  const container = new Container();
  container.registerInstance(WORKFLOW, { requestScouts, cancelScouts, stats, scoutSettings: vi.fn().mockResolvedValue(scoutSettingsFixture()) } as never);
  const view = (status: HelmraiserStatus | null, disabled = false) => (
    <ContainerProvider container={container}>
      <ScoutControls status={status} onRefresh={refresh} disabled={disabled} />
    </ContainerProvider>
  );
  const rendered = render(view(options.status === undefined ? statusWith(makeScouts()) : options.status, options.disabled));
  return { ...rendered, requestScouts, cancelScouts, refresh, stats,
    update: (status: HelmraiserStatus | null, disabled = false) => rendered.rerender(view(status, disabled)) };
}
/** The grid shows once the stats have been read. */
const grid = () => screen.findByRole('table');
const cell = (project: string, lens = 'state') => screen.getByRole('cell', { name: `${lens} cell for ${project}` });
const scout = (project: string, lens = 'state') => screen.getByRole('button', { name: `Scout ${lens} for ${project}` });
const scoutButtons = () => screen.getAllByRole('button', { name: /^Scout / });
const cancel = (project: string, lens = 'state') => screen.getByRole('button', { name: `Cancel ${lens} scout for ${project}` });
const pendingRow = (project: string, wait_reason: HelmraiserScouts['pending'][number]['wait_reason'] = null) => ({
  project, requested_at: '2026-10-02T10:00:00Z', wait_reason,
});

afterEach(() => vi.useRealTimers());

describe('ScoutControls grid and requests', () => {
  it.each(LENSES)('requests the %s lens of one project from its cell', async (lens) => {
    const { requestScouts } = setup();
    await grid();
    fireEvent.click(scout(A, lens));
    await waitFor(() => expect(requestScouts).toHaveBeenCalledExactlyOnceWith([A], lens));
  });

  it.each([
    ['older Helmraiser', makeHelmraiserStatus(), 'Update Helmraiser to enable scouting'],
    ['unavailable status', null, 'Scout status unavailable'],
  ])('%s shows its hint without a grid or automatic calls', (_name, status, hint) => {
    if (status) delete status.scouts;
    const { requestScouts, cancelScouts, stats } = setup({ status });
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Scout / })).not.toBeInTheDocument();
    expect(stats).not.toHaveBeenCalled();
    expect(requestScouts).not.toHaveBeenCalled();
    expect(cancelScouts).not.toHaveBeenCalled();
  });

  it('keeps its heading, with the grid above the automation settings', async () => {
    setup();
    await grid();
    const section = screen.getByRole('region', { name: 'Scout controls' });
    expect(within(section).getByRole('heading', { name: 'SCOUT' })).toBeInTheDocument();
    const settings = await within(section).findByRole('region', { name: 'Scout automation settings' });
    expect(screen.getByRole('table').compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows mixed result feedback by project basename and keeps it across a status refresh', async () => {
    const { requestScouts, refresh, update } = setup();
    await grid();
    fireEvent.click(scout(A));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(requestScouts).toHaveBeenCalledExactlyOnceWith([A], 'state');
    expect(screen.getByText(/requested:/)).toHaveTextContent('requested: alpha');
    expect(screen.getByText(/already pending:/)).toHaveTextContent('already pending: repo two');
    update(statusWith(makeScouts()));
    expect(screen.getByText(/requested:/)).toHaveTextContent('alpha');
  });

  it('blocks duplicate and overlapping actions while a request is in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    const { requestScouts, cancelScouts } = setup({
      status: statusWith(makeScouts({ pending: [pendingRow(B)] })),
      requestScouts: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    });
    await grid();
    fireEvent.click(scout(A));
    fireEvent.click(scout(A));
    fireEvent.click(scout(A, 'docs'));
    fireEvent.click(cancel(B));
    for (const button of scoutButtons()) expect(button).toBeDisabled();
    expect(cancel(B)).toBeDisabled();
    expect(requestScouts).toHaveBeenCalledOnce();
    expect(cancelScouts).not.toHaveBeenCalled();
    await act(async () => { release({ requested: [A], already_pending: [] }); await Promise.resolve(); });
  });

  it.each([
    new WireCallError('project is paused: /work/alpha', 'helmraiser_cli_error'),
    new Error('Vault blocked access to /work/alpha'),
  ])('shows refusal %s in the cell it came from and permits retry without refresh', async (error) => {
    const { refresh } = setup({ requestScouts: vi.fn().mockRejectedValue(error) });
    await grid();
    fireEvent.click(scout(A, 'docs'));
    expect(await within(cell(A, 'docs')).findByRole('alert')).toHaveTextContent(error.message);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(scout(A, 'docs')).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears a cell\'s refusal when the cell is asked again', async () => {
    const requestScouts = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce({ requested: [A], already_pending: [] });
    setup({ requestScouts });
    await grid();
    fireEvent.click(scout(A));
    expect(await within(cell(A)).findByRole('alert')).toHaveTextContent('denied');
    fireEvent.click(scout(A));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(requestScouts).toHaveBeenCalledTimes(2);
  });

  it('honours the panel disabled state', async () => {
    setup({ disabled: true, status: statusWith(makeScouts({ pending: [pendingRow(A)] })) });
    await grid();
    for (const button of scoutButtons()) expect(button).toBeDisabled();
    expect(cancel(A)).toBeDisabled();
  });

  it('identifies a refresh failure separately while retaining the request\'s success', async () => {
    setup({ refresh: vi.fn().mockRejectedValue(new Error('offline')) });
    await grid();
    fireEvent.click(scout(A));
    expect(await screen.findByRole('alert')).toHaveTextContent('Status refresh failed: offline');
    expect(screen.getByText(/requested:/)).toHaveTextContent('alpha');
  });
});

describe('ScoutControls cancellation', () => {
  it('isolates sibling lens cancellation and its cell error', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const rows = [pendingRow(A), { ...pendingRow(A), lens: 'docs' as const }];
    const { cancelScouts, update } = setup({ status: statusWith(makeScouts({ pending: rows })),
      cancelScouts: vi.fn().mockRejectedValue(new Error('denied')) });
    await grid();
    fireEvent.click(cancel(A, 'docs'));
    expect(await within(cell(A, 'docs')).findByRole('alert')).toHaveTextContent('denied');
    expect(cancelScouts).toHaveBeenCalledExactlyOnceWith([A], 'docs');
    expect(within(cell(A, 'state')).queryByRole('alert')).toBeNull();
    // Once the docs scout is no longer waiting, its cancel refusal goes with it.
    update(statusWith(makeScouts({ pending: [rows[0]!] })));
    expect(cancel(A)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('cancels only the chosen pending cell and preserves results after its refreshed row disappears', async () => {
    const { cancelScouts, refresh, update } = setup({
      status: statusWith(makeScouts({ pending: [pendingRow(A), pendingRow(PAUSED)] })),
      cancelScouts: vi.fn().mockResolvedValue({ cancelled: [PAUSED], not_pending: [] }),
    });
    await grid();
    fireEvent.click(cancel(PAUSED));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(cancelScouts).toHaveBeenCalledExactlyOnceWith([PAUSED], 'state');
    // No optimistic status changes: even successful cancellation waits for Helmraiser.
    expect(cancel(PAUSED)).toBeInTheDocument();
    update(statusWith(makeScouts({ pending: [pendingRow(A)] })));
    expect(screen.getByText(/cancelled:/)).toHaveTextContent('paused');
    expect(screen.getByText(/not pending:/)).toHaveTextContent('none');
    expect(cancel(A)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Cancel state scout for ${PAUSED}` })).not.toBeInTheDocument();
  });

  it('shows not-pending cancellation feedback and refreshes', async () => {
    const { refresh } = setup({ status: statusWith(makeScouts({ pending: [pendingRow(A)] })),
      cancelScouts: vi.fn().mockResolvedValue({ cancelled: [], not_pending: [A] }) });
    await grid();
    fireEvent.click(cancel(A));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByText(/not pending:/)).toHaveTextContent('alpha');
  });

  it.each([new WireCallError('not a focus project', 'helmraiser_cli_error'), new Error('Vault denied')])(
    'retains the pending cell with local cancellation failure %s', async (error) => {
      const { refresh } = setup({ status: statusWith(makeScouts({ pending: [pendingRow(A), pendingRow(B)] })),
        cancelScouts: vi.fn().mockRejectedValue(error) });
      await grid();
      fireEvent.click(cancel(A));
      expect(await within(cell(A)).findByRole('alert')).toHaveTextContent(error.message);
      expect(within(cell(B)).queryByRole('alert')).toBeNull();
      expect(cancel(A)).toBeEnabled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it('disables every local action during a delayed cancellation', async () => {
    let release: (value: unknown) => void = () => undefined;
    const { cancelScouts, requestScouts } = setup({ status: statusWith(makeScouts({ pending: [pendingRow(A), pendingRow(B)] })),
      cancelScouts: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    await grid();
    fireEvent.click(cancel(A));
    fireEvent.click(cancel(B));
    fireEvent.click(scout(A, 'docs'));
    expect(cancel(A)).toBeDisabled();
    expect(cancel(B)).toBeDisabled();
    for (const button of scoutButtons()) expect(button).toBeDisabled();
    expect(cancelScouts).toHaveBeenCalledOnce();
    expect(requestScouts).not.toHaveBeenCalled();
    await act(async () => { release({ cancelled: [A], not_pending: [] }); await Promise.resolve(); });
  });

  it('shows cancellation success even if the status refresh fails', async () => {
    setup({ status: statusWith(makeScouts({ pending: [pendingRow(A)] })),
      refresh: vi.fn().mockRejectedValue(new Error('offline')) });
    await grid();
    fireEvent.click(cancel(A));
    expect(await screen.findByRole('alert')).toHaveTextContent('Status refresh failed: offline');
    expect(screen.getByText(/cancelled:/)).toHaveTextContent('alpha');
  });
});
