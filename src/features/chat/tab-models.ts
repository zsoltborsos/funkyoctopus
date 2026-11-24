import { token } from '@core/container/container.ts';
import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';
import { CLAUDE_CODE_PROVIDER, type EngineKind } from '@shared/transport/protocol.ts';
import type { ModelRef } from '@features/settings/preferences.types.ts';

const STORAGE_KEY = 'funkyoctopus.chat.tab-models';

/** The model and effort a tab sends with each turn; null is the sidecar's default. */
export interface TabPick {
  model: ModelRef | null;
  effort: string | null;
}

interface Stored {
  /** Per tab, keyed by `chatId`. */
  tabs: Record<string, TabPick>;
  /** The last pick made in any tab of each engine: where a new tab starts. */
  last: Partial<Record<EngineKind, TabPick>>;
}

const NONE: TabPick = { model: null, effort: null };

const engineOf = (model: ModelRef): EngineKind =>
  model.provider === CLAUDE_CODE_PROVIDER ? 'claude-code' : 'pi';

/** One tab's view of the store: what the composer reads and sets. */
export interface TabModel {
  /** Changes to any tab's pick; `getVersion` moves with each. For `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
  get: () => TabPick;
  selectModel: (model: ModelRef) => void;
  selectEffort: (effort: string) => void;
}

/**
 * Per-tab model and effort, kept browser-side (T2.2) until T2.3 moves slot
 * state to the sidecar. A tab's pick survives a reload; a tab without one
 * starts on the last pick made in a tab of its engine, then on the sidecar's
 * default. A pick never crosses engines: a conversation never moves between
 * them.
 */
export class TabModels {
  private stored: Stored;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: StorageAdapter) {
    const raw = storage.get<Partial<Stored>>(STORAGE_KEY);
    this.stored = { tabs: raw?.tabs ?? {}, last: raw?.last ?? {} };
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A tab's handle; `kind` is read live, since `main`'s engine is known only once the slots arrive. */
  forTab(chatId: string, kind: () => EngineKind | null): TabModel {
    return {
      subscribe: this.subscribe,
      getVersion: this.getVersion,
      get: () => this.pick(chatId, kind()),
      selectModel: (model) => this.select(chatId, kind(), { model }),
      selectEffort: (effort) => this.select(chatId, kind(), { effort }),
    };
  }

  /** Forget the picks of tabs that no longer exist (closed, or gone with a sidecar restart). */
  retain(chatIds: readonly string[]): void {
    const keep = new Set(chatIds);
    const tabs = Object.fromEntries(
      Object.entries(this.stored.tabs).filter(([chatId]) => keep.has(chatId)),
    );
    if (Object.keys(tabs).length === Object.keys(this.stored.tabs).length) return;
    this.write({ ...this.stored, tabs });
  }

  private pick(chatId: string, kind: EngineKind | null): TabPick {
    const suits = (candidate: TabPick | undefined): candidate is TabPick =>
      candidate !== undefined &&
      (kind === null || candidate.model === null || engineOf(candidate.model) === kind);
    // Own keys only: a tab id is never a property of Object (`__proto__`, `constructor`).
    const own = Object.hasOwn(this.stored.tabs, chatId) ? this.stored.tabs[chatId] : undefined;
    if (suits(own)) return own;
    const last = kind === null ? undefined : this.stored.last[kind];
    return suits(last) ? last : NONE;
  }

  private select(chatId: string, kind: EngineKind | null, patch: Partial<TabPick>): void {
    const next = { ...this.pick(chatId, kind), ...patch };
    const engine = kind ?? (next.model ? engineOf(next.model) : null);
    this.write({
      tabs: { ...this.stored.tabs, [chatId]: next },
      last: engine === null ? this.stored.last : { ...this.stored.last, [engine]: next },
    });
  }

  private write(stored: Stored): void {
    this.stored = stored;
    this.storage.set(STORAGE_KEY, stored);
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const TAB_MODELS = token<TabModels>('TabModels');

/** The active tab's handle, provided by each tab's scope. */
export const TAB_MODEL = token<TabModel>('TabModel');
