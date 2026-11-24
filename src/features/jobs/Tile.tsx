import type { ReactNode } from 'react';

/** A label, its figure, a dim line under it, and optionally a smaller dim line saying what the figure counts. */
export function Tile({ label, sub, caption, children }: {
  label: string;
  sub?: string | undefined;
  caption?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-border p-3">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-1 text-xl">{children}</dd>
      {sub !== undefined && <dd className="mt-1 text-muted">{sub}</dd>}
      {caption !== undefined && <dd className="mt-1 text-[11px] text-muted">{caption}</dd>}
    </div>
  );
}
