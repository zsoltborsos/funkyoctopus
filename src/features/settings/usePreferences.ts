import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { PREFERENCES } from './preferences.service.ts';
import type { Preferences } from './preferences.types.ts';

/**
 * React binding for the PreferencesService. Reads the live value via
 * `useSyncExternalStore` so any component re-renders when preferences change,
 * regardless of which one triggered the update. Returns the current
 * preferences plus the service's `update` for writes.
 */
export function usePreferences(): {
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
} {
  const service = useService(PREFERENCES);
  const preferences = useSyncExternalStore(
    (onChange) => service.subscribe(onChange),
    () => service.get(),
  );
  return { preferences, update: (patch) => service.update(patch) };
}
