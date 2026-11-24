import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  ProjectOption,
  HelmraiserHold,
  HelmraiserProposalResult,
  HelmraiserStatusResuming,
  HelmraiserStatusRunning,
} from '@shared/transport/protocol.ts';
import { wireErrorCode } from '@shared/transport/errors.ts';
import { useService } from '@core/container/useService.ts';
import { CHAT_ORCHESTRATOR, type ChatOrchestrator, type ChatTurnOptions } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION, type ChatSession } from '@features/chat/chat-session.service.ts';
import { TAB_MODEL, type TabModel } from '@features/chat/tab-models.ts';
import { useTabFolder } from '@features/chat/useTabFolder.ts';
import type { Project } from '@features/settings/preferences.types.ts';
import { NotInstalled } from '@core/transport/NotInstalled.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { useJobs } from './useJobs.ts';
import { ActionButton } from './ActionButton.tsx';
import { AwaitingRow } from './AwaitingRow.tsx';
import { QueuedRow, type QueuedRowEntry } from './QueuedRow.tsx';
import { RetryControls } from './RetryControls.tsx';
import { RunLog } from './RunLog.tsx';
import { noWorkerHint, retriedNote } from './retry.ts';
import { reworkedNote } from './rework.ts';
import { ScoutedDrafts } from './ScoutedDrafts.tsx';
import { ScoutControls } from './ScoutControls.tsx';
import { HelmraiserDashboard } from './HelmraiserDashboard.tsx';
import { HeadlineStrip } from './HeadlineStrip.tsx';
import {
  MAX_HELMRAISER_TASK_BODY_CHARS,
  parseHelmraiserTaskBlock,
} from './helmraiser-task-block.ts';

export const CHAT_TO_HELMRAISER_INSTRUCTION =
  'Draft a Helmraiser task from this conversation. Reply with exactly one fenced block, `helmraiser-task`, whose first line is `title: …` and whose rest is Markdown with `## Goal` and `## Change`.';

/** Running/awaiting/failed title: newer builds carry a title, older ones an id. */
const titleOf = (row: { title?: string; id?: string; task?: string }): string => row.title ?? row.id ?? row.task ?? '';
/** Helmraiser marks actionable notes in prose; neutral intake commentary stays secondary. */
const intakeNoteNeedsAttention = (note: string): boolean =>
  /\b(?:attention|warning|warns?|inspect(?:s|ing)? source structure)\b/i.test(note);
/** Final segment of a project path, e.g. `/home/me/helmraiser` → `helmraiser`. */
const segmentOf = (project: string): string => project.split('/').filter(Boolean).at(-1) ?? project;
/** Local two-digit `HH:MM` for timestamps and epoch seconds alike. */
/** Failed rows shown before the rest collapse into a count. */
const FAILED_SHOWN = 5;
const hhmm = (date: Date): string =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** Raw message plus typed wire code, ready to render inline in the form. */
const intakeError = (error: unknown): { message: string; code?: string } => {
  const message = error instanceof Error ? error.message : String(error);
  const code = wireErrorCode(error);
  return code === undefined ? { message } : { message, code };
};

/** The chat folder when known, then today's preference fallback, then the first project. */
const defaultProject = (
  known: ProjectOption[],
  chatFolder: string | undefined,
  activeProject: { path: string } | null,
): string =>
  known.find((p) => p.path === chatFolder)?.path ??
  known.find((p) => p.path === activeProject?.path)?.path ??
  known[0]?.path ?? '';

/** One inline New-task flow: describe → propose → review → queue. */
type IntakeFlow = {
  open: boolean;
  project: string;
  title: string;
  goal: string;
  /** The drafted file once `draft` succeeded, so RETRY PROPOSE can reuse it. */
  draftPath: string | null;
  preview: HelmraiserProposalResult | null;
  error: { message: string; code?: string } | null;
  /** 'propose' covers the whole draft→propose sequence until the preview. */
  pending: 'chat' | 'propose' | 'queue' | null;
};

const emptyFlow = (project: string): IntakeFlow => ({
  open: true,
  project,
  title: '',
  goal: '',
  draftPath: null,
  preview: null,
  error: null,
  pending: null,
});

/** A chat tab's services, as a NEW TASK flow uses them. */
interface ChatSource {
  session: ChatSession;
  orchestrator: ChatOrchestrator;
  tabModel: TabModel;
  folder: Project | null;
}

/** What the tab shows under its header: the queue, or the dashboard of how runs went. */
const VIEWS = ['queue', 'dashboard'] as const;
type View = (typeof VIEWS)[number];

export function JobsPanel() {
  const jobs = useJobs();
  const [view, setView] = useState<View>('queue');
  const workflow = useService(WORKFLOW);
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const shown: ChatSource = {
    session: useService(CHAT_SESSION),
    orchestrator,
    tabModel: useService(TAB_MODEL),
    folder: useTabFolder().folder,
  };
  // A NEW TASK flow belongs to the chat tab shown when it opened: FROM CHAT
  // reads that tab and the queued task records it, even if another is shown since.
  const [pinned, setPinned] = useState<ChatSource | null>(null);
  const status = jobs.status;
  const running = status?.running ?? [];
  const resuming = status?.resuming ?? [];
  const awaiting = status?.awaiting ?? [];
  const queueNext = status?.queue_next ?? [];
  const held = status?.held ?? [];
  // A task that can never start is the owner's to fix, so it shows even when it
  // is not among the first five queued.
  const neverStartable = status?.never_startable ?? [];
  const queueRows: Array<{ entry: QueuedRowEntry; heldBy: HelmraiserHold | null }> = [
    ...queueNext.map((entry) => ({ entry, heldBy: entry.held_by ?? null })),
    ...neverStartable
      .filter((row) => !queueNext.some((entry) => entry.task_id === row.task_id))
      .map((entry) => ({ entry, heldBy: null })),
  ];
  const failed = status?.failed ?? [];
  // Authoritative totals from the ledger, not the displayed row lists: the
  // arrays are what renders, the counters are what the queue actually holds.
  const queued = status?.queued_count ?? 0;
  const awaitingTotal = status?.awaiting_count ?? 0;
  const failedTotal = status?.failed_24h_count ?? 0;
  const emptyQueue = Boolean(status) && running.length === 0 && resuming.length === 0 && awaitingTotal === 0 && queued === 0 && failedTotal === 0;

  // Known projects for the New-task select; an empty list only disables the flow.
  const [known, setKnown] = useState<ProjectOption[]>([]);
  useEffect(() => {
    let live = true;
    void orchestrator
      .discoverProjects()
      .then((catalog) => {
        if (live) setKnown(catalog.known);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [orchestrator]);

  const [flow, setFlow] = useState<IntakeFlow | null>(null);
  const source = flow && pinned ? pinned : shown;
  const chat = useSyncExternalStore(source.session.subscribe, source.session.getSnapshot);
  const activeProject = source.folder;
  /**
   * Brief result of a plan approval or a retry, under the header. `attention`
   * when nothing will pick the run up yet: attention, not ok.
   */
  const [resumeNote, setResumeNote] = useState<{ text: string; attention: boolean } | null>(null);
  useEffect(() => {
    if (resumeNote === null) return;
    const timer = window.setTimeout(() => setResumeNote(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [resumeNote]);
  /** Shown once, after DISCARD: the draft file was kept, not deleted. */
  const [keptDraft, setKeptDraft] = useState<string | null>(null);
  // One operation at a time across the whole panel.
  const busy = jobs.pending !== null || (flow !== null && flow.pending !== null);

  const openFlow = () => {
    setKeptDraft(null);
    setPinned(shown);
    setFlow(emptyFlow(defaultProject(known, shown.session.getSnapshot().activeSession?.cwd, shown.folder)));
  };

  // Discovery may finish after NEW TASK is opened; fill the default project in
  // then, so the form opened early is not stuck with an empty select.
  useEffect(() => {
    if (known.length === 0) return;
    setFlow((f) => (f && f.project === ''
      ? { ...f, project: defaultProject(known, chat.activeSession?.cwd, activeProject) }
      : f));
  }, [known, chat.activeSession?.cwd, activeProject]);

  const draftFromChat = async () => {
    if (!flow || flow.draftPath !== null || chat.busy || flow.pending !== null) return;
    if (source.session.closed) {
      setFlow({
        ...flow,
        error: { message: 'the chat this task reads from was closed — close NEW TASK and open it again from an open chat' },
      });
      return;
    }
    setFlow({ ...flow, error: null, pending: 'chat' });
    const opts: ChatTurnOptions = {};
    // The flow's tab's model: the turn runs in that tab's chat.
    const { model } = source.tabModel.get();
    if (model) {
      opts.provider = model.provider;
      opts.model = model.id;
    }
    // No effort: the saved effort may not be on this model's ladder (the
    // composer checks it against the models list), so the model's default applies.
    try {
      const reply = await source.session.sendAndWait(CHAT_TO_HELMRAISER_INSTRUCTION, opts);
      // Only the final assistant reply is authoritative. Narration emitted
      // before a tool call may look like a task, but is not the turn's answer.
      const finalStep = reply.steps.at(-1);
      const parsed = parseHelmraiserTaskBlock(finalStep?.kind === 'text' ? finalStep.text : '');
      setFlow((current) => {
        if (!current) return current;
        if (!parsed.ok) {
          return {
            ...current,
            pending: null,
            error: { message: 'the agent did not return a task block' },
          };
        }
        return {
          ...current,
          title: parsed.title,
          goal: parsed.body,
          pending: null,
          error: null,
        };
      });
    } catch {
      setFlow((current) => (current ? {
        ...current,
        pending: null,
        error: { message: 'the agent did not return a task block' },
      } : current));
    }
  };

  const propose = async () => {
    if (!flow) return;
    setFlow({ ...flow, error: null, pending: 'propose' });
    try {
      const draft = await workflow.draft(flow.project, flow.title, flow.goal);
      setFlow((f) => (f ? { ...f, draftPath: draft.path } : f));
      const proposal = await workflow.propose(draft.path);
      setFlow((f) => (f ? { ...f, preview: proposal, pending: null } : f));
    } catch (error) {
      setFlow((f) => (f ? {
        ...f,
        pending: null,
        error: intakeError(error),
      } : f));
    }
  };

  const retryPropose = async () => {
    if (!flow?.draftPath) return;
    setFlow({ ...flow, error: null, pending: 'propose' });
    try {
      const proposal = await workflow.propose(flow.draftPath);
      setFlow((f) => (f ? { ...f, preview: proposal, pending: null } : f));
    } catch (error) {
      setFlow((f) => (f ? {
        ...f,
        pending: null,
        error: intakeError(error),
      } : f));
    }
  };

  const queueDraft = async () => {
    if (!flow?.preview) return;
    setFlow((f) => (f ? { ...f, error: null, pending: 'queue' } : f));
    try {
      const current = await source.orchestrator.currentChat();
      await workflow.queue(flow.preview.path, current ? `fo:${current.path}` : undefined);
      await jobs.refresh();
      setFlow(null);
    } catch (error) {
      setFlow((f) => (f ? {
        ...f,
        pending: null,
        error: intakeError(error),
      } : f));
    }
  };

  /** DISCARD makes no call: the draft file stays on disk as a draft. */
  const discard = () => {
    if (flow?.draftPath) setKeptDraft(flow.draftPath);
    setFlow(null);
  };

  // Helmraiser is optional. Without its CLI there is no queue, report or scout to
  // show, so the view is this one line (and polling the monitor notices an install).
  if (jobs.notInstalled) {
    return (
      <section className="flex h-full flex-col gap-4 overflow-hidden rounded-lg border border-border bg-surface/40 p-5">
        <h2 className="font-mono text-sm tracking-widest text-accent">HELMRAISER</h2>
        <NotInstalled tool="helmraiser" />
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col gap-4 overflow-hidden rounded-lg border border-border bg-surface/40 p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-sm tracking-widest text-accent">HELMRAISER</h2>
          <nav aria-label="Helmraiser views" className="flex overflow-hidden rounded border border-border font-mono text-xs">
            {VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={`px-2 py-1 ${view === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'}`}
              >
                {option}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
          <ActionButton name="NEW TASK" color="muted" disabled={busy || flow !== null} onClick={openFlow} />
          {status && (
            <>
              <span className={`rounded border px-2 py-1 font-mono text-xs ${status.worker.state === 'running' ? 'border-ok text-ok' : 'border-border text-muted'}`}>
                {status.worker.state === 'running' ? 'WORKER RUNNING' : 'WORKER STOPPED'}
              </span>
              <ActionButton
                name={status.worker.state === 'running' ? 'STOP' : 'START'}
                color="muted"
                disabled={busy}
                onClick={() => void (status.worker.state === 'running' ? jobs.stopWorker() : jobs.startWorker())}
              />
              <ActionButton
                name={status.paused ? 'RESUME' : 'PAUSE'}
                color="muted"
                disabled={busy}
                onClick={() => void (status.paused ? jobs.resume() : jobs.pause())}
              />
            </>
          )}
        </div>
      </header>
      {/* Its own line, so the worker controls above stay together. */}
      {resumeNote !== null && (
        <p role="status" className={`-mt-2 font-mono text-xs ${resumeNote.attention ? 'text-attention' : 'text-ok'}`}>
          {resumeNote.text}
        </p>
      )}

      {status?.paused && <p className="font-mono text-xs text-attention">paused: {status.paused.reason}</p>}

      {keptDraft && !flow && (
        <p role="status" className="font-mono text-xs text-muted">draft kept at {keptDraft}</p>
      )}
      {flow && (
        <IntakeForm flow={flow} known={known} busy={busy} chatBusy={chat.busy}
          chatTitle={chat.activeSession?.title ?? 'untitled chat'}
          onPatch={(patch) => setFlow((f) => (f ? { ...f, ...patch } : f))}
          onFromChat={() => void draftFromChat()}
          onClose={() => setFlow(null)}
          onPropose={() => void propose()}
          onRetry={() => void retryPropose()}
          onQueue={() => void queueDraft()}
          onDiscard={discard}
        />
      )}
      {status && Object.entries(status.held_providers).map(([provider, hold]) => (
        <p key={provider} className="font-mono text-xs text-attention">{provider} held until {hhmm(new Date(hold.until * 1000))} — {hold.detail}</p>
      ))}

      {jobs.error && (jobs.unavailable
        // Not running is something waiting on you (install/start it), not a fault.
        ? <p role="status" className="font-mono text-sm text-attention">{jobs.error}</p>
        : <p role="alert" className="font-mono text-sm text-danger">⚠ {jobs.error}</p>)}

      {view === 'dashboard' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HelmraiserDashboard status={status} />
        </div>
      )}
      {/* Hidden, not unmounted: a review in flight, scout edits and the strip's
          slow report survive a look at the dashboard. */}
      <div hidden={view !== 'queue'} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          <HeadlineStrip status={status} onOpenDashboard={() => setView('dashboard')} />
          <ScoutControls status={status} onRefresh={jobs.refresh} disabled={busy} />
          <ScoutedDrafts refreshToken={status} onQueueSuccess={jobs.refresh} />
          <ScoutedDrafts mode="unqueued" refreshToken={status} onQueueSuccess={jobs.refresh} />
          {running.length > 0 && (
            <>
              <h3 className="font-mono text-xs text-muted">RUNNING ({running.length})</h3>
              {running.map((run) => <RunningRow key={run.run_id} run={run} disabled={busy} onAbort={(project) => void jobs.abort(project, run.run_id)} />)}
            </>
          )}
          {resuming.length > 0 && (
            <>
              <h3 className="font-mono text-xs text-muted">RESUMING ({resuming.length})</h3>
              {resuming.map((run) => <ResumingRow key={run.run_id} run={run} />)}
            </>
          )}
          {awaiting.length > 0 && (
            <>
              {/* Attention here means "waiting on you", not a fault — same rule as the chips. */}
              <h3 className="font-mono text-xs text-attention">AWAITING YOUR APPROVAL ({awaitingTotal})</h3>
              {awaiting.map((row) => (
                <AwaitingRow
                  key={row.run_id}
                  row={row}
                  jobs={jobs}
                  busy={busy}
                  onPlanApproved={(serves) => setResumeNote(serves
                    ? { text: 'plan approved — the worker resumes it', attention: false }
                    : { text: 'plan approved — start the worker to resume it', attention: true })}
                  onReworked={(result) => setResumeNote({ text: reworkedNote(result), attention: !result.worker_serves_project })}
                />
              ))}
            </>
          )}
          {queueRows.length > 0 && (
            <>
              <h3 className="font-mono text-xs text-muted">QUEUED NEXT ({queued})</h3>
              {queueRows.map(({ entry, heldBy }) => (
                <QueuedRow
                  key={entry.task_id}
                  entry={entry}
                  hold={heldBy ?? held.find((row) => row.task_id === entry.task_id) ?? null}
                  neverStartable={neverStartable.find((row) => row.task_id === entry.task_id) ?? null}
                  disabled={busy}
                  onRemove={jobs.queueRemove}
                />
              ))}
            </>
          )}
          {failed.length > 0 && (
            <>
              <h3 className="font-mono text-xs text-muted">FAILED · 24H ({failedTotal})</h3>
              {failed.slice(0, FAILED_SHOWN).map((row) => (
                <div key={row.run_id} className="rounded border border-border p-3 font-mono text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-text">{titleOf(row)}</strong>
                    {row.project && <span className="text-muted">{segmentOf(row.project)}</span>}
                    <span className="text-muted">{hhmm(new Date(row.ended_at))}</span>
                  </div>
                  {/* A rejection is the owner's decision, not a fault: dim, not danger. */}
                  <p className={`mt-1 text-xs ${row.reason === 'rejected' ? 'text-muted' : 'text-danger'}`}>{row.reason}</p>
                  <RunLog
                    runId={row.run_id}
                    follow={false}
                    // The owner rejected it: retrying would undo that decision, and helmraiser refuses it anyway.
                    actions={row.reason !== 'rejected' && (
                      <RetryControls
                        noWorker={status ? noWorkerHint(status.worker, row.project) : null}
                        disabled={busy}
                        onRetry={async (implement) => {
                          const result = await jobs.retry(row.run_id, implement);
                          setResumeNote({ text: retriedNote(result), attention: !result.worker_serves_project });
                        }}
                      />
                    )}
                  />
                </div>
              ))}
              {failed.length > FAILED_SHOWN && <p className="font-mono text-xs text-muted">+{failed.length - FAILED_SHOWN} more</p>}
            </>
          )}
          {emptyQueue && <p className="font-mono text-sm text-muted">queue empty</p>}
      </div>
    </section>
  );
}

/** Read-only review of what intake proposed, before the only QUEUE click. */
function IntakeForm({ flow, known, busy, chatBusy, chatTitle, onPatch, onFromChat, onClose, onPropose, onRetry, onQueue, onDiscard }: {
  flow: IntakeFlow;
  known: ProjectOption[];
  busy: boolean;
  chatBusy: boolean;
  /** The chat FROM CHAT reads: the tab shown when the flow opened. */
  chatTitle: string;
  onPatch: (patch: Partial<IntakeFlow>) => void;
  onFromChat: () => void;
  onClose: () => void;
  onPropose: () => void;
  onRetry: () => void;
  onQueue: () => void;
  onDiscard: () => void;
}) {
  const pending = flow.pending !== null;
  const canPropose = !busy && flow.project !== '' && flow.title.trim() !== '' && flow.goal.trim() !== '';
  const draftAlreadyExists = flow.error?.message.includes('task file already exists') ?? false;
  // After a successful draft anything failing is propose-side: the owner can fix
  // the file and retry intake on the same path, without drafting again.
  const showRetry = flow.draftPath !== null && !flow.preview && !pending;

  const errorLine = flow.error && (
    <p role="alert" className="font-mono text-xs text-danger">
      ⚠ {flow.error.message}{flow.error.code ? ` (${flow.error.code})` : ''}
    </p>
  );

  return (
    <section className="rounded-lg border border-border bg-surface/60 p-4 font-mono text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs tracking-widest text-accent">NEW TASK</h3>
        {/* The preview has its own QUEUE/DISCARD choice; CANCEL would close it
            without the kept-draft notice DISCARD gives, so it is hidden there. */}
        {!flow.preview && <ActionButton name="CANCEL" color="muted" disabled={busy} onClick={onClose} />}
      </div>

      {flow.preview ? (
        <>
          <p className="mt-2 text-xs text-muted">{flow.preview.path}</p>
          {flow.preview.notes.map((note) => (
            <p
              key={note}
              className={`mt-2 text-xs ${intakeNoteNeedsAttention(note) ? 'text-attention' : 'text-muted'}`}
            >
              {note}
            </p>
          ))}
          <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-bg p-3 text-xs text-text select-text">
            {flow.preview.task}
          </pre>
          {errorLine}
          <div className="mt-3 flex items-center gap-2">
            <ActionButton name="QUEUE" color="accent" disabled={busy} onClick={onQueue} />
            <ActionButton name="DISCARD" color="muted" disabled={busy} onClick={onDiscard} />
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              Project
              <select
                value={flow.project}
                disabled={pending}
                onChange={(event) => onPatch({ project: event.target.value })}
                className="rounded border border-border bg-bg px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
              >
                {known.length === 0 && <option value="">no known projects</option>}
                {known.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex min-w-64 flex-1 items-center gap-2 text-xs text-muted">
              Title
              <input
                value={flow.title}
                disabled={pending}
                maxLength={120}
                onChange={(event) => onPatch({ title: event.target.value })}
                className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          <label className="mt-3 block text-xs text-muted">
            Goal
            <textarea
              value={flow.goal}
              disabled={pending}
              rows={8}
              maxLength={MAX_HELMRAISER_TASK_BODY_CHARS}
              onChange={(event) => onPatch({ goal: event.target.value })}
              className="mt-1 w-full rounded border border-border bg-bg p-2 font-mono text-xs text-text focus:border-accent focus:outline-none"
            />
          </label>
          {flow.pending === 'propose' && (
            <p role="status" className="mt-2 font-mono text-xs text-attention">intake is proposing… (up to a couple of minutes)</p>
          )}
          {errorLine}
          {draftAlreadyExists && (
            <p className="mt-1 font-mono text-xs text-muted">a draft with this title already exists — choose a different title</p>
          )}
          {showRetry && (
            <p className="mt-1 font-mono text-xs text-muted">draft kept at {flow.draftPath}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {flow.draftPath === null && (
              <ActionButton
                name={flow.pending === 'chat' ? 'DRAFTING…' : 'FROM CHAT'}
                color="muted"
                disabled={busy || chatBusy}
                onClick={onFromChat}
              />
            )}
            {flow.draftPath === null && chatBusy && flow.pending !== 'chat' && (
              <span className="text-xs text-muted">chat turn in progress</span>
            )}
            {flow.draftPath === null && !chatBusy && (
              <span className="max-w-[32ch] truncate text-xs text-muted" title={chatTitle}>
                reads “{chatTitle}”
              </span>
            )}
            {showRetry
              ? <ActionButton name="RETRY PROPOSE" color="muted" disabled={busy} onClick={onRetry} />
              : <ActionButton name="PROPOSE" color="accent" disabled={!canPropose} onClick={onPropose} />}
          </div>
        </>
      )}
      {/* Kept for the refresh contract only; never called from the form itself. */}
    </section>
  );
}

function RunningRow({ run, disabled, onAbort }: { run: HelmraiserStatusRunning; disabled: boolean; onAbort: (project: string) => void }) {
  const project = run.project;
  return (
    <div className="rounded border border-border p-3 font-mono text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-text">{titleOf(run)}</strong>
        {project && <span className="text-muted">{segmentOf(project)}</span>}
        <span className="text-info">{run.stage}</span>
        <span className="text-muted">iteration {run.iteration}</span>
        <span className="text-muted">{run.minutes} min</span>
        <span className="text-muted">${run.cost_usd.toFixed(2)}</span>
        {project && <ActionButton name="ABORT" color="danger" disabled={disabled} onClick={() => onAbort(project)} />}
      </div>
      <RunLog runId={run.run_id} follow />
    </div>
  );
}

function ResumingRow({ run }: { run: HelmraiserStatusResuming }) {
  return (
    <div className="rounded border border-border p-3 font-mono text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-text">{titleOf(run)}</strong>
        <span className="text-muted">{segmentOf(run.project)}</span>
        <span className="text-info">resuming at {run.stage}</span>
      </div>
    </div>
  );
}
