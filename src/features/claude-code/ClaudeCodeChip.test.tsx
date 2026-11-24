import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import { TAB_FOLDER, TabFolders } from '@features/chat/tab-folders.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import type {
  ClaudeAuthInfo,
  ClaudeRecentSession,
  ClaudeStatusResult,
  ClaudeUsageLimit,
} from '@shared/transport/protocol.ts';
import { CLAUDE_CODE } from './claude-code.client.ts';
import { ClaudeCodeChip } from './ClaudeCodeChip.tsx';

const NOW = Date.UTC(2026, 9, 17, 17, 0, 0);
const MIN = 60_000;
const NOT_LOGGED_IN = 'Claude Code is not logged in — run `claude`, then /login, in a terminal';

const limit = (overrides: Partial<ClaudeUsageLimit> & Pick<ClaudeUsageLimit, 'kind' | 'label'>): ClaudeUsageLimit => ({
  percent: 10,
  resetsAt: null,
  active: false,
  ...overrides,
});

/** The shape of the recorded /usage report: 5h 72 %, week 72 %, Fable week 11 %. */
const limits = (): ClaudeUsageLimit[] => [
  limit({ kind: 'session', label: '5h', percent: 72, resetsAt: NOW + 90 * MIN, active: true }),
  limit({ kind: 'weekly_all', label: 'week', percent: 72, resetsAt: NOW + 4 * 24 * 60 * MIN }),
  limit({ kind: 'weekly_scoped', label: 'Fable week', percent: 11, resetsAt: NOW + 4 * 24 * 60 * MIN }),
];

const okStatus = (overrides: Partial<ClaudeStatusResult> = {}): ClaudeStatusResult => ({
  cli: 'ok',
  auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
  usage: { limits: limits(), fetchedAt: NOW - 2 * MIN },
  live: [
    { sessionId: 's1', name: 'alpha-a', cwd: '/home/example/projects/alpha', status: 'busy', kind: 'interactive', startedAt: 1 },
    { sessionId: 's2', name: 'beta-b', cwd: '/home/example/projects/beta', status: 'idle', kind: 'interactive', startedAt: 2 },
  ],
  ...overrides,
});

/** A sign-in billed per use: the sidecar reads no quota for it. */
const meteredStatus = (auth: ClaudeAuthInfo): ClaudeStatusResult => ({ cli: 'ok', auth, live: okStatus().live });

const recentRows = (): ClaudeRecentSession[] => [
  { sessionId: 'r1', title: 'Flaky status poll', lastModified: NOW - 2 * 60 * MIN, gitBranch: 'main' },
  { sessionId: 'r2', title: 'Draft the release notes', lastModified: NOW - 3 * 24 * 60 * MIN },
];

interface Setup {
  status?: ClaudeStatusResult | Error;
  /** Successive answers to `claude.status`; the last repeats. */
  statuses?: ClaudeStatusResult[];
  sessions?: ClaudeRecentSession[] | Error;
  root?: string | null;
  connected?: boolean;
}

function renderChip({ status = okStatus(), statuses, sessions = recentRows(), root = '/home/example/projects/alpha', connected = true }: Setup = {}) {
  const queue = statuses ? [...statuses] : null;
  const claude = {
    status: vi.fn((_refresh?: boolean) => {
      if (queue) return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
      return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
    }),
    sessions: vi.fn((_root: string | null) => (sessions instanceof Error ? Promise.reject(sessions) : Promise.resolve(sessions))),
  };
  const preferences = new PreferencesService(new MemoryStorageAdapter());
  // The shown chat tab's folder scopes the recent sessions.
  const folder = new TabFolders(new MemoryStorageAdapter()).forTab('main');
  if (root !== null) folder.set({ id: root, name: 'alpha', path: root, envTier: 'normal' });
  const container = new Container();
  container.registerInstance(CLAUDE_CODE, claude as never);
  container.registerInstance(PREFERENCES, preferences);
  container.registerInstance(TAB_FOLDER, folder);
  const view = render(
    <ContainerProvider container={container}>
      <ClaudeCodeChip connected={connected} />
    </ContainerProvider>,
  );
  return { claude, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ClaudeCodeChip states', () => {
  it('shows nothing until Claude Code answers, nor while disconnected, nor when the read fails', async () => {
    const { claude, container } = renderChip({ connected: false });
    expect(container).toBeEmptyDOMElement();
    expect(claude.status).not.toHaveBeenCalled();

    const failing = renderChip({ status: new Error('boom') });
    await waitFor(() => expect(failing.claude.status).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /claude/i })).not.toBeInTheDocument();
  });

  it('shows the plan with the 5h and weekly percentages, quiet while there is room', async () => {
    renderChip();
    const chip = await screen.findByRole('button', { name: /Claude Max/ });
    expect(chip).toHaveTextContent('Claude Max · 5h 72% · wk 72%');
    expect(chip).not.toHaveClass('text-attention');
  });

  it('turns to attention when an active limit reaches 80 %', async () => {
    renderChip({
      status: okStatus({
        usage: { fetchedAt: NOW, limits: [limit({ kind: 'session', label: '5h', percent: 80, active: true }), limit({ kind: 'weekly_all', label: 'week', percent: 30 })] },
      }),
    });
    const chip = await screen.findByRole('button', { name: /Claude Max/ });
    expect(chip).toHaveClass('text-attention');
    expect(chip).toHaveTextContent('Claude Max · 5h 80% · wk 30%');
  });

  it('turns to attention when any limit reaches 80 %, active or not', async () => {
    renderChip({
      status: okStatus({
        usage: { fetchedAt: NOW, limits: [limit({ kind: 'session', label: '5h', percent: 20, active: true }), limit({ kind: 'weekly_all', label: 'week', percent: 95 })] },
      }),
    });
    expect(await screen.findByRole('button', { name: /Claude Max/ })).toHaveClass('text-attention');
  });

  it('drops a meter it was not given rather than inventing one', async () => {
    renderChip({ status: okStatus({ usage: { fetchedAt: NOW, limits: [limit({ kind: 'weekly_all', label: 'week', percent: 41 })] } }) });
    expect(await screen.findByRole('button', { name: /Claude Max/ })).toHaveTextContent('Claude Max · wk 41%');
  });

  it('asks for attention when logged out, with the humane line as the tooltip', async () => {
    renderChip({
      status: { cli: 'ok', auth: { loggedIn: false, authMethod: 'none' }, live: [], error: NOT_LOGGED_IN },
    });
    const chip = await screen.findByRole('button', { name: /logged out/ });
    expect(chip).toHaveTextContent('Claude · logged out');
    expect(chip).toHaveClass('text-attention');
    expect(chip).toHaveAttribute('title', NOT_LOGGED_IN);
  });

  it('names an API key on the chip, so metered use is never a surprise', async () => {
    renderChip({
      status: meteredStatus({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
    });
    const chip = await screen.findByRole('button', { name: /API key/ });
    expect(chip).toHaveTextContent('Claude · API key');
    expect(chip).not.toHaveClass('text-attention');
  });

  it('asks for attention when usage was refused because an API key is in use', async () => {
    const line = 'Claude is on an API key — no subscription quota to read';
    renderChip({ status: okStatus({ usage: { error: line } }) });
    const chip = await screen.findByRole('button', { name: /usage unavailable/ });
    expect(chip).toHaveTextContent('Claude Max · usage unavailable');
    expect(chip).toHaveClass('text-attention');
    expect(chip).toHaveAttribute('title', line);
  });

  it('asks for attention when the CLI itself fails', async () => {
    renderChip({ status: { cli: 'error', live: [], error: 'claude auth timed out after 10 s' } });
    const chip = await screen.findByRole('button', { name: /unavailable/ });
    expect(chip).toHaveClass('text-attention');
    expect(chip).toHaveAttribute('title', 'claude auth timed out after 10 s');
  });

  it('keeps a missing claude quiet: dim, not interactive, and says how to fix it on hover', async () => {
    const line = 'Claude Code not found — install it, or set CLAUDE_BIN';
    renderChip({ status: { cli: 'missing', live: [], error: line } });
    const note = await screen.findByText('claude not found');
    expect(note).toHaveAttribute('title', line);
    expect(note).not.toHaveClass('text-attention');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('polls every 30 seconds and no faster', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { claude } = renderChip();
    await screen.findByRole('button', { name: /Claude Max/ });
    expect(claude.status).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(29_999);
      await Promise.resolve();
    });
    expect(claude.status).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(claude.status).toHaveBeenCalledTimes(2);
    // A poll never asks for a forced usage refresh; only the popover's button does.
    expect(claude.status).toHaveBeenLastCalledWith();
  });
});

describe('ClaudeCodeChip popover', () => {
  async function open(setup: Setup = {}) {
    const user = userEvent.setup();
    const rendered = renderChip(setup);
    const chip = await screen.findByRole('button', { name: /Claude/ });
    await user.click(chip);
    return { user, chip, ...rendered, popover: await screen.findByRole('dialog', { name: 'Claude' }) };
  }

  it('is closed until the chip is clicked, and the chip says so', async () => {
    const user = userEvent.setup();
    renderChip();
    const chip = await screen.findByRole('button', { name: /Claude Max/ });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Claude' })).toBeInTheDocument();
  });

  it('draws a bar per meter, including the per-model weekly one, with reset times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { popover } = await open();
    const meters = within(popover).getAllByRole('meter');
    expect(meters.map((meter) => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow')])).toEqual([
      ['5h', '72'],
      ['week', '72'],
      ['Fable week', '11'],
    ]);
    expect(within(popover).getByText('resets in 1h 30m')).toBeInTheDocument();
    expect(within(popover).getAllByText(/^resets /)).toHaveLength(3);
    expect(within(popover).getByText('read 2m ago')).toBeInTheDocument();
  });

  it('lists the live sessions with a busy/idle dot, the project folder, and the full path on hover', async () => {
    const { popover } = await open();
    const live = within(popover).getByRole('list', { name: 'live sessions' });
    const [alpha, beta] = within(live).getAllByRole('listitem');
    expect(alpha).toHaveTextContent('alpha-a');
    expect(within(alpha as HTMLElement).getByRole('img', { name: 'busy' })).toBeInTheDocument();
    expect(within(alpha as HTMLElement).getByText('alpha')).toHaveAttribute('title', '/home/example/projects/alpha');
    expect(within(beta as HTMLElement).getByRole('img', { name: 'idle' })).toBeInTheDocument();
  });

  it('says nothing is running rather than showing an empty list', async () => {
    const { popover } = await open({ status: okStatus({ live: [] }) });
    expect(within(popover).getByText('nothing running')).toBeInTheDocument();
  });

  it("fetches recent sessions for the active project's root when opened, not before", async () => {
    const user = userEvent.setup();
    const { claude } = renderChip();
    const chip = await screen.findByRole('button', { name: /Claude Max/ });
    expect(claude.sessions).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await user.click(chip);
    const popover = await screen.findByRole('dialog');
    expect(claude.sessions).toHaveBeenCalledWith('/home/example/projects/alpha');
    expect(within(popover).getByText('recent here')).toBeInTheDocument();
    const recent = await within(popover).findByRole('list', { name: 'recent sessions' });
    const [first, second] = within(recent).getAllByRole('listitem');
    expect(first).toHaveTextContent('Flaky status poll');
    expect(first).toHaveTextContent('main');
    expect(first).toHaveTextContent('2h ago');
    expect(second).toHaveTextContent('Draft the release notes');
    expect(second).toHaveTextContent('3d ago');
  });

  it('lists recent sessions across every project when no project is active', async () => {
    const { claude, popover } = await open({ root: null });
    expect(claude.sessions).toHaveBeenCalledWith(null);
    expect(within(popover).getByText('recent')).toBeInTheDocument();
    expect(within(popover).queryByText('recent here')).not.toBeInTheDocument();
  });

  it('says so when there are no recent sessions or the listing fails', async () => {
    const empty = await open({ sessions: [] });
    expect(await within(empty.popover).findByText('none yet')).toBeInTheDocument();
  });

  it('shows a failed listing as a line, not as an empty list', async () => {
    const { popover } = await open({ sessions: new Error('Could not list recent Claude Code sessions — EACCES') });
    expect(await within(popover).findByText('Could not list recent Claude Code sessions — EACCES')).toBeInTheDocument();
  });

  it('is read-only: nothing in it opens or resumes a session, the only button is refresh', async () => {
    const { popover } = await open();
    await within(popover).findByRole('list', { name: 'recent sessions' });
    expect(within(popover).getAllByRole('button').map((button) => button.textContent)).toEqual(['refresh']);
    expect(within(popover).queryByRole('link')).not.toBeInTheDocument();
  });

  it('explains a logged-out state in the popover and shows no meters', async () => {
    const { popover } = await open({
      status: { cli: 'ok', auth: { loggedIn: false }, live: [], error: NOT_LOGGED_IN },
    });
    expect(within(popover).getByText(NOT_LOGGED_IN)).toBeInTheDocument();
    expect(within(popover).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('says which sign-in is in use', async () => {
    const { popover } = await open();
    expect(within(popover).getByText('signed in with subscription (Max)')).toBeInTheDocument();
  });

  it('says a cloud provider is in use, and shows no meters for it', async () => {
    const { popover } = await open({
      status: meteredStatus({ loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' }),
    });
    expect(within(popover).getByText('signed in with Google Vertex AI')).toBeInTheDocument();
    expect(within(popover).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('shows why usage is unavailable instead of meters', async () => {
    const { popover } = await open({ status: okStatus({ usage: { error: 'Claude is on an API key — no subscription quota to read' } }) });
    expect(within(popover).getByText('Claude is on an API key — no subscription quota to read')).toBeInTheDocument();
    expect(within(popover).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the chip', async () => {
    const { user, chip } = await open();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveFocus();
  });

  it('closes on a click outside, and on a second click of the chip', async () => {
    const { user, chip } = await open();
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(chip);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open when the click lands inside it', async () => {
    const { user, popover } = await open();
    await user.click(within(popover).getByRole('heading', { name: /^live/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is reachable by keyboard: the chip takes focus and opens with Enter', async () => {
    const user = userEvent.setup();
    renderChip();
    const chip = await screen.findByRole('button', { name: /Claude Max/ });
    await user.tab();
    expect(chip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('refresh asks the sidecar for a fresh usage read and shows what comes back', async () => {
    const fresh = okStatus({ usage: { fetchedAt: NOW, limits: [limit({ kind: 'session', label: '5h', percent: 90, active: true }), limit({ kind: 'weekly_all', label: 'week', percent: 73 })] } });
    const { user, claude, popover, chip } = await open({ statuses: [okStatus(), fresh] });
    await user.click(within(popover).getByRole('button', { name: 'refresh' }));
    expect(claude.status).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(chip).toHaveTextContent('Claude Max · 5h 90% · wk 73%'));
  });
});
