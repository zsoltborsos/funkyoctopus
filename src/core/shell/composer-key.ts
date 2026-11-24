import { createContext } from 'react';
import { MAIN_CHAT } from '@shared/transport/protocol.ts';

/**
 * Whose composer the shell's draft is: the shown chat tab's `chatId`. Each tab
 * keeps its own draft and attachments, so text typed for one tab can never be
 * sent from another. Provided by the chat tabs; `main` without them.
 */
export const ComposerKeyContext = createContext<string>(MAIN_CHAT);
