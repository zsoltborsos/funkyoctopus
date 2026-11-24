import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { TRANSPORT, type ConnectionState } from '@core/transport/transport-client.ts';

/** Live connection state of the sidecar transport, React-bound. */
export function useConnection(): ConnectionState {
  const transport = useService(TRANSPORT);
  return useSyncExternalStore(transport.subscribe, transport.getState);
}
