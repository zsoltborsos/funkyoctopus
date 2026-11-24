import { token } from '@core/container/container.ts';
import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';

const STORAGE_KEY = 'funkyoctopus.chat.input-history';

/** Oldest entries fall off first; a year of dogfooding stays well under this. */
export const INPUT_HISTORY_CAP = 200;

/**
 * What the composer sent, oldest first — the shell's "press Up to get the last
 * command back". Persisted through the StorageAdapter seam like the prompt
 * library, global across sessions and folders: a quick repeat does not care
 * which chat it was typed in. Consecutive duplicates collapse (re-sending
 * "continue" five times is one entry), blanks are never kept.
 */
export class InputHistoryService {
  private entries: string[];

  constructor(private readonly storage: StorageAdapter) {
    this.entries = this.load();
  }

  /** Stable snapshot; a new array on every change so callers can compare by identity. */
  list = (): readonly string[] => this.entries;

  record(text: string): void {
    if (text.trim() === '') return;
    if (this.entries[this.entries.length - 1] === text) return;
    this.entries = [...this.entries, text].slice(-INPUT_HISTORY_CAP);
    this.storage.set(STORAGE_KEY, this.entries);
  }

  private load(): string[] {
    const raw = this.storage.get<unknown>(STORAGE_KEY);
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
  }
}

export const INPUT_HISTORY = token<InputHistoryService>('InputHistoryService');

/**
 * Where a recall stands: which entry is shown and what the composer held
 * before recall began. `null` is the resting state — the draft is the user's.
 */
export interface RecallState {
  readonly index: number;
  readonly stash: string;
}

export interface RecallStep {
  readonly state: RecallState | null;
  readonly text: string;
}

/**
 * Up: step to the older entry. From rest the current draft is stashed so
 * cycling never eats what was typed. Returns `null` when there is nothing
 * older — the caller leaves the composer alone.
 */
export function recallOlder(
  entries: readonly string[],
  state: RecallState | null,
  draft: string,
): RecallStep | null {
  const index = state === null ? entries.length - 1 : state.index - 1;
  const text = entries[index];
  if (text === undefined) return null;
  return { state: { index, stash: state?.stash ?? draft }, text };
}

/**
 * Down: step to the newer entry; past the newest, hand the stashed draft back
 * and return to rest. At rest there is nothing newer — `null`.
 */
export function recallNewer(entries: readonly string[], state: RecallState | null): RecallStep | null {
  if (state === null) return null;
  const index = state.index + 1;
  const text = entries[index];
  if (text === undefined) return { state: null, text: state.stash };
  return { state: { ...state, index }, text };
}

/** Esc: abandon the recall and hand the stashed draft back; at rest, nothing. */
export function recallCancel(state: RecallState | null): RecallStep | null {
  return state === null ? null : { state: null, text: state.stash };
}

/** True when the caret sits on the first line of `value` — Up may recall. */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes('\n');
}

/** True when the caret sits on the last line of `value` — Down may recall. */
export function caretOnLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes('\n');
}
