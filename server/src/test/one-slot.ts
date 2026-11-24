import { CHAT_NOT_FOUND, WireCallError } from '../../../src/shared/transport/errors.ts';
import type { ChatEngine } from '../chat-engine.ts';
import { MAIN, type ChatSlots } from '../chat-registry.ts';

/**
 * Just `main`, answered by one (often partial) engine: for seam tests that are
 * about what a call does to the engine, not about slots. Any other chat id is
 * not found, as with the registry.
 */
export function oneSlot(engine: unknown): ChatSlots {
  const only = engine as ChatEngine;
  const unsupported = (): never => {
    throw new Error('oneSlot: slot management is not part of this test');
  };
  return {
    engine: (chatId = MAIN) => {
      if (chatId !== MAIN) throw new WireCallError(`no chat ${chatId}`, CHAT_NOT_FOUND);
      return only;
    },
    list: () => [],
    create: unsupported,
    close: unsupported,
    openFor: async (_chatId, _ref, path, origin) => ({ chatId: MAIN, items: await only.openChat(path, origin) }),
    resolveApproval: (requestId, approved) => only.resolveApproval(requestId, approved),
    onSlots: () => () => undefined,
  };
}

/** Params as a client on `main` sends them: the chat id added to what the test gives. */
export const onMain = (params: unknown): unknown =>
  typeof params === 'object' && params !== null ? { chatId: MAIN, ...params } : { chatId: MAIN };
