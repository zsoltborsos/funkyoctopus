import { useState } from 'react';
import { useService } from '@core/container/useService.ts';
import { useShell } from '@core/shell/useShell.ts';
import type { EngineKind, LeeboardEntry } from '@shared/transport/protocol.ts';
import { CHAT_SESSIONS } from '../chat-sessions.service.ts';
import { TAB_FOLDERS, folderProject } from '../tab-folders.ts';
import { LEEBOARD } from './leeboard.client.ts';
import { reviewPrompt, takePrompt } from './take-prompt.ts';

export interface UseTakeIt {
  /** This panel's tab. */
  chatId: string;
  /** The entry id or 'digest' being routed; one action at a time. */
  pending: string | null;
  error: string | null;
  /** Prefill this tab's composer. */
  take: (entry: LeeboardEntry) => void;
  /** Show the open tab the entry belongs in, and prefill its composer. */
  goTo: (entry: LeeboardEntry, chatId: string) => void;
  /** Open a tab of `kind` in the project's folder, and prefill its composer. */
  openTab: (entry: LeeboardEntry, project: string, folder: string, kind: EngineKind) => void;
  /** Open a global tab for an owner digest review, and prefill its composer. */
  reviewDigest: (counts: { new: number; changed: number; closed: number }, kind: EngineKind) => void;
}

/**
 * "Take it" (T3 L5): put an entry's prompt, unsent and focused, into the
 * composer of the tab that should work on it. Never sends: the owner reads it
 * and presses Enter (decision 12). Leeboard keeps the entry; FO stores nothing.
 */
export function useTakeIt(): UseTakeIt {
  const leeboard = useService(LEEBOARD);
  const tabs = useService(CHAT_SESSIONS);
  const folders = useService(TAB_FOLDERS);
  const { composeInChat } = useShell();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const route = (entry: LeeboardEntry, toTab: () => string | Promise<string>): void => {
    if (pending) return;
    setPending(entry.id);
    setError(null);
    void (async () => {
      try {
        // The body is read now, so the prompt carries what the entry says today.
        const shown = await leeboard.show(entry.id).catch(() => null);
        const prompt = takePrompt(entry, shown?.entry?.body ?? null);
        // After whatever that tab's composer already holds: a draft there is never lost.
        composeInChat(prompt, await toTab(), { focus: true, append: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    })();
  };

  const reviewDigest: UseTakeIt['reviewDigest'] = (counts, kind) => {
    if (pending) return;
    setPending('digest');
    setError(null);
    void (async () => {
      try {
        const prompt = reviewPrompt(counts);
        composeInChat(prompt, await tabs.create(kind, null), { focus: true, append: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    })();
  };

  return {
    chatId: leeboard.chatId,
    pending,
    error,
    reviewDigest,
    take: (entry) => route(entry, () => leeboard.chatId),
    goTo: (entry, chatId) =>
      route(entry, () => {
        if (!tabs.activate(chatId)) throw new Error('that tab is no longer open');
        return chatId;
      }),
    openTab: (entry, project, folder, kind) =>
      route(entry, () =>
        // The new tab keeps the project's folder as its own, named as Leeboard names it.
        tabs.create(kind, folder, (chatId) => folders.forTab(chatId).set({ ...folderProject(folder), name: project })),
      ),
  };
}
