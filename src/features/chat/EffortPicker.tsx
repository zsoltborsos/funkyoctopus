import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useClickOutside } from './useClickOutside.ts';

interface EffortPickerProps {
  /** Effort levels the current model supports; empty disables the control. */
  levels: string[];
  selected: string | null;
  onSelect: (effort: string) => void;
}

/**
 * The composer's effort/thinking-level dropdown, scoped to whatever the selected
 * model supports (pi's ladder). Disabled when the model has no reasoning knob —
 * so the control always reflects a real, per-message choice.
 */
export function EffortPicker({ levels, selected, onSelect }: EffortPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  const disabled = levels.length === 0;
  const label = selected && levels.includes(selected) ? selected : 'auto';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label="Select effort"
        className={clsx(
          'flex items-center gap-2 rounded border border-border px-3 py-1.5 font-mono text-sm',
          disabled
            ? 'text-muted opacity-50'
            : 'bg-bg text-text hover:border-accent',
        )}
      >
        <span className="text-muted">effort</span>
        <span className="text-info">{disabled ? '—' : label}</span>
        {!disabled && <span className="text-muted">▾</span>}
      </button>

      {open && !disabled && (
        <div className="absolute bottom-full z-10 mb-1 w-40 overflow-hidden rounded border border-border bg-surface p-1 shadow-glow-accent">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                onSelect(level);
                setOpen(false);
              }}
              className={clsx(
                'block w-full rounded px-2 py-1 text-left font-mono text-sm',
                level === selected
                  ? 'bg-accent-soft text-accent'
                  : 'text-text hover:bg-bg',
              )}
            >
              {level}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
