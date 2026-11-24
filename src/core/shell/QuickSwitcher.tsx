import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { clsx } from 'clsx';
import { useService } from '@core/container/useService.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { describeTab, ENGINES, GLYPH } from '@features/chat/engines.ts';
import { ago, folderOf } from '@features/chat/session-label.ts';
import { switcherShortcut } from '@features/chat/shortcuts.ts';
import { TAB_FOLDERS } from '@features/chat/tab-folders.ts';
import {
  emphasise,
  filterEntries,
  storedEntries,
  storedHeading,
  switcherEntries,
  type ListedEntry,
} from './quick-switcher.ts';
import { useShell } from './useShell.ts';
import { useStoredChats } from './useStoredChats.ts';

/**
 * Ctrl+K from any view (T2.4a): one list of the views and the open chat tabs,
 * filtered as you type, and below them the stored chats the sidecar finds for
 * a query of three characters or more (T2.5). The key is bound on the window
 * here, at the shell, not in the chat view, so it works wherever the owner is;
 * it is taken from the browser's search bar.
 */
export function QuickSwitcher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !switcherShortcut(e)) return;
      e.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  return open ? <SwitcherDialog onClose={() => setOpen(false)} /> : null;
}

/** An overlay: it floats over the shell, so nothing under it moves. */
function SwitcherDialog({ onClose }: { onClose: () => void }) {
  const { view, setView } = useShell();
  const sessions = useService(CHAT_SESSIONS);
  const { tabs, activeChatId } = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const folders = useService(TAB_FOLDERS);
  useSyncExternalStore(folders.subscribe, folders.getVersion);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  // Opening a stored chat takes the sidecar a moment: one at a time, and a refusal is shown in place.
  const opening = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const stored = useStoredChats(query);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Focus goes to the filter, and back to where it was when the switcher closes
  // without moving the owner to another view (and unless that place is gone).
  const restoreFocus = useRef(true);
  useEffect(() => {
    const from = document.activeElement;
    input.current?.focus();
    return () => {
      if (restoreFocus.current && from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, []);

  const entries = switcherEntries(
    view,
    tabs,
    activeChatId,
    (chatId) => folders.forTab(chatId).get()?.name ?? 'Global',
  );
  const storedResult = stored.phase === 'searching' || stored.phase === 'done' ? stored.result : null;
  const storedRows = storedResult ? storedEntries(storedResult.hits) : [];
  const shown: ListedEntry[] = [...filterEntries(entries, query), ...storedRows];
  const index = Math.min(cursor, shown.length - 1);
  const active = shown[index];
  const optionId = (entry: ListedEntry): string => `${listId}-${entry.id}`;

  // The highlighted row stays in view as the arrows walk a long list.
  const activeKey = active?.id;
  useEffect(() => {
    const row = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row && 'scrollIntoView' in row) row.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const openStored = async (path: string): Promise<void> => {
    if (opening.current) return;
    opening.current = true;
    setOpenError(null);
    try {
      await sessions.reviewInOrigin(path);
    } catch (error) {
      setOpenError(humaneError(error, 'could not open that chat').message);
      return;
    } finally {
      opening.current = false;
    }
    restoreFocus.current = view === 'chat';
    setView('chat');
    onClose();
  };
  const pick = (entry: ListedEntry): void => {
    if (entry.kind === 'stored') {
      void openStored(entry.hit.path);
      return;
    }
    const target = entry.kind === 'view' ? entry.view : 'chat';
    // A jump to another view leaves the old place behind: a nav button back in
    // focus would sit there ringed for no reason.
    restoreFocus.current = target === view;
    if (entry.kind === 'tab') sessions.activate(entry.tab.chatId);
    setView(target);
    onClose();
  };
  const move = (step: 1 | -1): void => {
    if (shown.length > 0) setCursor((index + step + shown.length) % shown.length);
  };

  // Handled keys are marked handled: the chat view's window listener stops a
  // turn on Esc, and must not hear this one.
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (active) pick(active);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'Tab':
        // The filter is the only stop: focus stays in the dialog.
        e.preventDefault();
        break;
    }
  };

  const groups = [
    { key: 'Views', heading: 'Views', rows: shown.filter((entry) => entry.kind === 'view') },
    { key: 'Tabs', heading: 'Tabs', rows: shown.filter((entry) => entry.kind === 'tab') },
    {
      key: 'Stored',
      heading: storedResult ? storedHeading(storedResult.total, storedResult.hits.length) : '',
      rows: shown.filter((entry) => entry.kind === 'stored'),
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]">
      {/* Any press outside the panel closes it; keeping the default stops the press taking focus from the filter. */}
      <div
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        className="absolute inset-0 bg-bg/70"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Switcher"
        onKeyDown={onKeyDown}
        className="relative flex max-h-[70vh] w-[36rem] max-w-full flex-col rounded border border-border bg-surface font-mono text-xs shadow-glow-accent"
      >
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Jump to a view or chat tab"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Jump to a view or tab — 3+ letters also search stored chats…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
            setOpenError(null);
          }}
          className="w-full rounded-t border-b border-border bg-transparent px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted focus:border-accent/60"
        />
        {/* Above the list, so it shows while a refined query is out over a long list kept from the last. */}
        {stored.phase === 'searching' && (
          <p role="status" className="border-b border-border px-3 py-1.5 text-muted">
            searching stored chats…
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {/* Keep the press from taking focus off the filter. */}
          <div
            id={listId}
            role="listbox"
            aria-label="Views, chat tabs and stored chats"
            onMouseDown={(e) => e.preventDefault()}
          >
            {groups.map((group) => (
              <div key={group.key} role="group" aria-labelledby={`${listId}-${group.key}`}>
                <div
                  id={`${listId}-${group.key}`}
                  className="px-2 pb-1 pt-2 text-[0.7rem] uppercase tracking-widest text-muted"
                >
                  {group.heading}
                </div>
                {group.rows.map((entry) => (
                  <SwitcherRow
                    key={entry.id}
                    id={optionId(entry)}
                    entry={entry}
                    query={query}
                    selected={entry === active}
                    onHover={() => setCursor(shown.indexOf(entry))}
                    onPick={() => pick(entry)}
                  />
                ))}
              </div>
            ))}
          </div>
          {stored.phase === 'failed' && (
            <p role="alert" className="px-2 py-2 text-danger">
              Stored chat search failed: {stored.message}
            </p>
          )}
          {openError !== null && (
            <p role="alert" className="px-2 py-2 text-danger">
              Could not open that chat: {openError}
            </p>
          )}
          {stored.phase === 'done' && stored.result.hits.length === 0 && (
            <p role="status" className="px-2 py-2 text-muted">
              no stored chat matches
            </p>
          )}
          {shown.length === 0 && stored.phase === 'off' && (
            <p role="status" className="px-2 py-3 text-muted">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[0.7rem] text-muted">
          ↑↓ move · Enter jump · Esc close
        </div>
      </div>
    </div>
  );
}

function SwitcherRow({
  id,
  entry,
  query,
  selected,
  onHover,
  onPick,
}: {
  id: string;
  entry: ListedEntry;
  /** What the owner typed: a stored chat's snippet shows its words. */
  query: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const row = clsx(
    'flex cursor-pointer gap-2 rounded border px-2 py-1.5 text-sm text-text',
    entry.kind === 'stored' ? 'items-start' : 'items-center',
    selected ? 'border-accent/50 bg-accent-soft' : 'border-transparent',
  );
  if (entry.kind === 'stored') {
    const { hit } = entry;
    const engine = ENGINES[hit.engine];
    const folder = folderOf(hit.cwd);
    const age = ago(hit.modified);
    const gone = hit.folderGone === true;
    return (
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-label={`${hit.title} — ${[engine.label, folder, age, ...(gone ? ['folder gone'] : [])].filter(Boolean).join(', ')}`}
        aria-describedby={`${id}-snippet`}
        onMouseMove={onHover}
        onClick={onPick}
        // A chat whose folder is gone for good reads dimmer but stays pickable, as in the history list.
        className={clsx(row, gone && 'opacity-60')}
      >
        <span aria-hidden="true" className={clsx(GLYPH, 'w-5 text-center', engine.tone)}>
          {engine.glyph}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{hit.title}</span>
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted">{folder}</span>
            <span className="shrink-0 text-xs text-muted">{age}</span>
          </span>
          <span id={`${id}-snippet`} className="truncate text-xs text-muted">
            {emphasise(hit.snippet, query).map((part, i) =>
              part.match ? (
                <mark key={i} className="bg-transparent text-accent">
                  {part.text}
                </mark>
              ) : (
                part.text
              ),
            )}
          </span>
        </span>
      </div>
    );
  }
  const current = entry.current && (
    <span className="shrink-0 text-xs text-accent">current</span>
  );
  if (entry.kind === 'view') {
    return (
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-current={entry.current ? 'true' : undefined}
        onMouseMove={onHover}
        onClick={onPick}
        className={row}
      >
        <span aria-hidden="true" className="w-5 shrink-0 text-center text-muted">
          {entry.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {current}
      </div>
    );
  }
  const { tab } = entry;
  const engine = ENGINES[tab.kind];
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-current={entry.current ? 'true' : undefined}
      aria-label={`${tab.title} — ${[...describeTab(tab), entry.folder, ...(entry.current ? ['current'] : [])].join(', ')}`}
      onMouseMove={onHover}
      onClick={onPick}
      className={row}
    >
      <span aria-hidden="true" className={clsx(GLYPH, 'w-5 text-center', engine.tone)}>
        {engine.glyph}
      </span>
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      <span aria-hidden="true" className="max-w-[40%] shrink-0 truncate text-xs text-muted">
        {entry.folder}
      </span>
      {tab.attention && (
        <span aria-hidden="true" className="shrink-0 font-bold text-attention">
          !
        </span>
      )}
      {tab.busy ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
        />
      ) : (
        tab.unread && (
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-special" />
        )
      )}
      {current}
    </div>
  );
}
