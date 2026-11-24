import { useRef, useState, type ReactNode } from 'react';
import type { HumaneError } from '@core/transport/humane-error.ts';
import { NotInstalled } from '@core/transport/NotInstalled.tsx';
import type {
  EngineKind,
  LeeboardAsked,
  LeeboardBrief,
  LeeboardEntry,
  LeeboardRepoFile,
  LeeboardReview,
  LeeboardReviewRow,
  LeeboardRouted,
} from '@shared/transport/protocol.ts';
import { useLeeboard, useLeeboardEntry } from './useLeeboard.ts';
import { useTakeIt, type UseTakeIt } from './useTakeIt.ts';
import { Prose } from '../MessageView.tsx';
import { useClickOutside } from '../useClickOutside.ts';

/**
 * An owner inbox for requests and handoffs (with routing), holds across
 * every project, and the owner digest: a narrow spine plus a detail pane,
 * read through the CLI. Read-only: FO owns no memory (non-goal 7).
 *
 * Attention hold borders identify applicability to this tab, as decided by
 * Leeboard's brief. Elsewhere holds have dim borders. A missing `lb` is not a
 * fault: Leeboard is optional, so the panel says it is not installed, dim; a
 * waiting inbox, or a reply to this tab, is bright.
 *
 * The inbox also routes work (T3 L5): "take it" prefills the composer of the
 * tab that should do it — this one, the open tab of the entry's project or
 * session, or a new tab in the project's folder — and never sends.
 */

type TabId = 'inbox' | 'holds' | 'digest';

interface Tab {
  id: TabId;
  glyph: string;
  label: string;
  hint: string;
  /** Null until there is an honest number to show. */
  count: number | null;
  /** The count is something waiting on you. */
  attention?: boolean;
  /** Something is here to read (a waiting inbox): bright, so it differs from a zero. */
  waiting?: boolean;
  /** Requests from this tab that came back answered: a quiet marker beside the count. */
  replied?: number;
}

export function LeeboardPanel() {
  const { brief, briefError, review, reviewError, open: routed, openError, asked, askedError, holds, holdsError, loading, refresh } = useLeeboard();
  const takeIt = useTakeIt();
  const [open, setOpen] = useState<TabId | null>(null);
  // An entry opened from any tab reads over it; "← back" returns to the tab.
  const [reading, setReading] = useState<string | null>(null);
  const toggle = (tab: TabId) => {
    setOpen((current) => (current === tab ? null : tab));
    setReading(null);
  };

  const where = brief ? placeOf(brief) : null;
  const inbox = brief ? sortInbox(brief, routed ?? [], takeIt.chatId) : null;
  const replied = (asked ?? []).filter((request) => request.replied).length;
  const displayedHolds = holds ?? brief?.holds ?? null;
  const applicableIds = new Set(brief?.holds.map((hold) => hold.id));
  const applicableCount = displayedHolds?.filter((hold) => applicableIds.has(hold.id)).length ?? 0;
  const tabs: Tab[] = [
    {
      id: 'inbox',
      // One glyph, one meaning across the cockpit: none of these is the
      // shell's (›_ ⧉ ❯ ⚙) or a transcript tool icon.
      glyph: '↧',
      label: 'Inbox',
      hint: `Inbox — handoffs and requests addressed here${replied ? ` · ${replied} replied to this tab` : ''}`,
      count: inbox ? inbox.here.length : null,
      waiting: (inbox?.here.length ?? 0) > 0 || replied > 0,
      replied,
    },
    {
      id: 'holds',
      glyph: '⊘',
      label: 'Holds',
      hint: displayedHolds
        ? brief
          ? `Holds — ${applicableCount} ${applicableCount === 1 ? 'applies' : 'apply'} here · ${displayedHolds.length - applicableCount} elsewhere`
          : `Holds — ${displayedHolds.length} active · applicability unknown without the brief`
        : 'Holds — active holds across every scope',
      count: displayedHolds?.length ?? null,
      attention: applicableCount > 0,
    },
    {
      id: 'digest',
      glyph: 'Δ',
      label: 'Digest',
      hint: 'Digest — what changed in Leeboard since the owner last reviewed (peek only)',
      count: review ? review.new.length + review.changed.length + review.closed.length : null,
    },
  ];
  const shown = tabs.find((t) => t.id === open);

  return (
    <>
      {shown && (
        <aside
          aria-label="Leeboard detail"
          className="flex w-[34rem] min-w-0 flex-col rounded-lg border border-border bg-surface/40"
        >
          <header className="flex items-center gap-3 border-b border-border px-4 py-2.5 font-mono text-sm tracking-widest text-accent">
            <span className="shrink-0">{shown.label.toUpperCase()}</span>
            {where && (
              <span className="min-w-0 truncate text-xs font-normal tracking-normal text-muted" title={where}>
                {where}
              </span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setOpen(null)}
              aria-label="Close Leeboard detail"
              className="font-mono text-xs tracking-normal text-muted hover:text-text"
            >
              ✕
            </button>
          </header>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {reading ? (
              <EntryView id={reading} onBack={() => setReading(null)} />
            ) : shown.id === 'digest' ? (
              <DigestTab review={review} error={reviewError} loading={loading} takeIt={takeIt} onOpen={setReading} />
            ) : shown.id === 'holds' && displayedHolds !== null ? (
              <div className="flex flex-col gap-4">
                {brief ? <Context brief={brief} /> : (
                  <>
                    {briefError && <LeeboardFault error={briefError} />}
                    <Dim>Applicability to this tab is unknown without its brief.</Dim>
                  </>
                )}
                <HoldsTab holds={displayedHolds} applicableIds={applicableIds} error={holdsError} onOpen={setReading} />
              </div>
            ) : !brief ? (
              loading ? <Dim>reading the Leeboard brief…</Dim> : <LeeboardFault error={briefError} />
            ) : (
              <div className="flex flex-col gap-4">
                <Context brief={brief} />
                {shown.id === 'inbox' && inbox && (
                  <InboxTab
                    inbox={inbox}
                    asked={asked}
                    errors={[openError, askedError]}
                    takeIt={takeIt}
                    onOpen={setReading}
                  />
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      <nav
        aria-label="Leeboard"
        className="flex w-[4.75rem] shrink-0 flex-col items-center gap-1 rounded-lg border border-border bg-surface/40 px-1 py-3"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-label={tab.label}
            aria-pressed={open === tab.id}
            title={where ? `${tab.hint} · ${where}` : tab.hint}
            onClick={() => toggle(tab.id)}
            className={`flex w-full flex-col items-center gap-0.5 rounded border py-1.5 font-mono ${
              open === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:border-border hover:text-text'
            }`}
          >
            <span className="text-base leading-none">{tab.glyph}</span>
            <span
              className={`text-xs leading-none ${
                tab.attention ? 'text-attention' : tab.waiting ? 'font-bold text-text' : ''
              }`}
            >
              {tab.count === null ? '—' : tab.count}
              {tab.replied ? <span title={`${tab.replied} replied`}> ↩</span> : null}
            </span>
            <span className="text-[0.7rem] leading-none tracking-wide">{tab.label.toLowerCase()}</span>
          </button>
        ))}
        <div className="flex-1" />
        {/* A fault on the spine, so a closed panel still says it could not read lb. */}
        {briefError && !brief && (
          <span
            className={`font-mono text-[0.6rem] ${briefError.unavailable ? 'text-muted' : 'text-danger'}`}
            title={briefError.message}
          >
            no lb
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh Leeboard"
          title="Ask lb again"
          className="flex w-full flex-col items-center gap-0.5 rounded border border-transparent py-1.5 font-mono text-muted hover:border-border hover:text-text disabled:opacity-50"
        >
          <span className="text-base leading-none">↻</span>
          <span className="text-[0.6rem] leading-none tracking-wide">{loading ? 'reading' : 'refresh'}</span>
        </button>
      </nav>
    </>
  );
}

function placeOf(brief: LeeboardBrief): string {
  return brief.project ? `project ${brief.project}` : 'Global — no project';
}

function Dim({ children }: { children: ReactNode }) {
  return <p className="font-mono text-sm text-muted">{children}</p>;
}

/** `lb` could not answer. A missing CLI is not a fault (Leeboard is optional); anything else is. */
function LeeboardFault({ error }: { error: HumaneError | null }) {
  if (error?.unavailable) return <NotInstalled tool="leeboard" />;
  return (
    <p className="font-mono text-sm text-danger">
      could not read Leeboard{error ? ` — ${error.message}` : ''}. chat is unaffected.
    </p>
  );
}

/** Where the brief is from, and how stale the repo's state files are, in two dim lines at most. */
function Context({ brief }: { brief: LeeboardBrief }) {
  if (!brief.unregisteredRepo && brief.repoState.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 font-mono text-xs text-muted">
      {brief.unregisteredRepo && (
        <p className="break-words">
          unregistered repo {brief.unregisteredRepo} — <code>lb project add</code> registers it
        </p>
      )}
      {brief.repoState.length > 0 && (
        <p className="break-words">last commit: {brief.repoState.map(describeRepoFile).join(' · ')}</p>
      )}
    </div>
  );
}

function describeRepoFile(file: LeeboardRepoFile): string {
  if (file.lastCommit === null) return `${file.path} not committed`;
  const age = file.daysAgo === undefined ? file.lastCommit : `${file.daysAgo}d ago`;
  return file.commitsSince ? `${file.path} ${age}, ${file.commitsSince} commits since` : `${file.path} ${age}`;
}

/** The inbox split by where each entry belongs: this tab, or another tab (open or not yet). */
interface SortedInbox {
  here: LeeboardEntry[];
  elsewhere: LeeboardRouted[];
}

/**
 * Here: the brief's inbox (this project, FunkyOctopus, anyone) plus what is
 * routed to this tab's session. Elsewhere: another project's entries, and a
 * session's held by another open tab. A session no open tab holds is left to
 * that session's own `lb brief`.
 */
function sortInbox(brief: LeeboardBrief, routed: LeeboardRouted[], chatId: string): SortedInbox {
  const here: LeeboardEntry[] = [...brief.inbox];
  const elsewhere: LeeboardRouted[] = [];
  for (const row of routed) {
    if (here.some((entry) => entry.id === row.id)) continue;
    if (row.chatId === chatId) here.push(row);
    else if (row.to?.startsWith('project:') ? row.to !== `project:${brief.project}` : row.chatId !== null) elsewhere.push(row);
  }
  return { here, elsewhere };
}

const projectOf = (entry: LeeboardEntry): string | null =>
  entry.to?.startsWith('project:') ? entry.to.slice('project:'.length) : null;

function InboxTab({
  inbox,
  asked,
  errors,
  takeIt,
  onOpen,
}: {
  inbox: SortedInbox;
  asked: LeeboardAsked[] | null;
  errors: (HumaneError | null)[];
  takeIt: UseTakeIt;
  onOpen: (id: string) => void;
}) {
  const busy = takeIt.pending !== null;
  // A request this tab asked is listed once, under "Asked from this tab", with its routing there.
  const elsewhere = inbox.elsewhere.filter((row) => !asked?.some((request) => request.id === row.id));
  return (
    <div className="flex flex-col gap-4">
      {takeIt.error && (
        <p role="alert" className="font-mono text-xs text-danger">
          could not take it — {takeIt.error}
        </p>
      )}
      {errors.map(
        (error, index) =>
          error && (
            <p key={index} className="font-mono text-xs text-danger">
              {index === 0 ? 'could not list open requests' : 'could not list what this tab asked'} — {error.message}
            </p>
          ),
      )}
      <section className="flex flex-col gap-1.5">
        <Heading title="Addressed here" count={inbox.here.length} />
        {inbox.here.length === 0 ? (
          <Dim>Inbox empty — no handoffs or requests addressed here.</Dim>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {inbox.here.map((item) => (
              <li key={item.id}>
                <RoutedRow entry={item} onOpen={onOpen}>
                  <Action disabled={busy} onClick={() => takeIt.take(item)}>
                    {takeIt.pending === item.id ? 'taking…' : 'take it'}
                  </Action>
                </RoutedRow>
              </li>
            ))}
          </ul>
        )}
      </section>
      {asked && asked.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Heading title="Asked from this tab" count={asked.length} />
          <ul className="flex flex-col gap-1.5">
            {asked.map((request) => {
              // Still open and routable: send it on from here (it is not repeated under Elsewhere).
              const route = request.replied ? undefined : inbox.elsewhere.find((row) => row.id === request.id);
              return (
                <li key={request.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <EntryRow
                      entry={request}
                      onOpen={onOpen}
                      badge={request.replied ? 'replied' : null}
                      meta={`→ ${request.to ?? 'any'} · ${request.replied ? 'open it to read the reply' : request.status === 'active' ? 'waiting' : request.status}`}
                    />
                  </div>
                  {route && (
                    <div className={ACTIONS}>
                      <RouteAction row={route} takeIt={takeIt} busy={busy} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {elsewhere.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Heading title="Elsewhere" count={elsewhere.length} />
          <ul className="flex flex-col gap-1.5">
            {elsewhere.map((row) => (
              <li key={row.id}>
                <RoutedRow entry={row} onOpen={onOpen}>
                  <RouteAction row={row} takeIt={takeIt} busy={busy} />
                </RoutedRow>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Fixed width, so the cards beside the actions end on one line whatever the button says. */
const ACTIONS = 'flex min-w-[9.5rem] shrink-0 justify-end pt-2';

/** Where an entry for another tab goes from here: its open tab, else a new one in its project's folder. */
function RouteAction({ row, takeIt, busy }: { row: LeeboardRouted; takeIt: UseTakeIt; busy: boolean }) {
  const project = projectOf(row);
  if (row.chatId !== null) {
    return (
      <Action disabled={busy} onClick={() => takeIt.goTo(row, row.chatId!)}>
        {takeIt.pending === row.id ? 'opening…' : project ? `go to ${project} tab` : 'go to its tab'}
      </Action>
    );
  }
  if (project && row.folder) {
    return (
      <OpenTabMenu
        label={`open a ${project} tab`}
        disabled={busy}
        pending={takeIt.pending === row.id}
        onPick={(kind) => takeIt.openTab(row, project, row.folder!, kind)}
      />
    );
  }
  return <span className="font-mono text-xs text-muted">no folder for {project ?? 'it'}</span>;
}

function Heading({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="font-mono text-xs uppercase tracking-widest text-accent">
      {title} <span className="text-muted">{count}</span>
    </h3>
  );
}

/** An inbox entry (it opens to read) with what can be done with it beside it. */
function RoutedRow({
  entry,
  onOpen,
  children,
}: {
  entry: LeeboardEntry;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  const from = entry.harness ? ` · from ${entry.harness}` : '';
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <EntryRow entry={entry} onOpen={onOpen} meta={`${entry.kind} → ${entry.to ?? 'any'}${from}`} />
      </div>
      <div className={ACTIONS}>{children}</div>
    </div>
  );
}

function Action({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="whitespace-nowrap rounded border border-accent/60 px-2 py-1 font-mono text-xs text-accent hover:border-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

const ENGINE_CHOICES: [EngineKind, string, string][] = [
  ['pi', 'π', 'text-accent'],
  ['claude-code', '✻', 'text-special'],
];

/** Shared engine picker: the owner's choice, as from the tab bar's "＋ ▾". */
function OpenTabMenu({
  label,
  disabled,
  pending,
  onPick,
}: {
  label: string;
  disabled: boolean;
  pending: boolean;
  onPick: (kind: EngineKind) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useClickOutside(menu, () => setMenuOpen(false));
  return (
    <div ref={menu} className="relative">
      <Action disabled={disabled} onClick={() => setMenuOpen((shown) => !shown)}>
        {pending ? 'opening…' : `${label} ▾`}
      </Action>
      {menuOpen && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded border border-border bg-surface p-1 shadow-glow-accent"
        >
          {ENGINE_CHOICES.map(([kind, glyph, tone]) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onPick(kind);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-sm text-text hover:bg-accent-soft"
            >
              <span aria-hidden="true" className={`shrink-0 font-bold ${tone}`}>
                {glyph}
              </span>
              {kind === 'pi' ? 'pi' : 'Claude'} tab
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HoldsTab({ holds, applicableIds, error, onOpen }: {
  holds: LeeboardEntry[];
  applicableIds: Set<string>;
  error: HumaneError | null;
  onOpen: (id: string) => void;
}) {
  const applicable = holds.filter((hold) => applicableIds.has(hold.id));
  const elsewhere = new Map<string, LeeboardEntry[]>();
  for (const hold of holds) {
    if (applicableIds.has(hold.id)) continue;
    const group = elsewhere.get(hold.scope) ?? [];
    group.push(hold);
    elsewhere.set(hold.scope, group);
  }
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="font-mono text-xs text-danger">could not list active holds — {error.message}</p>
      )}
      {holds.length === 0 && <Dim>No active holds.</Dim>}
      {applicable.length > 0 && (
        <section className="flex flex-col gap-2">
          <Heading title="Applies here" count={applicable.length} />
          <HoldList holds={applicable} applicable onOpen={onOpen} />
        </section>
      )}
      {[...elsewhere].map(([scope, rows]) => (
        <section key={scope} className="flex flex-col gap-2">
          <Heading title={scope.startsWith('project:') ? scope.slice('project:'.length) : scope} count={rows.length} />
          <HoldList holds={rows} applicable={false} onOpen={onOpen} />
        </section>
      ))}
    </div>
  );
}

function HoldList({ holds, applicable, onOpen }: { holds: LeeboardEntry[]; applicable: boolean; onOpen: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {holds.map((hold) => (
        <li key={hold.id}>
          <button
            type="button"
            onClick={() => onOpen(hold.id)}
            className={`flex w-full flex-col gap-1 rounded border px-3 py-2 text-left font-mono ${
              applicable ? 'border-attention/60 hover:border-attention' : 'border-border hover:border-muted'
            }`}
          >
            <span className="break-words text-sm text-text">
              <span className={`mr-2 text-xs ${applicable ? 'text-attention' : 'text-muted'}`}>HOLD</span>
              {hold.title}
            </span>
            {hold.release && <span className="break-words text-xs text-text">release: {hold.release}</span>}
            {(hold.blocks?.length || hold.until) && (
              <span className="text-xs text-muted">
                {hold.blocks?.length ? `blocks ${hold.blocks.join(', ')}` : ''}
                {hold.blocks?.length && hold.until ? ' · ' : ''}
                {hold.until ? `until ${hold.until}` : ''}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function EntryRow({
  entry,
  meta,
  onOpen,
  compact = false,
  badge = null,
}: {
  entry: { id: string; title: string };
  meta: string | null;
  onOpen: (id: string) => void;
  compact?: boolean;
  /** A word before the title (an answered request's "replied"): bright, never attention. */
  badge?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.id)}
      className={`flex w-full flex-col rounded border text-left font-mono ${
        compact
          ? 'border-transparent px-2 py-0.5 hover:border-border'
          : 'gap-0.5 border-border px-3 py-2 hover:border-muted'
      }`}
    >
      {compact ? (
        // One line per entry where it fits: the title, then what qualifies it, dimmed.
        <span className="break-words text-sm text-text">
          {entry.title}
          {meta && <span className="ml-2 text-xs text-muted">{meta}</span>}
        </span>
      ) : (
        <>
          <span className="break-words text-sm text-text">
            {badge && <span className="mr-2 text-xs uppercase text-accent">{badge}</span>}
            {entry.title}
          </span>
          {meta && <span className="break-words text-xs text-muted">{meta}</span>}
        </>
      )}
    </button>
  );
}

function DigestTab({
  review,
  error,
  loading,
  takeIt,
  onOpen,
}: {
  review: LeeboardReview | null;
  error: HumaneError | null;
  loading: boolean;
  takeIt: UseTakeIt;
  onOpen: (id: string) => void;
}) {
  if (!review) return loading ? <Dim>reading the digest…</Dim> : <LeeboardFault error={error} />;
  const counts = { new: review.new.length, changed: review.changed.length, closed: review.closed.length };
  const groups: [string, LeeboardReviewRow[]][] = [
    ['New', review.new],
    ['Changed', review.changed],
    ['Closed', review.closed],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 font-mono text-xs text-muted">
          Since the owner last ran <code>lb review</code>. Peek only: reading it here marks nothing seen.
          {' '}The agent marks it seen only when you say so.
        </p>
        {!loading && !error && counts.new + counts.changed + counts.closed > 0 && (
          <div className="shrink-0">
            <OpenTabMenu
              label="review with an agent"
              disabled={takeIt.pending !== null}
              pending={takeIt.pending === 'digest'}
              onPick={(kind) => takeIt.reviewDigest(counts, kind)}
            />
          </div>
        )}
      </div>
      {takeIt.error && (
        <p role="alert" className="font-mono text-xs text-danger">
          could not open review — {takeIt.error}
        </p>
      )}
      {groups.every(([, rows]) => rows.length === 0) ? (
        <Dim>Nothing new since the last review.</Dim>
      ) : (
        groups.map(([title, rows]) =>
          rows.length === 0 ? (
            // Nothing to list: a count, not a disclosure that opens onto nothing.
            <p key={title} className="px-3 font-mono text-sm text-muted">
              {title} 0
            </p>
          ) : (
            <details key={title} className="rounded border border-border px-3 py-2">
              <summary className="cursor-pointer font-mono text-sm text-text marker:text-muted">
                {title} <span className="text-muted">{rows.length}</span>
              </summary>
              <ul className="mt-2 flex flex-col">
                {rows.map((row) => (
                  <li key={row.id}>
                    <EntryRow entry={row} onOpen={onOpen} meta={`${row.kind} · ${row.scope}${row.status === 'active' ? '' : ` · ${row.status}`}`} compact />
                  </li>
                ))}
              </ul>
            </details>
          ),
        )
      )}
    </div>
  );
}

/** One entry, read-only, its body as plain text: nothing in it is rendered as markup. */
function EntryView({ id, onBack }: { id: string; onBack: () => void }) {
  const { entry, error, loading } = useLeeboardEntry(id);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start font-mono text-xs text-muted hover:text-accent"
      >
        ← back
      </button>
      {loading ? (
        <Dim>reading the entry…</Dim>
      ) : !entry ? (
        <LeeboardFault error={error} />
      ) : (
        <article aria-label="Leeboard entry" className="flex flex-col gap-2">
          <h3 className="break-words font-mono text-sm text-text">
            {entry.kind === 'hold' && entry.status === 'active' && (
              <span className="mr-2 text-xs text-attention">HOLD</span>
            )}
            {entry.title}
          </h3>
          <p className="break-words font-mono text-xs text-muted">
            {[entry.kind, entry.scope, entry.status, entry.harness && `by ${entry.harness}`, entry.updated.slice(0, 10)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {entry.release && <p className="break-words font-mono text-xs text-text">release: {entry.release}</p>}
          {entry.to && <p className="font-mono text-xs text-muted">to {entry.to}</p>}
          {entry.holder && <p className="font-mono text-xs text-muted">holder: {entry.holder}</p>}
          {entry.body.trim() ? (
            <div className="md md-flat min-w-0 wrap-anywhere font-mono text-sm leading-relaxed text-text">
              <Prose text={entry.body} />
            </div>
          ) : (
            <p className="font-mono text-sm text-muted">(no body)</p>
          )}
          <p className="break-all font-mono text-xs text-muted">{entry.id}</p>
        </article>
      )}
    </div>
  );
}
