import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { CHAT_SESSIONS } from './chat-sessions.service.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { ChatTabBar } from './ChatTabBar.tsx';

/**
 * The chat view: the tab bar over the shown tab's panel. The panel is keyed by
 * its tab, so a switch mounts the other tab's conversation, composer models and
 * Leeboard panel fresh rather than carrying one tab's view state into another.
 */
export function ChatView() {
  const tabs = useService(CHAT_SESSIONS);
  const activeChatId = useSyncExternalStore(tabs.subscribe, () => tabs.getSnapshot().activeChatId);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <ChatTabBar />
      <div className="min-h-0 flex-1">
        <ChatPanel key={activeChatId} />
      </div>
    </div>
  );
}
