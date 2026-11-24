import { useState } from 'react';
import { humaneError } from '@core/transport/humane-error.ts';
import { ActionButton } from './ActionButton.tsx';

/** Helmraiser's help text for `rework` and its `--rebase` option, kept to its words (the rebase one as the checkbox's hover). */
const WHAT_IT_DOES = 'Hands the run back for feedback, a rebase, or both.';
const WHAT_REBASE_DOES = 'Also rebases the run branch onto its current base branch (the implementer resolves conflicts).';
/** The sidecar's bound on a note (`helmraiser.rework`), so a longer paste cannot be sent. */
const MAX_NOTE_CHARS = 20_000;

/** REWORK for a run awaiting merge: confirm-first, with the feedback note and the rebase option. */
export function ReworkForm({ noWorker, disabled, onRework, onCancel }: {
  /** Why a rework would wait for a worker, or null when a running worker serves the project. */
  noWorker: string | null;
  /** Another panel action is in flight. */
  disabled: boolean;
  /** Hands the run back; rejects with the CLI's refusal. */
  onRework: (note: string, rebase: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const [rebase, setRebase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Helmraiser takes a note, a rebase, or both; a blank note says nothing.
  const sendable = note.trim() !== '' || rebase;
  const confirm = async () => {
    setError(null);
    try {
      await onRework(note.trim(), rebase);
    } catch (failure) {
      // The sidecar words a refusal as the command ("helmraiser rework failed: …"); the row says what did not happen.
      // The form stays open, so a long note is not lost to a refusal.
      setError(`Not reworked — ${humaneError(failure, 'Rework failed').message.replace(/^helmraiser \S+ failed: /, '')}`);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {error && <p role="alert" className="basis-full text-xs text-danger">⚠ {error}</p>}
      <span className="basis-full text-xs text-muted">{WHAT_IT_DOES}</span>
      <label className="flex basis-full flex-col gap-1 text-xs text-muted">
        Rework note
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={MAX_NOTE_CHARS}
          placeholder="feedback for the implementer"
          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </label>
      <label className="flex basis-full items-center gap-2 text-xs text-muted" title={WHAT_REBASE_DOES}>
        <input type="checkbox" className="accent-accent" checked={rebase} onChange={(event) => setRebase(event.target.checked)} />
        also rebase onto the base branch
      </label>
      {!sendable && <span className="basis-full text-xs text-muted">Needs a note, or a rebase on its own — helmraiser takes either.</span>}
      {noWorker && <span className="basis-full text-xs text-attention">{noWorker}</span>}
      <ActionButton name="CONFIRM REWORK" color="accent" disabled={disabled || !sendable} onClick={() => void confirm()} />
      <ActionButton name="CANCEL" color="muted" disabled={disabled} onClick={onCancel} />
    </div>
  );
}
