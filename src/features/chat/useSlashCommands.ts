import { useEffect, useState } from 'react';
import { useService } from '@core/container/useService.ts';
import type { ChatCommandsResult } from '@shared/transport/protocol.ts';
import { CHAT_ORCHESTRATOR } from './chat-orchestrator.client.ts';
import { CHAT_SESSION } from './chat-session.service.ts';

/**
 * Each tab's last list, so a tab shown again offers its commands at once while
 * they are read again. The panel remounts on every tab switch.
 */
const known = new Map<string, ChatCommandsResult>();

/**
 * The shown tab's `/` commands, once `wanted` (a `/` was typed in this tab):
 * read then, and again after each of its turns ends (a Claude tab's first turn
 * starts the process that lists them; a turn can also change them). Not read
 * before: listing builds a pi tab's session, and a tab only shown must stay
 * as restored (T2.3). Null until the first read answers.
 */
export function useSlashCommands(wanted: boolean): ChatCommandsResult | null {
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const session = useService(CHAT_SESSION);
  const chatId = orchestrator.chatId;
  const [list, setList] = useState<ChatCommandsResult | null>(() => known.get(chatId) ?? null);
  // Another tab, or `/` wanted or dropped: start from what is known for this tab.
  const [shownFor, setShownFor] = useState({ chatId, wanted });
  if (shownFor.chatId !== chatId || shownFor.wanted !== wanted) {
    setShownFor({ chatId, wanted });
    setList(known.get(chatId) ?? null);
  }
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    const load = (): void => {
      orchestrator.commands().then(
        (result) => {
          known.set(chatId, result);
          if (live) setList(result);
        },
        // Best effort: the palette keeps what it had, and the next turn's end asks again.
        () => undefined,
      );
    };
    load();
    const stop = session.subscribeActivity((activity) => {
      if (activity.kind === 'turn-ended') load();
    });
    return () => {
      live = false;
      stop();
    };
  }, [orchestrator, session, chatId, wanted]);
  return list;
}
