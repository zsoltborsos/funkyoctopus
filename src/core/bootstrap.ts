import { LocalStorageAdapter } from '@shared/storage/local-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { PROMPT_LIBRARY, PromptLibraryService } from '@features/prompts/prompt-library.service.ts';
import { INPUT_HISTORY, InputHistoryService } from '@features/chat/input-history.ts';
import { SYSTEM, SystemClient } from '@features/status/system.client.ts';
import { CLAUDE_CODE, ClaudeCodeClient } from '@features/claude-code/claude-code.client.ts';
import { CHAT_ORCHESTRATOR, ChatOrchestrator } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION, ChatSession } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS, ChatSessions } from '@features/chat/chat-sessions.service.ts';
import { TAB_MODEL, TAB_MODELS, TabModels } from '@features/chat/tab-models.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import {
  CHAT_ATTENTION_NOTIFICATIONS,
  ChatAttentionNotifications,
} from '@features/chat/chat-attention-notifications.service.ts';
import { MODELS, ModelsClient } from '@features/chat/models.client.ts';
import { CHAT_SEARCH, ChatSearchClient } from '@features/chat/chat-search.client.ts';
import { LEEBOARD, LeeboardClient } from '@features/chat/leeboard-panel/leeboard.client.ts';
import { WORKFLOW, WorkflowClient } from '@features/jobs/workflow.client.ts';
import { HELMRAISER_MONITOR, HelmraiserMonitor } from '@features/jobs/helmraiser-monitor.service.ts';
import { HELMRAISER_NOTIFICATIONS, HelmraiserNotifications } from '@features/jobs/helmraiser-notifications.service.ts';
import { AWAY_DIGEST, AwayDigest } from '@features/chat/away-digest.ts';
import { TRANSPORT, TransportClient, sidecarUrl } from '@core/transport/transport-client.ts';
import { Container } from './container/container.ts';

/**
 * Wires the concrete adapters into a container. This is the single place that
 * knows which real implementation sits behind each seam — swap a line here and
 * the whole app follows, with no UI change. Tests register their own fakes and
 * never call this.
 *
 * As seams land (pi runtime, Leeboard, helmraiser orchestration), their
 * registrations join this function — each as a thin browser client that speaks
 * to the sidecar over the shared transport.
 */
export function registerServices(c: Container): void {
  const storage = new LocalStorageAdapter();
  c.register(PREFERENCES, () => new PreferencesService(storage));
  c.register(PROMPT_LIBRARY, () => new PromptLibraryService(storage));
  c.register(INPUT_HISTORY, () => new InputHistoryService(storage));

  const transport = new TransportClient(sidecarUrl());
  c.registerInstance(TRANSPORT, transport);
  c.register(SYSTEM, (c) => new SystemClient(c.resolve(TRANSPORT)));
  c.register(CLAUDE_CODE, (c) => new ClaudeCodeClient(c.resolve(TRANSPORT)));
  c.register(CHAT_SEARCH, (c) => new ChatSearchClient(c.resolve(TRANSPORT)));
  c.register(
    CHAT_ATTENTION_NOTIFICATIONS,
    (c) => new ChatAttentionNotifications(c.resolve(PREFERENCES)),
  );
  c.register(TAB_MODELS, () => new TabModels(storage));
  c.register(TAB_FOLDERS, () => new TabFolders(storage));
  // Chat tabs (T2.2): the chat services live in each tab's scope, never in the
  // app's container, so nothing can talk to a chat without naming its tab. The
  // views resolve them from the shown tab's scope (ActiveChatScope).
  c.register(CHAT_SESSIONS, (c) => {
    const transport = c.resolve(TRANSPORT);
    const attention = c.resolve(CHAT_ATTENTION_NOTIFICATIONS);
    const tabModels = c.resolve(TAB_MODELS);
    const tabFolders = c.resolve(TAB_FOLDERS);
    return new ChatSessions(
      transport,
      (chatId, hooks) => {
        const scope = new Container(c);
        const orchestrator = new ChatOrchestrator(transport, chatId);
        const session = new ChatSession(orchestrator, transport, crypto.randomUUID(), attention, hooks.focusHolder);
        scope.registerInstance(CHAT_ORCHESTRATOR, orchestrator);
        scope.registerInstance(CHAT_SESSION, session);
        scope.registerInstance(MODELS, new ModelsClient(transport, chatId));
        scope.registerInstance(LEEBOARD, new LeeboardClient(transport, chatId));
        scope.registerInstance(TAB_MODEL, tabModels.forTab(chatId, hooks.kind));
        scope.registerInstance(TAB_FOLDER, tabFolders.forTab(chatId));
        return { session, scope };
      },
      // Which tab a window shows is that window's own, kept across its reloads.
      new LocalStorageAdapter(sessionStorage),
      [tabModels, tabFolders],
    );
  });
  c.register(WORKFLOW, (c) => new WorkflowClient(c.resolve(TRANSPORT)));
  c.register(HELMRAISER_MONITOR, (c) => new HelmraiserMonitor(c.resolve(WORKFLOW)));
  c.register(HELMRAISER_NOTIFICATIONS, (c) =>
    new HelmraiserNotifications(
      c.resolve(WORKFLOW),
      c.resolve(SYSTEM),
      c.resolve(PREFERENCES),
      c.resolve(TRANSPORT),
    ));
  c.register(AWAY_DIGEST, (c) =>
    new AwayDigest(c.resolve(CHAT_SESSIONS), c.resolve(HELMRAISER_NOTIFICATIONS)),
  );
}
