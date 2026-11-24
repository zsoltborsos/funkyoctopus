import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';
import { token } from '@core/container/container.ts';
import { DEFAULT_PREFERENCES, type Preferences } from './preferences.types.ts';
import { isThemeId } from './themes.ts';

/** index.html reads `theme` from this key before first paint; keep them in step. */
export const STORAGE_KEY = 'funkyoctopus.preferences';

/**
 * PreferencesService — the source of truth for cockpit preferences.
 *
 * A deep module: three methods (`get`, `update`, `subscribe`) hide loading,
 * defaulting, merge-on-write, persistence and change notification. Callers
 * never see the storage key, the adapter, or how defaults fill gaps from an
 * older stored shape. The interface is also the whole test surface — drive it
 * with a MemoryStorageAdapter and never touch a browser.
 *
 * Unknown persisted keys are ignored and missing ones fall back to defaults,
 * so the app survives a preferences shape that predates a new field.
 */
export class PreferencesService {
  private current: Preferences;
  private readonly listeners = new Set<(prefs: Preferences) => void>();

  constructor(private readonly storage: StorageAdapter) {
    this.current = this.load();
  }

  /** The current preferences. Always fully populated. */
  get(): Preferences {
    return this.current;
  }

  /** Merge `patch` over the current preferences, persist, and notify. */
  update(patch: Partial<Preferences>): void {
    this.current = { ...this.current, ...patch };
    this.storage.set(STORAGE_KEY, this.current);
    for (const listener of this.listeners) {
      listener(this.current);
    }
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: (prefs: Preferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): Preferences {
    const stored = this.storage.get<Partial<Preferences>>(STORAGE_KEY);
    // Defaults first so a partial or outdated stored shape is filled in, not trusted.
    const preferences = { ...DEFAULT_PREFERENCES, ...(stored ?? {}) };
    // A theme that has left the registry falls back rather than styling nothing.
    if (!isThemeId(preferences.theme)) preferences.theme = DEFAULT_PREFERENCES.theme;
    return preferences;
  }
}

export const PREFERENCES = token<PreferencesService>('PreferencesService');
