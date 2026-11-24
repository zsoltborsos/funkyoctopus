import { useState } from 'react';
import type { HelmraiserHold, HelmraiserNeverStartable } from '@shared/transport/protocol.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { ActionButton } from './ActionButton.tsx';
import { holdText, neverStartableText } from './queue-hold.ts';

/** A queued task as the row needs it: a `queue_next` entry, or a `never_startable` row beyond the first five. */
export interface QueuedRowEntry {
  task_id: string;
  priority?: string;
  project?: string;
  id?: string;
  title?: string;
}

const titleOf = (entry: QueuedRowEntry): string => entry.title ?? entry.id ?? entry.task_id;
const segmentOf = (project: string): string => project.split('/').filter(Boolean).at(-1) ?? project;

/** One queued task: its priority, title, project, why it is held or cannot start, and REMOVE. */
export function QueuedRow({ entry, hold, neverStartable, disabled, onRemove }: {
  entry: QueuedRowEntry;
  hold: HelmraiserHold | null;
  neverStartable: HelmraiserNeverStartable | null;
  /** Another panel action is in flight. */
  disabled: boolean;
  /** Takes the task out of the queue; rejects with the CLI's refusal. */
  onRemove: (taskId: string) => Promise<void>;
}) {
  const title = titleOf(entry);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setError(null);
    try {
      await onRemove(entry.task_id);
    } catch (failure) {
      // The sidecar words a refusal as the command ("helmraiser queue failed: …"); the row says what did not happen.
      setError(`Not removed — ${humaneError(failure, 'Remove failed').message.replace(/^helmraiser \S+ failed: /, '')}`);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <article aria-label={`Queued task: ${title}`} className="rounded border border-border p-3 font-mono text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {entry.priority && <span className="text-muted">{entry.priority}</span>}
        <strong className="text-text">{title}</strong>
        {entry.project && <span className="text-muted">{segmentOf(entry.project)}</span>}
      </div>
      {hold && (
        <p className="mt-1 text-xs text-muted" title={hold.run_id ? `run ${hold.run_id}` : undefined}>
          {holdText(hold)}
        </p>
      )}
      {neverStartable && <p className="mt-1 text-xs text-attention">{neverStartableText(neverStartable)}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">⚠ {error}</p>}
      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Take this task out of the queue? It goes back to draft; its task file is untouched.</span>
          <ActionButton name="CONFIRM REMOVE" color="danger-solid" disabled={disabled} onClick={() => void remove()} />
          <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={() => setConfirming(false)} />
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <ActionButton name="REMOVE" color="muted" disabled={disabled} onClick={() => { setError(null); setConfirming(true); }} />
        </div>
      )}
    </article>
  );
}
