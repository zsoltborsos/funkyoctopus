import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sessionRefOf, type HelmraiserReworkResult, type HelmraiserRunReview, type HelmraiserStatusAwaiting } from '@shared/transport/protocol.ts';
import { useService } from '@core/container/useService.ts';
import { useShell } from '@core/shell/useShell.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDERS, folderProject } from '@features/chat/tab-folders.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { WORKFLOW } from './workflow.client.ts';
import type { JobsApi } from './useJobs.ts';
import { ActionButton } from './ActionButton.tsx';
import { ReworkForm } from './ReworkForm.tsx';
import { ReworkRounds } from './ReworkRounds.tsx';
import { noWorkerHint } from './retry.ts';

const titleOf = (row: { title?: string; id?: string; task?: string }): string => row.title ?? row.id ?? row.task ?? '';
const segmentOf = (project: string): string => project.split('/').filter(Boolean).at(-1) ?? project;

function reviewPrompt(row: HelmraiserStatusAwaiting, taskPath: string, planPath?: string): string {
  if (row.pending === 'plan') {
    if (!planPath) throw new Error('plan path unavailable');
    return `Review this Helmraiser run's plan before the owner approves it: run ${row.run_id}, plan at ${planPath}, task at ${taskPath}. Check the plan against the task and recommend approve or changes.`;
  }
  return `Review this Helmraiser run's diff against its task: run ${row.run_id}, branch ${row.branch ?? 'unknown'}, base ${row.base_commit ?? 'unknown'}. The task is in ${taskPath}.`;
}

/** Use summary.md's Review section when Helmraiser did not write review.md. */
const reviewSection = (summary: string | null): string | null => {
  if (!summary) return null;
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s+Review\b/i.test(line));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start]!)?.[0].length ?? 6;
  const endOffset = lines.slice(start + 1).findIndex((line) => {
    const heading = /^(#+)\s+/.exec(line);
    return heading !== null && heading[1]!.length <= level;
  });
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join('\n').trim();
};

function parseScopeRequest(value: unknown): { paths: string[]; reason: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('paths' in value) || !Array.isArray(value.paths)) return null;
  const paths = value.paths.filter((path: unknown): path is string => typeof path === 'string');
  if (paths.length === 0) return null;
  return { paths, reason: 'reason' in value && typeof value.reason === 'string' ? value.reason : null };
}

/** One awaiting-approval row: merge, plan and scope decisions share panel busy state. */
export function AwaitingRow({ row, jobs, busy, onPlanApproved, onReworked }: {
  row: HelmraiserStatusAwaiting;
  jobs: JobsApi;
  busy: boolean;
  onPlanApproved: (workerServesProject: boolean) => void;
  /** A merge approval was handed back for rework. */
  onReworked: (result: HelmraiserReworkResult) => void;
}) {
  const chatTabs = useService(CHAT_SESSIONS);
  const folders = useService(TAB_FOLDERS);
  // One Helmraiser chat navigation at a time, window-wide, whichever tab is shown.
  const navigation = chatTabs.reviewNavigation;
  const reviewNavigationPending = useSyncExternalStore(navigation.subscribe, navigation.isPending);
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const workflow = useService(WORKFLOW);
  const { composeInChat } = useShell();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [confirmingRework, setConfirmingRework] = useState(false);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [note, setNote] = useState('');
  const [approvalNote, setApprovalNote] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planText, setPlanText] = useState<string | null>(null);
  const [planFailed, setPlanFailed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [runReview, setRunReview] = useState<HelmraiserRunReview | null>(null);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [openingChat, setOpeningChat] = useState<'origin' | 'fresh' | null>(null);
  const generation = useRef(0);
  const [chatError, setChatError] = useState<string | null>(null);
  const kind = row.origin?.kind;
  const originSession = row.origin?.session;
  const identity = JSON.stringify([row.run_id, row.pending, kind, originSession]);
  const [availableOrigin, setAvailableOrigin] = useState<string | null>(null);
  const originAvailable = availableOrigin === identity;
  // Another run, or the same run at another stage: an earlier chat error and
  // origin check no longer apply.
  const [shownIdentity, setShownIdentity] = useState(identity);
  if (shownIdentity !== identity) {
    setShownIdentity(identity);
    setAvailableOrigin(null);
    setChatError(null);
  }
  useEffect(() => {
    let live = true;
    if (kind === 'fo' && originSession) {
      void orchestrator.chatExists(originSession).then(({ exists }) => {
        if (live && exists) setAvailableOrigin(identity);
      }).catch(() => undefined);
    }
    return () => { live = false; };
  }, [orchestrator, identity, kind, originSession]);
  // A review in flight belongs to this run and stage. Showing another tab
  // swaps the orchestrator, which must not cancel the review that showed it.
  useEffect(() => () => { generation.current += 1; }, [identity]);

  const getReviewTaskPath = async (): Promise<string> => {
    if (runReview) return runReview.taskPath;
    const loaded = await workflow.runReview(row.run_id);
    setRunReview(loaded);
    return loaded.taskPath;
  };
  const getPrompt = async (): Promise<string> => {
    const taskPath = await getReviewTaskPath();
    const plan = row.pending === 'plan' ? await workflow.plan(row.run_id) : null;
    return reviewPrompt(row, taskPath, plan?.path);
  };
  const reviewInOriginChat = async () => {
    if (busy || !originAvailable || kind !== 'fo' || !originSession) return;
    const release = navigation.tryAcquire();
    if (!release) return;
    setOpeningChat('origin');
    setChatError(null);
    const ticket = generation.current;
    try {
      const { exists } = await orchestrator.chatExists(originSession).catch((error: unknown) => {
        if (ticket === generation.current) setAvailableOrigin(null);
        throw error;
      });
      if (ticket !== generation.current) return;
      if (!exists) { setAvailableOrigin(null); return; }
      const prompt = await getPrompt();
      if (ticket !== generation.current) return;
      // The tab holding the conversation is shown, or a new tab of its engine
      // opens it; opening adopts its effective cwd, not the worktree.
      const shown = await chatTabs.reviewInOrigin(originSession);
      if (ticket === generation.current) composeInChat(prompt, shown);
    } catch (error) {
      if (ticket === generation.current) setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningChat(null);
      release();
    }
  };
  const openRunInChat = async () => {
    if (busy || !row.worktree) return;
    const release = navigation.tryAcquire();
    if (!release) return;
    setOpeningChat('fresh');
    setChatError(null);
    try {
      const prompt = await getPrompt();
      // A new tab in the worktree, so no tab's conversation is replaced: on the
      // engine of the chat the run came from, pi otherwise.
      const engine = (kind === 'fo' && originSession && sessionRefOf(originSession)?.engine) || 'pi';
      const worktree = row.worktree;
      const opened = await chatTabs.create(engine, worktree, (chatId) =>
        folders.forTab(chatId).set(folderProject(worktree)),
      );
      composeInChat(prompt, opened);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningChat(null);
      release();
    }
  };
  const disabled = busy || reviewNavigationPending || openingChat !== null;
  const originAction = originAvailable && (
    <ActionButton name={openingChat === 'origin' ? 'OPENING ORIGIN…' : 'REVIEW IN ITS CHAT'} color="accent" disabled={disabled} onClick={() => void reviewInOriginChat()} />
  );
  const freshAction = (
    <ActionButton name={openingChat === 'fresh' ? 'OPENING…' : 'OPEN IN CHAT'} color={originAvailable ? 'muted' : 'accent'} disabled={disabled} onClick={() => void openRunInChat()} />
  );
  const errorLine = chatError && <p role="alert" className="mt-2 text-xs text-danger">⚠ {chatError}</p>;
  const facts = (
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-text">{titleOf(row)}</strong>
      {row.project && <span className="text-muted">{segmentOf(row.project)}</span>}
      <span className="text-muted">{row.pending}</span>
      {kind === 'claude-code' && <span className="text-xs text-muted">queued from Claude Code</span>}
      <span className="text-muted">{row.verdict}</span>
      <span className="text-muted">${row.cost_usd.toFixed(2)}</span>
    </div>
  );

  if (row.pending === 'merge') {
    const toggleReview = async () => {
      const opening = !reviewOpen;
      setReviewOpen(opening);
      if (opening && runReview === null) {
        setReviewFailed(false);
        const loaded = await jobs.runReview(row.run_id);
        if (loaded !== undefined) setRunReview(loaded);
        else setReviewFailed(true);
      }
    };
    // Helmraiser's status lists a reworked run's earlier rounds (`reworks[]`), oldest first.
    const rounds = jobs.status?.reworks?.find((entry) => entry.run_id === row.run_id)?.reworks ?? [];
    return (
      <div className="rounded border border-border p-3 font-mono text-sm">
        {facts}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ActionButton name="REVIEW" color="muted" disabled={disabled} onClick={() => void toggleReview()} />
          {rounds.length > 0 && (
            <ActionButton name={`REWORK HISTORY (${rounds.length})`} color="muted" expanded={roundsOpen} disabled={disabled} onClick={() => setRoundsOpen(!roundsOpen)} />
          )}
          {originAction}
        </div>
        {roundsOpen && rounds.length > 0 && <ReworkRounds rounds={rounds} />}
        {errorLine}
        {reviewOpen && (
          <div className="mt-2 rounded border border-border bg-bg p-3 text-xs text-text">
            {runReview ? (
              <>
                <div className="grid gap-3 lg:grid-cols-2">
                  <section>
                    <h4 className="mb-1 tracking-widest text-accent">SUMMARY · VERIFY · EVIDENCE</h4>
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap select-text">{runReview.summary ?? 'No summary.md was written.'}</pre>
                  </section>
                  <section>
                    <h4 className="mb-1 tracking-widest text-accent">REVIEW · VERDICT · FINDINGS</h4>
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap select-text">{runReview.review ?? reviewSection(runReview.summary) ?? 'No review was written.'}</pre>
                  </section>
                </div>
                <section className="mt-3">
                  <h4 className="mb-1 tracking-widest text-accent">DIFF STAT</h4>
                  <table className="w-full table-fixed text-left">
                    <thead className="text-muted"><tr><th>file</th><th className="w-16 text-right">+</th><th className="w-16 text-right">−</th></tr></thead>
                    <tbody>
                      {runReview.diffStat.files.map((file) => (
                        <tr key={file.path} className="border-t border-border/60">
                          <td className="truncate py-1 pr-2" title={file.path}>{file.path}{file.binary ? ' (binary)' : ''}</td>
                          <td className="text-right text-ok">{file.additions}</td>
                          <td className="text-right text-danger">{file.deletions}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-border text-text"><tr><th>{runReview.diffStat.filesChanged} files</th><th className="text-right">+{runReview.diffStat.additions}</th><th className="text-right">−{runReview.diffStat.deletions}</th></tr></tfoot>
                  </table>
                  {runReview.diffTruncated && <p className="mt-1 text-attention">diff stat list truncated</p>}
                </section>
                {row.worktree && (
                  <div className="mt-3">
                    {freshAction}
                  </div>
                )}
              </>
            ) : (
              <p>{reviewFailed ? 'review could not be loaded — reopen REVIEW to retry' : 'loading review…'}</p>
            )}
          </div>
        )}
        {confirmingReject ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              Reject note
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="why (optional)"
                className="w-56 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
            <ActionButton name="CONFIRM REJECT" color="danger-solid" disabled={disabled} onClick={() => void jobs.reject(row.run_id, note)} />
            <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={() => { setConfirmingReject(false); setNote(''); }} />
          </div>
        ) : confirmingRework ? (
          <ReworkForm
            noWorker={jobs.status ? noWorkerHint(jobs.status.worker, row.project) : null}
            disabled={disabled}
            onRework={async (reworkNote, rebase) => {
              onReworked(await jobs.rework(row.run_id, reworkNote, rebase));
              setConfirmingRework(false);
            }}
            onCancel={() => setConfirmingRework(false)}
          />
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <ActionButton name="APPROVE" color="accent" disabled={disabled} onClick={() => void jobs.approve(row.run_id)} />
            <ActionButton name="REJECT" color="danger" disabled={disabled} onClick={() => setConfirmingReject(true)} />
            <ActionButton name="REWORK" color="muted" disabled={disabled} onClick={() => setConfirmingRework(true)} />
          </div>
        )}
      </div>
    );
  }

  if (row.pending === 'plan') {
    const togglePlan = async () => {
      const opening = !planOpen;
      setPlanOpen(opening);
      if (opening && planText === null) {
        setPlanFailed(false);
        const text = await jobs.plan(row.run_id);
        if (text !== undefined) setPlanText(text);
        else setPlanFailed(true);
      }
    };
    const approvePlan = async () => {
      const result = await jobs.approve(row.run_id, approvalNote);
      if (result !== undefined) onPlanApproved(result.worker_serves_project === true);
    };
    return (
      <div className="rounded border border-border p-3 font-mono text-sm">
        {facts}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ActionButton name="PLAN" color="muted" disabled={disabled} onClick={() => void togglePlan()} />
          <label className="flex items-center gap-2 text-xs text-muted">
            Approval note
            <input
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              placeholder="optional"
              className="w-64 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>
          {!confirmingReject && (
            <>
              <ActionButton name="APPROVE PLAN" color="accent" disabled={disabled} onClick={() => void approvePlan()} />
              <ActionButton name="REJECT" color="danger" disabled={disabled} onClick={() => setConfirmingReject(true)} />
            </>
          )}
        </div>
        {originAvailable && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {originAction}
            {row.worktree && freshAction}
          </div>
        )}
        {errorLine}
        {planOpen && (
          <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-bg p-3 text-xs text-text select-text">
            {planText ?? (planFailed ? 'plan could not be loaded — reopen PLAN to retry' : 'loading plan…')}
          </pre>
        )}
        {confirmingReject && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              Reject note
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="why (optional)"
                className="w-56 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
            <ActionButton name="CONFIRM REJECT" color="danger-solid" disabled={disabled} onClick={() => void jobs.reject(row.run_id, note)} />
            <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={() => { setConfirmingReject(false); setNote(''); }} />
          </div>
        )}
      </div>
    );
  }

  const scopeRequest = row.pending === 'scope' ? parseScopeRequest(row.scope_request) : null;
  if (scopeRequest) {
    return (
      <div className="rounded border border-border p-3 font-mono text-sm">
        {facts}
        <ul aria-label="Requested paths" className="mt-2 list-disc space-y-1 pl-5 text-xs text-text">
          {scopeRequest.paths.map((path, index) => (
            <li key={`${index}:${path}`}><code className="whitespace-pre-wrap break-all select-text">{path}</code></li>
          ))}
        </ul>
        {scopeRequest.reason && <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm text-text select-text">{scopeRequest.reason}</p>}
        {confirmingReject ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              Reject note
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="why (optional)"
                className="w-56 rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
            <ActionButton name="CONFIRM REJECT" color="danger-solid" disabled={disabled} onClick={() => void jobs.reject(row.run_id, note)} />
            <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={() => { setConfirmingReject(false); setNote(''); }} />
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ActionButton name="APPROVE SCOPE" color="accent" disabled={disabled} onClick={() => void jobs.approve(row.run_id)} />
            <ActionButton name="REJECT" color="danger" disabled={disabled} onClick={() => setConfirmingReject(true)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded border border-border p-3 font-mono text-sm">
      {facts}
      <code className="mt-2 block select-text font-mono text-xs text-text">helmraiser approve {row.run_id.slice(0, 8)}</code>
    </div>
  );
}
