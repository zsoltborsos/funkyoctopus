import type { StorageAdapter } from './storage-adapter.ts';

/**
 * Browser `localStorage` implementation of {@link StorageAdapter}.
 *
 * Reshaped from the original StorageService: kept the resilient get/set/remove
 * core, dropped the domain-specific `saveSettings`/`saveChatHistory` methods
 * (those belong to their own services, not the storage seam). All access is
 * wrapped so quota errors, private-mode blocks, and malformed JSON degrade to
 * a safe default rather than crashing a render.
 */
export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly store: Storage = localStorage) {}

  get<T>(key: string): T | null {
    try {
      const raw = this.store.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    try {
      this.store.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage unavailable — preferences are best-effort.
    }
  }

  remove(key: string): void {
    try {
      this.store.removeItem(key);
    } catch {
      // Nothing actionable if removal fails.
    }
  }
}
