import { DEFAULT_THEME, type ThemeId } from './themes.ts';

/** Sidebar docking side for the cockpit's menu rail. */
export type SidebarPosition = 'left' | 'right';

/** A chosen chat model, identified by its pi provider + id. */
export interface ModelRef {
  provider: string;
  id: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  envTier: 'lab' | 'normal' | 'prod-adjacent';
}

/**
 * User-facing cockpit preferences. Deliberately only the parts that are
 * genuinely local, backend-independent, and *actually applied* to the UI:
 * font size scales the whole rem-based interface, the theme picks the token
 * set, sidebar position docks the menu rail, and timestamps toggle in chat.
 * Model routing, tool config and RAG URLs are not here — they belong to seams.
 * A density mode was dropped until there's a real implementation behind it.
 */
export interface Preferences {
  fontSize: number;
  /** One of `THEMES` (themes.ts); applied as `data-theme` on <html>. */
  theme: ThemeId;
  showTimestamps: boolean;
  sidebarPosition: SidebarPosition;
  /** Chat model + effort the composer sends with each turn. Null model falls
   *  back to the sidecar's default; null effort lets the model decide. */
  chatModel: ModelRef | null;
  chatEffort: string | null;
  /** Starred models, as `provider::id` keys, pinned atop the picker. */
  favoriteModels: string[];
  /** Whether tool details start expanded; each row can override this locally. */
  toolStepsDefaultOpen: boolean;
  /** Opt-in browser notifications for Helmraiser awaiting/failed runs. */
  notifyHelmraiser: boolean;
  /** Opt-in browser notifications for finished turns and crew attention states. */
  notifyChat: boolean;
  /** Null selects global/studio mode. */
  activeProject: Project | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  fontSize: 17,
  theme: DEFAULT_THEME,
  showTimestamps: true,
  sidebarPosition: 'left',
  chatModel: null,
  chatEffort: null,
  favoriteModels: [],
  toolStepsDefaultOpen: false,
  notifyHelmraiser: false,
  notifyChat: false,
  activeProject: null,
};
