import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { useShell } from '@core/shell/useShell.ts';
import { AWAY_DIGEST, relativeAwayTime } from './away-digest.ts';

export function AwayDigestCard({ onChat }: { onChat: () => void }) {
  const digest = useService(AWAY_DIGEST);
  const snapshot = useSyncExternalStore(digest.subscribe, digest.getSnapshot);
  const { setView } = useShell();
  if (!snapshot) return null;

  return (
    <aside
      aria-label="While you were away"
      className="mx-4 mt-4 rounded border border-border bg-bg/70 px-3 py-2.5"
    >
      <div className="mb-1.5 flex items-center gap-3">
        <h2 className="font-mono text-sm font-semibold text-text">While you were away</h2>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => digest.dismiss()}
          aria-label="Dismiss while you were away"
          title="Dismiss"
          className="px-1 font-mono text-sm text-muted hover:text-text"
        >
          ✕
        </button>
      </div>
      <ul className="space-y-0.5">
        {snapshot.entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => {
                if (entry.target === 'jobs') setView('jobs');
                else onChat();
              }}
              className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-surface"
            >
              <span className="w-14 shrink-0 font-mono text-xs text-muted">
                {relativeAwayTime(entry.at, snapshot.shownAt)}
              </span>
              <span
                className={`min-w-0 truncate text-sm ${entry.attention ? 'text-attention' : 'text-text'}`}
              >
                {entry.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {snapshot.overflow > 0 && (
        <p className="mt-1 pl-1 font-mono text-xs text-muted">
          and {snapshot.overflow} more
        </p>
      )}
    </aside>
  );
}
