import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HelmraiserStatusAwaiting } from '@shared/transport/protocol.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { useShell } from '@core/shell/useShell.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS, ReviewNavigation } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { WORKFLOW } from './workflow.client.ts';
import type { JobsApi } from './useJobs.ts';
import { AwaitingRow } from './AwaitingRow.tsx';
import { ScoutedDrafts } from './ScoutedDrafts.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';

const draft = {
  project: '/draft-project', id: 'draft', title: 'Refine draft', size: 'M', source: 'scout',
  age: 1, intake_status: 'ready', intake_error: null, proposal: null, preflight: null,
  path: '/draft-project/.helmraiser/tasks/draft.md',
};
const discussionPrompt = `Help me refine this Helmraiser draft.\n\nProject: ${draft.project}\nTitle: ${draft.title}\nTask file: ${draft.path}\n\nRead the task file, help refine it, and queue it only when I am happy with it.`;
const origin = { kind: 'fo' as const, session: '/sessions/original.jsonl' };
const taskPath = '/custom/runs/run/task.md';
const planPath = '/custom/runs/run/plan.md';
const review = { taskPath, summary: 'Verify pass', review: 'pass', diffStat: { files: [], filesChanged: 0, additions: 0, deletions: 0 }, diffTruncated: false };
const rowFor = (pending: string): HelmraiserStatusAwaiting => ({
  run_id: 'run', task: 'fixture:run', pending, title: 'Waiting run', verdict: 'pass', cost_usd: 1,
  project: '/project', worktree: '/worktree', branch: 'feature/review', base_commit: 'abc', origin,
});
const promptFor = (pending: string) => pending === 'plan'
  ? `Review this Helmraiser run's plan before the owner approves it: run run, plan at ${planPath}, task at ${taskPath}. Check the plan against the task and recommend approve or changes.`
  : `Review this Helmraiser run's diff against its task: run run, branch feature/review, base abc. The task is in ${taskPath}.`;

function Probe() {
  const shell = useShell();
  const { setView, setChatDraft } = shell;
  useEffect(() => { setView('jobs'); setChatDraft('owner draft'); }, [setView, setChatDraft]);
  return <><div aria-label="view">{shell.view}</div><div aria-label="draft">{shell.chatDraft}</div></>;
}
function setup(row: HelmraiserStatusAwaiting, exists = true, otherRows: HelmraiserStatusAwaiting[] = [], unmountInChat = false, withDrafts = false, busy = false, swapScopeOnShow = false) {
  const chatExists = vi.fn().mockResolvedValue({ exists });
  const session = { send: vi.fn() };
  const workflow = { drafts: vi.fn().mockResolvedValue([draft]), dropDraft: vi.fn(), runReview: vi.fn().mockResolvedValue(review), plan: vi.fn().mockResolvedValue({ text: '# Plan', path: planPath }), queue: vi.fn(), startWorker: vi.fn() };
  const jobs = { runReview: vi.fn().mockResolvedValue(review), plan: vi.fn().mockResolvedValue('# Plan'), approve: vi.fn().mockResolvedValue({ worker_serves_project: true }), reject: vi.fn() };
  const onPlanApproved = vi.fn();
  const onReworked = vi.fn();
  const container = new Container();
  container.registerInstance(CHAT_ORCHESTRATOR, { chatExists, currentChat: vi.fn() } as never);
  container.registerInstance(CHAT_SESSION, session as never);
  // Every chat navigation goes through the tabs: review in its chat shows the
  // holder or opens a tab of its engine; open in chat and discuss open a new tab.
  // Both resolve with the tab they showed (here the probe's own, so its draft is visible).
  const tabs = {
    reviewNavigation: new ReviewNavigation(),
    reviewInOrigin: vi.fn().mockResolvedValue('main'),
    create: vi.fn().mockResolvedValue('main'),
  };
  container.registerInstance(CHAT_SESSIONS, tabs as never);
  const tabFolders = new TabFolders(new MemoryStorageAdapter());
  container.registerInstance(TAB_FOLDERS, tabFolders);
  container.registerInstance(WORKFLOW, workflow as never);
  function Rows({ rows }: { rows: HelmraiserStatusAwaiting[] }) {
    const { view } = useShell();
    if (unmountInChat && view === 'chat') return null;
    return <>
      {withDrafts && <ScoutedDrafts refreshToken={null} onQueueSuccess={async () => {}} />}
      {rows.map((entry) => <AwaitingRow key={entry.run_id} row={entry} jobs={jobs as unknown as JobsApi} busy={busy} onPlanApproved={onPlanApproved} onReworked={onReworked} />)}
    </>;
  }
  // As in the app, showing another tab swaps the shown tab's scope, and with
  // it the CHAT_ORCHESTRATOR the row resolves.
  let shownScope = container;
  const scopeListeners = new Set<() => void>();
  const showOtherTab = () => {
    shownScope = new Container(container);
    shownScope.registerInstance(CHAT_ORCHESTRATOR, { chatExists, currentChat: vi.fn() } as never);
    for (const listener of scopeListeners) listener();
  };
  const subscribeScope = (listener: () => void) => {
    scopeListeners.add(listener);
    return () => { scopeListeners.delete(listener); };
  };
  function Scoped({ children }: { children: ReactNode }) {
    const scope = useSyncExternalStore(subscribeScope, () => shownScope);
    return <ContainerProvider container={scope}>{children}</ContainerProvider>;
  }
  if (swapScopeOnShow) {
    tabs.reviewInOrigin.mockImplementation(async () => {
      act(() => showOtherTab());
      await Promise.resolve();
      return 'main';
    });
  }
  const tree = (next: HelmraiserStatusAwaiting) => <Scoped><ShellProvider><Rows rows={[next, ...otherRows]} /><Probe /></ShellProvider></Scoped>;
  const rendered = render(tree(row));
  return {
    chatExists, session, tabs, tabFolders, workflow, jobs, onPlanApproved,
    rerender: (next: HelmraiserStatusAwaiting) => rendered.rerender(tree(next)),
    unmount: rendered.unmount,
    remount: () => render(tree(row)),
  };
}
function scopeRow(): HelmraiserStatusAwaiting {
  const row = makeHelmraiserStatus({ includeScope: true }).awaiting.find((entry) => entry.pending === 'scope');
  if (!row) throw new Error('missing scope fixture');
  return row;
}

const expectGenericRow = (row: HelmraiserStatusAwaiting) => {
  expect(screen.getByText(row.title ?? '')).toBeInTheDocument();
  expect(screen.getByText('funkyoctopus')).toBeInTheDocument();
  expect(screen.getByText(row.pending)).toBeInTheDocument();
  expect(screen.getByText('pass')).toBeInTheDocument();
  expect(screen.getByText('$0.42')).toBeInTheDocument();
  expect(screen.getByText(`helmraiser approve ${row.run_id.slice(0, 8)}`)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
};

const primary = () => screen.findByRole('button', { name: 'REVIEW IN ITS CHAT' });
const buttonAt = (buttons: HTMLElement[], index: number): HTMLElement => {
  const button = buttons[index];
  if (!button) throw new Error(`missing review button ${index}`);
  return button;
};
const expandMerge = async (pending: string) => {
  if (pending === 'merge') {
    await userEvent.click(screen.getByRole('button', { name: 'REVIEW' }));
    await screen.findByText('SUMMARY · VERIFY · EVIDENCE');
  }
};
const noDecisions = (s: ReturnType<typeof setup>) => {
  expect(s.jobs.approve).not.toHaveBeenCalled();
  expect(s.jobs.reject).not.toHaveBeenCalled();
  expect(s.workflow.queue).not.toHaveBeenCalled();
  expect(s.workflow.startWorker).not.toHaveBeenCalled();
  expect(s.workflow.dropDraft).not.toHaveBeenCalled();
  expect(s.session.send).not.toHaveBeenCalled();
};

describe('scope status fixture', () => {
  it('preserves the default ledger and opts into consistent scope counters', () => {
    const original = makeHelmraiserStatus();
    expect(original.awaiting).toHaveLength(1);
    expect(original.awaiting_count).toBe(1);
    expect(original.queue.awaiting_approval).toBe(1);
    const status = makeHelmraiserStatus({ includeScope: true });
    expect(status.awaiting).toHaveLength(2);
    expect(status.awaiting_count).toBe(2);
    expect(status.queue.awaiting_approval).toBe(2);
    expect(scopeRow().scope_request).toEqual({
      paths: ['src/a.ts', 'src/b.ts'],
      reason: 'These files are needed to complete the implementation.',
    });
  });

  it('returns isolated scope path arrays', () => {
    const first = scopeRow();
    first.scope_request?.paths.push('src/changed.ts');
    expect(scopeRow().scope_request?.paths).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('generic awaiting fallback', () => {
  it.each(['absent', 'null'])('retains CLI guidance for a scope request that is %s', (variant) => {
    const row = scopeRow();
    if (variant === 'absent') delete row.scope_request;
    else row.scope_request = null;
    setup(row);
    expectGenericRow(row);
  });

  it('keeps unknown kinds generic even with valid scope metadata', () => {
    const row = { ...scopeRow(), pending: 'future-kind' };
    setup(row);
    expectGenericRow(row);
  });
});

describe('scope approval', () => {
  it('shows the shared facts, selectable paths, plain reason and owner-only scope decisions', async () => {
    setup({ ...scopeRow(), origin, worktree: '/worktree' });
    await act(async () => {});
    expect(screen.getByText('Approve additional implementation paths')).toBeInTheDocument();
    expect(screen.getByText('funkyoctopus')).toBeInTheDocument();
    expect(screen.getByText('scope')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.getByText('$0.42')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Requested paths' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
    for (const path of ['src/a.ts', 'src/b.ts']) {
      expect(within(list).getByText(path).tagName).toBe('CODE');
      expect(within(list).getByText(path)).toHaveClass('select-text', 'whitespace-pre-wrap', 'break-all');
    }
    expect(screen.getByText('These files are needed to complete the implementation.')).toHaveClass('text-text', 'select-text');
    expect(screen.getByRole('button', { name: 'APPROVE SCOPE' })).toHaveClass('text-accent');
    expect(screen.getByRole('button', { name: 'REJECT' })).toHaveClass('text-danger');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByText(/merge/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/helmraiser approve/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Approval note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /REVIEW|PLAN|OPEN IN CHAT/ })).not.toBeInTheDocument();
  });

  it('approves only the full run ID, without a note, plan outcome, worker start or chat navigation', async () => {
    const row = scopeRow();
    const s = setup(row);
    await userEvent.click(screen.getByRole('button', { name: 'APPROVE SCOPE' }));
    expect(s.jobs.approve).toHaveBeenCalledExactlyOnceWith(row.run_id);
    expect(s.jobs.reject).not.toHaveBeenCalled();
    expect(s.onPlanApproved).not.toHaveBeenCalled();
    expect(s.workflow.startWorker).not.toHaveBeenCalled();
    expect(s.workflow.plan).not.toHaveBeenCalled();
    expect(s.workflow.runReview).not.toHaveBeenCalled();
    expect(s.tabs.create).not.toHaveBeenCalled();
    expect(s.tabs.reviewInOrigin).not.toHaveBeenCalled();
    expect(s.session.send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
    expect(screen.getByLabelText('draft')).toHaveTextContent('owner draft');
  });

  it.each(['Needs a smaller scope.', ''])('confirms rejection with optional note %j', async (note) => {
    const row = scopeRow();
    const s = setup(row);
    await userEvent.click(screen.getByRole('button', { name: 'REJECT' }));
    expect(s.jobs.reject).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'APPROVE SCOPE' })).not.toBeInTheDocument();
    if (note) await userEvent.type(screen.getByLabelText('Reject note'), note);
    expect(screen.getByRole('button', { name: 'CONFIRM REJECT' })).toHaveClass('bg-danger/10');
    await userEvent.click(screen.getByRole('button', { name: 'CONFIRM REJECT' }));
    expect(s.jobs.reject).toHaveBeenCalledExactlyOnceWith(row.run_id, note);
    expect(s.jobs.approve).not.toHaveBeenCalled();
    expect(s.onPlanApproved).not.toHaveBeenCalled();
  });

  it('cancels rejection without a decision and clears the note before reopening', async () => {
    const s = setup(scopeRow());
    await userEvent.click(screen.getByRole('button', { name: 'REJECT' }));
    await userEvent.type(screen.getByLabelText('Reject note'), 'discard me');
    await userEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(screen.getByRole('button', { name: 'APPROVE SCOPE' })).toBeEnabled();
    expect(screen.queryByLabelText('Reject note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'REJECT' }));
    expect(screen.getByLabelText('Reject note')).toHaveValue('');
    noDecisions(s);
  });

  it('disables scope decisions while the panel is busy', async () => {
    const s = setup(scopeRow(), true, [], false, false, true);
    for (const name of ['APPROVE SCOPE', 'REJECT']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(screen.queryByLabelText('Reject note')).not.toBeInTheDocument();
    noDecisions(s);
  });

  it.each([false, true])('honours the shared navigation lock with rejection confirmation %s', async (confirming) => {
    const s = setup(scopeRow());
    if (confirming) await userEvent.click(screen.getByRole('button', { name: 'REJECT' }));
    let release: (() => void) | null = null;
    act(() => { release = s.tabs.reviewNavigation.tryAcquire(); });
    const names = confirming ? ['CONFIRM REJECT', 'CANCEL'] : ['APPROVE SCOPE', 'REJECT'];
    try {
      for (const name of names) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        await userEvent.click(button);
      }
      expect(screen.queryByLabelText('Reject note') !== null).toBe(confirming);
      noDecisions(s);
    } finally {
      act(() => { release?.(); });
    }
    for (const name of names) expect(screen.getByRole('button', { name })).toBeEnabled();
  });
});

describe('defensive scope metadata parsing', () => {
  it.each<{ name: string; request: unknown }>([
    { name: 'undefined', request: undefined },
    { name: 'null', request: null },
    { name: 'string', request: 'src/a.ts' },
    { name: 'number', request: 42 },
    { name: 'boolean', request: true },
    { name: 'array request', request: ['src/a.ts'] },
    { name: 'missing paths', request: {} },
    { name: 'null paths', request: { paths: null } },
    { name: 'string paths', request: { paths: 'src/a.ts' } },
    { name: 'object paths', request: { paths: { 0: 'src/a.ts' } } },
    { name: 'empty paths', request: { paths: [] } },
    { name: 'no string paths', request: { paths: [null, 1, false, {}, []] } },
  ])('uses the generic fallback for $name', ({ request }) => {
    const row = { ...scopeRow(), scope_request: request } as unknown as HelmraiserStatusAwaiting;
    setup(row);
    expectGenericRow(row);
    expect(screen.queryByRole('list', { name: 'Requested paths' })).not.toBeInTheDocument();
  });

  it('drops non-string paths, preserving string content, order and duplicates', () => {
    const request: unknown = { paths: [null, 'src/b.ts', 3, ' src/a.ts ', false, 'src/b.ts', '<b>path</b>'], reason: 'Paths as supplied.' };
    setup({ ...scopeRow(), scope_request: request } as unknown as HelmraiserStatusAwaiting);
    const paths = within(screen.getByRole('list', { name: 'Requested paths' })).getAllByRole('listitem');
    expect(paths.map((item) => item.textContent)).toEqual(['src/b.ts', ' src/a.ts ', 'src/b.ts', '<b>path</b>']);
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('button', { name: 'APPROVE SCOPE' })).toBeEnabled();
  });

  it.each<{ reason: unknown }>([
    { reason: undefined }, { reason: null }, { reason: 42 }, { reason: false }, { reason: {} }, { reason: ['text'] }, { reason: '' },
  ])('keeps valid paths actionable without rendering reason $reason', ({ reason }) => {
    setup({ ...scopeRow(), scope_request: { paths: ['src/a.ts'], reason } } as unknown as HelmraiserStatusAwaiting);
    expect(screen.getByRole('list', { name: 'Requested paths' })).toHaveTextContent('src/a.ts');
    expect(screen.getByRole('button', { name: 'APPROVE SCOPE' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'REJECT' })).toBeEnabled();
    expect(document.querySelector('p')).toBeNull();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('accepts valid paths when the reason property is absent', () => {
    const request: unknown = { paths: ['src/a.ts'] };
    setup({ ...scopeRow(), scope_request: request } as unknown as HelmraiserStatusAwaiting);
    expect(screen.getByRole('button', { name: 'APPROVE SCOPE' })).toBeEnabled();
    expect(document.querySelector('p')).toBeNull();
  });

  it('renders markup-looking reason as literal selectable text', () => {
    const reason = '<img src=x onerror="alert(1)"> **not Markdown**\n<script>no()</script>';
    setup({ ...scopeRow(), scope_request: { paths: ['src/a.ts'], reason } });
    expect(screen.getByText(reason, { normalizer: (text) => text })).toHaveClass('select-text', 'whitespace-pre-wrap', 'wrap-anywhere', 'text-text');
    expect(document.querySelector('img, script')).toBeNull();
  });
});

describe('discussion / review navigation', () => {
  it.each([
    ['discussion', 'origin', 'create'], ['discussion', 'fresh', 'create'],
    ['review', 'origin', 'open'], ['review', 'fresh', 'create'],
  ])('rejects same-batch competing clicks: %s first, %s review, deferred %s', async (winner, reviewAction, stage) => {
    const s = setup(rowFor('plan'), true, [], true, true);
    const originButton = await primary();
    const discuss = await screen.findByRole('button', { name: 'DISCUSS' });
    const freshButton = screen.getByRole('button', { name: 'OPEN IN CHAT' });
    const reviewButton = reviewAction === 'origin' ? originButton : freshButton;
    let currentPath = '/sessions/prior.jsonl';
    let release = () => {};
    s.tabs.create.mockImplementation(() => { currentPath = '/sessions/fresh.jsonl'; return Promise.resolve('main'); });
    s.tabs.reviewInOrigin.mockImplementation((path: string) => { currentPath = path; return Promise.resolve('main'); });
    const method = stage === 'open' ? s.tabs.reviewInOrigin : s.tabs.create;
    method.mockImplementationOnce(() => new Promise<string>((resolve) => {
      release = () => {
        currentPath = stage === 'open' ? origin.session : '/sessions/fresh.jsonl';
        resolve('main');
      };
    }));
    const first = winner === 'discussion' ? discuss : reviewButton;
    const second = winner === 'discussion' ? reviewButton : discuss;
    act(() => { fireEvent.click(first); fireEvent.click(second); });
    await waitFor(() => expect(method).toHaveBeenCalledOnce());
    expect(discuss).toBeDisabled();
    expect(originButton).toBeDisabled();
    expect(freshButton).toBeDisabled();
    expect(screen.getByLabelText('draft').textContent).toBe('owner draft');
    expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
    fireEvent.click(second);
    await act(async () => { release(); await Promise.resolve(); });
    const expected = winner === 'discussion' ? discussionPrompt : promptFor('plan');
    await waitFor(() => expect(screen.getByLabelText('draft').textContent).toBe(expected));
    expect(currentPath).toBe(winner === 'review' && reviewAction === 'origin' ? origin.session : '/sessions/fresh.jsonl');
    // A fresh chat is a new pi tab in the folder: no tab's conversation is replaced.
    expect(s.tabs.create).toHaveBeenCalledTimes(winner === 'review' && reviewAction === 'origin' ? 0 : 1);
    if (winner !== 'review' || reviewAction !== 'origin') {
      expect(s.tabs.create).toHaveBeenCalledWith('pi', winner === 'discussion' ? draft.project : '/worktree', expect.any(Function));
    }
    expect(s.tabs.reviewInOrigin).toHaveBeenCalledTimes(winner === 'review' && reviewAction === 'origin' ? 1 : 0);
    expect(screen.queryByRole('button', { name: 'DISCUSS' })).not.toBeInTheDocument();
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    noDecisions(s);
  });

  it.each(['origin failure', 'origin gone', 'fresh create failure'])('releases after %s so an explicit discussion succeeds', async (outcome) => {
    const s = setup(rowFor('plan'), true, [], false, true);
    const originButton = await primary();
    const discuss = await screen.findByRole('button', { name: 'DISCUSS' });
    let settle = () => {};
    if (outcome === 'origin gone') {
      s.chatExists.mockImplementationOnce(() => new Promise<{ exists: boolean }>((resolve) => { settle = () => resolve({ exists: false }); }));
    } else {
      const method = outcome === 'origin failure' ? s.tabs.reviewInOrigin : s.tabs.create;
      method.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { settle = () => reject(new Error(outcome)); }));
    }
    fireEvent.click(outcome.startsWith('origin') ? originButton : screen.getByRole('button', { name: 'OPEN IN CHAT' }));
    await waitFor(() => expect(discuss).toBeDisabled());
    // Wait until the delayed operation, not just lock acquisition, has started.
    await waitFor(() => expect(outcome.startsWith('origin') ? s.chatExists : s.tabs.create).toHaveBeenCalledTimes(outcome.startsWith('origin') ? 2 : 1));
    if (outcome === 'origin failure') await waitFor(() => expect(s.tabs.reviewInOrigin).toHaveBeenCalledOnce());
    fireEvent.click(discuss);
    await act(async () => { settle(); await Promise.resolve(); });
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(discuss).toBeEnabled();
    expect(screen.getByLabelText('draft').textContent).toBe('owner draft');
    fireEvent.click(discuss);
    await waitFor(() => expect(screen.getByLabelText('draft').textContent).toBe(discussionPrompt));
    expect(s.tabs.create).toHaveBeenLastCalledWith('pi', draft.project, expect.any(Function));
    noDecisions(s);
  });

  it.each(['origin', 'fresh'])('keeps DISCUSS disabled across remount while a %s review is unresolved', async (action) => {
    const s = setup(rowFor('plan'), true, [], false, true);
    await primary();
    let release = () => {};
    const method = action === 'origin' ? s.tabs.reviewInOrigin : s.tabs.create;
    method.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('main'); }));
    fireEvent.click(screen.getByRole('button', { name: action === 'origin' ? 'REVIEW IN ITS CHAT' : 'OPEN IN CHAT' }));
    await waitFor(() => expect(method).toHaveBeenCalledOnce());
    s.unmount();
    s.remount();
    const discuss = await screen.findByRole('button', { name: 'DISCUSS' });
    expect(discuss).toBeDisabled();
    fireEvent.click(discuss);
    await act(async () => { release(); await Promise.resolve(); });
    expect(screen.getByLabelText('draft').textContent).toBe('owner draft');
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(discuss).toBeEnabled();
    fireEvent.click(discuss);
    await waitFor(() => expect(screen.getByLabelText('draft').textContent).toBe(discussionPrompt));
    noDecisions(s);
  });
});

describe('shared review navigation', () => {
  it.each(['merge', 'plan'])('keeps the first %s prompt paired with its chat when another row tries a delayed open', async (pending) => {
    const first = rowFor(pending);
    const second = { ...rowFor('plan'), run_id: 'other-run', origin: { ...origin, session: '/sessions/other.jsonl' } };
    const s = setup(first, true, [second], true);
    let currentPath = '/sessions/prior.jsonl';
    const releases = new Map<string, () => void>();
    s.tabs.reviewInOrigin.mockImplementation((path: string) => new Promise<string>((resolve) => {
      releases.set(path, () => { currentPath = path; resolve('main'); });
    }));
    const buttons = await screen.findAllByRole('button', { name: 'REVIEW IN ITS CHAT' });
    expect(buttons).toHaveLength(2);
    // Same batch: the second handler must be blocked even before a disabled-state render.
    act(() => { fireEvent.click(buttonAt(buttons, 0)); fireEvent.click(buttonAt(buttons, 1)); });
    await waitFor(() => expect(releases.has(origin.session)).toBe(true));
    await act(async () => { releases.get(origin.session)?.(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByLabelText('view')).toHaveTextContent('chat'));
    expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument();
    // An already-issued second open can still switch the session after Jobs unmounts.
    await act(async () => { releases.get(second.origin.session)?.(); await Promise.resolve(); });
    expect(currentPath).toBe(origin.session);
    expect(screen.getByLabelText('draft').textContent).toBe(promptFor(pending));
    expect(s.tabs.reviewInOrigin).toHaveBeenCalledExactlyOnceWith(origin.session);
    expect(s.tabs.create).not.toHaveBeenCalled();
    noDecisions(s);
  });

  it.each([
    ['origin', 'fresh'], ['fresh', 'origin'], ['fresh', 'fresh'],
  ])('blocks a second-row %s / %s review combination through completion', async (firstAction, secondAction) => {
    const second = { ...rowFor('plan'), run_id: 'other-run', origin: { ...origin, session: '/sessions/other.jsonl' } };
    const s = setup(rowFor('plan'), true, [second], true);
    await screen.findAllByRole('button', { name: 'REVIEW IN ITS CHAT' });
    let release = () => {};
    const firstMethod = firstAction === 'origin' ? s.tabs.reviewInOrigin : s.tabs.create;
    firstMethod.mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve('main'); }));
    const firstButton = buttonAt(screen.getAllByRole('button', { name: firstAction === 'origin' ? 'REVIEW IN ITS CHAT' : 'OPEN IN CHAT' }), 0);
    const secondButton = buttonAt(screen.getAllByRole('button', { name: secondAction === 'origin' ? 'REVIEW IN ITS CHAT' : 'OPEN IN CHAT' }), 1);
    act(() => { fireEvent.click(firstButton); fireEvent.click(secondButton); });
    await waitFor(() => expect(firstMethod).toHaveBeenCalledTimes(1));
    expect(secondButton).toBeDisabled();
    expect(s.tabs.reviewNavigation.isPending()).toBe(true);
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByLabelText('draft').textContent).toBe(promptFor('plan')));
    expect(s.tabs.reviewInOrigin).toHaveBeenCalledTimes(firstAction === 'origin' ? 1 : 0);
    expect(s.tabs.create).toHaveBeenCalledTimes(firstAction === 'fresh' ? 1 : 0);
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    noDecisions(s);
  });

  it('holds the lock across a row unmount/remount until the delayed open settles', async () => {
    const second = { ...rowFor('plan'), run_id: 'other-run', origin: { ...origin, session: '/sessions/other.jsonl' } };
    const s = setup(rowFor('merge'), true, [second], true);
    let release = () => {};
    s.tabs.reviewInOrigin.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('main'); }));
    await userEvent.click(buttonAt(await screen.findAllByRole('button', { name: 'REVIEW IN ITS CHAT' }), 0));
    await waitFor(() => expect(s.tabs.reviewInOrigin).toHaveBeenCalledTimes(1));
    s.unmount();
    s.remount();
    const buttons = await screen.findAllByRole('button', { name: 'REVIEW IN ITS CHAT' });
    expect(buttonAt(buttons, 1)).toBeDisabled();
    await userEvent.click(buttonAt(buttons, 1));
    expect(s.tabs.reviewInOrigin).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await Promise.resolve(); });
    expect(screen.getByLabelText('draft')).toHaveTextContent('owner draft');
    expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    await userEvent.click(buttonAt(buttons, 1));
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent('run other-run, plan at'));
    expect(s.tabs.reviewInOrigin).toHaveBeenLastCalledWith(second.origin.session);
    noDecisions(s);
  });

  it('reviews a Claude Code chat’s run in its chat whatever the shown tab’s engine: the tabs show or open it', async () => {
    const claudeOrigin = 'claude-code:11111111-1111-4111-8111-111111111111';
    const row = { ...rowFor('merge'), origin: { kind: 'fo' as const, session: claudeOrigin } };
    const s = setup(row);
    await userEvent.click(await primary());
    await waitFor(() => expect(s.tabs.reviewInOrigin).toHaveBeenCalledExactlyOnceWith(claudeOrigin));
    await waitFor(() => expect(screen.getByLabelText('view')).toHaveTextContent('chat'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(s.tabs.create).not.toHaveBeenCalled();
    noDecisions(s);
  });

  it('releases the shared lock on failure so another row can be reviewed', async () => {
    const second = { ...rowFor('plan'), run_id: 'other-run', origin: { ...origin, session: '/sessions/other.jsonl' } };
    const s = setup(rowFor('merge'), true, [second]);
    const buttons = await screen.findAllByRole('button', { name: 'REVIEW IN ITS CHAT' });
    s.tabs.reviewInOrigin.mockRejectedValueOnce(new Error('open failed'));
    await userEvent.click(buttonAt(buttons, 0));
    await screen.findByRole('alert');
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(buttonAt(buttons, 1)).toBeEnabled();
    await userEvent.click(buttonAt(buttons, 1));
    await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent("run other-run, plan at"));
    expect(s.tabs.reviewInOrigin).toHaveBeenLastCalledWith(second.origin.session);
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    noDecisions(s);
  });
});

for (const pending of ['merge', 'plan']) {
  describe(`${pending} origin review`, () => {
    it('offers primary review and secondary fresh review; opens exact origin outside recent history, then composes unsent', async () => {
      const s = setup(rowFor(pending));
      await primary();
      await expandMerge(pending);
      expect(screen.getByRole('button', { name: 'OPEN IN CHAT' })).toHaveClass('text-muted');
      await userEvent.click(await primary());
      await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent(promptFor(pending)));
      expect(s.chatExists).toHaveBeenCalledTimes(2);
      expect(s.chatExists).toHaveBeenLastCalledWith(origin.session);
      expect(s.tabs.reviewInOrigin).toHaveBeenCalledExactlyOnceWith(origin.session);
      expect(s.tabs.create).not.toHaveBeenCalled();
      expect(screen.getByLabelText('view')).toHaveTextContent('chat');
      noDecisions(s);
    });

    it('composes the prompt when the origin is shown in another tab, whose scope replaces the orchestrator', async () => {
      const s = setup(rowFor(pending), true, [], false, false, false, true);
      await userEvent.click(await primary());
      await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent(promptFor(pending)));
      expect(s.tabs.reviewInOrigin).toHaveBeenCalledExactlyOnceWith(origin.session);
      expect(screen.getByLabelText('view')).toHaveTextContent('chat');
      noDecisions(s);
    });

    it.each(['claude-code', 'absent', 'null', 'gone'])('preserves the fallback for %s', async (variant) => {
      const row = rowFor(pending);
      if (variant === 'claude-code') row.origin = { kind: 'claude-code', session: 'uuid' };
      if (variant === 'absent') delete row.origin;
      if (variant === 'null') row.origin = null;
      const s = setup(row, variant !== 'gone');
      await act(async () => {});
      expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument();
      expect(screen.queryByText('queued from Claude Code') !== null).toBe(variant === 'claude-code');
      expect(s.chatExists).toHaveBeenCalledTimes(variant === 'gone' ? 1 : 0);
      await expandMerge(pending);
      expect(screen.queryByRole('button', { name: 'OPEN IN CHAT' }) !== null).toBe(pending === 'merge');
      noDecisions(s);
    });

    it('reviews without worktree and preserves composer/navigation during a deferred open, blocking duplicate clicks', async () => {
      const row = rowFor(pending);
      delete row.worktree;
      const s = setup(row);
      let release = () => {};
      s.tabs.reviewInOrigin.mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve('main'); }));
      const button = await primary();
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(s.tabs.reviewInOrigin).toHaveBeenCalledTimes(1));
      expect(screen.getByLabelText('draft')).toHaveTextContent('owner draft');
      expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
      expect(screen.queryByRole('button', { name: 'OPEN IN CHAT' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'OPENING ORIGIN…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: pending === 'plan' ? 'APPROVE PLAN' : 'APPROVE' })).toBeDisabled();
      await act(async () => { release(); await Promise.resolve(); });
      expect(screen.getByLabelText('draft')).toHaveTextContent(promptFor(pending));
      expect(s.tabs.create).not.toHaveBeenCalled();
      noDecisions(s);
    });

    it('opens the fresh review in a new tab of the origin chat’s engine, in the worktree, never in the shown tab', async () => {
      const row = { ...rowFor(pending), origin: { kind: 'fo' as const, session: 'claude-code:22222222-2222-4222-8222-222222222222' } };
      const s = setup(row);
      await primary();
      await expandMerge(pending);
      s.tabs.create.mockResolvedValueOnce('n1');
      await userEvent.click(screen.getByRole('button', { name: 'OPEN IN CHAT' }));
      await waitFor(() => expect(s.tabs.create).toHaveBeenCalledOnce());
      const [engine, root, prepare] = s.tabs.create.mock.calls[0] as [string, string, (chatId: string) => void];
      expect([engine, root]).toEqual(['claude-code', '/worktree']);
      // The new tab keeps the worktree as its own folder.
      prepare('n1');
      expect(s.tabFolders.forTab('n1').get()?.path).toBe('/worktree');
      // The prompt went to the new tab, so the shown tab's draft is untouched.
      await waitFor(() => expect(screen.getByLabelText('view')).toHaveTextContent('chat'));
      expect(screen.getByLabelText('draft')).toHaveTextContent('owner draft');
      noDecisions(s);
    });

    it('uses the pending-kind prompt for secondary fresh review', async () => {
      const s = setup(rowFor(pending));
      await primary();
      await expandMerge(pending);
      await userEvent.click(screen.getByRole('button', { name: 'OPEN IN CHAT' }));
      await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent(promptFor(pending)));
      expect(s.tabs.create).toHaveBeenCalledExactlyOnceWith('pi', '/worktree', expect.any(Function));
      expect(s.tabs.reviewInOrigin).not.toHaveBeenCalled();
      noDecisions(s);
    });

    it.each(['metadata', 'open', 'probe'])('handles %s failure without composing; retry is available for metadata/open', async (failure) => {
      const s = setup(rowFor(pending));
      const button = await primary();
      if (failure === 'metadata') s.workflow.runReview.mockRejectedValueOnce(new Error('metadata unavailable'));
      if (failure === 'open') s.tabs.reviewInOrigin.mockRejectedValueOnce(new Error('open unavailable'));
      if (failure === 'probe') s.chatExists.mockRejectedValueOnce(new Error('probe unavailable'));
      await userEvent.click(button);
      await screen.findByRole('alert');
      expect(screen.getByLabelText('draft')).toHaveTextContent('owner draft');
      expect(screen.getByLabelText('view')).toHaveTextContent('jobs');
      if (failure !== 'open') expect(s.tabs.reviewInOrigin).not.toHaveBeenCalled();
      if (failure !== 'probe') {
        await userEvent.click(await primary());
        await waitFor(() => expect(screen.getByLabelText('draft')).toHaveTextContent(promptFor(pending)));
      } else {
        expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument();
      }
      noDecisions(s);
    });

    it('removes primary on deletion between check and click without silently creating a chat', async () => {
      const s = setup(rowFor(pending));
      const button = await primary();
      s.chatExists.mockResolvedValueOnce({ exists: false });
      await userEvent.click(button);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument());
      expect(s.tabs.reviewInOrigin).not.toHaveBeenCalled();
      expect(s.tabs.create).not.toHaveBeenCalled();
      await expandMerge(pending);
      expect(screen.queryByRole('button', { name: 'OPEN IN CHAT' }) !== null).toBe(pending === 'merge');
      noDecisions(s);
    });

    it('ignores a late existence response after the origin changes', async () => {
      const s = setup(rowFor(pending));
      await primary();
      let release = (_value: { exists: boolean }) => {};
      s.chatExists.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      s.rerender({ ...rowFor(pending), origin: { ...origin, session: '/sessions/slow.jsonl' } });
      s.rerender({ ...rowFor(pending), origin: { kind: 'claude-code', session: 'uuid' } });
      await act(async () => { release({ exists: true }); await Promise.resolve(); });
      expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument();
      expect(screen.getByText('queued from Claude Code')).toBeInTheDocument();
    });

    it('initial probe failure preserves fallback', async () => {
      const row = rowFor(pending);
      delete row.origin;
      const s = setup(row);
      s.chatExists.mockRejectedValue(new Error('offline'));
      s.rerender(rowFor(pending));
      await act(async () => {});
      expect(screen.queryByRole('button', { name: 'REVIEW IN ITS CHAT' })).not.toBeInTheDocument();
      await expandMerge(pending);
      expect(screen.queryByRole('button', { name: 'OPEN IN CHAT' }) !== null).toBe(pending === 'merge');
    });

    it('keeps owner approval and confirm-first rejection functional', async () => {
      const s = setup(rowFor(pending));
      await primary();
      await userEvent.click(screen.getByRole('button', { name: pending === 'plan' ? 'APPROVE PLAN' : 'APPROVE' }));
      expect(s.jobs.approve).toHaveBeenCalledWith('run', ...(pending === 'plan' ? [''] : []));
      if (pending === 'plan') expect(s.onPlanApproved).toHaveBeenCalledWith(true);
      await userEvent.click(screen.getByRole('button', { name: 'REJECT' }));
      expect(s.jobs.reject).not.toHaveBeenCalled();
      await userEvent.type(screen.getByLabelText('Reject note'), 'changes');
      await userEvent.click(screen.getByRole('button', { name: 'CONFIRM REJECT' }));
      expect(s.jobs.reject).toHaveBeenCalledWith('run', 'changes');
      expect(s.session.send).not.toHaveBeenCalled();
    });
  });
}
