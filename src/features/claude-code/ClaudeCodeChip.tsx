import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useClickOutside } from '@features/chat/useClickOutside.ts';
import { claudeChip } from './claude-chip.ts';
import { ClaudeCodePopover } from './ClaudeCodePopover.tsx';
import { useClaudeStatus } from './useClaudeStatus.ts';

/**
 * The status-bar chip for Claude Code: plan and quota at a glance, a popover
 * with the detail on click. Renders nothing (separator included) until the
 * sidecar has answered. A missing `claude` is a quiet dim note rather than a
 * hidden chip, so a misconfigured CLAUDE_BIN is not silently invisible, and
 * it has no popover because there is nothing to show.
 */
export function ClaudeCodeChip({ connected }: { connected: boolean }) {
  const { status, refreshing, refresh } = useClaudeStatus(connected);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useClickOutside(wrapper, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!status) return null;
  const chip = claudeChip(status);

  return (
    <>
      <span className="text-faint">|</span>
      {chip.interactive ? (
        <div ref={wrapper} className="relative">
          <button
            ref={button}
            type="button"
            aria-expanded={open}
            aria-haspopup="dialog"
            title={chip.tooltip}
            onClick={() => setOpen((value) => !value)}
            className={clsx(chip.tone === 'attention' ? 'text-attention' : 'text-muted hover:text-text')}
          >
            {chip.label}
          </button>
          {open && <ClaudeCodePopover status={status} refreshing={refreshing} onRefresh={() => void refresh()} />}
        </div>
      ) : (
        <span className="text-muted" title={chip.tooltip}>
          {chip.label}
        </span>
      )}
    </>
  );
}
