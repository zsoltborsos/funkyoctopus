import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import type { ChatCommand, ChatCommandsResult } from '@shared/transport/protocol.ts';
import { SLASH_LIST_ID, SOURCE_LABEL, slashOptionId } from './slash-commands.ts';

/**
 * The `/` palette over the composer: the shown tab's commands that match what
 * follows the `/`. It never takes focus; the composer drives it (↑↓ move,
 * Enter or Tab pick, Esc close) and a click picks.
 */
export function SlashPalette({
  list,
  query,
  matches,
  selected,
  onHover,
  onPick,
}: {
  /** Null while the first read is on its way. */
  list: ChatCommandsResult | null;
  query: string;
  matches: ChatCommand[];
  selected: number;
  onHover: (index: number) => void;
  onPick: (command: ChatCommand) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The highlighted row stays in view as the arrows walk a long list.
  useEffect(() => {
    const row = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row && 'scrollIntoView' in row) row.scrollIntoView({ block: 'nearest' });
  }, [selected, matches]);

  let empty: string | null = null;
  if (list === null) empty = 'reading this chat’s commands…';
  else if (list.state === 'none') {
    empty = 'Claude lists its commands once this tab’s process runs — send a message first';
  } else if (matches.length === 0) {
    empty = `no command matches /${query} — Enter sends it as a message`;
  }

  return (
    <div
      ref={panel}
      className="absolute inset-x-0 bottom-full z-20 mb-1 flex max-h-72 flex-col rounded border border-border bg-surface font-mono text-xs shadow-glow-accent"
    >
      {empty ? (
        <p role="status" className="px-3 py-2 text-muted">
          {empty}
        </p>
      ) : (
        <div id={SLASH_LIST_ID} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1">
          {matches.map((command, index) => (
            <div
              key={`${command.source}:${command.name}`}
              id={slashOptionId(index)}
              role="option"
              aria-selected={index === selected}
              // Keeps the composer's focus (and caret) on a click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => onHover(index)}
              onClick={() => onPick(command)}
              className={clsx(
                'flex cursor-pointer items-baseline gap-2 rounded border px-2 py-1',
                index === selected ? 'border-accent/50 bg-accent-soft' : 'border-transparent',
              )}
            >
              <span className="shrink-0 text-sm text-accent">/{command.name}</span>
              {command.argumentHint && <span className="shrink-0 text-text/70">{command.argumentHint}</span>}
              <span className="min-w-0 flex-1 truncate text-muted" title={command.description}>
                {command.description}
              </span>
              <span
                className={clsx(
                  'shrink-0 rounded border px-1 text-[0.7rem]',
                  // Neutral, so special keeps its one meaning; on the selected row the outline stays visible.
                  index === selected ? 'border-accent/40 text-muted' : 'border-border text-muted',
                )}
              >
                {SOURCE_LABEL[command.source]}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-border px-3 py-1 text-[0.7rem] text-muted">
        {empty ? 'Esc close' : '↑↓ move · Enter or Tab pick · Esc close'}
        {list?.state === 'last-known' && ' · last known list: this tab’s Claude process is not running'}
      </div>
    </div>
  );
}
