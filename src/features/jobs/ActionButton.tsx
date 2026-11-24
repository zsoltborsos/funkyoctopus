/** Small outlined action button; disabled while any action is in flight. `expanded` marks a disclosure toggle. */
export function ActionButton({ name, color, disabled, onClick, expanded }: {
  name: string;
  color: 'accent' | 'danger' | 'danger-solid' | 'muted';
  disabled: boolean;
  onClick: () => void;
  expanded?: boolean;
}) {
  const styles = {
    accent: 'border-accent text-accent',
    danger: 'border-danger text-danger',
    'danger-solid': 'border-danger bg-danger/10 text-danger',
    muted: 'border-border text-muted',
  } as const;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      // An open disclosure reads brighter than a closed one, not only to a screen reader.
      className={`rounded border px-2 py-1 text-xs ${styles[color]} aria-expanded:border-text aria-expanded:text-text disabled:opacity-40`}
    >
      {name}
    </button>
  );
}
