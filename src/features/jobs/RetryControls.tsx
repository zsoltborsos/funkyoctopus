import { useState } from 'react';
import { humaneError } from '@core/transport/humane-error.ts';
import { ActionButton } from './ActionButton.tsx';

/** What each button does, in the words of `helmraiser retry --help`. */
const WHAT_IT_DOES = {
  resume: 'It resumes at verify → evidence → review.',
  implement: 'It goes back to implement with the last verify failure.',
} as const;

type Mode = keyof typeof WHAT_IT_DOES;

/** RETRY and RETRY (IMPLEMENT) for a failed run: confirm-first, with what the choice does. */
export function RetryControls({ noWorker, disabled, onRetry }: {
  /** Why a retry would wait for a worker, or null when a running worker serves the project. */
  noWorker: string | null;
  /** Another panel action is in flight. */
  disabled: boolean;
  /** Hands the run back; rejects with the CLI's refusal. */
  onRetry: (implement: boolean) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retry = async (mode: Mode) => {
    setError(null);
    try {
      await onRetry(mode === 'implement');
    } catch (failure) {
      // The sidecar words a refusal as the command ("helmraiser retry failed: …"); the row says what did not happen.
      setError(`Not retried — ${humaneError(failure, 'Retry failed').message.replace(/^helmraiser \S+ failed: /, '')}`);
    } finally {
      setConfirming(null);
    }
  };
  // Rendered into a wrapping flex row (RunLog's `actions`): lines of text take the full width, buttons share one line.
  return (
    <>
      {error && <p role="alert" className="basis-full text-xs text-danger">⚠ {error}</p>}
      {confirming ? (
        <>
          <span className="basis-full text-xs text-muted">
            Re-reads the task file and hands the run back to the worker. {WHAT_IT_DOES[confirming]} With no commits and a clean worktree it restarts from the start.
          </span>
          {noWorker && <span className="basis-full text-xs text-attention">{noWorker}</span>}
          <ActionButton
            name={confirming === 'implement' ? 'CONFIRM RETRY (IMPLEMENT)' : 'CONFIRM RETRY'}
            color="accent"
            disabled={disabled}
            onClick={() => void retry(confirming)}
          />
          <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={() => setConfirming(null)} />
        </>
      ) : (
        <>
          <ActionButton name="RETRY" color="muted" disabled={disabled} onClick={() => { setError(null); setConfirming('resume'); }} />
          <ActionButton name="RETRY (IMPLEMENT)" color="muted" disabled={disabled} onClick={() => { setError(null); setConfirming('implement'); }} />
        </>
      )}
    </>
  );
}
