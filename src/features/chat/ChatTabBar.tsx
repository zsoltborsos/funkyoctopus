import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { useService } from '@core/container/useService.ts';
import { TURN_IN_PROGRESS, wireErrorCode } from '@shared/transport/errors.ts';
import type { EngineKind } from '@shared/transport/protocol.ts';
import { CHAT_SESSIONS, type ChatTab } from './chat-sessions.service.ts';
import { describeTab, ENGINES, GLYPH } from './engines.ts';
import { newTabShortcut, tabCycleShortcut, tabJumpShortcut } from './shortcuts.ts';
import { useShell } from '@core/shell/useShell.ts';
import { useClickOutside } from './useClickOutside.ts';
import { TAB_FOLDERS } from './tab-folders.ts';
import { useTabFolder } from './useTabFolder.ts';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What closing a tab would lose, said before it does. */
function closeWarning(title: string, busy: boolean, unsent: boolean): string {
  if (busy && unsent) {
    return `a turn is running in “${title}” and it has an unsent draft — closing stops it and discards the draft.`;
  }
  if (busy) return `a turn is running in “${title}” — closing stops it.`;
  return `“${title}” has an unsent draft — closing discards it.`;
}

/**
 * The chat tabs over the chat panel (T2.2). Tabs are the sidecar's, shared by
 * every window and `fo`: this bar shows them, switches the shown one, opens a
 * pi or Claude Code tab from "＋ ▾", and closes one — asking first while a turn
 * is live or its composer holds something unsent (T2.3). `main` cannot be
 * closed. A tab closed elsewhere with something unsent leaves a notice that
 * offers it to the shown tab.
 */
export function ChatTabBar() {
  const tabs = useService(CHAT_SESSIONS);
  const {
    tabs: rows,
    activeChatId,
    failure,
    closedElsewhere,
  } = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
  const { folder } = useTabFolder();
  const folders = useService(TAB_FOLDERS);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { hasUnsent, moveComposer, discardComposer } = useShell();
  /** The tab whose close waits on "close anyway": a turn is live in it (`busy`, as the sidecar may say late), or a draft. */
  const [confirming, setConfirming] = useState<{ chatId: string; busy: boolean } | null>(null);
  /** Tabs closed elsewhere whose unsent drafts this window still holds, offered until used or dismissed (kept by the store, so a close seen while another view was shown is offered here). */
  const orphans = closedElsewhere.filter((tab) => hasUnsent(tab.chatId));
  const menu = useRef<HTMLDivElement>(null);
  useClickOutside(menu, () => setMenuOpen(false));
  const active = rows.find((tab) => tab.chatId === activeChatId);
  const list = useRef<HTMLDivElement>(null);
  // With more tabs than fit, the list scrolls; the shown tab is always scrolled into view.
  useEffect(() => {
    const shown = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (shown && 'scrollIntoView' in shown)
      shown.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeChatId, rows.length]);

  const newTab = (kind: EngineKind): void => {
    setMenuOpen(false);
    setError(null);
    // A new tab starts in the shown tab's folder, and keeps it as its own.
    void tabs
      .create(kind, folder?.path ?? null, (chatId) => folders.forTab(chatId).set(folder))
      .catch((e: unknown) => setError(messageOf(e)));
  };

  const close = (tab: ChatTab, confirmed: { busy: boolean } | null = null): void => {
    setError(null);
    if (!confirmed && (tab.busy || hasUnsent(tab.chatId))) {
      setConfirming({ chatId: tab.chatId, busy: tab.busy });
      return;
    }
    setConfirming(null);
    void tabs
      .close(tab.chatId, { force: confirmed?.busy ?? false })
      .then(() => discardComposer(tab.chatId))
      .catch((e: unknown) => {
        // The turn started after this window last heard: ask, as if it had known.
        if (wireErrorCode(e) === TURN_IN_PROGRESS) setConfirming({ chatId: tab.chatId, busy: true });
        else setError(messageOf(e));
      });
  };

  const dropOrphan = (chatId: string): void => tabs.dismissClosed(chatId);

  // Tab keys live on the window while the chat view is mounted, as the
  // composer's do; read through a ref so the one listener sees fresh closures.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e) => {
      if (e.defaultPrevented) return;
      const position = tabJumpShortcut(e);
      const step = tabCycleShortcut(e);
      if (position !== null) {
        // A position with no tab is left to the browser.
        if (tabs.jump(position)) e.preventDefault();
      } else if (step !== null) {
        e.preventDefault();
        tabs.cycle(step);
      } else if (newTabShortcut(e)) {
        e.preventDefault();
        newTab(active?.kind ?? 'pi');
      }
    };
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent): void => keys.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // A tab that went away (closed elsewhere) needs no confirmation any more.
  const confirmTab = rows.find((tab) => tab.chatId === confirming?.chatId);
  const confirmBusy = confirmTab !== undefined && (confirming?.busy === true || confirmTab.busy);

  // Drawn before the tab list arrives too, so "＋ ▾" and any failure to read it always show.
  return (
    <div className="relative mb-2 flex min-w-0 flex-col gap-1 font-mono text-xs">
      <div className="flex min-w-0 items-stretch gap-1">
        <div
          ref={list}
          role="tablist"
          aria-label="Chats"
          className="flex min-w-0 gap-1 overflow-x-auto"
        >
          {rows.map((tab, index) => {
            const shown = tab.chatId === activeChatId;
            const engine = ENGINES[tab.kind];
            const facts = describeTab(tab);
            const position =
              index < 8 ? `Alt+${index + 1}` : index === rows.length - 1 ? 'Alt+9' : null;
            return (
              <div
                key={tab.chatId}
                className={clsx(
                  // Full width until they crowd, then they shrink alike; "＋ ▾" follows the last one.
                  '@container flex w-60 min-w-[4.5rem] items-center rounded border',
                  shown
                    ? 'border-accent/60 bg-accent-soft text-text'
                    : 'border-border bg-surface/40 text-muted hover:border-faint hover:text-text',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={shown}
                  aria-label={`${tab.title} — ${facts.join(', ')}`}
                  title={`${tab.title}\n${facts.join(' · ')}${tab.closable ? '' : ' · the main chat, always open'}${position ? `\n${position}` : ''}`}
                  onClick={() => tabs.activate(tab.chatId)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-left"
                >
                  <span aria-hidden="true" className={clsx(GLYPH, engine.tone)}>
                    {engine.glyph}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
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
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-special"
                      />
                    )
                  )}
                  {/* The title needs the room more on a narrow tab; the tooltip still says crew. */}
                  {(tab.crew || tab.crewPending) && (
                    <span
                      aria-hidden="true"
                      className={clsx(
                        'hidden shrink-0 @min-[9rem]:inline',
                        tab.crew ? 'text-special' : 'text-muted',
                      )}
                    >
                      {tab.crew ? 'crew' : 'crew next'}
                    </span>
                  )}
                  {tab.subagentsLeftRunning > 0 && (
                    <span aria-hidden="true" className="shrink-0 text-muted">
                      ⧗{tab.subagentsLeftRunning}
                    </span>
                  )}
                </button>
                {tab.closable && (
                  <button
                    type="button"
                    onClick={() => close(tab)}
                    aria-label={`Close ${tab.title}`}
                    title="Close this tab everywhere"
                    className="shrink-0 self-stretch px-1 text-sm leading-none text-muted hover:text-danger"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div ref={menu} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="New tab"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="New tab (Alt+T: same engine as this one)"
            className="h-full rounded border border-border px-2 text-muted hover:border-accent hover:text-accent"
          >
            ＋ ▾
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="New tab"
              className="absolute right-0 top-full z-20 mt-1 w-52 rounded border border-border bg-surface p-1 shadow-glow-accent"
            >
              {(Object.keys(ENGINES) as EngineKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => newTab(kind)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-text hover:bg-accent-soft"
                >
                  <span aria-hidden="true" className={clsx(GLYPH, ENGINES[kind].tone)}>
                    {ENGINES[kind].glyph}
                  </span>
                  {ENGINES[kind].label} tab
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {failure && (
        <div role="alert" className="rounded border border-border bg-surface px-2 py-1 text-text">
          <span className="text-attention">⚠</span> tabs unavailable: {failure}
        </div>
      )}
      {/* Float under the bar, over the CHAT header, so they never push the transcript down. */}
      {(confirmTab ?? error) && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-1 rounded border border-border bg-surface p-2 shadow-glow-accent">
          {confirmTab && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-text">
              <span>
                <span className="text-attention">⚠</span>{' '}
                {closeWarning(confirmTab.title, confirmBusy, hasUnsent(confirmTab.chatId))}
              </span>
              <button
                type="button"
                onClick={() => close(confirmTab, { busy: confirmBusy })}
                className="rounded border border-danger px-2 py-0.5 text-danger hover:bg-danger/10"
              >
                close anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded border border-border px-2 py-0.5 text-muted hover:text-text"
              >
                keep it
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="flex items-center gap-2 text-text">
              <span className="min-w-0 flex-1">
                <span className="text-attention">⚠</span> {error}
              </span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss"
                className="shrink-0 px-1 text-muted hover:text-text"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
      {/* In the flow, not floating: a notice that stays until answered must not hide the CHAT bar. */}
      {orphans.map((orphan) => (
        <div
          key={orphan.chatId}
          role="status"
          aria-label="Unsent draft"
          className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-text"
        >
          <span className="min-w-0 flex-1">
            <span className="text-attention">⚠</span> “{orphan.title}” was closed elsewhere — its
            unsent draft is kept here.
          </span>
          <button
            type="button"
            onClick={() => {
              moveComposer(orphan.chatId, activeChatId);
              dropOrphan(orphan.chatId);
            }}
            className="rounded border border-accent px-2 py-0.5 text-accent hover:bg-accent-soft"
          >
            put it in this tab
          </button>
          <button
            type="button"
            onClick={() => dropOrphan(orphan.chatId)}
            aria-label="Dismiss"
            className="shrink-0 px-1 text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      ))}
      {active && active.subagentsLeftRunning > 0 && (
        <p className="text-muted">
          {active.subagentsLeftRunning} subagent{active.subagentsLeftRunning === 1 ? '' : 's'} still
          running in sessions this tab switched away from
        </p>
      )}
    </div>
  );
}
