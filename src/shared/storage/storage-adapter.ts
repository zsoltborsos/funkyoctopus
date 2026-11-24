/**
 * StorageAdapter — the seam between services and where their data physically
 * lives. A tiny key/value interface: services depend on this, never on
 * `localStorage` directly, so persistence can move (localStorage → IndexedDB →
 * a synced backend) without touching a single caller.
 *
 * Reads never throw: a corrupt or absent value resolves to `null`, and the
 * caller decides on defaults.
 */
export interface StorageAdapter {
  /** Read and parse the value at `key`, or `null` if absent/unreadable. */
  get<T>(key: string): T | null;
  /** Serialize and persist `value` at `key`. */
  set<T>(key: string, value: T): void;
  /** Remove `key` if present. */
  remove(key: string): void;
}
