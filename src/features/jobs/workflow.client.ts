import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type {
  HelmraiserCancelScoutsResult,
  HelmraiserRequestScoutsResult,
  HelmraiserDraftResult,
  HelmraiserDropClass,
  HelmraiserEvent,
  HelmraiserLogResult,
  HelmraiserProposalResult,
  HelmraiserQueueResult,
  HelmraiserReport,
  HelmraiserReportWindow,
  HelmraiserReworkResult,
  HelmraiserRetryResult,
  HelmraiserRunReview,
  HelmraiserScoutedDraft,
  HelmraiserScoutLens,
  HelmraiserScoutSettings,
  HelmraiserScoutSettingsUpdate,
  HelmraiserStats,
  HelmraiserStatsWindow,
  HelmraiserStatus,
} from '@shared/transport/protocol.ts';

/**
 * Browser face of the workflow-engine seam (helmraiser). The shell observes and
 * acts on the queue through the CLI; helmraiser owns orchestration.
 */
export class WorkflowClient {
  constructor(private readonly transport: TransportClient) {}

  status(): Promise<HelmraiserStatus> {
    return this.transport.call('helmraiser.status');
  }

  /** The window's runs, spend and per-model figures; a big window can take minutes. */
  report(since: HelmraiserReportWindow): Promise<HelmraiserReport> {
    return this.transport.call('helmraiser.report', { since });
  }

  /** Ledger-wide figures for the window, from `helmraiser stats`; `project` narrows every section to one project. */
  stats(since: HelmraiserStatsWindow, project?: string): Promise<HelmraiserStats> {
    return this.transport.call('helmraiser.stats', { since, ...(project !== undefined ? { project } : {}) });
  }

  allDrafts(): Promise<HelmraiserScoutedDraft[]> {
    return this.transport.call('helmraiser.allDrafts');
  }

  scoutSettings(): Promise<HelmraiserScoutSettings> {
    return this.transport.call('helmraiser.scoutSettings');
  }

  setScoutSettings(update: HelmraiserScoutSettingsUpdate): Promise<HelmraiserScoutSettings> {
    return this.transport.call('helmraiser.setScoutSettings', update);
  }

  resetScoutSettings(lens: HelmraiserScoutLens): Promise<HelmraiserScoutSettings> {
    return this.transport.call('helmraiser.resetScoutSettings', { lens });
  }

  drafts(): Promise<HelmraiserScoutedDraft[]> {
    return this.transport.call('helmraiser.drafts');
  }

  requestScouts(projects: string[], lens?: HelmraiserScoutLens): Promise<HelmraiserRequestScoutsResult> {
    return this.transport.call('helmraiser.requestScouts', { projects, ...(lens !== undefined ? { lens } : {}) });
  }

  cancelScouts(projects: string[], lens?: HelmraiserScoutLens): Promise<HelmraiserCancelScoutsResult> {
    return this.transport.call('helmraiser.cancelScouts', { projects, ...(lens !== undefined ? { lens } : {}) });
  }

  abort(projectPath: string, runId: string): Promise<void> {
    return this.transport.call('helmraiser.abort', { projectPath, runId });
  }

  plan(runId: string): Promise<{ text: string; path: string }> {
    return this.transport.call('helmraiser.plan', { runId });
  }

  runReview(runId: string): Promise<HelmraiserRunReview> {
    return this.transport.call('helmraiser.runReview', { runId });
  }

  /** The run's last 200 ledger events; with `sinceId`, only those after that event id. */
  log(runId: string, sinceId?: number): Promise<HelmraiserLogResult> {
    return this.transport.call('helmraiser.log', { runId, ...(sinceId !== undefined ? { sinceId } : {}) });
  }

  approve(runId: string, note?: string): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.approve', { runId, ...(note !== undefined ? { note } : {}) });
  }

  reject(runId: string, note?: string): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.reject', { runId, ...(note !== undefined ? { note } : {}) });
  }

  startWorker(): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.workerStart');
  }

  stopWorker(): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.workerStop');
  }

  pause(): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.pause');
  }

  resume(): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.resume');
  }

  /** Write a draft task file into the project's `.helmraiser/tasks/`. */
  draft(project: string, title: string, text: string): Promise<HelmraiserDraftResult> {
    return this.transport.call('helmraiser.draft', { project, title, text });
  }

  /** Ask Helmraiser intake for a proposal on a drafted task file. */
  propose(path: string): Promise<HelmraiserProposalResult> {
    return this.transport.call('helmraiser.propose', { path });
  }

  /** Queue the drafted+proposed task file exactly as it stands on disk. */
  queue(path: string, origin?: string): Promise<HelmraiserQueueResult> {
    return this.transport.call('helmraiser.queue', { path, ...(origin !== undefined ? { origin } : {}) });
  }

  dropDraft(taskId: string, reason: string, dropClass?: HelmraiserDropClass): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.dropDraft', { taskId, reason, ...(dropClass ? { class: dropClass } : {}) });
  }

  /** Take one queued task back to draft; `taskId` is the full `<project-slug>:<id>`. */
  queueRemove(taskId: string): Promise<Record<string, unknown>> {
    return this.transport.call('helmraiser.queueRemove', { taskId });
  }

  /** Hand a failed run back to the worker; `implement` goes back to implement rather than verify. */
  retry(runId: string, implement?: boolean): Promise<HelmraiserRetryResult> {
    return this.transport.call('helmraiser.retry', { runId, ...(implement ? { implement } : {}) });
  }

  /** Hand a run awaiting merge back to the worker with a note, a rebase, or both; a blank note is none. */
  rework(runId: string, note?: string, rebase?: boolean): Promise<HelmraiserReworkResult> {
    return this.transport.call('helmraiser.rework', {
      runId, ...(note?.trim() ? { note } : {}), ...(rebase ? { rebase } : {}),
    });
  }

  /** Open the awaiting/failed observation stream; returns a cancel function. */
  observe(handlers: HelmraiserObservationHandlers): () => void {
    return this.transport.stream(
      'helmraiser.observe',
      {},
      {
        onChunk: (chunk) => handlers.onEvent(chunk as HelmraiserEvent),
        onEnd: () => handlers.onEnd?.(),
      },
    );
  }
}

/** Handlers for the observation-only helmraiser-event stream. */
export interface HelmraiserObservationHandlers {
  onEvent: (event: HelmraiserEvent) => void;
  onEnd?: () => void;
}

export const WORKFLOW = token<WorkflowClient>('WorkflowClient');
