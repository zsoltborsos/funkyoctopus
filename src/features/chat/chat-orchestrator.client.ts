import { token } from '@core/container/container.ts';
import type { TransportClient } from '@core/transport/transport-client.ts';
import {
  MAIN_CHAT,
  type ChatChunk,
  type ChatCommandsResult,
  type ChatImageAttachment,
  type ChatOpenResult,
  type ChatSessionInfo,
  type ChatTimelineItem,
  type ProjectCatalog,
  type ProjectOption,
} from '@shared/transport/protocol.ts';

export interface ChatHandlers {
  onChunk: (chunk: ChatChunk) => void;
  onDone: () => void;
  /** `code` is the wire error's code when the sidecar gave one. */
  onError: (message: string, code?: string) => void;
}

/** Handlers for the observation-only custom-event stream. */
export interface ChatObservationHandlers {
  onChunk: (chunk: ChatChunk) => void;
  onEnd: () => void;
}

/** Per-message model + effort; applied to the pi session before the turn. */
export interface ChatTurnOptions {
  provider?: string;
  model?: string;
  effort?: string;
}

/**
 * Browser face of the chat-orchestrator seam for one chat slot. Streams an
 * assistant turn from that slot's engine; the UI depends on this, never on the
 * engine or the transport directly. Every chat call names the slot: `main` for
 * the single-tab browser (T2.1); T2.2 gives each tab its own.
 */
export class ChatOrchestrator {
  constructor(
    private readonly transport: TransportClient,
    readonly chatId: string = MAIN_CHAT,
  ) {}

  discoverProjects(): Promise<ProjectCatalog> {
    return this.transport.call('projects.discover', {});
  }

  /** Canonicalise a typed folder path into a selectable project option. */
  resolveProject(path: string): Promise<ProjectOption> {
    return this.transport.call('projects.resolve', { path });
  }

  /** Re-root, and get back the transcript of that root's resumed conversation. */
  setRoot(path: string | null, clientId?: string): Promise<ChatTimelineItem[]> {
    return this.transport.call('chat.setRoot', {
      chatId: this.chatId,
      path,
      ...(clientId !== undefined ? { clientId } : {}),
    });
  }

  newChat(clientId?: string): Promise<ChatSessionInfo | null> {
    return this.transport.call('chat.new', {
      chatId: this.chatId,
      ...(clientId !== undefined ? { clientId } : {}),
    });
  }

  /** Read-only sidecar check; browser paths are never trusted locally. */
  chatExists(path: string): Promise<{ exists: boolean }> {
    return this.transport.call('chat.exists', { chatId: this.chatId, path });
  }

  /**
   * Reopen a stored chat: its transcript, or the chat that already has it open
   * (one holder per session; this chat is not switched).
   */
  openChat(path: string, clientId?: string): Promise<ChatOpenResult> {
    return this.transport.call('chat.open', {
      chatId: this.chatId,
      path,
      ...(clientId !== undefined ? { clientId } : {}),
    });
  }

  /** The live session's timeline, without building, swapping or disposing. */
  transcript(): Promise<ChatTimelineItem[]> {
    return this.transport.call('chat.transcript', { chatId: this.chatId });
  }

  /** History for one root, or every root when `root` is null. */
  listChats(root: string | null): Promise<ChatSessionInfo[]> {
    return this.transport.call('chat.list', { chatId: this.chatId, root });
  }

  currentChat(): Promise<ChatSessionInfo | null> {
    return this.transport.call('chat.current', { chatId: this.chatId });
  }

  /** The `/` palette's commands for this slot's engine; a Claude slot with no process gives its last-known list. */
  commands(): Promise<ChatCommandsResult> {
    return this.transport.call('chat.commands', { chatId: this.chatId });
  }

  /** FO's own `/compact` (pi): resolves when the compaction is done. */
  compact(instructions?: string, clientId?: string): Promise<{ compacted: true }> {
    return this.transport.call('chat.compact', {
      chatId: this.chatId,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    });
  }

  /** FO's own `/rename` (pi): the session as now described. */
  rename(name: string): Promise<ChatSessionInfo | null> {
    return this.transport.call('chat.rename', { chatId: this.chatId, name });
  }

  resolveApproval(requestId: string, approved: boolean): Promise<boolean> {
    return this.transport.call('vault.resolve', { requestId, approved });
  }

  send(
    text: string,
    handlers: ChatHandlers,
    opts: ChatTurnOptions = {},
    images: ChatImageAttachment[] = [],
    clientId?: string,
  ): () => void {
    return this.transport.stream(
      'chat.send',
      {
        chatId: this.chatId,
        text,
        ...opts,
        ...(images.length > 0 ? { images } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
      },
      {
        onChunk: (chunk) => handlers.onChunk(chunk as ChatChunk),
        onEnd: (error) => {
          if (error) {
            handlers.onError(error.message, error.code);
          } else {
            handlers.onDone();
          }
        },
      },
    );
  }

  /**
   * Open the session-scoped observation stream; returns a cancel function. The
   * browser subscribes once per open chat and re-subscribes on load and
   * reconnect. `clientId` identifies this tab on the shared session.
   */
  observe(handlers: ChatObservationHandlers, clientId?: string): () => void {
    return this.transport.stream(
      'chat.observe',
      { chatId: this.chatId, ...(clientId !== undefined ? { clientId } : {}) },
      {
        onChunk: (chunk) => handlers.onChunk(chunk as ChatChunk),
        onEnd: () => handlers.onEnd(),
      },
    );
  }
}

export const CHAT_ORCHESTRATOR = token<ChatOrchestrator>('ChatOrchestrator');
