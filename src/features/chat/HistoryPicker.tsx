import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { ChatSessionInfo } from '@shared/transport/protocol.ts';
import { useClickOutside } from './useClickOutside.ts';
import { ago, folderOf } from './session-label.ts';

interface HistoryPickerProps {
  sessions: ChatSessionInfo[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

/** Linux home prefixes collapse to `~`; unrelated absolute paths stay whole. */
function homeAbbrev(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~');
}

/**
 * The chat-history dropdown: past conversations for the current root (or every
 * root in global mode), most recent first. Structure deliberately mirrors
 * `ModelPicker` — there is no reason for a second dropdown idiom in the same
 * composer.
 */
export function HistoryPicker({ sessions, activePath, onOpen }: HistoryPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Chat history"
        className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-muted hover:border-accent hover:text-text"
      >
        history
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 max-h-96 w-96 overflow-y-auto rounded border border-border bg-surface p-1 shadow-glow-accent">
          {sessions.map((session) => {
            const active = session.path === activePath;
            const gone = session.folderGone === true;
            return (
              <button
                key={session.path}
                type="button"
                onClick={() => {
                  onOpen(session.path);
                  setOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-sm',
                  active ? 'bg-accent-soft text-accent' : 'text-text hover:bg-bg',
                  // A row whose recorded folder is gone for good reads dimmer,
                  // but stays ordinary: opening it surfaces the sidecar's
                  // rejection through the chat error path.
                  gone && 'opacity-60',
                )}
              >
                <span className="flex flex-1 flex-col overflow-hidden">
                  <span className="truncate">{session.title}</span>
                  {/* Global mode spans every root, so the folder is the only way
                      to tell this project's chats from a sibling's. */}
                  <span className="truncate text-xs text-muted">
                    {folderOf(session.cwd)}
                    {session.movedFrom && ` · moved from ${homeAbbrev(session.movedFrom)}`}
                    {gone && ' · folder gone'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {session.messageCount !== undefined && `${session.messageCount} · `}
                  {ago(session.modified)}
                </span>
              </button>
            );
          })}
          {sessions.length === 0 && (
            <p className="px-2 py-2 font-mono text-xs text-muted">no past chats here</p>
          )}
        </div>
      )}
    </div>
  );
}
