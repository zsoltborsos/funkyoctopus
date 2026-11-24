import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useNow } from '@core/clock/useNow.ts';
import { useService } from '@core/container/useService.ts';
import { useTabFolder } from '@features/chat/useTabFolder.ts';
import type { ClaudeRecentSession, ClaudeStatusResult, ClaudeUsageLimit } from '@shared/transport/protocol.ts';
import { CLAUDE_CODE } from './claude-code.client.ts';
import { NEAR_LIMIT_PERCENT, folderName, formatAgo, formatReset, signInMethod } from './claude-chip.ts';

const RELATIVE_TIME_TICK_MS = 30_000;

type Recent = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: ClaudeRecentSession[] };

interface ClaudeCodePopoverProps {
  status: ClaudeStatusResult;
  refreshing: boolean;
  onRefresh: () => void;
}

function Meter({ limit, now }: { limit: ClaudeUsageLimit; now: number }) {
  const percent = Math.round(limit.percent);
  const near = percent >= NEAR_LIMIT_PERCENT;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex justify-between text-text">
        <span>{limit.label}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="meter"
        aria-label={limit.label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded bg-border"
      >
        <div
          className={clsx('h-full', near ? 'bg-attention' : 'bg-ok')}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      {limit.resetsAt !== null && <span className="text-muted">resets {formatReset(limit.resetsAt, now)}</span>}
    </li>
  );
}

/**
 * The status-bar chip's read-only detail: how Claude is signed in, quota bars
 * (a subscription only), the sessions running now, and this project's recent ones. Mounted only while open, so the recent
 * list is fetched on open and never in the background. Nothing in it opens or
 * resumes a session.
 */
export function ClaudeCodePopover({ status, refreshing, onRefresh }: ClaudeCodePopoverProps) {
  const claude = useService(CLAUDE_CODE);
  const root = useTabFolder().folder?.path ?? null;
  // An answer counts only for the folder it was asked about; another folder shows loading.
  const [answer, setAnswer] = useState<{ root: string | null; recent: Recent } | null>(null);
  const recent: Recent = answer?.root === root ? answer.recent : { state: 'loading' };
  // Reset times and ages are minute-grained.
  const now = useNow(RELATIVE_TIME_TICK_MS);
  const usage = status.usage;
  const method = status.auth ? signInMethod(status.auth) : null;

  useEffect(() => {
    let active = true;
    claude
      .sessions(root)
      .then((rows) => {
        if (active) setAnswer({ root, recent: { state: 'ready', rows } });
      })
      .catch((error: unknown) => {
        if (active) setAnswer({ root, recent: { state: 'error', message: error instanceof Error ? error.message : 'Could not list recent sessions' } });
      });
    return () => {
      active = false;
    };
  }, [claude, root]);

  return (
    <div
      role="dialog"
      aria-label="Claude"
      className="absolute bottom-full left-0 z-20 mb-2 flex max-h-[calc(100vh-4rem)] w-96 max-w-[90vw] flex-col gap-3 overflow-y-auto rounded border border-border bg-surface p-3 text-xs shadow-lg"
    >
      <header className="flex items-center justify-between">
        <h2 className="tracking-widest text-text">CLAUDE</h2>
        <button
          type="button"
          disabled={refreshing}
          onClick={onRefresh}
          className="rounded border border-border px-2 py-0.5 text-muted hover:text-text disabled:opacity-50"
        >
          refresh
        </button>
      </header>

      {method !== null && <p className="text-muted">signed in with {method}</p>}
      {status.error && <p className="text-attention">{status.error}</p>}

      {usage && 'limits' in usage && (
        <section className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {usage.limits.map((limit) => (
              <Meter key={`${limit.kind}:${limit.label}`} limit={limit} now={now} />
            ))}
          </ul>
          <span className="text-muted">read {formatAgo(usage.fetchedAt, now)}</span>
        </section>
      )}
      {usage && 'error' in usage && <p className="text-attention">{usage.error}</p>}

      <section className="flex flex-col gap-1">
        <h3 className="text-muted">
          live · <span className="text-accent">●</span> busy · <span>●</span> idle
        </h3>
        {status.live.length === 0 ? (
          <p className="text-muted">nothing running</p>
        ) : (
          <ul aria-label="live sessions" className="flex flex-col gap-1">
            {status.live.map((session) => (
              <li key={session.sessionId} className="flex items-center gap-2">
                <span
                  role="img"
                  aria-label={session.status}
                  title={session.status}
                  className={clsx(
                    'inline-block h-2 w-2 shrink-0 rounded-full',
                    session.status === 'busy' ? 'bg-accent' : 'bg-muted',
                  )}
                />
                <span className="truncate text-text">{session.name}</span>
                <span className="truncate text-muted" title={session.cwd}>{folderName(session.cwd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-muted">{root === null ? 'recent' : 'recent here'}</h3>
        {recent.state === 'loading' && <p className="text-muted">…</p>}
        {recent.state === 'error' && <p className="text-attention">{recent.message}</p>}
        {recent.state === 'ready' && recent.rows.length === 0 && <p className="text-muted">none yet</p>}
        {recent.state === 'ready' && recent.rows.length > 0 && (
          <ul aria-label="recent sessions" className="flex flex-col gap-1">
            {recent.rows.map((row) => (
              <li key={row.sessionId} className="flex items-baseline gap-2">
                <span className="truncate text-text">{row.title || '(untitled)'}</span>
                {row.gitBranch && <span className="shrink-0 text-muted">{row.gitBranch}</span>}
                <span className="ml-auto shrink-0 text-muted">{formatAgo(row.lastModified, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
