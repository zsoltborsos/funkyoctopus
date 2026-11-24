import { useEffect, useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { HELMRAISER_MONITOR } from './helmraiser-monitor.service.ts';
import { useConnection } from '@features/status/useConnection.ts';

export function useHelmraiserMonitor() {
  const monitor = useService(HELMRAISER_MONITOR);
  const connection = useConnection();
  useEffect(() => {
    if (connection === 'open') void monitor.refresh();
  }, [connection, monitor]);
  return {
    ...useSyncExternalStore(monitor.subscribe, monitor.getSnapshot),
    refresh: () => monitor.refresh(),
  };
}
