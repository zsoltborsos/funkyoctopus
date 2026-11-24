import { useId } from 'react';
import type { HelmraiserUsageWindow } from '@shared/transport/protocol.ts';

/** A fraction as a CSS percentage, to a tenth of a percent. */
const pct = (fraction: number): string => `${+(fraction * 100).toFixed(1)}%`;

/**
 * One subscription window as a bar: an info fill to its `fraction`, an
 * attention marker where Helmraiser starts to warn, a danger one where it stops starting
 * work (when it has a stop line), and the whole-number percentage beside it.
 */
export function UsageBar({ label, usage, labelClassName = '' }: {
  label: string;
  usage: HelmraiserUsageWindow;
  /** Lets a list of bars give every label one width, so the bars line up. */
  labelClassName?: string;
}) {
  const labelId = useId();
  const percent = Math.round(usage.fraction * 100);
  const lines = [`${percent}%`, `warn at ${Math.round(usage.warn_at * 100)}%`];
  if (usage.stop_at !== null) lines.push(`stop at ${Math.round(usage.stop_at * 100)}%`);
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className={`text-muted ${labelClassName}`}>{label}</span>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={lines.join(', ')}
        className="relative h-2 w-24 overflow-hidden rounded-sm bg-border"
      >
        <span data-fill className="absolute inset-y-0 left-0 bg-info" style={{ width: pct(Math.min(usage.fraction, 1)) }} />
        <span data-marker="warn" className="absolute inset-y-0 w-px bg-attention" style={{ left: pct(usage.warn_at) }} />
        {usage.stop_at !== null && (
          <span data-marker="stop" className="absolute inset-y-0 w-px bg-danger" style={{ left: pct(usage.stop_at) }} />
        )}
      </div>
      <span>{percent}%</span>
    </div>
  );
}
