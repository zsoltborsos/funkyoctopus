import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import { WireCallError } from '@shared/transport/errors.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { RunLog } from './RunLog.tsx';
import type { HelmraiserLogEvent } from '@shared/transport/protocol.ts';
import { makeFailedRunLog } from './__fixtures__/helmraiser-log.ts';

// Deterministic local-time assertions (the timeline renders HH:MM:SS local).
beforeAll(() => { process.env.TZ = 'UTC'; });

const RUN_ID = '142d660e-8ed6-4338-9413-5ad16510baaa';

/** A click inside async act, so the read it starts has settled when this resolves (the fake-timer tests cannot waitFor). */
const click = (element: HTMLElement) => act(() => { fireEvent.click(element); return Promise.resolve(); });

function renderLog(log: Mock, follow = false) {
  const container = new Container();
  container.registerInstance(WORKFLOW, { log } as never);
  const view = render(
    <ContainerProvider container={container}><RunLog runId={RUN_ID} follow={follow} /></ContainerProvider>,
  );
  return { ...view, toggle: () => screen.getByRole('button', { name: 'LOG' }) };
}

/** The four timeline columns of one row: time, stage, type, summary. */
const cells = (row: HTMLElement): string[] =>
  [...(row.firstElementChild?.children ?? [])].map((cell) => cell.textContent ?? '');

describe('RunLog', () => {
  it('is collapsed until asked, and reads nothing before that', () => {
    const log = vi.fn();
    const { toggle } = renderLog(log);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Run log' })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('opens a timeline of time, stage, type and a one-line summary', async () => {
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: false });
    const { toggle } = renderLog(log);
    await userEvent.setup().click(toggle());

    const rows = within(await screen.findByRole('list', { name: 'Run log' })).getAllByRole('listitem');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(log).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(rows).toHaveLength(39);
    expect(cells(rows[0] as HTMLElement)).toEqual([
      '16:35:56', '', 'run_start', 'task -home-example-projects-acme-monorepo:app-sign-in-tagline-mansalva · pi 1.3.0',
    ]);
    expect(cells(rows[8] as HTMLElement)).toEqual(['16:36:11', 'plan', 'stage_start', 'plan']);
    expect(cells(rows[10] as HTMLElement)).toEqual(['16:36:12', 'plan', 'agent_start', '']);
    expect(cells(rows[15] as HTMLElement)[2]).toBe('tool_execution_end');
    expect(cells(rows[15] as HTMLElement)[3]).toBe('read ok');
  });

  it('lists each verify check as pass or fail, with the tail of only the failed ones in a <pre>', async () => {
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: false });
    const { toggle } = renderLog(log);
    await userEvent.setup().click(toggle());

    const list = await screen.findByRole('list', { name: 'Run log' });
    const verify = within(list).getAllByRole('listitem').find((row) => cells(row)[2] === 'verify_result') as HTMLElement;
    expect(cells(verify)[3]).toBe('failed: diff-check');
    const checks = within(verify).getByRole('group', { name: 'Verify checks' });
    expect([...checks.children].filter((node) => node.tagName === 'P').map((node) => node.textContent)).toEqual([
      'PASS lint · 1.4 s',
      'PASS typecheck · 9.5 s',
      'PASS release-tests · 87 s',
      'FAIL diff-check · exit 2 · 0.5 s',
    ]);
    const tails = checks.querySelectorAll('pre');
    expect(tails).toHaveLength(1);
    expect(tails[0]?.textContent).toBe(
      'acme-app/assets/fonts/Mansalva-OFL.txt:21: trailing whitespace.\n+fonts, including any derivative works, can be bundled, embedded,',
    );
    // The passing checks' output is not shown.
    expect(within(verify).queryByText(/Test Suites/)).toBeNull();
  });

  it('shows how the run ended by its status, without repeating the reason its row already shows', async () => {
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: false });
    const { toggle } = renderLog(log);
    await userEvent.setup().click(toggle());

    const list = await screen.findByRole('list', { name: 'Run log' });
    const end = within(list).getAllByRole('listitem').at(-1) as HTMLElement;
    expect(cells(end)).toEqual(['16:46:28', '', 'run_end', 'failed']);
    expect(within(end).queryByText(/Keeping it unchanged/)).toBeNull();
  });

  it.each([
    ['failed', 'text-danger'],
    ['aborted', 'text-danger'],
    ['landed', 'text-ok'],
    // A run parked for the owner's approval also writes run_end; that is waiting, not a fault.
    ['awaiting_approval', 'text-muted'],
  ])('colours a run that ended %s as %s', async (status, tone) => {
    const end = { id: 9, ts: 1792428388, source: 'helmraiser', stage: null, type: 'run_end', payload: { status } };
    const { toggle } = renderLog(vi.fn().mockResolvedValue({ events: [end], truncated: false }));
    await userEvent.setup().click(toggle());
    const row = within(await screen.findByRole('list', { name: 'Run log' })).getByRole('listitem');
    expect(cells(row)[3]).toBe(status);
    expect(row.firstElementChild?.lastElementChild).toHaveClass(tone);
  });

  it('says so when earlier events were left out, and not otherwise', async () => {
    const user = userEvent.setup();
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: true });
    const { toggle, unmount } = renderLog(log);
    await user.click(toggle());
    expect(await screen.findByText('39 most recent events · earlier ones not shown')).toBeInTheDocument();
    unmount();

    const again = renderLog(vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: false }));
    await user.click(again.toggle());
    await screen.findByRole('list', { name: 'Run log' });
    expect(screen.queryByText(/earlier ones not shown/)).toBeNull();
  });

  it('says it is reading, then that a run has no events yet', async () => {
    let resolve: (value: { events: never[]; truncated: boolean }) => void = () => undefined;
    const log = vi.fn(() => new Promise<{ events: never[]; truncated: boolean }>((done) => { resolve = done; }));
    const { toggle } = renderLog(log);
    await userEvent.setup().click(toggle());
    expect(screen.getByRole('status')).toHaveTextContent('reading the log…');
    resolve({ events: [], truncated: false });
    expect(await screen.findByText('no events yet')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    ['an unknown run', new WireCallError('helmraiser log failed: unknown run: 142d660e', 'helmraiser_cli_error'), '⚠ Log not loaded — unknown run: 142d660e'],
    ['a missing CLI', new WireCallError('Helmraiser CLI not found: helmraiser', 'helmraiser_unavailable'), '⚠ Log not loaded — Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net'],
    ['a plain failure', new Error('boom'), '⚠ Log not loaded — boom'],
  ])('shows %s as an alert in place, and the toggle still works', async (_name, failure, message) => {
    const user = userEvent.setup();
    const { toggle } = renderLog(vi.fn().mockRejectedValue(failure));
    await user.click(toggle());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByRole('list', { name: 'Run log' })).toBeNull();
    await user.click(toggle());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses, and reads afresh when opened again', async () => {
    const user = userEvent.setup();
    const log = vi.fn()
      .mockResolvedValueOnce({ events: makeFailedRunLog().slice(0, 2), truncated: false })
      .mockResolvedValueOnce({ events: makeFailedRunLog().slice(0, 5), truncated: false });
    const { toggle } = renderLog(log);
    await user.click(toggle());
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Run log' })).getAllByRole('listitem')).toHaveLength(2));
    await user.click(toggle());
    expect(screen.queryByRole('list', { name: 'Run log' })).toBeNull();
    await user.click(toggle());
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Run log' })).getAllByRole('listitem')).toHaveLength(5));
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('RunLog following a running run', () => {
  afterEach(() => { vi.useRealTimers(); });

  const all = makeFailedRunLog();
  const page = (from: number, to: number, truncated = false) => ({ events: all.slice(from, to), truncated });
  const rowCount = () => within(screen.getByRole('list', { name: 'Run log' })).getAllByRole('listitem').length;
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  async function openFollowing(log: Mock, follow = true) {
    vi.useFakeTimers();
    const view = renderLog(log, follow);
    await click(view.toggle());
    return view;
  }

  it('reads what is new after the last seen event every few seconds, and appends it', async () => {
    const log = vi.fn().mockResolvedValueOnce(page(0, 5)).mockResolvedValueOnce(page(5, 8)).mockResolvedValue(page(8, 8));
    await openFollowing(log);
    expect(log).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(rowCount()).toBe(5);

    await tick(2_999);
    expect(log).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(log).toHaveBeenLastCalledWith(RUN_ID, 337486); // the fifth event's id
    expect(rowCount()).toBe(8);

    await tick(3_000);
    expect(log).toHaveBeenLastCalledWith(RUN_ID, 337489); // the eighth's
    expect(rowCount()).toBe(8);
  });

  it('never starts a read while the last one is still out', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const log = vi.fn().mockResolvedValueOnce(page(0, 2)).mockImplementationOnce(() => new Promise((done) => { finish = done; }));
    await openFollowing(log);
    await tick(3_000);
    expect(log).toHaveBeenCalledTimes(2);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(2);
    await act(async () => { finish(page(2, 3)); await vi.advanceTimersByTimeAsync(0); });
    await tick(3_000);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('keeps the last 200 events as it follows and says earlier ones are left out', async () => {
    const synthetic = (from: number, to: number): HelmraiserLogEvent[] => Array.from({ length: to - from }, (_, i) => (
      { id: from + i, ts: 1792427756, source: 'pi', stage: 'implement', type: 'turn_start', payload: {} }
    ));
    const log = vi.fn()
      .mockResolvedValueOnce({ events: synthetic(1, 200), truncated: false }) // ids 1..199
      .mockResolvedValue({ events: synthetic(200, 205), truncated: false });
    await openFollowing(log);
    expect(rowCount()).toBe(199);
    expect(screen.queryByText(/earlier ones not shown/)).toBeNull();

    await tick(3_000);
    expect(rowCount()).toBe(200);
    expect(screen.getByText('200 most recent events · earlier ones not shown')).toBeInTheDocument();
    expect(log).toHaveBeenLastCalledWith(RUN_ID, 199);
  });

  it('stops when the log is collapsed, and when it is unmounted', async () => {
    const log = vi.fn().mockResolvedValue(page(0, 2));
    const { toggle, unmount } = await openFollowing(log);
    await tick(3_000);
    expect(log).toHaveBeenCalledTimes(2);

    await click(toggle());
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(2);

    await click(toggle());
    expect(log).toHaveBeenCalledTimes(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('ignores a read that comes back after the log was collapsed', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const log = vi.fn(() => new Promise((done) => { finish = done; }));
    const { toggle } = await openFollowing(log);
    await click(toggle());
    await act(async () => { finish(page(0, 3)); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole('list', { name: 'Run log' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops once the run has ended', async () => {
    const log = vi.fn().mockResolvedValueOnce(page(0, 36)).mockResolvedValueOnce(page(36, 39)).mockResolvedValue(page(39, 39));
    await openFollowing(log);
    await tick(3_000);
    expect(rowCount()).toBe(39);
    expect(within(screen.getByRole('list', { name: 'Run log' })).getAllByRole('listitem').at(-1)?.textContent).toContain('run_end');
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does not follow a run that is not running', async () => {
    const log = vi.fn().mockResolvedValue(page(0, 5));
    await openFollowing(log, false);
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('shows a failed follow-up read in place and carries on; a failed first read is not retried', async () => {
    const log = vi.fn()
      .mockResolvedValueOnce(page(0, 3))
      .mockRejectedValueOnce(new WireCallError('helmraiser log failed: database is locked', 'helmraiser_cli_error'))
      .mockResolvedValueOnce(page(3, 5));
    await openFollowing(log);
    await tick(3_000);
    expect(screen.getByRole('alert')).toHaveTextContent('⚠ Log not loaded — database is locked');
    expect(rowCount()).toBe(3);
    await tick(3_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowCount()).toBe(5);
    expect(log).toHaveBeenLastCalledWith(RUN_ID, 337484);
  });

  it('does not retry a first read that failed', async () => {
    const log = vi.fn().mockRejectedValue(new WireCallError('helmraiser log failed: unknown run: 142d660e', 'helmraiser_cli_error'));
    await openFollowing(log);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stops following, after one last full read, when the row stops being a running one', async () => {
    const log = vi.fn().mockResolvedValueOnce(page(0, 5)).mockResolvedValue(page(0, 39));
    const container = new Container();
    container.registerInstance(WORKFLOW, { log } as never);
    vi.useFakeTimers();
    const tree = (follow: boolean) => (
      <ContainerProvider container={container}><RunLog runId={RUN_ID} follow={follow} /></ContainerProvider>
    );
    const view = render(tree(true));
    await click(screen.getByRole('button', { name: 'LOG' }));
    expect(rowCount()).toBe(5);

    view.rerender(tree(false));
    await tick(0);
    expect(log).toHaveBeenLastCalledWith(RUN_ID);
    expect(rowCount()).toBe(39);
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('opens scrolled to the newest event, and keeps to the bottom as more arrive unless the reader scrolled up', async () => {
    let height = 900;
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    const log = vi.fn().mockResolvedValueOnce(page(0, 5)).mockResolvedValueOnce(page(5, 6)).mockResolvedValueOnce(page(6, 7)).mockResolvedValue(page(7, 7));
    await openFollowing(log);
    const list = screen.getByRole('list', { name: 'Run log' });
    expect(list.scrollTop).toBe(900);

    height = 1500;
    await tick(3_000);
    expect(list.scrollTop).toBe(1500);

    list.scrollTop = 100;
    fireEvent.scroll(list);
    height = 2000;
    await tick(3_000);
    expect(rowCount()).toBe(7);
    expect(list.scrollTop).toBe(100);
    vi.restoreAllMocks();
  });
});
