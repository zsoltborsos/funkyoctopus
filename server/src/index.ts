import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionInfo, getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk';
import { MethodRegistry } from './transport/registry.ts';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { registerSystemSeam } from './seams/system.ts';
import { registerChatSeam } from './seams/chat.ts';
import { registerModelsSeam, unionModels, withDefaultModel } from './seams/models.ts';
import { registerLeeboardSeam } from './seams/leeboard.ts';
import { registerWorkflowSeam } from './seams/workflow.ts';
import { registerClaudeCodeSeam } from './seams/claude-code.ts';
import { registerSearchSeam } from './seams/search.ts';
import { ChatSearch } from './search/chat-search.ts';
import { projectPathIndex } from './projects/registry.ts';
import { ClaudeCodeStatus } from './claude-code/status.ts';
import { ClaudeCodeChat, type ClosedSessions } from './claude-code/chat.ts';
import { claudeSessionStore } from './claude-code/sessions.ts';
import { ChatRegistry } from './chat-registry.ts';
import { openSlots } from './chat-slots-file.ts';
import { FALLBACK_MODELS } from './claude-code/models.ts';
import { openClaudeModels } from './claude-code/models-file.ts';
import { openClaudeCommands } from './claude-code/commands-file.ts';
import { ModelCatalog } from './pi/model-catalog.ts';
import { PiChat } from './pi/pi-chat.ts';
import { resolvePiModel } from './pi/default-model.ts';
import { markPiReady } from './pi/pi-ready.ts';
import { HelmraiserCli } from './helmraiser/cli.ts';
import { HelmraiserWatcher } from './helmraiser/watcher.ts';
import { HelmraiserDesktopNotifier } from './helmraiser/desktop-notifier.ts';
import { registerHelmraiserEventsSeam } from './seams/helmraiser-events.ts';
import { startHealthProbes, trackBackend } from './health.ts';
import { HelmraiserFactory, vaultBeforeSpawn } from './helmraiser/factory.ts';
import { Upkeep, readEmbeddedSdkVersion, readGlobalPiVersion, runPiCommand } from './upkeep/upkeep.ts';
import { productionReadStableLatest } from './upkeep/detect.ts';
import { detectClaudeSdkDrift, productionClaudeSdkDriftDeps } from './upkeep/claude-sdk-drift.ts';
import { piUpdateDeferral, updatableExtensionPackages } from './upkeep/update-defer.ts';
import { crewActiveFor } from './pi/crew.ts';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  defaultEmbeddedState,
  loadEmbeddedState,
  type EmbeddedStateConfig,
  type EmbeddedStateFs,
} from './upkeep/embedded-state.ts';
import { ensureStateDir, repositoryStateDir } from './upkeep/state-path.ts';
import { VaultGuard } from './security/vault.ts';
import { messageOf } from './util/errors.ts';

const startedAt = Date.now();

// The state dir is derived from the canonical repository path, the same way
// the promotion tool in tools/pi-upkeep derives it, so both read and write
// the same embedded-state.json.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const embeddedStateFs: EmbeddedStateFs = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile,
  rename,
  unlink,
  mkdir,
  chmod,
};

/**
 * Resolves the durable embedded-state store, failing closed to memory-only
 * (no store) on any error so listen is never blocked by state issues.
 */
async function resolveEmbeddedState(): Promise<EmbeddedStateConfig | undefined> {
  try {
    const stateDir = await repositoryStateDir(repoRoot, { fs: { realpath } });
    await ensureStateDir(stateDir, embeddedStateFs);
    const loaded = await loadEmbeddedState(stateDir, embeddedStateFs);
    if (loaded.kind === 'invalid') {
      console.error(`funkyoctopus upkeep — embedded state invalid, starting fresh: ${loaded.reason}`);
    }
    return {
      stateDir,
      fs: embeddedStateFs,
      initial: loaded.kind === 'loaded' ? loaded.state : defaultEmbeddedState(),
    };
  } catch (error) {
    console.error(`funkyoctopus upkeep — no durable embedded state: ${messageOf(error)}`);
    return undefined;
  }
}

// helmraiser: the CLI is the only Helmraiser plane.
// The Vault must exist before the CLI: actions approve/reject/start/stop/pause/
// resume pass through the same guard as abort, while `status()` — the health
// probe — stays unguarded.
const helmraiserVault = await VaultGuard.create(
  () => Promise.reject(new Error(
    'Vault escalation requires interactive approval; Helmraiser actions are non-interactive',
  )),
  config.vaultPath,
);
const beforeSpawn = vaultBeforeSpawn(helmraiserVault);
const helmraiserCli = new HelmraiserCli(undefined, beforeSpawn);
// Desktop notifications ride the same watcher events the browser streams, so
// both deliveries agree on what was already reported.
const desktopNotifier = new HelmraiserDesktopNotifier(config.desktopNotifications);
// One always-running watcher over `helmraiser status --json`: parked and failed
// runs become helmraiser-event streams and, when enabled, desktop notifications —
// neither delivery needs a browser tab to be watching.
const helmraiserWatcher = new HelmraiserWatcher(
  () => helmraiserCli.status(),
  (event) => desktopNotifier.notify(event),
);
// Helmraiser is probed on start and on a slow cadence, so the status strip says
// "not running" rather than inferring liveness from a consumer call that failed
// for its own reasons. The probe timer is unref'd, so a dead backend cannot
// hold the process open.
startHealthProbes([() => helmraiserCli.status()]);
const helmraiserFactory = new HelmraiserFactory(
  undefined,
  beforeSpawn,
);
// pi model runtime, shared by the chat session and the model picker.
const catalog = new ModelCatalog();
// Claude Code, read-only: the status popover's source, and the engine's picture of which
// sessions are running.
const claudeStatus = new ClaudeCodeStatus({ bin: config.claudeBin, version: config.version, query, listSessions });

// The checkout's state dir: upkeep's embedded state and the chat slots both live there.
const embeddedState = await resolveEmbeddedState();
// The chat tabs the last run had (T2.3): UI state only, armed below, never started.
// Locked to this sidecar: a second one from this checkout starts with main only and records nothing.
const savedSlots = embeddedState
  ? await openSlots(embeddedState.stateDir).catch((error: unknown) => {
      console.warn(`[chats] chat tabs are not kept across restarts: ${messageOf(error)}`);
      return null;
    })
  : null;
for (const warning of savedSlots?.warnings ?? []) console.warn(`[chats] ${warning}`);
if (!embeddedState) console.warn('[chats] no state dir: chat tabs are not kept across restarts');

// Chat slots (decision 13). `main` always exists and is answered by pi, or by
// Claude Code on the owner's own sign-in (FUNKYOCTOPUS_CHAT_ENGINE, read here,
// so switching it is a restart; decision 12).
const claudeSessions = claudeSessionStore({
  listSessions,
  getSessionInfo,
  getSessionMessages,
  // Opening or starting a session reads fresh; a send into a running process takes the cached listing.
  live: (fresh) => claudeStatus.live(fresh),
});
// One just-closed map for every Claude slot: slot B opening what slot A closed a moment ago must not fork it.
const claudeClosed: ClosedSessions = new Map();
// The models one Claude slot's process listed, offered by every Claude slot and by models.list.
// The last run's list (kept in the state dir) stands in until a live process lists them again;
// nothing is started here to ask.
const savedModels = await openClaudeModels(embeddedState?.stateDir ?? null);
for (const warning of savedModels.warnings) console.warn(`[models] ${warning}`);
const claudeModels = savedModels.cache;
// The command lists Claude processes gave, per folder: what a Claude tab with no process offers
// in its `/` palette. Kept beside the models; nothing is started to ask (decision 12).
const savedCommands = await openClaudeCommands(embeddedState?.stateDir ?? null);
for (const warning of savedCommands.warnings) console.warn(`[commands] ${warning}`);
const chats = new ChatRegistry({
  mainKind: config.chatEngine,
  maxSlots: config.maxChats,
  maxClaudeRunning: config.maxClaudeRunning,
  restored: savedSlots?.records ?? [],
  factories: {
    pi: (slot) => {
      const piChat = new PiChat(catalog, undefined, undefined, undefined, undefined, undefined, {
        ...(slot.root !== null ? { root: slot.root } : {}),
        fresh: slot.fresh,
        crew: slot.crew,
        claim: slot.claim,
      });
      // A first-start `main` builds its session now rather than on the first message; a new slot
      // starts fresh, lazily, and a restored one only arms (limit 2).
      if (!slot.fresh && !slot.restored) piChat.prewarm();
      return piChat;
    },
    // Started lazily, on the first send: nothing spawns `claude` at boot.
    'claude-code': (slot) =>
      new ClaudeCodeChat({
        query,
        bin: config.claudeBin,
        version: config.version,
        idleMs: config.claudeIdleMs,
        sessions: claudeSessions,
        closed: claudeClosed,
        modelCache: claudeModels,
        commandCache: savedCommands.cache,
        claim: slot.claim,
        release: slot.release,
        mayStart: slot.mayStartClaude,
        fresh: slot.fresh,
        ...(slot.root !== null ? { root: slot.root } : {}),
      }),
  },
});
// Restore arms what the tabs held, before anything can talk to them.
await chats.armRestored();
const slotsWriter = savedSlots?.writer(() => chats.records()) ?? null;
chats.onSlots(() => slotsWriter?.schedule());
// pi is in the status strip while some slot runs it: never started, its seeded `unknown` would sit there for good.
const trackPi = (): void => trackBackend('pi', chats.hasKind('pi'));
trackPi();
chats.onSlots(trackPi);
// Restored pi tabs build nothing at boot; the catalog says whether pi can run, without a session.
// The model is the one the main slot's pi session would pick (env, then pi's own settings).
const resolveMainPiModel = () =>
  resolvePiModel(
    { provider: config.piProvider, model: config.piModel },
    SettingsManager.create(config.primaryWorkspaceRoot, getAgentDir()),
  );
if (chats.hasKind('pi')) {
  void markPiReady(catalog, resolveMainPiModel);
}
// Both engines' models, tagged by provider; the browser shows a slot only its own engine's.
// pi's default model is marked on its entry, so the browser names no model of its own.
const modelLister = unionModels(withDefaultModel(catalog, resolveMainPiModel), {
  list: () => Promise.resolve(claudeModels.models ?? FALLBACK_MODELS),
});

const registry = new MethodRegistry();
// upkeep: automatic `pi update --all` after every startup and every 24h while
// the sidecar stays alive. Every outcome is a cached status, never an
// exception, and the updater never touches the repository — no npm, no
// embedded SDK bump, no sidecar restart.
const upkeep = new Upkeep({
  disabled: config.upkeepDisabled,
  intervalMs: config.upkeepIntervalMs,
  runUpdate: (signal) => runPiCommand(['update', '--all'], signal),
  readGlobalVersion: readGlobalPiVersion,
  readEmbeddedVersion: readEmbeddedSdkVersion,
  readInstalledVersion: readEmbeddedSdkVersion,
  readStableLatest: productionReadStableLatest(),
  readClaudeSdk: () => detectClaudeSdkDrift(productionClaudeSdkDriftDeps(process.env, config.version)),
  ...(embeddedState !== undefined ? { embeddedState } : {}),
  // Waits only while crew work runs and an updatable extension package is installed (update-defer.ts).
  deferUpdate: () => piUpdateDeferral(chats.list(), crewActiveFor, () => updatableExtensionPackages(getAgentDir())),
});
registerSystemSeam(registry, startedAt, upkeep, config.desktopNotifications);
// claude code: read-only awareness (plan, quota, running and recent sessions)
// from the owner's installed `claude`; no model turns, no login, no credential
// file (CURRENT_STATE decision 12).
registerClaudeCodeSeam(registry, claudeStatus);
registerChatSeam(registry, chats, undefined, undefined, claudeSessions);
// Stored-chat search (T2.5): the index is read on the first search, never at boot.
registerSearchSeam(
  registry,
  new ChatSearch({
    sessionRoot: join(getAgentDir(), 'sessions'),
    claude: claudeSessions,
    projectPaths: () => projectPathIndex(),
  }),
);
registerModelsSeam(registry, modelLister);
registerLeeboardSeam(registry, chats);
registerWorkflowSeam(registry, helmraiserFactory, helmraiserCli);
registerHelmraiserEventsSeam(registry, helmraiserWatcher);

const app = await createApp(registry, config.wsAllowedOrigins, config.serveUiDir);
await app.listen({ host: config.host, port: config.port });
app.log.info(`chat engine: ${config.chatEngine}`);
app.log.info(`funkyoctopus sidecar ready — methods: ${registry.names().join(', ')}`);

// Upkeep starts only after a successful listen and never blocks the ready path.
void upkeep.startup();
// The Helmraiser watcher starts after listen for the same reason, and dispose()
// joins shutdown ahead of the app close.
helmraiserWatcher.start();

// Idempotent shutdown: end every chat slot (pi sessions quit, Claude Code processes close),
// dispose the upkeep timer, close the app.
const shutdown = (): void => {
  // Recorded as they stand, before disposing empties the registry.
  void (slotsWriter?.close() ?? Promise.resolve()).finally(() => savedSlots?.release());
  void chats.dispose();
  helmraiserWatcher.dispose();
  upkeep.dispose();
  void app.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
