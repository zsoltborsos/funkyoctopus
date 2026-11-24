/** The selectable feature views the cockpit navigates between. */
export type ShellView = 'chat' | 'jobs' | 'prompts' | 'settings';

/**
 * Something attached to the chat composer for the next send: an image (pasted
 * or dropped; base64 without the `data:` prefix) or a file path (pasted or
 * dropped as text). Paths travel inside the message text; images travel as
 * image content.
 */
export type ComposerAttachment =
  | { id: string; kind: 'image'; name: string; mimeType: string; data: string }
  | { id: string; kind: 'path'; path: string };

/**
 * Shell state: which feature is in focus plus the shown chat tab's composer
 * draft (each tab keeps its own).
 *
 * The draft lives here (not inside the chat view) so other views — notably the
 * prompt library — can load text into the composer and jump to chat via
 * `composeInChat`. It is pure UI state, so it stays in React context rather
 * than the DI container, which is reserved for the seam services.
 */
export interface ShellState {
  view: ShellView;
  setView: (view: ShellView) => void;
  chatDraft: string;
  setChatDraft: (draft: string) => void;
  /** Attachments for the next send; kept with the draft so a view switch keeps them. */
  chatAttachments: ComposerAttachment[];
  setChatAttachments: (
    update: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  /**
   * Load text into a tab's composer and switch focus to the chat view: the tab
   * named, else the one shown when this is called. With `focus`, that tab's
   * composer also takes keyboard focus once it is shown; with `append`, the text
   * goes after what the composer already holds instead of replacing it.
   */
  composeInChat: (text: string, chatId?: string, options?: { focus?: boolean; append?: boolean }) => void;
  /** The shown tab's composer was asked to take focus; it calls `composerFocusTaken` once it has. */
  composerFocusRequested: boolean;
  composerFocusTaken: () => void;
  /** Whether a tab's composer holds text or attachments not yet sent (the draft guard asks). */
  hasUnsent: (chatId: string) => boolean;
  /** Move what one tab's composer holds into another's, after what that one holds. */
  moveComposer: (from: string, to: string) => void;
  /** Drop what a tab's composer holds: the tab was closed knowing it. */
  discardComposer: (chatId: string) => void;
}
