import type { ChatTab } from '@features/chat/chat-sessions.service.ts';
import { ENGINES } from '@features/chat/engines.ts';
import type { ChatSearchHit } from '@shared/transport/protocol.ts';
import { NAV } from './nav.ts';
import type { ShellView } from './shell.types.ts';

/** One line of the switcher: a view, or an open chat tab. `current` is where the owner is now. */
export type SwitcherEntry =
  | { kind: 'view'; id: string; view: ShellView; label: string; glyph: string; current: boolean }
  | { kind: 'tab'; id: string; tab: ChatTab; folder: string; current: boolean };

/** The views, then the tabs in the bar's order; `folderOf` names a tab's folder as the owner sees it. */
export function switcherEntries(
  view: ShellView,
  tabs: readonly ChatTab[],
  activeChatId: string,
  folderOf: (chatId: string) => string,
): SwitcherEntry[] {
  return [
    ...NAV.map((item): SwitcherEntry => ({
      kind: 'view',
      id: `view-${item.view}`,
      view: item.view,
      label: item.label,
      glyph: item.glyph,
      current: item.view === view,
    })),
    ...tabs.map((tab): SwitcherEntry => ({
      kind: 'tab',
      id: `tab-${tab.chatId}`,
      tab,
      folder: folderOf(tab.chatId),
      current: tab.chatId === activeChatId,
    })),
  ];
}

const haystack = (entry: SwitcherEntry): string =>
  (entry.kind === 'view'
    ? entry.label
    : `${entry.tab.title} ${entry.folder} ${ENGINES[entry.tab.kind].label}`
  ).toLowerCase();

/** Entries holding every word of the query (any order, any case) in their label, title, folder or engine. */
export function filterEntries(entries: readonly SwitcherEntry[], query: string): SwitcherEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const text = haystack(entry);
    return words.every((word) => text.includes(word));
  });
}

/** A stored chat the sidecar found for the query: one more line of the switcher, below the views and tabs. */
export interface StoredEntry {
  kind: 'stored';
  id: string;
  hit: ChatSearchHit;
}

/** Every line the keyboard cursor walks. */
export type ListedEntry = SwitcherEntry | StoredEntry;

/** A query shorter than this (trimmed) searches nothing: one or two letters would match nearly every stored chat. */
const STORED_MIN_QUERY = 3;

/** What to ask the sidecar for: the trimmed query, or null while it is too short to search. */
export function storedQuery(query: string): string | null {
  const words = query.trim();
  return words.length >= STORED_MIN_QUERY ? words : null;
}

/** Keyed by engine and session id, not path: an element id cannot hold a path with spaces in it. */
export function storedEntries(hits: readonly ChatSearchHit[]): StoredEntry[] {
  return hits.map((hit) => ({ kind: 'stored', id: `stored-${hit.engine}-${hit.id}`, hit }));
}

/** The group heading: how many chats matched, and how many of them are listed when the sidecar cut the list. */
export function storedHeading(total: number, listed: number): string {
  return `Stored chats · ${total > listed ? `showing ${listed} of ${total}` : total}`;
}

/** A snippet cut into plain and matching parts: every word of the query, in any case, is a match. */
export function emphasise(text: string, query: string): { text: string; match: boolean }[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = words.length > 0 ? text.split(new RegExp(`(${words.join('|')})`, 'i')) : [text];
  // A split with one capture group alternates plain, match, plain, ...
  return parts.flatMap((part, i) => (part === '' ? [] : [{ text: part, match: i % 2 === 1 }]));
}
