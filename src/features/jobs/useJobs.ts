import { useState } from 'react';
import { useService } from '@core/container/useService.ts';
import { WORKFLOW } from './workflow.client.ts';
import { useHelmraiserMonitor } from './useHelmraiserMonitor.ts';
import { type HumaneError, humaneError } from '@core/transport/humane-error.ts';
import type { HelmraiserReworkResult, HelmraiserRetryResult } from '@shared/transport/protocol.ts';

/** The panel-facing API of the hook, for typing row components. */
export type JobsApi = ReturnType<typeof useJobs>;

export function useJobs() {
  const workflow = useService(WORKFLOW);
  const monitor = useHelmraiserMonitor();
  const [actionError, setActionError] = useState<HumaneError | null>(null);
  /** Key of the action in flight, e.g. `approve:<runId>`, `worker`, `queue`. */
  const [pending, setPending] = useState<string | null>(null);

  const run = async <T,>(key: string, action: () => Promise<T>, fallback: string): Promise<T | undefined> => {
    setPending(key);
    try {
      const result = await action();
      setActionError(null);
      await monitor.refresh();
      return result;
    } catch (error) {
      setActionError(humaneError(error, fallback));
      return undefined;
    } finally {
      setPending(null);
    }
  };

  const read = async <T,>(key: string, action: () => Promise<T>, fallback: string): Promise<T | undefined> => {
    setPending(key);
    try {
      const result = await action();
      setActionError(null);
      return result;
    } catch (error) {
      setActionError(humaneError(error, fallback));
      return undefined;
    } finally {
      setPending(null);
    }
  };

  const plan = async (runId: string): Promise<string | undefined> =>
    (await read(`plan:${runId}`, () => workflow.plan(runId), 'Plan load failed'))?.text;
  const runReview = (runId: string) => read(
    `review:${runId}`,
    () => workflow.runReview(runId),
    'Review load failed',
  );
  const approve = (runId: string, note?: string) => run(
    `approve:${runId}`,
    () => note === undefined ? workflow.approve(runId) : workflow.approve(runId, note),
    'Approve failed',
  );
  const reject = (runId: string, note?: string) => run(`reject:${runId}`, () => workflow.reject(runId, note), 'Reject failed');
  const startWorker = () => run('worker', () => workflow.startWorker(), 'Start worker failed');
  const stopWorker = () => run('worker', () => workflow.stopWorker(), 'Stop worker failed');
  const pause = () => run('queue', () => workflow.pause(), 'Pause failed');
  const resume = () => run('queue', () => workflow.resume(), 'Resume failed');
  const abort = (project: string, runId: string) => run(`abort:${runId}`, () => workflow.abort(project, runId), 'Abort failed');
  /** Rejects with the CLI's refusal so the queued row can show it itself, not the shared error line. */
  const queueRemove = async (taskId: string): Promise<void> => {
    setPending(`queueRemove:${taskId}`);
    try {
      await workflow.queueRemove(taskId);
      setActionError(null);
      await monitor.refresh();
    } finally {
      setPending(null);
    }
  };

  /** Rejects with the CLI's refusal so the failed row can show it itself, not the shared error line. */
  const retry = async (runId: string, implement: boolean): Promise<HelmraiserRetryResult> => {
    setPending(`retry:${runId}`);
    try {
      const result = await workflow.retry(runId, implement);
      setActionError(null);
      await monitor.refresh();
      return result;
    } finally {
      setPending(null);
    }
  };

  /** Rejects with the CLI's refusal so the awaiting row can show it itself, not the shared error line. */
  const rework = async (runId: string, note: string, rebase: boolean): Promise<HelmraiserReworkResult> => {
    setPending(`rework:${runId}`);
    try {
      const result = await workflow.rework(runId, note, rebase);
      setActionError(null);
      await monitor.refresh();
      return result;
    } finally {
      setPending(null);
    }
  };

  return {
    ...monitor,
    error: actionError?.message ?? monitor.error,
    unavailable: actionError?.unavailable ?? monitor.unavailable,
    /** The status read found no Helmraiser CLI. Only that read clears it, so an old action error cannot hold it. */
    notInstalled: monitor.unavailable,
    pending,
    plan,
    runReview,
    approve,
    reject,
    startWorker,
    stopWorker,
    pause,
    resume,
    abort,
    queueRemove,
    retry,
    rework,
  };
}
