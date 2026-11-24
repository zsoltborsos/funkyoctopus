import type { StorageAdapter } from './storage-adapter.ts';

/**
 * In-memory {@link StorageAdapter} for tests and ephemeral use.
 *
 * Its existence is what makes the storage seam *real* rather than
 * hypothetical: services can be exercised through their interface with no
 * browser, no `localStorage`, no cleanup between tests. Values are cloned on
 * the way in and out so a caller mutating a returned object can't corrupt the
 * store — matching the serialize/parse boundary of the real adapter.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly map = new Map<string, string>();

  get<T>(key: string): T | null {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  set<T>(key: string, value: T): void {
    this.map.set(key, JSON.stringify(value));
  }

  remove(key: string): void {
    this.map.delete(key);
  }
}
