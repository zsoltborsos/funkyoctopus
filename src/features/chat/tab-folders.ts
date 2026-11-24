import { token } from '@core/container/container.ts';
import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';
import { MAIN_CHAT } from '@shared/transport/protocol.ts';
import type { Project } from '@features/settings/preferences.types.ts';

const STORAGE_KEY = 'funkyoctopus.chat.tab-folders';

/** A folder known only by its path, named by its last segment (as the selector names one). */
export const folderProject = (path: string): Project => ({
  id: path,
  name: path.split('/').filter(Boolean).at(-1) ?? path,
  path,
  envTier: 'normal',
});

/** One tab's working folder: what the selector, CHAT bar, footer and new tabs read. Null is Global. */
export interface TabFolder {
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
  get: () => Project | null;
  set: (project: Project | null) => void;
}

/** How long a folder picked here outranks the sidecar's older word on the tab's root. */
const PICK_HOLD_MS = 15_000;

/**
 * Each chat tab's working folder (T2.2 review), kept browser-side beside the
 * tab's model pick, so tabs never share one folder. A tab with none recorded is
 * Global, except `main`, which starts on the pre-tabs global folder.
 */
export class TabFolders {
  private stored: Record<string, Project | null>;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  /** Folders picked here that the sidecar has not reported back yet, and when. */
  private readonly picks = new Map<string, { path: string | null; at: number }>();

  constructor(
    private readonly storage: StorageAdapter,
    /** The pre-tabs single folder (preferences), `main`'s until it has its own. */
    private readonly legacyMain: () => Project | null = () => null,
    private readonly now: () => number = Date.now,
  ) {
    this.stored = storage.get<Record<string, Project | null>>(STORAGE_KEY) ?? {};
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  forTab(chatId: string): TabFolder {
    return {
      subscribe: this.subscribe,
      getVersion: this.getVersion,
      get: () =>
        // Own keys only: a tab id is never a property of Object (`__proto__`, `constructor`).
        Object.hasOwn(this.stored, chatId)
          ? (this.stored[chatId] ?? null)
          : chatId === MAIN_CHAT
            ? this.legacyMain()
            : null,
      set: (project) => {
        const owned = Object.hasOwn(this.stored, chatId);
        const current = owned ? this.stored[chatId] : undefined;
        if (owned && (current?.id ?? null) === (project?.id ?? null) && current?.name === project?.name) return;
        this.picks.set(chatId, { path: project?.path ?? null, at: this.now() });
        this.write({ ...this.stored, [chatId]: project });
      },
    };
  }

  /**
   * The sidecar says which folder a tab is in (T2.3): the tab shows it, so a
   * tab made by `fo` or another window, or restored after a restart, shows its
   * real folder. A matching entry is kept as it is, with its project's name.
   *
   * Only a root that says something is followed: a Global root holding no
   * session is what a first start reports, and must not wipe a stored folder.
   * A folder just picked here outranks the sidecar until it reports that folder
   * (its state may have been sent before the move landed), or for 15 s.
   */
  follow(chatId: string, root: string | null, holdsSession: boolean): void {
    if (root === null && !holdsSession) return;
    const pick = this.picks.get(chatId);
    if (pick) {
      if (pick.path !== root && this.now() - pick.at < PICK_HOLD_MS) return;
      this.picks.delete(chatId);
    }
    if ((this.forTab(chatId).get()?.path ?? null) === root) return;
    this.write({ ...this.stored, [chatId]: root === null ? null : folderProject(root) });
  }

  /** Forget the folders of tabs that no longer exist. */
  retain(chatIds: readonly string[]): void {
    const keep = new Set(chatIds);
    const next = Object.fromEntries(
      Object.entries(this.stored).filter(([chatId]) => keep.has(chatId)),
    );
    if (Object.keys(next).length !== Object.keys(this.stored).length) this.write(next);
  }

  private write(stored: Record<string, Project | null>): void {
    this.stored = stored;
    this.storage.set(STORAGE_KEY, stored);
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const TAB_FOLDERS = token<TabFolders>('TabFolders');

/** The shown tab's folder, provided by each tab's scope. */
export const TAB_FOLDER = token<TabFolder>('TabFolder');
