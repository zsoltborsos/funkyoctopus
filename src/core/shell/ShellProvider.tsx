import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ShellContext } from './shell-context.ts';
import { ComposerKeyContext } from './composer-key.ts';
import type { ComposerAttachment, ShellView } from './shell.types.ts';

interface Composer {
  draft: string;
  attachments: ComposerAttachment[];
}

const EMPTY: Composer = { draft: '', attachments: [] };

/** Provides shell navigation + composer state to the tree; the composer is the shown tab's. */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ShellView>('chat');
  const key = useContext(ComposerKeyContext);
  // Read by `composeInChat` at call time: a flow that just showed a tab composes into it.
  const shownKey = useRef(key);
  useLayoutEffect(() => {
    shownKey.current = key;
  }, [key]);
  const [composers, setComposers] = useState<Record<string, Composer>>({});
  const composer = composers[key] ?? EMPTY;

  const patch = useCallback(
    (target: string, update: (current: Composer) => Composer) =>
      setComposers((all) => ({ ...all, [target]: update(all[target] ?? EMPTY) })),
    [],
  );
  const setChatDraft = useCallback(
    (draft: string) => patch(key, (c) => ({ ...c, draft })),
    [patch, key],
  );
  const setChatAttachments = useCallback(
    (update: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) =>
      patch(key, (c) => ({
        ...c,
        attachments: typeof update === 'function' ? update(c.attachments) : update,
      })),
    [patch, key],
  );
  // The tab whose composer should take focus when it is next shown (a prefilled prompt to review).
  const [focusFor, setFocusFor] = useState<string | null>(null);
  const composeInChat = useCallback(
    (text: string, chatId?: string, options?: { focus?: boolean; append?: boolean }) => {
      const target = chatId ?? shownKey.current;
      patch(target, (c) => ({
        ...c,
        draft: options?.append && c.draft.trim() !== '' ? `${c.draft}\n\n${text}` : text,
      }));
      if (options?.focus) setFocusFor(target);
      setView('chat');
    },
    [patch],
  );
  const composerFocusTaken = useCallback(() => setFocusFor(null), []);

  const hasUnsent = useCallback(
    (chatId: string) => {
      const held = composers[chatId];
      return held !== undefined && (held.draft.trim() !== '' || held.attachments.length > 0);
    },
    [composers],
  );
  const moveComposer = useCallback(
    (from: string, to: string) =>
      setComposers((all) => {
        const moving = all[from] ?? EMPTY;
        const target = all[to] ?? EMPTY;
        const draft = [target.draft, moving.draft].filter((text) => text.trim() !== '').join('\n\n');
        return { ...all, [from]: EMPTY, [to]: { draft, attachments: [...target.attachments, ...moving.attachments] } };
      }),
    [],
  );
  const discardComposer = useCallback(
    (chatId: string) =>
      setComposers((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== chatId))),
    [],
  );

  const value = useMemo(
    () => ({
      view,
      setView,
      chatDraft: composer.draft,
      setChatDraft,
      chatAttachments: composer.attachments,
      setChatAttachments,
      composeInChat,
      composerFocusRequested: focusFor === key,
      composerFocusTaken,
      hasUnsent,
      moveComposer,
      discardComposer,
    }),
    [view, composer, setChatDraft, setChatAttachments, composeInChat, focusFor, key, composerFocusTaken, hasUnsent, moveComposer, discardComposer],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
