import { clsx } from 'clsx';
import { CHAT_SHORTCUTS } from '@features/chat/shortcuts.ts';
import { usePreferences } from './usePreferences.ts';
import type { SidebarPosition } from './preferences.types.ts';
import { THEMES } from './themes.ts';

/**
 * SettingsPanel — a thin view over PreferencesService: it reads via the hook
 * and writes via `update`, holding no state of its own. Every control here is
 * wired to a visible effect (font size scales the UI, the theme recolours it,
 * sidebar docks the rail, timestamps toggle in chat) — nothing decorative.
 */
export function SettingsPanel() {
  const { preferences, update } = usePreferences();
  const theme = THEMES.find((t) => t.id === preferences.theme) ?? THEMES[0];

  /** Disabling is immediate; enabling first asks for notification permission. */
  const handleNotificationPreference = (
    key: 'notifyHelmraiser' | 'notifyChat',
    value: boolean,
  ): void => {
    if (!value) {
      update({ [key]: false });
      return;
    }
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      update({ [key]: true });
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === 'granted') update({ [key]: true });
    });
  };

  return (
    <section className="h-full min-h-0 w-full overflow-y-auto rounded-lg border border-border bg-surface/40 p-6 font-mono text-text">
      <header className="mb-6 border-b border-border pb-3">
        <h2 className="text-sm tracking-widest text-accent">SETTINGS</h2>
        <p className="mt-1 text-xs text-muted">cockpit · local · persisted</p>
      </header>

      <div className="flex flex-col gap-6">
        <Row label={`Font size — ${preferences.fontSize}px`}>
          <input
            type="range"
            min={16}
            max={28}
            value={preferences.fontSize}
            aria-label="Font size"
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
            className="accent-accent"
          />
        </Row>

        <Row label={`Theme — ${theme.note}`}>
          <Segmented
            options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
            value={preferences.theme}
            onChange={(v) => update({ theme: v })}
          />
        </Row>

        <Row label="Show timestamps">
          <Toggle
            checked={preferences.showTimestamps}
            onChange={(v) => update({ showTimestamps: v })}
            ariaLabel="Show timestamps"
          />
        </Row>

        <Row label="Expand tool steps by default">
          <Toggle
            checked={preferences.toolStepsDefaultOpen}
            onChange={(value) => update({ toolStepsDefaultOpen: value })}
            ariaLabel="Expand tool steps by default"
          />
        </Row>

        <Row label="Notify me about Helmraiser runs">
          <Toggle
            checked={preferences.notifyHelmraiser}
            onChange={(value) => handleNotificationPreference('notifyHelmraiser', value)}
            ariaLabel="Notify me about Helmraiser runs"
          />
        </Row>

        <Row label="Notify me when chat work finishes">
          <Toggle
            checked={preferences.notifyChat}
            onChange={(value) => handleNotificationPreference('notifyChat', value)}
            ariaLabel="Notify me when chat work finishes"
          />
        </Row>

        <Row label="Menu side">
          <Segmented
            options={SIDEBAR_OPTIONS}
            value={preferences.sidebarPosition}
            onChange={(v) => update({ sidebarPosition: v })}
          />
        </Row>

        {/* Read-only: the table the chat composer binds, shown so the shortcuts
            are discoverable without being memorised. */}
        <section aria-labelledby="settings-shortcuts" className="border-t border-border pt-4">
          <h3 id="settings-shortcuts" className="mb-2 text-xs tracking-widest text-muted">
            CHAT SHORTCUTS
          </h3>
          <dl className="grid grid-cols-[max-content_minmax(0,28rem)] gap-x-6 gap-y-1.5 text-xs">
            {CHAT_SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt className="whitespace-nowrap text-accent">{s.keys}</dt>
                <dd className="text-muted">{s.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-6 w-11 rounded-full border transition-colors',
        checked
          ? 'border-accent bg-accent-soft'
          : 'border-border bg-surface-raised',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-4 w-4 rounded-full transition-all',
          checked ? 'left-6 bg-accent' : 'left-1 bg-muted',
        )}
      />
    </button>
  );
}

const SIDEBAR_OPTIONS: { value: SidebarPosition; label: string }[] = [
  { value: 'left', label: 'left' },
  { value: 'right', label: 'right' },
];

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'px-3 py-1 text-xs uppercase transition-colors',
            value === option.value
              ? 'bg-accent-soft text-accent'
              : 'text-muted hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
