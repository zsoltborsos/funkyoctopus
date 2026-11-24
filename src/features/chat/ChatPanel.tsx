import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useShell } from '@core/shell/useShell.ts';
import { usePreferences } from '@features/settings/usePreferences.ts';
import { usePromptLibrary } from '@features/prompts/usePromptLibrary.ts';
import type { ModelRef } from '@features/settings/preferences.types.ts';
import { useChat } from './useChat.ts';
import { useModels } from './useModels.ts';
import { chatAgent } from './agent.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { EffortPicker } from './EffortPicker.tsx';
import { HistoryPicker } from './HistoryPicker.tsx';
import { folderOf } from './session-label.ts';
import { LeeboardPanel } from './leeboard-panel/LeeboardPanel.tsx';
import { CrewCard } from './CrewCard.tsx';
import { CrewAuditCard } from './CrewAuditCard.tsx';
import { CrewStrip } from './CrewStrip.tsx';
import { MessageView, ToolStep } from './MessageView.tsx';
import { useStickToBottom } from './useStickToBottom.ts';
import { useService } from '@core/container/useService.ts';
import { CHAT_ORCHESTRATOR } from './chat-orchestrator.client.ts';
import { TAB_MODEL } from './tab-models.ts';
import { useTabFolder } from './useTabFolder.ts';
import { isJumpToLatestShortcut, isNewChatShortcut, isStopShortcut } from './shortcuts.ts';
import { useComposerHistory } from './useComposerHistory.ts';
import { useSlashCommands } from './useSlashCommands.ts';
import { SlashPalette } from './SlashPalette.tsx';
import { SLASH_LIST_ID, actionFor, filterCommands, slashOptionId, slashQuery } from './slash-commands.ts';
import type { ChatCommand } from '@shared/transport/protocol.ts';
import {
  attachmentsFromImages,
  composeMessage,
  imageAttachments,
  pathAttachments,
  pathsFromText,
} from './attachments.ts';
import type { QueuedMessage } from './chat-session.service.ts';
import { CHAT_ATTENTION_NOTIFICATIONS } from './chat-attention-notifications.service.ts';
import { crewAuditFromRaw, crewAuditItemSteps, projectCrewAudits } from './crew-audit.ts';
import type { ChatTurnOptions } from './chat-orchestrator.client.ts';
import { isChatEventItem, isCrewAuditItem, type ChatUsage } from './chat.types.ts';
import { AwayDigestCard } from './AwayDigestCard.tsx';

/**
 * The sidecar's global root as last read. The panel remounts on every tab
 * switch; a tab starts from what is already known instead of a placeholder
 * while the catalog is read again.
 */
let knownGlobalRoot = '';

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
};

/** Sub-1% occupancy is real but rounds to zero — say so rather than show "0%". */
const formatPercent = (p: number): string => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);

/** Context-window occupancy of the live session: used, total, and percent. */
function ContextMeter({ usage }: { usage: ChatUsage }) {
  const percent = usage.percent;
  const tone =
    percent === null
      ? 'text-muted'
      : percent >= 90
        ? 'text-danger'
        : percent >= 70
          ? 'text-attention'
          : 'text-muted';
  return (
    <span
      className={`font-mono text-xs ${tone}`}
      title="Context window used by this conversation"
    >
      ctx {usage.tokens === null ? '—' : formatTokens(usage.tokens)}/
      {formatTokens(usage.contextWindow)}
      {percent !== null && ` · ${formatPercent(percent)}`}
    </span>
  );
}

/** The chat ring: a thin view over the chat-orchestrator seam (pi). */
export function ChatPanel() {
  const {
    messages,
    busy,
    usage,
    sessions,
    activeSession,
    activeSessionPath,
    activeCrew,
    crewUnread,
    queued,
    turnNotice,
    send,
    cancel,
    unqueue,
    returned,
    takeReturned,
    resolveApproval,
    compact,
    rename,
    newChat,
    openChat,
    refresh,
    markCrewSeen,
    setCrewViewed,
  } = useChat();
  const { chatDraft, setChatDraft, chatAttachments, setChatAttachments, composerFocusRequested, composerFocusTaken } = useShell();
  const { preferences, update } = usePreferences();
  const { models, loading: modelsLoading, error: modelsError } = useModels();
  // Model and effort are the tab's own (T2.2), and the picker offers only its engine's models.
  const tabModel = useService(TAB_MODEL);
  useSyncExternalStore(tabModel.subscribe, tabModel.getVersion);
  const pick = tabModel.get();
  const { add } = usePromptLibrary();
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateTitle, setTemplateTitle] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  // Up/Down recall sent messages, shell-style; see useComposerHistory.
  const inputHistory = useComposerHistory({
    draft: chatDraft,
    setDraft: setChatDraft,
    composer,
  });
  // The `/` palette (T2.4b): open while a typed draft is naming a command. Only
  // typing arms it, so a recalled or restored `/…` draft leaves Up/Down to history.
  const [paletteArmed, setPaletteArmed] = useState(false);
  // Listed only once a `/` is typed here: listing builds a pi tab's session.
  const [commandsWanted, setCommandsWanted] = useState(false);
  if (paletteArmed && !commandsWanted) setCommandsWanted(true);
  const commandList = useSlashCommands(commandsWanted);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteQuery = paletteArmed ? slashQuery(chatDraft) : null;
  const paletteMatches =
    paletteQuery !== null && commandList ? filterCommands(commandList.commands, paletteQuery) : [];
  const paletteSelected = paletteMatches.length > 0 ? Math.min(paletteIndex, paletteMatches.length - 1) : -1;
  /** `/rename` with no name asks for one here. */
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [dragging, setDragging] = useState(false);
  /** One-line notice under the composer (e.g. a drop that attached nothing). */
  const [notice, setNotice] = useState<string | null>(null);
  // The sidecar's global root, for the no-project footer line.
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const [globalRoot, setGlobalRoot] = useState(knownGlobalRoot);
  // The tab's own working folder (null is Global).
  const { folder } = useTabFolder();
  const barTitle = activeSession?.title ?? 'untitled chat';
  const barCwd = activeSession?.cwd ?? folder?.path ?? globalRoot;
  useEffect(() => {
    let live = true;
    void orchestrator
      .discoverProjects()
      .then((catalog) => {
        knownGlobalRoot = catalog.globalRoot;
        if (live) setGlobalRoot(catalog.globalRoot);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [orchestrator]);

  // History changes only as a result of an action the cockpit itself took, so it
  // is read on mount (and after those actions) rather than polled.
  useEffect(() => {
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; `refresh` is a fresh closure each render.
  }, []);
  // Effort options are scoped to the selected model's ladder; unknown/default
  // model → no ladder, so the effort control disables itself.
  const selectedOption = pick.model
    ? models.find((m) => m.provider === pick.model?.provider && m.id === pick.model.id)
    : undefined;
  // A pick the engine no longer lists falls back to its default rather than failing the send.
  const chatModel = selectedOption || models.length === 0 ? pick.model : null;
  const effortLevels = selectedOption?.thinkingLevels ?? [];
  // No explicit choice means the composer is on the sidecar's default route, which
  // the sidecar marks in the list. Who answers (pi or Claude Code) follows from
  // what the sidecar's engine serves.
  const agent = chatAgent(models, chatModel);
  const liveModel = agent.model;
  // "None configured" is only true to say of a list that was read.
  const noPiModel = liveModel === null && !modelsLoading && modelsError === null;
  // Whether the live route can see an image, straight from pi's model metadata;
  // an unknown route is given the benefit of the doubt.
  const routeOption = selectedOption ?? models.find((m) => m.isDefault);
  const routeTakesImages = routeOption ? routeOption.input.includes('image') : true;
  // Pure render projection: crew audit models, spawn→result correlation and
  // duplicate suppression. The durable timeline in ChatSession is untouched.
  const crewState = useMemo(() => projectCrewAudits(messages), [messages]);
  // The empty state keys off what would be *seen*: a fresh session can already
  // hold display:false custom events (pi extensions announce themselves), and
  // those must not swallow the "speak to the runtime" line.
  const nothingToShow = messages.every((item) => isChatEventItem(item) && !item.display);
  // The transcript follows the tail while it streams; reopening a chat lands
  // at its latest turn; the reader scrolling up takes over until they jump back.
  const transcript = useStickToBottom<HTMLDivElement>(messages, activeSessionPath);
  const chatAttention = useService(CHAT_ATTENTION_NOTIFICATIONS);
  useEffect(
    () => chatAttention.attachScroller(transcript.jumpToLatest),
    [chatAttention, transcript.jumpToLatest],
  );

  // View lifecycle: while the panel is mounted the conversation is viewed;
  // unmounting marks it not viewed so updates accumulate. Mount never clears
  // unread — only an explicit in-chat action (composer focus) does.
  useEffect(() => {
    setCrewViewed(true);
    return () => setCrewViewed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only; the closures call stable session methods.
  }, []);

  /** FO's own commands: compact runs now; rename takes the name given, or asks for one. */
  const runAction = (command: ChatCommand, args: string): void => {
    setChatDraft('');
    setNotice(null);
    setPaletteArmed(false);
    const fail = (error: unknown): void =>
      setNotice(error instanceof Error ? error.message : `/${command.name} failed`);
    if (command.name === 'compact') {
      void compact(args || undefined).catch(fail);
    } else if (command.name === 'rename') {
      if (args) {
        void rename(args).catch(fail);
      } else {
        setRenameText('');
        setRenaming(true);
      }
    }
  };

  /** A palette pick: a text command is completed for its arguments; an action runs. */
  const pickCommand = (command: ChatCommand): void => {
    setPaletteArmed(false);
    if (command.kind === 'action') {
      inputHistory.record(`/${command.name}`);
      runAction(command, '');
      return;
    }
    inputHistory.noteEdit();
    setChatDraft(`/${command.name} `);
    composer.current?.focus();
  };

  const submitRename = (e: FormEvent): void => {
    e.preventDefault();
    const name = renameText.trim();
    if (!name) return;
    setRenaming(false);
    void rename(name).catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'could not rename the chat'),
    );
    composer.current?.focus();
  };

  const doSend = (): void => {
    // `/compact …` or `/rename …` typed out runs FO's own action instead of going as text.
    const action = chatAttachments.length === 0 && commandList ? actionFor(chatDraft, commandList.commands) : null;
    if (action) {
      inputHistory.record(chatDraft.trim());
      runAction(action.command, action.args);
      return;
    }
    const opts: ChatTurnOptions = {};
    if (chatModel) {
      opts.provider = chatModel.provider;
      opts.model = chatModel.id;
    }
    if (pick.effort && effortLevels.includes(pick.effort)) {
      opts.effort = pick.effort;
    }
    // Path chips travel inside the text; images travel as image content. A
    // message that is only images has nothing for pi to answer — keep it.
    const { text, images } = composeMessage(chatDraft, chatAttachments);
    if (!text) return;
    // While a turn streams this queues rather than sends; either way the
    // composer is free again and nothing typed or attached is lost.
    send(text, opts, images);
    inputHistory.record(text);
    setChatDraft('');
    setChatAttachments([]);
    setNotice(null);
    // Your own message always brings the tail into view.
    transcript.jumpToLatest();
  };

  /** Put queued messages back into the composer without clobbering what is being typed. */
  const restoreToComposer = (messages: QueuedMessage[]): void => {
    if (messages.length === 0) return;
    const texts = messages.map((m) => m.text);
    // A blank line between entries keeps separate messages reading as separate.
    setChatDraft([...texts, chatDraft].filter((t) => t.trim()).join('\n\n'));
    const images = messages.flatMap((m) => m.images ?? []);
    if (images.length > 0) {
      setChatAttachments((prev) => [...attachmentsFromImages(images), ...prev]);
    }
  };

  // The engine refused to drive a conversation another Claude Code holds: what was queued
  // behind that send comes back here, as STOP's does, whether or not the panel was showing.
  useEffect(() => {
    if (returned.length > 0) restoreToComposer(takeReturned());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when something is handed back; the helpers are fresh closures each render.
  }, [returned]);

  /** STOP / Esc: abort the turn; anything queued behind it returns to the composer. */
  const stop = (): void => {
    restoreToComposer(cancel());
  };

  const attachFiles = (files: Iterable<File>): void => {
    const list = [...files];
    void imageAttachments(list).then((images) => {
      if (images.length > 0) {
        setChatAttachments((prev) => [...prev, ...images]);
        setNotice(null);
      } else if (list.length > 0) {
        // Browsers hand over a dropped file's bytes, never its path: only
        // images can be attached that way. Paths come in as text.
        setNotice('only images can be dropped here — paste a file path for anything else');
      }
    });
  };

  const attachPaths = (paths: string[]): void => {
    setChatAttachments((prev) => [...prev, ...pathAttachments(paths)]);
    setNotice(null);
  };

  const removeAttachment = (id: string): void =>
    setChatAttachments((prev) => prev.filter((a) => a.id !== id));

  // Paste: image files become image attachments; text that is nothing but
  // file paths becomes path chips; anything else pastes as text as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      attachFiles(files);
      return;
    }
    const paths = pathsFromText(e.clipboardData.getData('text/plain'));
    if (paths) {
      e.preventDefault();
      attachPaths(paths);
    }
  };

  const onDragOver = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (): void => setDragging(false);
  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      attachFiles(e.dataTransfer.files);
      return;
    }
    const dropped = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const paths = pathsFromText(dropped);
    if (paths) {
      attachPaths(paths);
    } else if (dropped.trim()) {
      setChatDraft([chatDraft, dropped].filter((t) => t.trim()).join('\n'));
    }
  };

  // A prompt put here to review (Leeboard's "take it") arrives focused, read from its first line.
  useEffect(() => {
    if (!composerFocusRequested) return;
    const box = composer.current;
    if (box) {
      box.focus();
      box.setSelectionRange(0, 0);
      box.scrollTop = 0;
    }
    composerFocusTaken();
  }, [composerFocusRequested, composerFocusTaken]);

  const startNewChat = (): void => {
    void newChat().catch(() => undefined);
    composer.current?.focus();
  };

  // Keyboard shortcuts live on the window while the chat view is mounted; the
  // handler is read through a ref so the one listener always sees the latest
  // closures without re-subscribing every render.
  const keyHandler = useRef<(e: globalThis.KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandler.current = (e) => {
      if (e.defaultPrevented) return;
      if (isNewChatShortcut(e)) {
        e.preventDefault();
        startNewChat();
      } else if (busy && isStopShortcut(e)) {
        e.preventDefault();
        stop();
      } else if (isJumpToLatestShortcut(e)) {
        // Ctrl+End in a draft is the caret's; with the composer empty (the
        // reading posture) it is the transcript's.
        if (e.target === composer.current && chatDraft !== '') return;
        e.preventDefault();
        transcript.jumpToLatest();
      }
    };
  });
  useEffect(() => {
    const listener = (e: globalThis.KeyboardEvent): void => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    doSend();
  };

  /** The palette's keys, while it is open; true when the key was its. */
  const paletteKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (paletteQuery === null || e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'Escape' && !e.shiftKey) {
      // Its own: the chat view's Esc-to-stop must not hear it.
      setPaletteArmed(false);
    } else if (paletteMatches.length === 0 || e.shiftKey) {
      return false;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setPaletteIndex((paletteSelected + step + paletteMatches.length) % paletteMatches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const picked = paletteMatches[paletteSelected];
      if (picked) pickCommand(picked);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (paletteKey(e)) return;
    if (inputHistory.handleKeyDown(e)) {
      setPaletteArmed(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const selectModel = (ref: ModelRef): void => tabModel.selectModel(ref);
  const selectEffort = (effort: string): void => tabModel.selectEffort(effort);
  const toggleFavorite = (key: string): void => {
    const favorites = new Set(preferences.favoriteModels);
    if (favorites.has(key)) {
      favorites.delete(key);
    } else {
      favorites.add(key);
    }
    update({ favoriteModels: [...favorites] });
  };

  const saveTemplate = (e: FormEvent): void => {
    e.preventDefault();
    const body = chatDraft.trim();
    if (!body) {
      return;
    }
    add({ title: templateTitle, body });
    setTemplateTitle('');
    setSavingTemplate(false);
  };

  return (
    // Chat keeps `flex-1 min-w-0` so the detail pane opens over its width rather
    // than pushing the column off-screen; the Leeboard panel is chat-scoped, not shell
    // state, so it lives here.
    <div className="flex h-full w-full min-w-0 gap-3">
    <section className="flex h-full min-w-0 flex-1 flex-col rounded-lg border border-border bg-surface/40">
      <header className="@container flex items-center gap-3 border-b border-border px-4 py-2.5 font-mono text-sm tracking-widest text-accent">
        <span className="shrink-0">CHAT</span>
        {/* Session title and working folder, from pi's session info (T1.4); a
            tab with no conversation yet names itself and the tab's folder. */}
        <span
          className="flex min-w-0 max-w-[48ch] items-baseline gap-2 truncate font-normal tracking-normal"
          title={`${barTitle}\n${barCwd}`}
        >
          <span className="truncate text-text" aria-label="Session title">
            {barTitle}
          </span>
          {/* With the Leeboard pane open the bar is half as wide; the folder is the
              lowest-value item, so it yields before the title does. */}
          {barCwd && (
            <span
              className="hidden shrink-0 text-xs text-muted @min-[48rem]:inline"
              aria-label="Working folder"
            >
              {folderOf(barCwd)}
            </span>
          )}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={startNewChat}
          title="Ctrl+N / Alt+N"
          className="shrink-0 whitespace-nowrap rounded border border-border px-3 py-1 font-mono text-xs tracking-normal text-muted hover:border-accent hover:text-accent"
        >
          ＋ new chat
        </button>
        <div className="shrink-0 font-normal tracking-normal">
          <HistoryPicker
            sessions={sessions}
            activePath={activeSessionPath}
            onOpen={(path) => {
              setNotice(null);
              void openChat(path).catch((error: unknown) => {
                // A chat whose recorded folder is gone for good is a user-facing
                // condition, not a silent failure: its sidecar message (e.g.
                // `folder no longer exists: …`) shows on the existing notice line.
                setNotice(error instanceof Error ? error.message : 'could not open chat');
              });
            }}
          />
        </div>
      </header>

      <AwayDigestCard onChat={transcript.jumpToLatest} />

      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          {...transcript.containerProps}
          aria-label="Transcript"
          className="h-full overflow-y-auto"
        >
          {/* One stable wrapper: the stick-to-bottom observer watches its size. */}
          <div className="flex min-h-full min-w-0 flex-col gap-4 p-4">
            {nothingToShow ? (
              <p className="m-auto font-mono text-sm text-muted">
                speak to the runtime
                {liveModel !== null && ` — ${agent.name} is driving ${liveModel}`}
                {noPiModel && ' — no pi model configured; set one in pi or FUNKYOCTOPUS_MODEL'}
              </p>
            ) : (
              messages.map((item) => {
                if (isChatEventItem(item)) {
                  // Genuine semantic redelivery and consecutive identical warnings
                  // are suppressed at this pure projection layer; the durable
                  // timeline is untouched.
                  if (crewState.hiddenResultIds.has(item.id) || crewState.hiddenWarningIds.has(item.id)) {
                    return null;
                  }
                  const enrichment = crewState.resultEnrichments.get(item.id);
                  return (
                    <CrewCard
                      key={item.id}
                      event={item}
                      showTimestamp={preferences.showTimestamps}
                      {...(enrichment ? { enrichment } : {})}
                    />
                  );
                }
                if (isCrewAuditItem(item)) {
                  // Historical pre-compaction crew activity survives as its own
                  // top-level item at its chronological position. The projection's
                  // settled-aware model carries any interrupted marking. When the
                  // carried call cannot be parsed as a recognized audit, the
                  // existing generic tool representation renders instead — never
                  // both, never nothing.
                  const audit =
                    crewState.audits.get(item.call.callId) ?? crewAuditFromRaw(item);
                  if (audit) {
                    return <CrewAuditCard key={item.id} audit={audit} />;
                  }
                  const { call, result } = crewAuditItemSteps(item);
                  return (
                    <ToolStep
                      key={item.id}
                      call={call}
                      result={result}
                      defaultOpen={preferences.toolStepsDefaultOpen}
                    />
                  );
                }
                return (
                  <MessageView
                    key={item.id}
                    message={item}
                    showTimestamp={preferences.showTimestamps}
                    toolStepsDefaultOpen={preferences.toolStepsDefaultOpen}
                    agentName={agent.name}
                    currentModel={liveModel}
                    models={models}
                    onResolveApproval={(requestId, approved) => {
                      void resolveApproval(requestId, approved);
                    }}
                    crewState={crewState}
                  />
                );
              })
            )}
          </div>
        </div>
        {!transcript.atBottom && (
          <button
            type="button"
            onClick={transcript.jumpToLatest}
            aria-label="Jump to latest"
            className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-accent bg-bg px-3 py-1 font-mono text-xs text-accent shadow backdrop-blur-sm hover:bg-accent/10"
          >
            ↓ {busy ? 'new output' : 'jump to latest'}
          </button>
        )}
      </div>

      <div className="border-t border-border p-3">
        <p className="mb-2 font-mono text-xs text-muted">
          {folder
            ? `PROJECT · ${folder.path} · TOOLS ON`
            : `GLOBAL · ${globalRoot || 'workspace'} · TOOLS ON`}
        </p>
        <CrewStrip agents={activeCrew} unread={crewUnread} />
        {queued.length > 0 && (
          <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1">
            {queued.map((q, i) => (
              <li
                key={q.id}
                className="flex items-center gap-2 rounded border border-dashed border-border px-2 py-1 font-mono text-xs"
              >
                <span className="shrink-0 text-muted">queued {i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-text" title={q.text}>
                  {q.text}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const taken = unqueue(q.id);
                    if (taken) restoreToComposer([taken]);
                  }}
                  aria-label={`Return queued message ${i + 1} to the composer`}
                  title="Return to the composer"
                  className="text-muted hover:text-text"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {queued.length > 0 && (
          <p className="mb-2 font-mono text-xs text-muted">
            sends when this turn ends · STOP returns it to the composer
          </p>
        )}
        {renaming && (
          <form onSubmit={submitRename} className="mb-2 flex gap-2">
            <input
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                // Cancels the rename only; a running turn is not stopped by it.
                e.preventDefault();
                setRenaming(false);
                composer.current?.focus();
              }}
              placeholder="name this chat…"
              aria-label="Chat name"
              autoFocus
              className="flex-1 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              className="rounded border border-accent px-3 font-mono text-xs text-accent hover:bg-accent/10"
            >
              RENAME
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              aria-label="Cancel renaming"
              className="rounded border border-border px-3 font-mono text-xs text-muted hover:text-text"
            >
              ✕
            </button>
          </form>
        )}
        {savingTemplate && (
          <form onSubmit={saveTemplate} className="mb-2 flex gap-2">
            <input
              value={templateTitle}
              onChange={(e) => setTemplateTitle(e.target.value)}
              placeholder="template title…"
              aria-label="Template title"
              autoFocus
              className="flex-1 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              className="rounded border border-accent px-3 font-mono text-xs text-accent hover:bg-accent/10"
            >
              SAVE
            </button>
            <button
              type="button"
              onClick={() => setSavingTemplate(false)}
              aria-label="Cancel saving template"
              className="rounded border border-border px-3 font-mono text-xs text-muted hover:text-text"
            >
              ✕
            </button>
          </form>
        )}

        <form
          onSubmit={submit}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex flex-col gap-2 rounded ${dragging ? 'bg-accent/5 ring-2 ring-accent/80' : ''}`}
        >
          {dragging && (
            <p className="font-mono text-xs text-accent">drop to attach (images, or paths as text)</p>
          )}
          {chatAttachments.length > 0 && (
            <ul aria-label="Attachments" className="flex flex-wrap items-center gap-2">
              {chatAttachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-1.5 rounded border border-border bg-bg px-1.5 py-1 font-mono text-xs text-text"
                >
                  {a.kind === 'image' ? (
                    <img
                      src={`data:${a.mimeType};base64,${a.data}`}
                      alt={a.name}
                      title={a.name}
                      className="h-12 w-12 rounded object-cover"
                    />
                  ) : (
                    // The basename is what identifies the file, so the directory
                    // is the part that truncates.
                    <span className="flex max-w-[48ch] items-baseline" title={a.path}>
                      <span className="shrink-0">📎&nbsp;</span>
                      <span className="min-w-0 truncate text-muted">
                        {a.path.slice(0, a.path.lastIndexOf('/') + 1)}
                      </span>
                      <span className="shrink-0">{a.path.slice(a.path.lastIndexOf('/') + 1)}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove attachment ${a.kind === 'image' ? a.name : a.path}`}
                    className="px-1 py-0.5 text-sm leading-none text-text hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(turnNotice ?? notice) && (
            <p className="font-mono text-xs text-text">{turnNotice ?? notice}</p>
          )}
          {!routeTakesImages && chatAttachments.some((a) => a.kind === 'image') && (
            <p role="alert" className="font-mono text-xs text-attention">
              ⚠ {liveModel} takes text only — pick an image-capable model or the image will not be
              seen
            </p>
          )}
          <div className="relative">
          {paletteQuery !== null && (
            <SlashPalette
              list={commandList}
              query={paletteQuery}
              matches={paletteMatches}
              selected={paletteSelected}
              onHover={setPaletteIndex}
              onPick={pickCommand}
            />
          )}
          <textarea
            ref={composer}
            value={chatDraft}
            onChange={(e) => {
              inputHistory.noteEdit();
              setChatDraft(e.target.value);
              setPaletteArmed(slashQuery(e.target.value) !== null);
              setPaletteIndex(0);
            }}
            aria-controls={paletteSelected >= 0 ? SLASH_LIST_ID : undefined}
            aria-activedescendant={paletteSelected >= 0 ? slashOptionId(paletteSelected) : undefined}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={markCrewSeen}
            placeholder={
              busy
                ? 'turn in progress — Enter queues the message for when it ends; Esc stops'
                : chatAttachments.length > 0
                  ? 'say something about the attachment…  (Enter to send)'
                  : 'message the runtime…  (Enter to send, Shift+Enter for newline · paste or drop images and paths)'
            }
            aria-label="Message"
            rows={2}
            className="w-full resize-none rounded border border-border bg-bg px-3 py-2 font-mono text-base text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          </div>

          <div className="flex items-center gap-2">
            <ModelPicker
              models={models}
              selected={chatModel}
              favorites={preferences.favoriteModels}
              onSelect={selectModel}
              onToggleFavorite={toggleFavorite}
            />
            <EffortPicker
              levels={effortLevels}
              selected={pick.effort}
              onSelect={selectEffort}
            />
            {chatDraft.trim() && !savingTemplate && (
              <button
                type="button"
                onClick={() => setSavingTemplate(true)}
                className="font-mono text-xs text-muted hover:text-accent"
              >
                ＋ template
              </button>
            )}

            <div className="flex-1" />

            {usage && <ContextMeter usage={usage} />}

            {busy ? (
              <button
                type="button"
                onClick={stop}
                title="Esc"
                className="rounded border border-danger px-5 py-1.5 font-mono text-sm text-danger hover:bg-danger/10"
              >
                STOP
              </button>
            ) : (
              <button
                type="submit"
                className="rounded border border-accent px-5 py-1.5 font-mono text-sm text-accent hover:bg-accent/10"
              >
                SEND
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
      <LeeboardPanel />
    </div>
  );
}
