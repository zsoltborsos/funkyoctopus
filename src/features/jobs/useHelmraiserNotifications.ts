import { useEffect } from 'react';
import { useService } from '@core/container/useService.ts';
import { useShell } from '@core/shell/useShell.ts';
import { HELMRAISER_NOTIFICATIONS } from './helmraiser-notifications.service.ts';

/**
 * Keeps the Helmraiser notification subscription alive for the whole app, in
 * every view — not only while the Jobs panel is mounted.
 */
export function useHelmraiserNotifications(): void {
  const service = useService(HELMRAISER_NOTIFICATIONS);
  const { setView } = useShell();
  useEffect(() => service.start(() => setView('jobs')), [service, setView]);
}
