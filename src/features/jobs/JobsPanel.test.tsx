import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import type { HelmraiserReportWindow } from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { TRANSPORT } from '@core/transport/transport-client.ts';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { useShell } from '@core/shell/useShell.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS, ReviewNavigation } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import { TAB_MODEL, TabModels } from '@features/chat/tab-models.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import type { Project } from '@features/settings/preferences.types.ts';
import { WORKFLOW } from './workflow.client.ts';
import { HELMRAISER_MONITOR, type HelmraiserMonitorSnapshot } from './helmraiser-monitor.service.ts';
import { scoutSettingsFixture } from './scout-settings.fixture.ts';
import { JobsPanel } from './JobsPanel.tsx';
import { addQueueHolds, makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { makeHelmraiserReport } from './__fixtures__/helmraiser-report.ts';
import { makeHelmraiserStats, makeStatsScoutRow } from './__fixtures__/helmraiser-stats.ts';
import { makeFailedRunLog } from './__fixtures__/helmraiser-log.ts';

// Deterministic local-time assertions (held until / ended at render as HH:MM).
beforeAll(() => { process.env.TZ = 'UTC'; });

const KNOW_A = { id: '/home/example/projects/helmraiser', name: 'helmraiser', path: '/home/example/projects/helmraiser', envTier: 'normal' as const };
const KNOW_B = { id: '/home/example/projects/funkyoctopus', name: 'funkyoctopus', path: '/home/example/projects/funkyoctopus', envTier: 'normal' as const };
const ACTIVE_A: Project = { id: KNOW_A.id, name: KNOW_A.name, path: KNOW_A.path, envTier: 'lab' };
const CURRENT_CHAT = {
  path: '/fixture/session.jsonl', id: 'chat-1', cwd: KNOW_A.path, title: 'Current chat',
  created: '2026-10-02T10:00:00Z', modified: '2026-10-02T10:01:00Z',
};

function ShellProbe() {
  const shell = useShell();
  return <><div aria-label="shell view">{shell.view}</div><div aria-label="chat draft">{shell.chatDraft}</div></>;
}

/** The intake proposal the fake `propose` resolves with by default. */
const PROPOSAL = {
  task_id: 't:1',
  id: 'new-task',
  status: 'draft' as const,
  path: '/home/example/projects/helmraiser/.helmraiser/tasks/new-task.md',
  proposal: { verify: [] },
  task: '---\ntitle: New task\n---\n\n## Goal\n\nDescribe the work.\n',
  notes: ['The plan is sound.'],
};

function renderPanel(
  mutate: (status: ReturnType<typeof makeHelmraiserStatus>) => void = () => undefined,
  snapshotOverride: Partial<HelmraiserMonitorSnapshot> = {},
  workflowOverride: Record<string, Mock> = {},
  options: {
    activeProject?: Project | null;
    discover?: () => Promise<unknown>;
    currentChat?: () => Promise<typeof CURRENT_CHAT | null>;
  } = {},
) {
  const status = makeHelmraiserStatus();
  status.scouts = { focus_projects: [], paused_projects: [], pending: [], running: [], recent: [] };
  mutate(status);
  const snapshot: HelmraiserMonitorSnapshot = { status, loading: false, error: null, unavailable: false, ...snapshotOverride };
  const abort = vi.fn().mockResolvedValue(undefined);
  const plan = vi.fn().mockResolvedValue({ text: '# Implementation plan\n\n1. Make the change.' });
  const runReview = vi.fn().mockResolvedValue({
    summary: '## Verify\n- npm run verify: pass\n\n## Evidence\n- browser screenshot',
    review: '### Review\nVerdict: pass\n- [medium] src/run.ts:42 — preserve ordering',
    diffStat: {
      files: [{ path: 'src/run.ts', additions: 7, deletions: 2, binary: false }],
      filesChanged: 1, additions: 7, deletions: 2,
    },
    diffTruncated: false,
    taskPath: '/non-default/helmraiser/runs/865c36b8-a39d-433a-bc6c-87b1715d14e2/task.md',
  });
  const approve = vi.fn().mockResolvedValue({});
  const reject = vi.fn().mockRejectedValue(new Error('not implemented'));
  const startWorker = vi.fn().mockResolvedValue({});
  const stopWorker = vi.fn().mockResolvedValue({});
  const pause = vi.fn().mockResolvedValue({});
  const resume = vi.fn().mockResolvedValue({});
  const draft = vi.fn().mockResolvedValue({
    task_id: 't:1', id: 'new-task', status: 'draft', path: PROPOSAL.path,
  });
  const propose = vi.fn().mockResolvedValue(PROPOSAL);
  const queueTask = vi.fn().mockResolvedValue({ ...PROPOSAL, status: 'queued' });
  const drafts = vi.fn().mockResolvedValue([]);
  const dropDraft = vi.fn().mockResolvedValue({ status: 'dropped' });
  const queueRemove = vi.fn().mockResolvedValue({ status: 'draft' });
  const log = vi.fn().mockResolvedValue({ events: [], truncated: false });
  const retry = vi.fn().mockResolvedValue({
    retried: 'timeout: pi session exceeded its time limit', run_id: '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc',
    task_id: '-home-example-projects-helmraiser:live-subscription-usage', project: '/home/example/projects/helmraiser',
    status: 'resuming', stage: 'verify', worker: 'running', worker_serves_project: true,
  });
  const rework = vi.fn().mockResolvedValue({
    reworked: 'merge', run_id: '865c36b8-a39d-433a-bc6c-87b1715d14e2',
    task_id: '-home-example-projects-helmraiser:report-rejected-split', project: '/home/example/projects/helmraiser',
    status: 'resuming', stage: 'implement', worker: 'running', worker_serves_project: true,
  });
  const report = vi.fn((since: HelmraiserReportWindow) => Promise.resolve(makeHelmraiserReport({ since })));
  const stats = vi.fn().mockResolvedValue(makeHelmraiserStats());
  const workflow = {
    abort, plan, runReview, approve, reject, startWorker, stopWorker, pause, resume,
    draft, drafts, dropDraft, queueRemove, log, retry, rework, propose, queue: queueTask, report, stats,
    allDrafts: vi.fn().mockResolvedValue([]),
    scoutSettings: vi.fn().mockResolvedValue(scoutSettingsFixture()),
    ...workflowOverride,
  };
  const refresh = vi.fn().mockResolvedValue(undefined);
  const monitor = { getSnapshot: () => snapshot, subscribe: () => () => undefined, refresh };
  const currentChat = vi.fn(options.currentChat ?? (() => Promise.resolve(CURRENT_CHAT)));
  const orchestrator = {
    currentChat,
    discoverProjects: vi.fn(options.discover
      ? options.discover
      : () => Promise.resolve({
          globalRoot: '/home/example/projects',
          known: [KNOW_A, KNOW_B],
          folders: [],
        })),
  };
  const storage = new MemoryStorageAdapter();
  const preferences = new PreferencesService(storage);
  // The shown chat tab's folder.
  const tabFolders = new TabFolders(storage);
  const folder = tabFolders.forTab('main');
  if (options.activeProject !== undefined) folder.set(options.activeProject);
  const chatSnapshot = {
    messages: [], busy: false, usage: null, sessions: [], activeSession: null,
    activeSessionPath: null, activeCrew: [], crewUnread: 0, queued: [], turnNotice: null,
  };
  const chatSession = {
    getSnapshot: () => chatSnapshot,
    subscribe: () => () => undefined,
    sendAndWait: vi.fn(),
  };
  // Chat navigations go through the tabs; a new tab resolves as the shown one here.
  const create = vi.fn().mockResolvedValue('main');
  const tabs = { reviewNavigation: new ReviewNavigation(), reviewInOrigin: vi.fn().mockResolvedValue('main'), create };
  const container = new Container();
  container.registerInstance(WORKFLOW, workflow as never);
  container.registerInstance(HELMRAISER_MONITOR, monitor as never);
  container.registerInstance(CHAT_ORCHESTRATOR, orchestrator as never);
  container.registerInstance(CHAT_SESSION, chatSession as never);
  container.registerInstance(CHAT_SESSIONS, tabs as never);
  container.registerInstance(TAB_MODEL, new TabModels(new MemoryStorageAdapter()).forTab('main', () => 'pi'));
  container.registerInstance(TAB_FOLDER, folder);
  container.registerInstance(TAB_FOLDERS, tabFolders);
  container.registerInstance(PREFERENCES, preferences);
  container.registerInstance(TRANSPORT, { getState: () => 'open', subscribe: () => () => undefined } as never);
  const rendered = render(
    <ContainerProvider container={container}>
      <ShellProvider><JobsPanel /><ShellProbe /></ShellProvider>
    </ContainerProvider>,
  );
  return { abort, plan, runReview, approve, reject, startWorker, stopWorker, pause, resume, refresh, report: workflow.report, stats: workflow.stats, draft, drafts, dropDraft, queueRemove, log, retry, rework, propose, queue: queueTask, orchestrator, currentChat, preferences, create, chatSession, container, rerender: rendered.rerender };
}

describe('JobsPanel', () => {
  it('mounts the Scout controls with the project x lens grid from the whole-ledger stats', async () => {
    const stats = vi.fn().mockResolvedValue(makeHelmraiserStats(
      (['state', 'docs', 'tests', 'guardrails'] as const).map((lens) => makeStatsScoutRow('/work/alpha', lens)),
    ));
    renderPanel((status) => {
      if (status.scouts) status.scouts.focus_projects = ['/work/alpha'];
    }, {}, { stats });
    expect(screen.getByRole('region', { name: 'Scout controls' })).toBeInTheDocument();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['project', 'state', 'docs', 'tests', 'guardrails']);
    expect(screen.getByRole('rowheader', { name: 'alpha' })).toHaveAttribute('title', '/work/alpha');
    expect(screen.getByRole('button', { name: 'Scout guardrails for /work/alpha' })).toBeEnabled();
    expect(stats).toHaveBeenCalledExactlyOnceWith('all');
    expect(await screen.findByText('No drafts — run a scout')).toBeInTheDocument();
  });

  it('mounts the Scouted section with its exact empty state', async () => {
    renderPanel();
    expect(await screen.findByText('No drafts — run a scout')).toBeInTheDocument();
  });

  it('shows the queue header, its queue | dashboard switch on queue, and an ok worker chip while the worker runs', () => {
    renderPanel();
    expect(screen.getByText('HELMRAISER')).toBeInTheDocument();
    // The old "· queue" suffix is now the switch's queue button.
    expect(screen.queryByText('· queue')).not.toBeInTheDocument();
    const views = screen.getByRole('navigation', { name: 'Helmraiser views' });
    expect(within(views).getAllByRole('button').map((button) => button.textContent)).toEqual(['queue', 'dashboard']);
    expect(within(views).getByRole('button', { name: 'queue' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(views).getByRole('button', { name: 'dashboard' })).toHaveAttribute('aria-pressed', 'false');
    const chip = screen.getByText('WORKER RUNNING');
    expect(chip.className).toContain('text-ok');
  });

  it('shows a dim worker chip when the worker is stopped', () => {
    renderPanel((status) => { status.worker = { state: 'stopped' }; });
    const chip = screen.getByText('WORKER STOPPED');
    expect(chip.className).toContain('text-muted');
  });

  it('renders paused and held-provider warnings in attention with local held-until times', () => {
    renderPanel((status) => {
      status.paused = { reason: 'budget cap reached', until: null };
      status.held_providers = { 'opencode-go': { until: 1790278146, detail: '5h window 11% used' } };
    });
    expect(screen.getByText('paused: budget cap reached')).toHaveClass('text-attention');
    expect(screen.getByText('opencode-go held until 19:29 — 5h window 11% used')).toHaveClass('text-attention');
  });

  it('renders the four sections with their counts and row facts from the fixture', () => {
    renderPanel();
    expect(screen.getByText('RUNNING (1)')).toBeInTheDocument();
    expect(screen.getByText('AWAITING YOUR APPROVAL (1)')).toHaveClass('text-attention');
    expect(screen.getByText('QUEUED NEXT (1)')).toBeInTheDocument();
    expect(screen.getByText('FAILED · 24H (1)')).toBeInTheDocument();

    expect(screen.getByText('Planned runs: a strong model plans, the cheap implementer follows the plan')).toBeInTheDocument();
    expect(screen.getAllByText('helmraiser')).toHaveLength(4); // one per section: running, awaiting, queued, failed
    expect(screen.getByText('implement')).toHaveClass('text-info');
    expect(screen.getByText('iteration 1')).toBeInTheDocument();
    expect(screen.getByText('7 min')).toBeInTheDocument();
    expect(screen.getByText('$2.07')).toBeInTheDocument();

    expect(screen.getByText('Count rejected runs separately')).toBeInTheDocument();
    expect(screen.getByText('merge')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.getByText('$0.11')).toBeInTheDocument();
    // A merge row is actionable right here; the CLI shorthand is gone.
    expect(screen.queryByText('helmraiser approve 865c36b8')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'APPROVE' })).toHaveClass('text-accent');
    expect(screen.getByRole('button', { name: 'REJECT' })).toHaveClass('text-danger');

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Status rows name their project, id and title')).toBeInTheDocument();

    expect(screen.getByText('Live subscription usage')).toBeInTheDocument();
    expect(screen.getByText('timeout: pi session exceeded its time limit')).toHaveClass('text-danger');
    expect(screen.getByText('15:12')).toBeInTheDocument();
  });

  it('falls back through title → id → task for row titles', () => {
    renderPanel((status) => {
      delete status.running[0]!.title;
      delete status.failed[0]!.title;
      delete status.failed[0]!.id;
      delete status.queue_next[0]!.title;
      delete status.queue_next[0]!.id;
    });
    expect(screen.getByText('planned-runs')).toBeInTheDocument();
    expect(screen.getByText('-home-example-projects-helmraiser:live-subscription-usage')).toBeInTheDocument();
    expect(screen.getByText('-home-example-projects-helmraiser:status-row-identity')).toBeInTheDocument();
  });

  it('offers ABORT only on running rows with a project, and abort calls with that project and run id', async () => {
    const user = userEvent.setup();
    const { abort, refresh } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'ABORT' }));
    expect(abort).toHaveBeenCalledWith('/home/example/projects/helmraiser', 'e1fba81e-9ac9-4421-af2c-9a28dc79da8e');
    expect(refresh).toHaveBeenCalled();
  });

  it('hides ABORT on running rows without a project', () => {
    renderPanel((status) => { delete status.running[0]!.project; });
    expect(screen.queryByRole('button', { name: 'ABORT' })).not.toBeInTheDocument();
  });

  it('does not render an empty queued section or claim the queue is empty when only the queued counter is nonzero', () => {
    // queue_next can be empty while status.queued_count is not: the counter keeps
    // the global empty state false, but a section requires visible rows.
    renderPanel((status) => { status.queue_next = []; status.queued_count = 3; });
    expect(screen.queryByText('queue empty')).not.toBeInTheDocument();
    expect(screen.queryByText('QUEUED NEXT (3)')).not.toBeInTheDocument();
  });

  it('shows five failed rows, then a count of the rest, and dims rejections', () => {
    renderPanel((status) => {
      const base = status.failed[0]!;
      status.failed = Array.from({ length: 7 }, (_, i) => ({
        ...base,
        run_id: `run-${i}`,
        title: `Failed task ${i}`,
        reason: i === 0 ? 'rejected' : base.reason,
      }));
      status.failed_24h_count = 7;
    });
    expect(screen.getByText('FAILED · 24H (7)')).toBeInTheDocument();
    expect(screen.getByText('Failed task 4')).toBeInTheDocument();
    expect(screen.queryByText('Failed task 5')).not.toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    expect(screen.getByText('rejected')).toHaveClass('text-muted');
    expect(screen.getByText('rejected')).not.toHaveClass('text-danger');
  });

  it('shows only "queue empty" for a loaded empty status', () => {
    renderPanel((status) => {
      status.queue_next = []; status.running = []; status.awaiting = []; status.failed = [];
      status.queued_count = 0; status.awaiting_count = 0; status.failed_24h_count = 0;
    });
    expect(screen.getByText('queue empty')).toBeInTheDocument();
    expect(screen.queryByText('RUNNING (0)')).not.toBeInTheDocument();
    expect(screen.queryByText('AWAITING YOUR APPROVAL (0)')).not.toBeInTheDocument();
    expect(screen.queryByText('QUEUED NEXT (0)')).not.toBeInTheDocument();
    expect(screen.queryByText('FAILED · 24H (0)')).not.toBeInTheDocument();
  });

  it('counts the awaiting and failed headings from the ledger totals, not the displayed rows', () => {
    renderPanel((status) => {
      status.awaiting_count = 3;
      status.failed_24h_count = 5;
    });
    expect(screen.getByText('AWAITING YOUR APPROVAL (3)')).toBeInTheDocument();
    expect(screen.getByText('FAILED · 24H (5)')).toBeInTheDocument();
  });

  it('says Helmraiser is not installed in one dim line, with a link, and shows nothing else of the view', () => {
    const { report, stats, drafts } = renderPanel(() => undefined, {
      status: null,
      error: 'Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net',
      unavailable: true,
    });
    expect(screen.getByText('HELMRAISER')).toBeInTheDocument();
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net');
    expect(line).toHaveClass('text-muted');
    expect(within(line).getByRole('link', { name: 'https://zsoltborsos.net' })).toHaveAttribute('href', 'https://zsoltborsos.net');
    // Queue, dashboard, headline strip, scout controls and task intake have nothing to work on.
    expect(screen.queryByRole('navigation', { name: 'Helmraiser views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'NEW TASK' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Last 24 hours' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Scout controls' })).not.toBeInTheDocument();
    expect(screen.queryByText('queue empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // And no read is asked of a Helmraiser that is not there.
    expect(report).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(drafts).not.toHaveBeenCalled();
  });

  it('keeps a real helmraiser error danger and audible', () => {
    renderPanel(() => undefined, { status: null, error: 'helmraiser status → 503', unavailable: false });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('503');
    expect(alert.className).toContain('text-danger');
  });

  it('sends the full run id when approving a merge row', async () => {
    const user = userEvent.setup();
    const { approve, refresh } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'APPROVE' }));
    expect(approve).toHaveBeenCalledWith('865c36b8-a39d-433a-bc6c-87b1715d14e2');
    expect(refresh).toHaveBeenCalled();
  });

  describe('queued rows held or unable to start', () => {
    it('says what a held queued row waits for and why, naming the task it waits on', () => {
      renderPanel(addQueueHolds);
      const row = screen.getByRole('article', { name: 'Queued task: Sync the board with the access policy' });
      expect(within(row).getByText('waits for the merge of access-policy — same files')).toBeInTheDocument();
      // A queued row that is not held says nothing of the kind.
      const free = screen.getByRole('article', { name: 'Queued task: Status rows name their project, id and title' });
      expect(within(free).queryByText(/waits for|depends on|cannot start/)).not.toBeInTheDocument();
    });

    it('uses the held list when the queued entry itself carries no held_by', () => {
      renderPanel((status) => {
        addQueueHolds(status);
        status.queue_next.find((entry) => entry.id === 'board-sync')!.held_by = null;
      });
      const row = screen.getByRole('article', { name: 'Queued task: Sync the board with the access policy' });
      expect(within(row).getByText('waits for the merge of access-policy — same files')).toBeInTheDocument();
    });

    it('shows an unknown hold reason as its raw code', () => {
      renderPanel((status) => {
        addQueueHolds(status);
        status.queue_next.find((entry) => entry.id === 'board-sync')!.held_by!.reason = 'queue_full';
      });
      const row = screen.getByRole('article', { name: 'Queued task: Sync the board with the access policy' });
      expect(within(row).getByText('waits for the merge of access-policy — queue_full')).toBeInTheDocument();
    });

    it('says a never-startable task cannot start, and why, on its own row beyond the first five', () => {
      renderPanel(addQueueHolds);
      const row = screen.getByRole('article', { name: 'Queued task: Rewrite the loop' });
      expect(within(row).getByText(/^cannot start — projected \$5 on opencode-go\/unlisted is 167% of the opencode-go 5h window/)).toBeInTheDocument();
    });

    it('puts the cannot-start line on the queued row it belongs to instead of repeating the task', () => {
      renderPanel((status) => {
        addQueueHolds(status);
        status.queue_next.push({
          task_id: status.never_startable![0]!.task_id, id: 'rewrite-the-loop', title: 'Rewrite the loop',
          priority: 'low', project: '/home/example/projects/helmraiser', held_by: null,
        });
      });
      expect(screen.getAllByRole('article', { name: 'Queued task: Rewrite the loop' })).toHaveLength(1);
      expect(screen.getByText(/^cannot start — /)).toBeInTheDocument();
    });
  });

  describe('removing a queued task', () => {
    const FREE_TASK = '-home-example-projects-helmraiser:status-row-identity';
    const freeRow = () => screen.getByRole('article', { name: 'Queued task: Status rows name their project, id and title' });

    it('asks first and sends nothing until the removal is confirmed', async () => {
      const user = userEvent.setup();
      const { queueRemove } = renderPanel();
      await user.click(within(freeRow()).getByRole('button', { name: 'REMOVE' }));
      expect(within(freeRow()).getByText('Take this task out of the queue? It goes back to draft; its task file is untouched.')).toBeInTheDocument();
      expect(within(freeRow()).getByRole('button', { name: 'CONFIRM REMOVE' })).toBeInTheDocument();
      expect(queueRemove).not.toHaveBeenCalled();
    });

    it('CANCEL puts the row back without calling anything', async () => {
      const user = userEvent.setup();
      const { queueRemove } = renderPanel();
      await user.click(within(freeRow()).getByRole('button', { name: 'REMOVE' }));
      await user.click(within(freeRow()).getByRole('button', { name: 'CANCEL' }));
      expect(within(freeRow()).getByRole('button', { name: 'REMOVE' })).toBeInTheDocument();
      expect(within(freeRow()).queryByRole('button', { name: 'CONFIRM REMOVE' })).not.toBeInTheDocument();
      expect(queueRemove).not.toHaveBeenCalled();
    });

    it('CONFIRM REMOVE sends the full task id once and refreshes the panel', async () => {
      const user = userEvent.setup();
      const { queueRemove, refresh } = renderPanel();
      refresh.mockClear(); // the monitor already refreshed once when the transport opened
      await user.click(within(freeRow()).getByRole('button', { name: 'REMOVE' }));
      await user.click(within(freeRow()).getByRole('button', { name: 'CONFIRM REMOVE' }));
      expect(queueRemove).toHaveBeenCalledExactlyOnceWith(FREE_TASK);
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the CLI\'s refusal on that row only, and leaves the row removable again', async () => {
      const user = userEvent.setup();
      const refusal = new WireCallError('helmraiser queue failed: cannot remove task in status running; only queued tasks can be removed', 'helmraiser_cli_error');
      const { refresh } = renderPanel(addQueueHolds, {}, { queueRemove: vi.fn().mockRejectedValue(refusal) });
      refresh.mockClear();
      await user.click(within(freeRow()).getByRole('button', { name: 'REMOVE' }));
      await user.click(within(freeRow()).getByRole('button', { name: 'CONFIRM REMOVE' }));
      expect(await within(freeRow()).findByRole('alert')).toHaveTextContent('⚠ Not removed — cannot remove task in status running; only queued tasks can be removed');
      expect(within(freeRow()).getByRole('button', { name: 'REMOVE' })).toBeEnabled();
      const other = screen.getByRole('article', { name: 'Queued task: Sync the board with the access policy' });
      expect(within(other).queryByRole('alert')).not.toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
      // The next try starts clean.
      await user.click(within(freeRow()).getByRole('button', { name: 'REMOVE' }));
      expect(within(freeRow()).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('offers REMOVE on held and never-startable rows too', () => {
      renderPanel(addQueueHolds);
      for (const title of ['Sync the board with the access policy', 'Rewrite the loop']) {
        expect(within(screen.getByRole('article', { name: `Queued task: ${title}` })).getByRole('button', { name: 'REMOVE' })).toBeEnabled();
      }
    });

    it('disables REMOVE while another panel action is pending', async () => {
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, { approve: vi.fn(() => new Promise(() => undefined)) });
      await user.click(screen.getByRole('button', { name: 'APPROVE' }));
      expect(within(freeRow()).getByRole('button', { name: 'REMOVE' })).toBeDisabled();
    });
  });

  describe('new task intake flow', () => {
    /** Open the form and fill it; returns after the fields are set. */
    async function fillForm(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
      await user.type(screen.getByLabelText('Title'), 'New task');
      await user.type(screen.getByLabelText('Goal'), 'Describe the work.');
    }

    it('opens the inline form naming known projects and defaulting to the active chat project', async () => {
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {}, { activeProject: ACTIVE_A });
      await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
      expect(within(screen.getByRole('combobox', { name: 'Project' })).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual([
        '/home/example/projects/helmraiser',
        '/home/example/projects/funkyoctopus',
      ]);
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('/home/example/projects/helmraiser');
    });

    it('fills the default project when discovery lands after the form opened', async () => {
      let release: (catalog: unknown) => void = () => undefined;
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {}, {
        activeProject: ACTIVE_A,
        discover: () => new Promise((resolve) => { release = resolve; }),
      });
      await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
      // Discovery has not resolved yet: no options, and PROPOSE cannot be armed.
      expect(screen.getByText('no known projects')).toBeInTheDocument();
      await user.type(screen.getByLabelText('Title'), 'Late discovery');
      await user.type(screen.getByLabelText('Goal'), 'Describe the work.');
      expect(screen.getByRole('button', { name: 'PROPOSE' })).toBeDisabled();

      release({ globalRoot: '/home/example/projects', known: [KNOW_A, KNOW_B], folders: [] });
      await waitFor(() => expect(screen.getByRole('button', { name: 'PROPOSE' })).toBeEnabled());
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(KNOW_A.path);
    });

    it('defaults to the first known project when the chat project is not known', async () => {
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {}, { activeProject: null });
      await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(KNOW_A.path);
    });

    it('PROPOSE drafts then proposes with the exact typed values, previewing the rendered task', async () => {
      const user = userEvent.setup();
      const { draft, propose } = renderPanel();
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await waitFor(() => expect(screen.getByText(PROPOSAL.path)).toBeInTheDocument());
      expect(draft).toHaveBeenCalledWith('/home/example/projects/helmraiser', 'New task', 'Describe the work.');
      expect(propose).toHaveBeenCalledWith(PROPOSAL.path);
      expect(propose).toHaveBeenCalledAfter(draft);
      expect(screen.getByText(/## Goal/)).toBeInTheDocument();
      expect(screen.getByText('The plan is sound.')).toHaveClass('text-muted');
    });

    it('puts attention notes above the task preview without coloring neutral notes attention', async () => {
      const user = userEvent.setup();
      const warning = 'Attention: proposed verification inspects source structure.';
      renderPanel(() => undefined, {}, {
        propose: vi.fn().mockResolvedValue({ ...PROPOSAL, notes: ['The plan is sound.', warning] }),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      const preview = await screen.findByText(/## Goal/);
      const neutral = screen.getByText('The plan is sound.');
      const attention = screen.getByText(warning);
      expect(neutral).toHaveClass('text-muted');
      expect(neutral).not.toHaveClass('text-attention');
      expect(attention).toHaveClass('text-attention');
      expect(attention.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the intake wait line and disables buttons while the proposal is in flight', async () => {
      let release: (value: typeof PROPOSAL) => void = () => undefined;
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {
        propose: vi.fn(() => new Promise<typeof PROPOSAL>((resolve) => { release = resolve; })),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      expect(screen.getByText(/intake is proposing/)).toBeInTheDocument();
      expect(screen.getByText(/up to a couple of minutes/)).toBeInTheDocument();
      for (const name of ['PROPOSE', 'CANCEL', 'STOP', 'PAUSE', 'NEW TASK']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      release(PROPOSAL);
      await waitFor(() => expect(screen.getByRole('button', { name: 'QUEUE' })).toBeEnabled());
    });

    it('QUEUE queues once with the preview path and current FO origin, refreshes and closes the form', async () => {
      const user = userEvent.setup();
      const { queue, refresh, currentChat } = renderPanel();
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'QUEUE' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'QUEUE' }));
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(currentChat).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledWith(PROPOSAL.path, 'fo:/fixture/session.jsonl');
      await waitFor(() => expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument());
    });

    it('queues without origin when there is no current conversation', async () => {
      const user = userEvent.setup();
      const { queue } = renderPanel(() => undefined, {}, {}, {
        currentChat: () => Promise.resolve(null),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await user.click(await screen.findByRole('button', { name: 'QUEUE' }));
      await waitFor(() => expect(queue).toHaveBeenCalledWith(PROPOSAL.path, undefined));
    });

    it('keeps the preview when current-chat lookup fails and does not queue', async () => {
      const user = userEvent.setup();
      const { queue } = renderPanel(() => undefined, {}, {}, {
        currentChat: () => Promise.reject(new Error('chat lookup failed')),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await user.click(await screen.findByRole('button', { name: 'QUEUE' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('chat lookup failed');
      expect(screen.getByText(PROPOSAL.path)).toBeInTheDocument();
      expect(queue).not.toHaveBeenCalled();
    });

    it('DISCARD makes no workflow call, closes and shows the kept-draft line', async () => {
      const user = userEvent.setup();
      const { draft, propose, queue } = renderPanel();
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'DISCARD' })).toBeEnabled());
      draft.mockClear(); propose.mockClear(); queue.mockClear();
      await user.click(screen.getByRole('button', { name: 'DISCARD' }));
      expect(draft).not.toHaveBeenCalled();
      expect(propose).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(`draft kept at ${PROPOSAL.path.replace(/[/.]/g, '\\$&')}`))).toBeInTheDocument();
    });

    it('a propose failure keeps inputs, shows error, code and draft path, and RETRY re-proposes the same path', async () => {
      const user = userEvent.setup();
      let calls = 0;
      const proposeOverride = vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new WireCallError('intake judged the proposal invalid', 'helmraiser_cli_error'));
        }
        return Promise.resolve(PROPOSAL);
      });
      const { draft } = renderPanel(() => undefined, {}, { propose: proposeOverride });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('intake judged the proposal invalid');
      expect(alert.textContent).toContain('helmraiser_cli_error');
      expect(screen.getByText(new RegExp(`draft kept at ${PROPOSAL.path.replace(/[/.]/g, '\\$&')}`))).toBeInTheDocument();
      // Inputs survive the failure.
      expect(screen.getByLabelText('Title')).toHaveValue('New task');
      expect(screen.getByLabelText('Goal')).toHaveValue('Describe the work.');
      expect(draft).toHaveBeenCalledOnce(); // no second draft on retry
      // Once a draft path exists, FROM CHAT must not replace the displayed
      // fields while RETRY PROPOSE still targets the already-saved file.
      expect(screen.queryByRole('button', { name: 'FROM CHAT' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'RETRY PROPOSE' }));
      await waitFor(() => expect(screen.getByText(/## Goal/)).toBeInTheDocument());
      expect(proposeOverride).toHaveBeenCalledTimes(2);
      expect(proposeOverride).toHaveBeenNthCalledWith(2, PROPOSAL.path);
      expect(draft).toHaveBeenCalledOnce();
    });

    it('an existing-draft failure keeps the typed values and suggests a different title', async () => {
      const user = userEvent.setup();
      const { propose } = renderPanel(() => undefined, {}, {
        draft: vi.fn().mockRejectedValue(new WireCallError(
          'helmraiser add failed: task file already exists',
          'helmraiser_cli_error',
        )),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('task file already exists');
      expect(alert.textContent).toContain('helmraiser_cli_error');
      expect(screen.getByText(/choose a different title/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toHaveValue('New task');
      expect(screen.getByLabelText('Goal')).toHaveValue('Describe the work.');
      expect(propose).not.toHaveBeenCalled();
    });

    it('a queue failure keeps the preview and shows the error inline', async () => {
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {
        queue: vi.fn().mockRejectedValue(new WireCallError('helmraiser queue failed', 'helmraiser_cli_error')),
      });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'QUEUE' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'QUEUE' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('helmraiser queue failed');
      expect(screen.getByText(/## Goal/)).toBeInTheDocument();
      expect(screen.getByText(PROPOSAL.path)).toBeInTheDocument();
    });

    it('the preview shows only QUEUE and DISCARD, with no closing CANCEL', async () => {
      const user = userEvent.setup();
      renderPanel();
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'QUEUE' })).toBeEnabled());
      expect(screen.queryByRole('button', { name: 'CANCEL' })).not.toBeInTheDocument();
    });

    it('a pending panel action disables the intake controls too', async () => {
      let settleApprove: (value: unknown) => void = () => undefined;
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {
        approve: vi.fn(() => new Promise((resolve) => { settleApprove = resolve; })),
      });
      await user.click(screen.getByRole('button', { name: 'APPROVE' }));
      expect(screen.getByRole('button', { name: 'NEW TASK' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'STOP' })).toBeDisabled();
      settleApprove(undefined);
      await waitFor(() => expect(screen.getByRole('button', { name: 'NEW TASK' })).toBeEnabled());
    });

    it('a pending intake call disables the panel action buttons', async () => {
      const user = userEvent.setup();
      renderPanel(() => undefined, {}, {
        propose: vi.fn(() => new Promise<typeof PROPOSAL>(() => undefined)), // never settles
      });
      await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
      await user.type(screen.getByLabelText('Title'), 'Pending task');
      await user.type(screen.getByLabelText('Goal'), 'Describe the work.');
      await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
      expect(screen.getByText(/intake is proposing/)).toBeInTheDocument();
      for (const name of ['APPROVE', 'REJECT', 'STOP', 'PAUSE', 'ABORT']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
    });
  });

  it('confirms a reject with the typed note', async () => {
    const user = userEvent.setup();
    const { reject, refresh } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'REJECT' }));
    expect(screen.queryByRole('button', { name: 'APPROVE' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Reject note'), 'not ready');
    await user.click(screen.getByRole('button', { name: 'CONFIRM REJECT' }));
    expect(reject).toHaveBeenCalledWith('865c36b8-a39d-433a-bc6c-87b1715d14e2', 'not ready');
    expect(refresh).toHaveBeenCalled();
  });

  it('closes the reject form without rejecting', async () => {
    const user = userEvent.setup();
    const { reject } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'REJECT' }));
    await user.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(screen.getByRole('button', { name: 'APPROVE' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Reject note')).not.toBeInTheDocument();
    expect(reject).not.toHaveBeenCalled();
  });

  it('expands REVIEW with verdict, findings, verify/evidence and diff stat', async () => {
    const user = userEvent.setup();
    const { runReview } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    expect(await screen.findByText(/Verdict: pass/)).toBeInTheDocument();
    expect(screen.getByText(/\[medium\] src\/run\.ts:42 — preserve ordering/)).toBeInTheDocument();
    expect(screen.getByText(/npm run verify: pass/)).toBeInTheDocument();
    expect(screen.getByText(/browser screenshot/)).toBeInTheDocument();
    expect(screen.getByText('src/run.ts')).toBeInTheDocument();
    expect(screen.getByText('+7')).toBeInTheDocument();
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(runReview).toHaveBeenCalledWith('865c36b8-a39d-433a-bc6c-87b1715d14e2');
  });

  it('falls back to summary.md Review content when review.md is absent', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, {
      runReview: vi.fn().mockResolvedValue({
        summary: '## Verify\npass\n\n### Review\nVerdict: pass\n- [high] src/a.ts:7 — fix this\n\n## Footer\nnot review',
        review: null,
        diffStat: { files: [], filesChanged: 0, additions: 0, deletions: 0 },
        diffTruncated: false,
        taskPath: '/custom/runs/id/task.md',
      }),
    });
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    await waitFor(() => {
      const reviewPane = screen.getByText('REVIEW · VERDICT · FINDINGS').closest('section')?.querySelector('pre');
      expect(reviewPane).toHaveTextContent('[high] src/a.ts:7 — fix this');
      expect(reviewPane).toHaveTextContent('Verdict: pass');
      expect(reviewPane).not.toHaveTextContent('not review');
    });
  });

  it('shows a failed review load and retries after REVIEW is closed and reopened', async () => {
    const user = userEvent.setup();
    const runReview = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({
        summary: 'verify: pass', review: 'Verdict: pass',
        diffStat: { files: [], filesChanged: 0, additions: 0, deletions: 0 },
        diffTruncated: false, taskPath: '/custom/runs/id/task.md',
      });
    renderPanel(() => undefined, {}, { runReview });
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    expect(await screen.findByText('review could not be loaded — reopen REVIEW to retry')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    expect(await screen.findByText('Verdict: pass')).toBeInTheDocument();
    expect(runReview).toHaveBeenCalledTimes(2);
  });

  it('keeps a NEW TASK flow on the tab shown when it opened: FROM CHAT reads that tab even after a switch', async () => {
    const user = userEvent.setup();
    const { chatSession, container, rerender } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    expect(screen.getByText('reads “untitled chat”')).toBeInTheDocument();

    // Another tab is shown now (Alt+2 from the chat view, say): its scope answers.
    const other = new Container(container);
    const otherSession = {
      getSnapshot: () => ({ messages: [], busy: false, activeSession: { title: 'other tab' } }),
      subscribe: () => () => undefined,
      sendAndWait: vi.fn(),
    };
    other.registerInstance(CHAT_SESSION, otherSession as never);
    other.registerInstance(TAB_MODEL, new TabModels(new MemoryStorageAdapter()).forTab('b', () => 'pi'));
    other.registerInstance(TAB_FOLDER, new TabFolders(new MemoryStorageAdapter()).forTab('b'));
    rerender(
      <ContainerProvider container={other}>
        <ShellProvider><JobsPanel /><ShellProbe /></ShellProvider>
      </ContainerProvider>,
    );
    expect(screen.getByText('reads “untitled chat”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'FROM CHAT' }));

    await waitFor(() => expect(chatSession.sendAndWait).toHaveBeenCalledOnce());
    expect(otherSession.sendAndWait).not.toHaveBeenCalled();
  });

  it('says so when the tab a NEW TASK flow reads from was closed, and sends nothing', async () => {
    const user = userEvent.setup();
    const { chatSession } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    // The pinned tab closes (from this window, another one, or fo) before FROM CHAT.
    (chatSession as { closed?: boolean }).closed = true;
    await user.click(screen.getByRole('button', { name: 'FROM CHAT' }));

    expect(await screen.findByText(/the chat this task reads from was closed/)).toBeInTheDocument();
    expect(chatSession.sendAndWait).not.toHaveBeenCalled();
  });

  it('opens a fresh chat in a new tab at the worktree and prefills without sending', async () => {
    const user = userEvent.setup();
    const { create } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    await user.click(await screen.findByRole('button', { name: 'OPEN IN CHAT' }));
    await waitFor(() => expect(screen.getByLabelText('shell view')).toHaveTextContent('chat'));
    expect(create).toHaveBeenCalledExactlyOnceWith(
      'pi',
      '/home/example/projects/helmraiser/.helmraiser/worktrees/report-rejected-split',
      expect.any(Function),
    );
    expect(screen.getByLabelText('chat draft')).toHaveTextContent(
      "Review this Helmraiser run's diff against its task: run 865c36b8-a39d-433a-bc6c-87b1715d14e2, branch feature/report-rejected-split, base abc1234. The task is in /non-default/helmraiser/runs/865c36b8-a39d-433a-bc6c-87b1715d14e2/task.md.",
    );
  });

  it('hides OPEN IN CHAT when an older awaiting row has no worktree', async () => {
    const user = userEvent.setup();
    renderPanel((status) => { delete status.awaiting[0]!.worktree; });
    await user.click(screen.getByRole('button', { name: 'REVIEW' }));
    await screen.findByText(/Verdict: pass/);
    expect(screen.queryByRole('button', { name: 'OPEN IN CHAT' })).not.toBeInTheDocument();
  });

  it('expands PLAN through the jobs API and renders its plain text', async () => {
    const user = userEvent.setup();
    const { plan } = renderPanel((status) => { status.awaiting[0]!.pending = 'plan'; });
    await user.click(screen.getByRole('button', { name: 'PLAN' }));
    expect(await screen.findByText(/# Implementation plan/)).toBeInTheDocument();
    expect(plan).toHaveBeenCalledWith('865c36b8-a39d-433a-bc6c-87b1715d14e2');
  });

  it('says when the plan could not be loaded, and reopening PLAN retries', async () => {
    const user = userEvent.setup();
    const plan = vi.fn()
      .mockRejectedValueOnce(new Error('Helmraiser plan does not exist'))
      .mockResolvedValueOnce({ text: '# Implementation plan' });
    renderPanel((status) => { status.awaiting[0]!.pending = 'plan'; }, {}, { plan });
    await user.click(screen.getByRole('button', { name: 'PLAN' }));
    expect(await screen.findByText('plan could not be loaded — reopen PLAN to retry')).toBeInTheDocument();
    expect(screen.queryByText('loading plan…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'PLAN' }));
    await user.click(screen.getByRole('button', { name: 'PLAN' }));
    expect(await screen.findByText('# Implementation plan')).toBeInTheDocument();
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('APPROVE PLAN sends the entered note and reports a serving worker without starting one', async () => {
    const user = userEvent.setup();
    const approvePlan = vi.fn().mockResolvedValue({ approved: 'plan', worker_serves_project: true });
    const { startWorker } = renderPanel(
      (status) => { status.awaiting[0]!.pending = 'plan'; },
      {},
      { approve: approvePlan },
    );
    await user.type(screen.getByLabelText('Approval note'), 'Keep the migration reversible.');
    await user.click(screen.getByRole('button', { name: 'APPROVE PLAN' }));
    await waitFor(() => expect(screen.getByText('plan approved — the worker resumes it')).toBeInTheDocument());
    expect(approvePlan).toHaveBeenCalledWith(
      '865c36b8-a39d-433a-bc6c-87b1715d14e2',
      'Keep the migration reversible.',
    );
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('reports that a stopped worker must be started after plan approval without starting it', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(
      (status) => {
        status.awaiting[0]!.pending = 'plan';
        status.worker = { state: 'stopped' };
      },
      {},
      { approve: vi.fn().mockResolvedValue({ approved: 'plan', worker_serves_project: false }) },
    );
    await user.click(screen.getByRole('button', { name: 'APPROVE PLAN' }));
    await waitFor(() => expect(screen.getByText('plan approved — start the worker to resume it')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'START' })).toBeInTheDocument();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('requires confirmation before rejecting a plan and sends its optional rejection note', async () => {
    const user = userEvent.setup();
    const reject = vi.fn().mockResolvedValue({ rejected: true });
    renderPanel((status) => { status.awaiting[0]!.pending = 'plan'; }, {}, { reject });
    await user.click(screen.getByRole('button', { name: 'REJECT' }));
    expect(reject).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Reject note'), 'Revise step two.');
    await user.click(screen.getByRole('button', { name: 'CONFIRM REJECT' }));
    expect(reject).toHaveBeenCalledWith('865c36b8-a39d-433a-bc6c-87b1715d14e2', 'Revise step two.');
  });

  it('shares panel busy handling while a plan is loading', async () => {
    const user = userEvent.setup();
    let resolvePlan: (value: { text: string }) => void = () => undefined;
    renderPanel(
      (status) => { status.awaiting[0]!.pending = 'plan'; },
      {},
      { plan: vi.fn(() => new Promise((resolve) => { resolvePlan = resolve; })) },
    );
    await user.click(screen.getByRole('button', { name: 'PLAN' }));
    for (const name of ['PLAN', 'APPROVE PLAN', 'REJECT', 'STOP', 'PAUSE', 'ABORT']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    resolvePlan({ text: 'loaded' });
    await waitFor(() => expect(screen.getByText('loaded')).toBeInTheDocument());
  });

  it('renders resuming runs read-only and counts them as active work', () => {
    renderPanel((status) => {
      status.running = []; status.awaiting = []; status.queue_next = []; status.failed = [];
      status.queued_count = 0; status.awaiting_count = 0; status.failed_24h_count = 0;
      status.resuming = [{
        run_id: '865c36b8-a39d-433a-bc6c-87b1715d14e2',
        task: 'fixture:resume-plan', project: '/fixture/funkyoctopus', id: 'resume-plan',
        title: 'Resume the approved implementation', stage: 'implement',
      }];
    });
    expect(screen.getByText('RESUMING (1)')).toBeInTheDocument();
    expect(screen.getByText('Resume the approved implementation')).toBeInTheDocument();
    expect(screen.getByText('funkyoctopus')).toBeInTheDocument();
    expect(screen.getByText('resuming at implement')).toBeInTheDocument();
    expect(screen.queryByText('queue empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ABORT' })).not.toBeInTheDocument();
  });

  it('treats an older status without resuming as an empty list', () => {
    renderPanel((status) => { delete status.resuming; });
    expect(screen.queryByText(/RESUMING/)).not.toBeInTheDocument();
    expect(screen.getByText('RUNNING (1)')).toBeInTheDocument();
  });

  it('shows STOP and PAUSE in the header while the worker runs and the queue is open', async () => {
    const user = userEvent.setup();
    const { stopWorker, pause } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'STOP' }));
    await user.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('shows START and RESUME when the worker is stopped and the queue is paused', async () => {
    const user = userEvent.setup();
    const { startWorker, resume } = renderPanel((status) => {
      status.worker = { state: 'stopped' };
      status.paused = { reason: 'budget cap reached', until: null };
    });
    await user.click(screen.getByRole('button', { name: 'START' }));
    await user.click(screen.getByRole('button', { name: 'RESUME' }));
    expect(startWorker).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('disables every action button while an action is pending and recovers after', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, {
      approve: vi.fn(() => new Promise((resolve) => { settle = resolve; })),
    });
    await user.click(screen.getByRole('button', { name: 'APPROVE' }));
    for (const name of ['APPROVE', 'REJECT', 'STOP', 'PAUSE', 'ABORT']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    settle(undefined);
    await waitFor(() => expect(screen.getByRole('button', { name: 'APPROVE' })).toBeEnabled());
  });

  it('shows a failed action in the existing error line and clears pending', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, {
      approve: vi.fn().mockRejectedValue(new Error('helmraiser approve failed: unknown run: deadbeef')),
    });
    await user.click(screen.getByRole('button', { name: 'APPROVE' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('helmraiser approve failed: unknown run: deadbeef'));
    expect(screen.getByRole('button', { name: 'APPROVE' })).toBeEnabled();
  });

  it('leaves no v1 controls behind', () => {
    renderPanel();
    expect(screen.queryByText(/DRAFT TOPIC|INITIALIZE|DEEP VIEW|DISPATCH/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/TOPIC|WORKFLOW|AGENT|DELIVERY/)).not.toBeInTheDocument();
  });
});

describe('JobsPanel views', () => {
  const views = () => within(screen.getByRole('navigation', { name: 'Helmraiser views' }));

  it('swaps the queue for the dashboard and back, keeping the header and the worker controls', async () => {
    const user = userEvent.setup();
    const { report } = renderPanel((status) => {
      if (status.scouts) status.scouts.focus_projects = ['/work/alpha'];
    });
    expect(screen.getByRole('region', { name: 'Scout controls' })).toBeInTheDocument();
    expect(screen.getByText('RUNNING (1)')).toBeInTheDocument();

    await user.click(views().getByRole('button', { name: 'dashboard' }));
    expect(views().getByRole('button', { name: 'dashboard' })).toHaveAttribute('aria-pressed', 'true');
    expect(views().getByRole('button', { name: 'queue' })).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByText('HEALTH · LAST 7D')).toBeInTheDocument();
    expect(report).toHaveBeenCalledWith('7d');
    // None of the queue shows: not the Scout controls, nor any row section.
    expect(screen.queryByRole('region', { name: 'Scout controls' })).not.toBeInTheDocument();
    expect(screen.getByText('RUNNING (1)')).not.toBeVisible();
    expect(screen.getByText('QUEUED NEXT (1)')).not.toBeVisible();
    expect(screen.getByText('FAILED · 24H (1)')).not.toBeVisible();
    // The header and the worker controls are in both views.
    expect(screen.getByText('HELMRAISER')).toBeInTheDocument();
    expect(screen.getByText('WORKER RUNNING')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NEW TASK' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'STOP' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeEnabled();

    await user.click(views().getByRole('button', { name: 'queue' }));
    expect(screen.getByRole('region', { name: 'Scout controls' })).toBeInTheDocument();
    expect(screen.getByText('RUNNING (1)')).toBeVisible();
    expect(screen.queryByText('HEALTH · LAST 7D')).not.toBeInTheDocument();
    // The queue stayed mounted, so its strip did not ask for 24h again.
    expect(report.mock.calls.filter(([since]) => since === '24h')).toHaveLength(1);
  });

  it('puts the 24h headline at the top of the queue, above the Scout controls and the rows, and its link opens the dashboard', async () => {
    const user = userEvent.setup();
    const { report } = renderPanel((status) => {
      if (status.scouts) status.scouts.focus_projects = ['/work/alpha'];
    });
    const strip = screen.getByRole('region', { name: 'Last 24 hours' });
    expect(await within(strip).findByText('LAST 24H · 16:05')).toBeInTheDocument();
    expect(report).toHaveBeenCalledExactlyOnceWith('24h');
    const before = (other: HTMLElement) => Boolean(strip.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByRole('region', { name: 'Scout controls' }))).toBe(true);
    expect(before(screen.getByText('RUNNING (1)'))).toBe(true);
    expect(before(screen.getByText('AWAITING YOUR APPROVAL (1)'))).toBe(true);

    await user.click(within(strip).getByRole('button', { name: 'dashboard →' }));
    expect(await screen.findByText('HEALTH · LAST 7D')).toBeInTheDocument();
    expect(views().getByRole('button', { name: 'dashboard' })).toHaveAttribute('aria-pressed', 'true');
    // The strip belongs to the queue view only; the dashboard asks for its own window.
    expect(screen.queryByRole('region', { name: 'Last 24 hours' })).not.toBeInTheDocument();
    expect(report).toHaveBeenLastCalledWith('7d');
  });

  it('gives the dashboard the status the panel already has, for its subscription bars', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(views().getByRole('button', { name: 'dashboard' }));
    await screen.findByText('HEALTH · LAST 7D');
    // The fixture's one provider, all three windows (the queue's headline strip is gone).
    expect(screen.getAllByRole('meter').map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['11', '11', '5']);
  });
});

describe('JobsPanel run log', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A click inside async act, so the read it starts has settled when this resolves. */
  const click = (element: HTMLElement) => act(() => { fireEvent.click(element); return Promise.resolve(); });

  const RUNNING_ID = 'e1fba81e-9ac9-4421-af2c-9a28dc79da8e';
  const FAILED_ID = '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc';
  const rowOf = (title: string) => screen.getByText(title).closest('.rounded') as HTMLElement;
  const runningRow = () => rowOf('Planned runs: a strong model plans, the cheap implementer follows the plan');
  const failedRow = () => rowOf('Live subscription usage');

  it('gives running and failed rows a collapsed LOG toggle, and no other row', () => {
    const { log } = renderPanel();
    expect(within(runningRow()).getByRole('button', { name: 'LOG' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(failedRow()).getByRole('button', { name: 'LOG' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: 'LOG' })).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  it('opens each row\'s own run, in place, and the rest of the panel stays usable', async () => {
    const user = userEvent.setup();
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog(), truncated: false });
    renderPanel(() => undefined, {}, { log });
    await user.click(within(failedRow()).getByRole('button', { name: 'LOG' }));
    expect(log).toHaveBeenCalledExactlyOnceWith(FAILED_ID);
    const list = await within(failedRow()).findByRole('list', { name: 'Run log' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(39);
    // The row says why it failed; the log does not say it again.
    expect(within(list).getAllByRole('listitem').at(-1)?.textContent).not.toContain('Keeping it unchanged');

    await user.click(within(runningRow()).getByRole('button', { name: 'LOG' }));
    expect(log).toHaveBeenLastCalledWith(RUNNING_ID);
    expect(within(runningRow()).getByRole('button', { name: 'ABORT' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeEnabled();
  });

  it('shows an unreadable log as an alert on its own row only', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, { log: vi.fn().mockRejectedValue(new WireCallError('helmraiser log failed: unknown run: 3b8cf951', 'helmraiser_cli_error')) });
    await user.click(within(failedRow()).getByRole('button', { name: 'LOG' }));
    expect(await within(failedRow()).findByRole('alert')).toHaveTextContent('⚠ Log not loaded — unknown run: 3b8cf951');
    expect(within(runningRow()).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('follows an open running log but not an open failed one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.fn().mockResolvedValue({ events: makeFailedRunLog().slice(0, 3), truncated: false });
    renderPanel(() => undefined, {}, { log });
    await click(within(failedRow()).getByRole('button', { name: 'LOG' }));
    await click(within(runningRow()).getByRole('button', { name: 'LOG' }));
    expect(log).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(RUNNING_ID, 337484);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(log.mock.calls.filter(([runId]) => runId === FAILED_ID)).toHaveLength(1);
  });
});

describe('JobsPanel retrying a failed run', () => {
  const FAILED_ID = '3b8cf951-3d8c-40cf-a77b-f6cf0f28cedc';
  const rowOf = (title: string) => screen.getByText(title).closest('.rounded') as HTMLElement;
  const failedRow = () => rowOf('Live subscription usage');
  // The CLI help's own words for what each button does.
  const RESUME_WORDS = 'It resumes at verify → evidence → review.';
  const IMPLEMENT_WORDS = 'It goes back to implement with the last verify failure.';

  it('gives failed rows RETRY and RETRY (IMPLEMENT), and no other row', () => {
    const { retry } = renderPanel();
    expect(within(failedRow()).getByRole('button', { name: 'RETRY' })).toBeEnabled();
    expect(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'RETRY' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'RETRY (IMPLEMENT)' })).toHaveLength(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('offers no retry on a run the owner rejected', () => {
    renderPanel((status) => {
      const base = status.failed[0]!;
      status.failed = [base, { ...base, run_id: 'run-rejected', title: 'Rejected task', reason: 'rejected' }];
    });
    expect(within(failedRow()).getByRole('button', { name: 'RETRY' })).toBeEnabled();
    expect(within(rowOf('Rejected task')).queryByRole('button', { name: /^RETRY/ })).not.toBeInTheDocument();
  });

  it('RETRY says what it does in the help\'s words and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { retry } = renderPanel();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    expect(within(failedRow()).getByText(/^Re-reads the task file and hands the run back to the worker\./)).toHaveTextContent(RESUME_WORDS);
    expect(within(failedRow()).queryByText(IMPLEMENT_WORDS, { exact: false })).not.toBeInTheDocument();
    expect(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' })).toBeEnabled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('RETRY (IMPLEMENT) says what it does in the help\'s words and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { retry } = renderPanel();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' }));
    expect(within(failedRow()).getByText(/^Re-reads the task file and hands the run back to the worker\./)).toHaveTextContent(IMPLEMENT_WORDS);
    expect(within(failedRow()).queryByText(RESUME_WORDS, { exact: false })).not.toBeInTheDocument();
    expect(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY (IMPLEMENT)' })).toBeEnabled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('CANCEL puts the buttons back without calling anything', async () => {
    const user = userEvent.setup();
    const { retry } = renderPanel();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CANCEL' }));
    expect(within(failedRow()).getByRole('button', { name: 'RETRY' })).toBeInTheDocument();
    expect(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' })).toBeInTheDocument();
    expect(within(failedRow()).queryByRole('button', { name: /^CONFIRM RETRY/ })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it('CONFIRM RETRY sends the full run id once, without implement, and refreshes the panel', async () => {
    const user = userEvent.setup();
    const { retry, refresh } = renderPanel();
    refresh.mockClear(); // the monitor already refreshed once when the transport opened
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(FAILED_ID, false);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('CONFIRM RETRY (IMPLEMENT) sends the full run id once with implement', async () => {
    const user = userEvent.setup();
    const { retry, refresh } = renderPanel();
    refresh.mockClear();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY (IMPLEMENT)' }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(FAILED_ID, true);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('sends one retry only while it is in flight and holds the rest of the panel meanwhile', async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => undefined;
    const retry = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    renderPanel(() => undefined, {}, { retry });
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    expect(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeDisabled();
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => { finish({ worker_serves_project: true }); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'PAUSE' })).toBeEnabled());
  });

  it('says the worker resumes the run when one serves the project, and starts nothing', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(() => undefined, {}, {
      retry: vi.fn().mockResolvedValue({ retried: 'blocked: x', stage: 'verify', worker: 'running', worker_serves_project: true }),
    });
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    expect(await screen.findByText('run retried — the worker resumes it')).toHaveClass('text-ok');
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('says the running worker does not serve the project, without telling to start one', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(
      (status) => { status.worker = { state: 'running', projects: ['/home/example/projects/funkyoctopus'], exclude_projects: [] }; },
      {},
      { retry: vi.fn().mockResolvedValue({ retried: 'blocked: x', stage: 'verify', worker: 'running', worker_serves_project: false }) },
    );
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    // Nothing picks the run up yet: that needs the owner, so attention.
    expect(await screen.findByText('run retried — no worker serves its project')).toHaveClass('text-attention');
    expect(screen.queryByText(/start the worker/)).not.toBeInTheDocument();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('says to start the worker when none is running, next to START, and starts nothing', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(
      (status) => { status.worker = { state: 'stopped' }; },
      {},
      { retry: vi.fn().mockResolvedValue({ retried: 'blocked: x', stage: 'verify', worker: 'none', worker_serves_project: false }) },
    );
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    // Nothing picks the run up yet: that needs the owner, so attention.
    expect(await screen.findByText('run retried — start the worker to resume it')).toHaveClass('text-attention');
    expect(screen.getByRole('button', { name: 'START' })).toBeInTheDocument();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['stopped', (status: ReturnType<typeof makeHelmraiserStatus>) => { status.worker = { state: 'stopped' }; },
      'no worker serves this project — START the worker to resume it'],
    ['serving other projects only', (status: ReturnType<typeof makeHelmraiserStatus>) => { status.worker = { state: 'running', projects: ['/home/example/projects/funkyoctopus'], exclude_projects: [] }; },
      'no worker serves this project — the running worker is scoped to other projects'],
    ['excluding this project', (status: ReturnType<typeof makeHelmraiserStatus>) => { status.worker = { state: 'running', projects: null, exclude_projects: ['/home/example/projects/helmraiser'] }; },
      'no worker serves this project — the running worker is scoped to other projects'],
  ])('warns before confirming that no worker serves the project when the worker is %s', async (_name, mutate, hint) => {
    const user = userEvent.setup();
    renderPanel(mutate);
    expect(within(failedRow()).queryByText(/no worker serves this project/)).not.toBeInTheDocument();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' }));
    expect(within(failedRow()).getByText(hint)).toBeInTheDocument();
    expect(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY (IMPLEMENT)' })).toBeEnabled();
  });

  it('does not warn when a running worker serves the project', async () => {
    const user = userEvent.setup();
    renderPanel((status) => { status.worker = { state: 'running', projects: ['/home/example/projects/helmraiser'], exclude_projects: [] }; });
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    expect(within(failedRow()).queryByText(/no worker serves this project/)).not.toBeInTheDocument();
  });

  it('shows the CLI\'s refusal on that row only, and leaves the row retryable again', async () => {
    const user = userEvent.setup();
    const refusal = new WireCallError(
      `helmraiser retry failed: run ${FAILED_ID} failed with timeout: pi session exceeded its time limit; retry is only for a run that was blocked or failed verify`,
      'helmraiser_cli_error',
    );
    const { refresh } = renderPanel(
      (status) => { status.failed.push({ ...status.failed[0]!, run_id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Another failure' }); },
      {},
      { retry: vi.fn().mockRejectedValue(refusal) },
    );
    refresh.mockClear();
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY' }));
    expect(await within(failedRow()).findByRole('alert')).toHaveTextContent(
      `⚠ Not retried — run ${FAILED_ID} failed with timeout: pi session exceeded its time limit; retry is only for a run that was blocked or failed verify`,
    );
    expect(within(failedRow()).getByRole('button', { name: 'RETRY' })).toBeEnabled();
    expect(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' })).toBeEnabled();
    expect(within(rowOf('Another failure')).queryByRole('alert')).not.toBeInTheDocument();
    // The refusal belongs to the row, not the panel's shared error line, and nothing was refreshed.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
    // The next try starts clean.
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY' }));
    expect(within(failedRow()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an unreachable helmraiser on the row too, without the CLI prefix to strip', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, { retry: vi.fn().mockRejectedValue(new WireCallError('helmraiser retry exited 1: boom', 'helmraiser_cli_error')) });
    await user.click(within(failedRow()).getByRole('button', { name: 'RETRY (IMPLEMENT)' }));
    await user.click(within(failedRow()).getByRole('button', { name: 'CONFIRM RETRY (IMPLEMENT)' }));
    expect(await within(failedRow()).findByRole('alert')).toHaveTextContent('⚠ Not retried — helmraiser retry exited 1: boom');
  });
});

describe('JobsPanel reworking a run awaiting merge', () => {
  const MERGE_ID = '865c36b8-a39d-433a-bc6c-87b1715d14e2';
  const rowOf = (title: string) => screen.getByText(title).closest('.rounded') as HTMLElement;
  const mergeRow = () => rowOf('Count rejected runs separately');
  // The CLI help's own words: the command's description and the --note and --rebase options.
  const COMMAND_WORDS = 'Hands the run back for feedback, a rebase, or both.';
  const REBASE_WORDS = 'Also rebases the run branch onto its current base branch (the implementer resolves conflicts).';
  /** Adds a plan and a scope approval beside the merge one. */
  const withOtherApprovals = (status: ReturnType<typeof makeHelmraiserStatus>) => {
    const merge = status.awaiting[0]!;
    status.awaiting.push(
      { ...merge, run_id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Plan waiting', pending: 'plan' },
      { ...merge, run_id: 'aaaaaaaa-0000-4000-8000-000000000003', title: 'Scope waiting', pending: 'scope', scope_request: { paths: ['src/a.ts'], reason: 'needed' } },
    );
  };

  it('gives only the merge approval a REWORK button, beside APPROVE and REJECT', () => {
    const { rework } = renderPanel(withOtherApprovals);
    expect(screen.getAllByRole('button', { name: 'REWORK' })).toHaveLength(1);
    const buttons = within(mergeRow()).getAllByRole('button').map((button) => button.textContent);
    expect(buttons.slice(-3)).toEqual(['APPROVE', 'REJECT', 'REWORK']);
    expect(within(rowOf('Plan waiting')).queryByRole('button', { name: 'REWORK' })).not.toBeInTheDocument();
    expect(within(rowOf('Scope waiting')).queryByRole('button', { name: 'REWORK' })).not.toBeInTheDocument();
    expect(rework).not.toHaveBeenCalled();
  });

  it('REWORK asks first, in the help\'s words, and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { rework } = renderPanel();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    expect(within(mergeRow()).getByText(COMMAND_WORDS)).toBeInTheDocument();
    expect(within(mergeRow()).getByRole('textbox', { name: 'Rework note' })).toHaveValue('');
    expect(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' })).not.toBeChecked();
    // The rebase help is the checkbox label's hover, not another line of text.
    expect(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }).closest('label')).toHaveAttribute('title', REBASE_WORDS);
    expect(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' })).toBeInTheDocument();
    // Deciding differently is a different click: approving or rejecting is not offered meanwhile.
    expect(within(mergeRow()).queryByRole('button', { name: 'APPROVE' })).not.toBeInTheDocument();
    expect(within(mergeRow()).queryByRole('button', { name: 'REJECT' })).not.toBeInTheDocument();
    expect(rework).not.toHaveBeenCalled();
  });

  it('blocks the confirm until there is a note, or a rebase, and says so', async () => {
    const user = userEvent.setup();
    const { rework } = renderPanel();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    const confirm = () => within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' });
    expect(confirm()).toBeDisabled();
    expect(within(mergeRow()).getByText('Needs a note, or a rebase on its own — helmraiser takes either.')).toBeInTheDocument();
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), '  \n ');
    expect(confirm()).toBeDisabled();
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    expect(confirm()).toBeEnabled();
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    expect(confirm()).toBeDisabled();
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'clarify the widget');
    expect(confirm()).toBeEnabled();
    expect(rework).not.toHaveBeenCalled();
  });

  it('CANCEL puts APPROVE, REJECT and REWORK back, forgets the note, and calls nothing', async () => {
    const user = userEvent.setup();
    const { rework } = renderPanel();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'half a thought');
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    await user.click(within(mergeRow()).getByRole('button', { name: 'CANCEL' }));
    for (const name of ['APPROVE', 'REJECT', 'REWORK']) expect(within(mergeRow()).getByRole('button', { name })).toBeEnabled();
    expect(within(mergeRow()).queryByRole('textbox', { name: 'Rework note' })).not.toBeInTheDocument();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    expect(within(mergeRow()).getByRole('textbox', { name: 'Rework note' })).toHaveValue('');
    expect(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' })).not.toBeChecked();
    expect(rework).not.toHaveBeenCalled();
  });

  it('CONFIRM REWORK sends the full run id and the trimmed note once, then refreshes and closes the form', async () => {
    const user = userEvent.setup();
    const { rework, refresh } = renderPanel();
    refresh.mockClear(); // the monitor already refreshed once when the transport opened
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), '  clarify the widget\nand its tests ');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(rework).toHaveBeenCalledExactlyOnceWith(MERGE_ID, 'clarify the widget\nand its tests', false);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(mergeRow()).queryByRole('textbox', { name: 'Rework note' })).not.toBeInTheDocument());
    expect(within(mergeRow()).getByRole('button', { name: 'REWORK' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends the rebase flag with the note, and a rebase on its own without one', async () => {
    const user = userEvent.setup();
    const { rework } = renderPanel();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'keep the 30 s limit');
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    await waitFor(() => expect(rework).toHaveBeenLastCalledWith(MERGE_ID, 'keep the 30 s limit', true));
    await waitFor(() => expect(within(mergeRow()).queryByRole('textbox', { name: 'Rework note' })).not.toBeInTheDocument());
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    await waitFor(() => expect(rework).toHaveBeenLastCalledWith(MERGE_ID, '', true));
    expect(rework).toHaveBeenCalledTimes(2);
  });

  it('sends one rework only while it is in flight and holds the rest of the panel meanwhile', async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => undefined;
    const rework = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    renderPanel(() => undefined, {}, { rework });
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeDisabled();
    expect(rework).toHaveBeenCalledOnce();
    await act(async () => { finish({ worker: 'running', worker_serves_project: true }); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'PAUSE' })).toBeEnabled());
  });

  it('says the worker resumes the run when one serves the project, and starts nothing', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(() => undefined, {}, {
      rework: vi.fn().mockResolvedValue({ reworked: 'merge', stage: 'implement', worker: 'running', worker_serves_project: true }),
    });
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(await screen.findByText('run sent back for rework — the worker resumes it')).toHaveClass('text-ok');
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('says the running worker does not serve the project, without telling to start one', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(
      (status) => { status.worker = { state: 'running', projects: ['/home/example/projects/funkyoctopus'], exclude_projects: [] }; },
      {},
      { rework: vi.fn().mockResolvedValue({ reworked: 'merge', stage: 'implement', worker: 'running', worker_serves_project: false }) },
    );
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    // Nothing picks the run up yet: that needs the owner, so attention.
    expect(await screen.findByText('run sent back for rework — no worker serves its project')).toHaveClass('text-attention');
    expect(screen.queryByText(/start the worker/)).not.toBeInTheDocument();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('says to start the worker when none is running, next to START, and starts nothing', async () => {
    const user = userEvent.setup();
    const { startWorker } = renderPanel(
      (status) => { status.worker = { state: 'stopped' }; },
      {},
      { rework: vi.fn().mockResolvedValue({ reworked: 'merge', stage: 'implement', worker: 'none', worker_serves_project: false }) },
    );
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(await screen.findByText('run sent back for rework — start the worker to resume it')).toHaveClass('text-attention');
    expect(screen.getByRole('button', { name: 'START' })).toBeInTheDocument();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['stopped', (status: ReturnType<typeof makeHelmraiserStatus>) => { status.worker = { state: 'stopped' }; },
      'no worker serves this project — START the worker to resume it'],
    ['serving other projects only', (status: ReturnType<typeof makeHelmraiserStatus>) => { status.worker = { state: 'running', projects: ['/home/example/projects/funkyoctopus'], exclude_projects: [] }; },
      'no worker serves this project — the running worker is scoped to other projects'],
  ])('warns in the form that no worker serves the project when the worker is %s', async (_name, mutate, hint) => {
    const user = userEvent.setup();
    renderPanel(mutate);
    expect(within(mergeRow()).queryByText(/no worker serves this project/)).not.toBeInTheDocument();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    expect(within(mergeRow()).getByText(hint)).toBeInTheDocument();
  });

  it('does not warn when a running worker serves the project', async () => {
    const user = userEvent.setup();
    renderPanel((status) => { status.worker = { state: 'running', projects: ['/home/example/projects/helmraiser'], exclude_projects: [] }; });
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    expect(within(mergeRow()).queryByText(/no worker serves this project/)).not.toBeInTheDocument();
  });

  it('shows the CLI\'s refusal on that row only, keeps the form and the note, and sends nothing else', async () => {
    const user = userEvent.setup();
    const refusal = new WireCallError(
      `helmraiser rework failed: run ${MERGE_ID} already contains main; nothing to rebase`,
      'helmraiser_cli_error',
    );
    const { refresh } = renderPanel(
      (status) => { status.awaiting.push({ ...status.awaiting[0]!, run_id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Another merge' }); },
      {},
      { rework: vi.fn().mockRejectedValue(refusal) },
    );
    refresh.mockClear();
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'a long thought worth keeping');
    await user.click(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' }));
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(await within(mergeRow()).findByRole('alert')).toHaveTextContent(
      `⚠ Not reworked — run ${MERGE_ID} already contains main; nothing to rebase`,
    );
    // Still a form, still the owner's words: a refusal costs a click, not the note.
    expect(within(mergeRow()).getByRole('textbox', { name: 'Rework note' })).toHaveValue('a long thought worth keeping');
    expect(within(mergeRow()).getByRole('checkbox', { name: 'also rebase onto the base branch' })).toBeChecked();
    expect(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' })).toBeEnabled();
    expect(within(rowOf('Another merge')).queryByRole('alert')).not.toBeInTheDocument();
    // The refusal belongs to the row, not the panel's shared error line, and nothing was refreshed.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/run sent back for rework/)).not.toBeInTheDocument();
    // The next try starts clean.
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    await waitFor(() => expect(within(mergeRow()).getByRole('alert')).toBeInTheDocument());
  });

  it('shows an unreachable helmraiser on the row too, without the CLI prefix to strip', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, { rework: vi.fn().mockRejectedValue(new WireCallError('helmraiser rework exited 1: boom', 'helmraiser_cli_error')) });
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(await within(mergeRow()).findByRole('alert')).toHaveTextContent('⚠ Not reworked — helmraiser rework exited 1: boom');
  });

  it('clears the refusal when the form is cancelled and reopened', async () => {
    const user = userEvent.setup();
    renderPanel(() => undefined, {}, { rework: vi.fn().mockRejectedValue(new WireCallError('helmraiser rework failed: nope', 'helmraiser_cli_error')) });
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    await user.type(within(mergeRow()).getByRole('textbox', { name: 'Rework note' }), 'fix it');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CONFIRM REWORK' }));
    expect(await within(mergeRow()).findByRole('alert')).toHaveTextContent('Not reworked — nope');
    await user.click(within(mergeRow()).getByRole('button', { name: 'CANCEL' }));
    await user.click(within(mergeRow()).getByRole('button', { name: 'REWORK' }));
    expect(within(mergeRow()).queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('earlier rounds', () => {
    // The live `status.reworks[]` shape (helmraiser `build_status`; request payloads from `Ledger.hand_back`).
    const request = { approval_id: 3, findings: [], iteration_allowance: 2, extra_cost_usd: 1.3333, extra_minutes: 20, iterations_before: 1 };
    const history = (runId: string, status = 'awaiting_approval') => ({
      run_id: runId, task: '-home-example-projects-helmraiser:report-rejected-split', status, rework_rounds: 2,
      reworks: [
        { ...request, round: 1, note: 'Clarify the widget.\nThen cover the empty case.' },
        { ...request, approval_id: 5, round: 2, rebase: true as const, note: 'Rebase the run branch onto the current base branch.' },
      ],
    });
    const toggle = () => within(mergeRow()).getByRole('button', { name: 'REWORK HISTORY (2)' });

    it('shows the rounds behind a collapsed toggle that counts them', async () => {
      const user = userEvent.setup();
      renderPanel((status) => { status.reworks = [history(MERGE_ID)]; });
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(within(mergeRow()).queryByText(/Clarify the widget/)).not.toBeInTheDocument();
      await user.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      const list = within(mergeRow()).getByRole('list', { name: 'Earlier rework rounds' });
      const [first, second] = within(list).getAllByRole('listitem');
      expect(first).toHaveTextContent('Round 1');
      expect(first).not.toHaveTextContent('rebase');
      expect(first).toHaveTextContent('Clarify the widget. Then cover the empty case.');
      expect(second).toHaveTextContent('Round 2 · rebase');
      expect(second).toHaveTextContent('Rebase the run branch onto the current base branch.');
      await user.click(toggle());
      expect(within(mergeRow()).queryByRole('list', { name: 'Earlier rework rounds' })).not.toBeInTheDocument();
    });

    it('keeps a long note from walling the row: its own scroll area, line breaks kept', async () => {
      const user = userEvent.setup();
      renderPanel((status) => {
        const entry = history(MERGE_ID);
        entry.reworks[0]!.note = Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join('\n');
        status.reworks = [entry];
      });
      await user.click(toggle());
      const note = within(within(mergeRow()).getAllByRole('listitem')[0]!).getByText((_text, element) => element?.tagName === 'PRE');
      expect(note).toHaveClass('max-h-40', 'overflow-y-auto', 'whitespace-pre-wrap');
      expect(note.textContent?.startsWith('line 1\nline 2\n')).toBe(true);
      expect(note.textContent?.endsWith('line 60')).toBe(true);
    });

    it('offers no history on a row that was never reworked, or when another run was', () => {
      renderPanel((status) => {
        status.awaiting.push({ ...status.awaiting[0]!, run_id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Another merge' });
        status.reworks = [history('aaaaaaaa-0000-4000-8000-000000000001')];
      });
      expect(within(mergeRow()).queryByRole('button', { name: /^REWORK HISTORY/ })).not.toBeInTheDocument();
      expect(within(rowOf('Another merge')).getByRole('button', { name: 'REWORK HISTORY (2)' })).toBeInTheDocument();
    });

    it('is quiet on a status with no reworks at all', () => {
      renderPanel();
      expect(screen.queryByRole('button', { name: /^REWORK HISTORY/ })).not.toBeInTheDocument();
    });

    it('counts one round in the singular label', () => {
      renderPanel((status) => {
        const entry = history(MERGE_ID);
        entry.reworks = entry.reworks.slice(0, 1);
        entry.rework_rounds = 1;
        status.reworks = [entry];
      });
      expect(within(mergeRow()).getByRole('button', { name: 'REWORK HISTORY (1)' })).toBeInTheDocument();
    });
  });
});
