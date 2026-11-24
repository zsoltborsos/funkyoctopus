import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useService } from '@core/container/useService.ts';
import {
  INPUT_HISTORY,
  caretOnFirstLine,
  caretOnLastLine,
  recallCancel,
  recallNewer,
  recallOlder,
  type RecallState,
  type RecallStep,
} from './input-history.ts';

export interface ComposerHistory {
  /** Handle Up/Down/Esc for recall. True when the key was consumed. */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The user typed: the recalled text is now theirs; recall is over. */
  noteEdit: () => void;
  /** A message went out: remember it and rest. */
  record: (text: string) => void;
}

interface Args {
  draft: string;
  setDraft: (text: string) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Shell-style input history on the composer: Up recalls the last sent message
 * (only with the caret on the first line, so a multi-line draft still edits
 * normally), Down walks back toward — and past the newest, restores — what
 * was being typed; Esc abandons the recall outright. The recall cursor is
 * per composer and lives in a ref: it never needs to render.
 */
export function useComposerHistory({ draft, setDraft, composer }: Args): ComposerHistory {
  const history = useService(INPUT_HISTORY);
  const state = useRef<RecallState | null>(null);
  // A recalled entry lands with the caret at its end, the way a shell does;
  // the move waits for React to commit the new value.
  const caretToEnd = useRef(false);
  useEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    const el = composer.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, [draft, composer]);

  const apply = (step: RecallStep | null): boolean => {
    if (step === null) return false;
    state.current = step.state;
    setDraft(step.text);
    caretToEnd.current = true;
    return true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return false;
    const el = e.currentTarget;
    let step: RecallStep | null;
    if (e.key === 'ArrowUp' && caretOnFirstLine(el.value, el.selectionStart)) {
      step = recallOlder(history.list(), state.current, draft);
    } else if (e.key === 'ArrowDown' && caretOnLastLine(el.value, el.selectionEnd)) {
      step = recallNewer(history.list(), state.current);
    } else if (e.key === 'Escape') {
      step = recallCancel(state.current);
    } else {
      return false;
    }
    if (!apply(step)) return false;
    e.preventDefault();
    return true;
  };

  return {
    handleKeyDown,
    noteEdit: () => {
      state.current = null;
    },
    record: (text) => {
      state.current = null;
      history.record(text);
    },
  };
}
