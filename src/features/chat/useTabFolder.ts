import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import type { Project } from '@features/settings/preferences.types.ts';
import { TAB_FOLDER } from './tab-folders.ts';

/** The shown tab's working folder (null is Global), and a setter; re-renders when it changes. */
export function useTabFolder(): {
  folder: Project | null;
  setFolder: (project: Project | null) => void;
} {
  const tab = useService(TAB_FOLDER);
  useSyncExternalStore(tab.subscribe, tab.getVersion);
  return { folder: tab.get(), setFolder: tab.set };
}
