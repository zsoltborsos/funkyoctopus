/**
 * Chat keyboard shortcuts — one table, bound by the composer and listed in
 * Settings, so the two cannot drift.
 */
export interface ChatShortcut {
  keys: string;
  does: string;
}

export const CHAT_SHORTCUTS: readonly ChatShortcut[] = [
  { keys: 'Enter', does: 'send · Shift+Enter for a newline' },
  { keys: 'Enter, while a turn streams', does: 'queue the message; it sends when the turn ends' },
  { keys: 'Esc', does: 'stop the turn; queued messages return to the composer' },
  {
    keys: 'Ctrl+N · Alt+N',
    does: 'new chat · use Alt+N in a browser tab (Chrome keeps Ctrl+N)',
  },
  { keys: 'Ctrl+End', does: 'jump to the latest message (while the composer is empty)' },
  {
    keys: 'Up · Down',
    does: 'recall earlier messages (caret on the first / last line) · Esc leaves recall, restoring your draft',
  },
  { keys: 'Alt+1 … Alt+9', does: 'show chat tab 1–8 · Alt+9 is the last tab' },
  { keys: 'Alt+PageDown · Alt+PageUp', does: 'next / previous chat tab' },
  {
    keys: 'Alt+T',
    does: 'new chat tab on the shown tab’s engine · the ＋ menu picks pi or Claude',
  },
  {
    keys: 'Ctrl+K',
    does: 'switcher: jump to a view or a chat tab, from any view · type to filter, Enter jumps, Esc closes',
  },
];

/** The subset of KeyboardEvent the matchers read — DOM or React event alike. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** An input method is composing: every key is its. */
  isComposing?: boolean;
}

/** Ctrl+N or Alt+N (exactly one of the two), by physical key so layouts do not matter. */
export const isNewChatShortcut = (e: KeyLike): boolean =>
  e.code === 'KeyN' && !e.shiftKey && !e.metaKey && e.ctrlKey !== e.altKey;

/** A bare Escape. */
export const isStopShortcut = (e: KeyLike): boolean =>
  e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;

/** Ctrl+End alone: jump the transcript to its end. */
export const isJumpToLatestShortcut = (e: KeyLike): boolean =>
  e.key === 'End' && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;

/**
 * Alt and nothing else, outside an input method's composition: the tab keys.
 * Ctrl+Tab/T/W and Alt+arrows belong to the browser.
 */
const altOnly = (e: KeyLike): boolean =>
  e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.isComposing !== true;

/**
 * The key typed a character other than the one the shortcut names: macOS's
 * Option+1 is ¡ and Option+T is †, which belong to the person typing.
 */
const typesOtherCharacter = (e: KeyLike, expected: string): boolean =>
  [...e.key].length === 1 && e.key.toLowerCase() !== expected;

/** Alt+1…9 by physical key: the tab position (9 meaning the last), or null. */
export const tabJumpShortcut = (e: KeyLike): number | null => {
  if (!altOnly(e)) return null;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  return digit && !typesOtherCharacter(e, digit) ? Number(digit) : null;
};

/** Alt+PageDown → the next tab (1), Alt+PageUp → the previous (-1), else null. */
export const tabCycleShortcut = (e: KeyLike): 1 | -1 | null => {
  if (!altOnly(e)) return null;
  if (e.key === 'PageDown') return 1;
  if (e.key === 'PageUp') return -1;
  return null;
};

/** Alt+T, by physical key: a new tab. */
export const newTabShortcut = (e: KeyLike): boolean =>
  altOnly(e) && e.code === 'KeyT' && !typesOtherCharacter(e, 't');

/** Ctrl+K, by physical key: the switcher. Taken from the browser's search bar. */
export const switcherShortcut = (e: KeyLike): boolean =>
  e.code === 'KeyK' &&
  e.ctrlKey &&
  !e.altKey &&
  !e.shiftKey &&
  !e.metaKey &&
  e.isComposing !== true;
