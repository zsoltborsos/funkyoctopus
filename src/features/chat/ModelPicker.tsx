import { useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { ModelOption } from '@shared/transport/protocol.ts';
import type { ModelRef } from '@features/settings/preferences.types.ts';
import { modelKey } from './models.client.ts';
import { useClickOutside } from './useClickOutside.ts';

interface ModelPickerProps {
  models: ModelOption[];
  selected: ModelRef | null;
  favorites: string[];
  onSelect: (ref: ModelRef) => void;
  onToggleFavorite: (key: string) => void;
}

/**
 * The composer's model dropdown: a starred-favourites section pinned above the
 * full list grouped by provider, so a big multi-provider catalogue stays
 * navigable and the daily drivers are one click away. Selection and favourites
 * are owned by preferences — this component only renders and reports intent.
 */
export function ModelPicker({
  models,
  selected,
  favorites,
  onSelect,
  onToggleFavorite,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const selectedKey = selected ? modelKey(selected.provider, selected.id) : null;
  const selectedName = useMemo(() => {
    if (!selected) {
      return 'default';
    }
    const match = models.find((m) => m.provider === selected.provider && m.id === selected.id);
    return match?.name ?? selected.id;
  }, [models, selected]);
  const selectedProvider = selected?.provider ?? null;

  const favoriteModels = useMemo(
    () => models.filter((m) => favSet.has(modelKey(m.provider, m.id))),
    [models, favSet],
  );
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  }, [models]);

  /**
   * `showProvider` is on wherever a row sits outside its provider group — the
   * favourites section — because the same model name can be served by several
   * providers and the name alone would not say which one is being picked.
   */
  const renderRow = (m: ModelOption, showProvider = false) => {
    const key = modelKey(m.provider, m.id);
    const active = key === selectedKey;
    const fav = favSet.has(key);
    return (
      <div
        key={key}
        className={clsx(
          'flex items-center gap-1 rounded px-2 py-1',
          active ? 'bg-accent-soft' : 'hover:bg-bg',
        )}
      >
        <button
          type="button"
          onClick={() => {
            onSelect({ provider: m.provider, id: m.id });
            setOpen(false);
          }}
          className={clsx(
            'flex-1 truncate text-left font-mono text-sm',
            active ? 'text-accent' : 'text-text',
          )}
        >
          {m.name}
          {showProvider && <span className="ml-2 text-xs text-muted">{m.provider}</span>}
        </button>
        <button
          type="button"
          onClick={() => onToggleFavorite(key)}
          aria-label={fav ? `Unfavorite ${m.name}` : `Favorite ${m.name}`}
          className={clsx(
            'shrink-0 px-1 text-sm',
            fav ? 'text-accent' : 'text-muted hover:text-accent',
          )}
        >
          {fav ? '★' : '☆'}
        </button>
      </div>
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Select model"
        className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text hover:border-accent"
      >
        <span className="text-muted">model</span>
        <span className="max-w-[18ch] truncate text-accent">{selectedName}</span>
        {selectedProvider && (
          <span className="max-w-[12ch] truncate text-xs text-muted">{selectedProvider}</span>
        )}
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-full z-10 mb-1 max-h-96 w-72 overflow-y-auto rounded border border-border bg-surface p-1 shadow-glow-accent">
          {favoriteModels.length > 0 && (
            <>
              <p className="px-2 py-1 font-mono text-xs tracking-widest text-muted">
                ★ FAVORITES
              </p>
              {favoriteModels.map((m) => renderRow(m, true))}
              <div className="my-1 border-t border-border" />
            </>
          )}
          {groups.map(([provider, list]) => (
            <div key={provider}>
              <p className="px-2 py-1 font-mono text-xs tracking-widest text-muted">
                {provider}
              </p>
              {list.map((m) => renderRow(m))}
            </div>
          ))}
          {models.length === 0 && (
            <p className="px-2 py-2 font-mono text-xs text-muted">no models available</p>
          )}
        </div>
      )}
    </div>
  );
}
