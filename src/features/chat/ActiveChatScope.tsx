import { useSyncExternalStore, type ReactNode } from 'react';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { useService } from '@core/container/useService.ts';
import { ComposerKeyContext } from '@core/shell/composer-key.ts';
import { CHAT_SESSIONS } from './chat-sessions.service.ts';

/**
 * Provides the shown chat tab's scope, and its composer, to everything below it: whatever resolves
 * a chat service (the composer, Leeboard panel, CHAT bar, folder selector, history,
 * Helmraiser's chat actions) gets the shown tab's, and follows a switch.
 */
export function ActiveChatScope({ children }: { children: ReactNode }) {
  const tabs = useService(CHAT_SESSIONS);
  const activeChatId = useSyncExternalStore(tabs.subscribe, () => tabs.getSnapshot().activeChatId);
  return (
    <ContainerProvider container={tabs.scope(activeChatId)}>
      <ComposerKeyContext.Provider value={activeChatId}>{children}</ComposerKeyContext.Provider>
    </ContainerProvider>
  );
}
