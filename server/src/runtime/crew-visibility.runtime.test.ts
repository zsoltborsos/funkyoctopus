/**
 * Verify the *delivered* in-session crew visibility
 * contract end-to-end, opt-in via `npm run test:runtime`, against pi-crew
 * 1.0.34's result protocol.
 *
 * A production PiChat parent is driven through a thin in-process
 * ChatOrchestrator adapter into the real browser ChatSession service, so the
 * same live ChatChunks and `chat.observe` stream feed `messages`, `activeCrew`
 * and unread. Under 1.0.34 a successful cycle (`completed` / `needs_input`)
 * crew-result leaves the agent open, visible and active until the owner closes
 * it with `crew_done`; aborts are no longer crew-result custom messages. The
 * suite verifies exactly that lifecycle:
 *
 * - one spawned scout waits (public bounded bash sentinel) for a release file
 *   the test creates only after the parent turn ends, guaranteeing the
 *   successful `completed` crew-result arrives through the observation after
 *   the request stream ended;
 * - the spawned agent's active row remains and carries the completed status;
 * - the owner closes that exact id with `crew_done`, producing a successful
 *   `{"subagent_id":"..."}` acknowledgement, and the active row is removed.
 *   pi-crew delivers the result with `triggerTurn`, so the owner may close it
 *   in that triggered turn (the cockpit sees only pi-crew's `crew-status`
 *   snapshot) or, if it does not, in a parent turn the suite requests;
 * - reopening the stored session still renders the stored result exactly once
 *   and never reconstructs a live row.
 *
 * Budget (shared by this file, one invocation):
 *   - exactly one logical parent session (disposed/reopened via production APIs);
 *   - <= 1 actual crew_spawn execution, counted from public
 *     `tool_execution_start` ids (target exactly 1 after success);
 *   - <= 5 real parent/auto turns, 120s per parent turn, <= 20min file time;
 *   - failure-safe exact cleanup and zero tracked leaks/temp resources.
 *
 * No private state, terminal parsing, polling APIs, or node_modules patches.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentSession,
  type AgentSessionEvent,
  type CustomMessageEntry,
} from '@earendil-works/pi-coding-agent';
import {
  ChatSession,
  type ChatSessionSnapshot,
} from '../../../src/features/chat/chat-session.service.ts';
import type {
  ChatOrchestrator,
  ChatHandlers,
  ChatObservationHandlers,
  ChatTurnOptions,
} from '../../../src/features/chat/chat-orchestrator.client.ts';
import { projectCrewAudits } from '../../../src/features/chat/crew-audit.ts';
import type {
  ChatEventItem,
  ChatOpenResult,
  ChatSessionInfo,
  ChatStep,
  ChatTimelineItem,
  ProjectOption,
} from '../../../src/shared/transport/protocol.ts';
import type { ModelCatalog } from '../pi/model-catalog.ts';
import type { PiChat } from '../pi/pi-chat.ts';
import {
  createRuntimeSessionDirectory,
  createRuntimeTempDirectory,
  createRuntimeVaultFile,
  disposeAllRuntimeChats,
  disposeRuntimeChat,
  runtimeChatCounts,
  trackRuntimeChat,
} from '../test/runtime-env.ts';
import { assertRuntimePinAvailable, resolveRuntimePin } from '../test/runtime-preflight.ts';

// Dynamic imports only — `config.ts` snapshots its env at import, so the pin
// and Vault env must be set before the production modules are evaluated.
let PiChatClass: typeof PiChat;
let ModelCatalogClass: typeof ModelCatalog;
let catalog: ModelCatalog;
let pin: { provider: string; id: string };

/** Shared invocation budget. */
const MAX_TURNS = 5;
const MAX_SPAWNS = 1;
const TURN_TIMEOUT_MS = 120_000;
const FILE_TIMEOUT_MS = 20 * 60_000;
/** Bounded wait for an asynchronous crew-result through the observation. */
const RESULT_WAIT_TIMEOUT_MS = 180_000;
/** Bounded wait for the owner's crew_done acknowledgement to land. */
const DONE_WAIT_TIMEOUT_MS = 60_000;

/** Public bounded sentinel window the scout waits on via its public bash tool. */
const SENTINEL_ONE = 'phase6-release-1';
const SENTINEL_ONE_CMD = `for i in $(seq 1 150); do [ -f "${SENTINEL_ONE}" ] && break; sleep 1; done`;
/** The parent model must report this literal acknowledgement after crew_done. */
const DONE_SUCCESS_MARKER = 'phase6 done acknowledgement ok';

let streamedTurns = 0;
let autoRuns = 0;
let agentEndCount = 0;
/** First recorded turn-budget violation (bounded, recorded not thrown from the
 *  pi listener dispatch). */
let turnBudgetViolation: string | null = null;
let sessionGeneration = 0;
const spawnExecutionCallIds = new Set<string>();
const spawnIds = new Set<string>();
const toolActions: string[] = [];

function totalTurns(): number {
  return streamedTurns + autoRuns;
}

function assertTotalTurnsWithinBudget(): void {
  if (totalTurns() > MAX_TURNS) {
    throw new Error(
      `crew-visibility suite exceeded its ${MAX_TURNS}-turn budget ` +
        `(${streamedTurns} streamed + ${autoRuns} auto turns)`,
    );
  }
}

/** Throw a recorded turn-budget violation cleanly, outside pi callbacks. */
function checkTurnBudgetViolation(): void {
  if (turnBudgetViolation) throw new Error(turnBudgetViolation);
}

type SpawnStepCall = Extract<ChatStep, { kind: 'tool-call' }>;
type SpawnStepResult = Extract<ChatStep, { kind: 'tool-result' }>;

/** A newly executed tool action: the new call plus its matching result. */
interface NewToolAction {
  call: SpawnStepCall;
  result?: SpawnStepResult;
}

/**
 * Test-only bridge from the production PiChat async generators to the real
 * browser ChatSession service callbacks. Faithful cancellation and observe
 * cleanup; exposes no private production state. An aborted stream never emits
 * a false onDone.
 */
class RuntimeChatOrchestrator {
  private readonly controllers = new Set<AbortController>();
  /** True while a send drain is running (auto-turn accounting). */
  sending = false;
  /** Number of send() invocations (browser-triggered turns). */
  sendCalls = 0;
  /** Epoch ms of the most recent send's onDone (parent turn completion). */
  lastSendDoneAt: number | null = null;

  constructor(private readonly chat: PiChat) {}

  discoverProjects(): Promise<ProjectOption[]> {
    throw new Error('discoverProjects is not used by the runtime crew suite');
  }
  setRoot(path: string | null): Promise<ChatTimelineItem[]> {
    return this.chat.setRoot(path);
  }
  newChat(): Promise<ChatSessionInfo | null> {
    return this.chat.newChat();
  }
  openChat(path: string): Promise<ChatOpenResult> {
    return this.chat.openChat(path).then((items) => ({ items }));
  }
  listChats(root: string | null): Promise<ChatSessionInfo[]> {
    return this.chat.listChats(root);
  }
  currentChat(): Promise<ChatSessionInfo | null> {
    return this.chat.current();
  }
  resolveApproval(requestId: string, approved: boolean): Promise<boolean> {
    return Promise.resolve(this.chat.resolveApproval(requestId, approved));
  }

  send(text: string, handlers: ChatHandlers, opts: ChatTurnOptions = {}): () => void {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.sendCalls += 1;
    this.sending = true;
    streamedTurns += 1;
    assertTotalTurnsWithinBudget();
    void (async () => {
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const chunk of this.chat.send(text, controller.signal, opts)) {
          handlers.onChunk(chunk);
        }
        if (!aborted) {
          handlers.onDone();
          this.lastSendDoneAt = Date.now();
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          handlers.onError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        this.sending = false;
        this.controllers.delete(controller);
      }
    })();
    return () => {
      if (this.controllers.delete(controller)) {
        controller.abort();
      }
    };
  }

  observe(handlers: ChatObservationHandlers): () => void {
    const controller = new AbortController();
    this.controllers.add(controller);
    void (async () => {
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const chunk of this.chat.observe(controller.signal)) {
          handlers.onChunk(chunk);
        }
        if (!aborted) handlers.onEnd();
      } catch {
        handlers.onEnd();
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        this.controllers.delete(controller);
      }
    })();
    return () => {
      if (this.controllers.delete(controller)) {
        controller.abort();
      }
    };
  }

  /** Abort every live stream (failure-safe cleanup). */
  dispose(): void {
    for (const controller of [...this.controllers]) {
      this.controllers.delete(controller);
      controller.abort();
    }
  }
}

let trackedChat: PiChat | null = null;
let adapter: RuntimeChatOrchestrator | null = null;
let chatSession: ChatSession | null = null;
let unsubscribeSession: (() => void) | null = null;
let unsubscribeSnapshots: (() => void) | null = null;
const snapshots: ChatSessionSnapshot[] = [];

/** Session-level listener: spawn executions + auto-turn/agent-end accounting. */
function onSessionEvent(event: AgentSessionEvent): void {
  if (event.type === 'tool_execution_start' && event.toolName === 'crew_spawn') {
    spawnExecutionCallIds.add(event.toolCallId);
  }
  if (event.type === 'agent_start') {
    if (adapter && !adapter.sending) autoRuns += 1;
    // Never throw from the pi callback dispatch: record a bounded violation
    // that the wait/prompt boundaries throw cleanly outside pi.
    if (turnBudgetViolation === null && totalTurns() > MAX_TURNS) {
      turnBudgetViolation =
        `turn budget exceeded (${totalTurns()} > ${MAX_TURNS}: ${streamedTurns} streamed + ${autoRuns} auto turns)`;
    }
  }
  if (event.type === 'agent_end') agentEndCount += 1;
}

/** The session under test must be built on the exact configured pin — never a fallback. */
function assertPinned(session: AgentSession | null): asserts session is AgentSession {
  expect(session).not.toBeNull();
  expect(session!.model?.provider).toBe(pin.provider);
  expect(session!.model?.id).toBe(pin.id);
}

/**
 * (Re)bind the session listener to the CURRENT live session — after the
 * initial construction and after every dispose/open. Unsubscribes the old
 * listener, obtains and pin-asserts the live session, subscribes, and returns
 * it. Call before any subsequent parent send so auto-turn accounting always
 * follows the active session.
 */
async function bindLiveListener(): Promise<AgentSession> {
  unsubscribeSession?.();
  unsubscribeSession = null;
  const chat = trackedChat;
  if (!chat) throw new Error('tracked chat not initialized');
  const session = await chat.liveSession();
  assertPinned(session);
  sessionGeneration += 1;
  unsubscribeSession = session.subscribe(onSessionEvent);
  return session;
}

/** Bounded wait for a ChatSession snapshot predicate. No unbounded sleeps. */
async function waitForSnapshot(
  cs: ChatSession,
  predicate: (snapshot: ChatSessionSnapshot) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkTurnBudgetViolation();
    if (predicate(cs.getSnapshot())) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}\n${boundedEvidence()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function collectToolCalls(snapshot: ChatSessionSnapshot): Map<string, SpawnStepCall> {
  const calls = new Map<string, SpawnStepCall>();
  for (const item of snapshot.messages) {
    if ('role' in item) {
      for (const step of item.steps) {
        if (step.kind === 'tool-call') calls.set(step.callId, step);
      }
    }
  }
  return calls;
}

function toolResultFor(snapshot: ChatSessionSnapshot, callId: string): SpawnStepResult | undefined {
  for (const item of snapshot.messages) {
    if ('role' in item) {
      const result = item.steps.find(
        (step): step is SpawnStepResult =>
          step.kind === 'tool-result' && step.callId === callId,
      );
      if (result) return result;
    }
  }
  return undefined;
}

/**
 * Drive one requested tool action. Baselines the callIds already present,
 * runs the prompt (up to one retry ONLY when the attempt executed no matching
 * call), and returns the NEW matching call + result — never a historical call.
 * More than one matching call in a single turn fails/caps immediately.
 */
async function promptToolAction(
  text: string,
  retryText: string,
  tool: string,
  label: string,
): Promise<NewToolAction> {
  const cs = chatSession;
  if (!cs) throw new Error('chatSession not initialized');
  const before = collectToolCalls(cs.getSnapshot());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    checkTurnBudgetViolation();
    cs.send(attempt === 0 ? text : retryText);
    await waitForSnapshot(cs, (s) => !s.busy, TURN_TIMEOUT_MS, `parent turn "${label}"`);
    const calls = [...collectToolCalls(cs.getSnapshot()).values()].filter(
      (call) => !before.has(call.callId) && call.tool === tool,
    );
    if (calls.length > 1) {
      throw new Error(
        `more than one ${tool} call executed in a single turn (${calls.map((c) => c.callId).join(', ')})\n${boundedEvidence()}`,
      );
    }
    const call = calls[0];
    if (!call) continue; // no call executed — the one sanctioned retry
    const result = toolResultFor(cs.getSnapshot(), call.callId);
    toolActions.push(`${tool}:${call.callId}:${result?.ok ? 'ok' : result ? 'error' : 'pending'}`);
    return result ? { call, result } : { call };
  }
  throw new Error(`model did not call ${tool} in 2 attempts\n${boundedEvidence()}`);
}

/**
 * The persisted successful `crew_done` result for `agentId`, if the owner
 * already closed it — the triggered turn's tool activity is not streamed to
 * the browser, so the stored session is its public record.
 */
function persistedDoneAck(
  session: AgentSession,
  agentId: string,
): { callId: string; output: string } | undefined {
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'toolResult' || message.toolName !== 'crew_done' || message.isError) continue;
    const output = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    if (output.includes(`"subagent_id":"${agentId}"`)) return { callId: message.toolCallId, output };
  }
  return undefined;
}

/** The spawned agent's id: `subagent_id` (pi-crew 1.0.34) or `id` (1.0.28). */
function spawnedId(details: unknown): string | undefined {
  const record = details as { subagent_id?: string; id?: string } | undefined;
  return record?.subagent_id ?? record?.id;
}

/** Spawn: retry only if no call executed; an executed-but-failed/malformed
 *  spawn fails immediately rather than risking a second spawn. */
async function promptSpawn(text: string, retryText: string, label: string): Promise<NewToolAction> {
  const action = await promptToolAction(text, retryText, 'crew_spawn', label);
  if (!action.result || !action.result.ok) {
    throw new Error(
      `crew_spawn executed but returned no successful result — failing rather than risking >${MAX_SPAWNS} spawns\n${boundedEvidence()}`,
    );
  }
  const id = spawnedId(action.result.details);
  if (typeof id !== 'string' || !id) {
    throw new Error(`crew_spawn result carried no structured id\n${boundedEvidence()}`);
  }
  return action;
}

function isEventItem(item: ChatTimelineItem): item is ChatEventItem {
  return 'kind' in item && item.kind === 'custom-message';
}

function crewResultEvents(items: ChatTimelineItem[]): ChatEventItem[] {
  return items.filter(
    (item): item is ChatEventItem => isEventItem(item) && item.customType === 'crew-result',
  );
}

function eventDetails(event: ChatEventItem): { agentId?: string; status?: string } {
  return typeof event.details === 'object' && event.details !== null
    ? (event.details)
    : {};
}

/**
 * Honest parent/auto-run accounting is the streamed-send counter plus the
 * session listener's auto-run counter; both are asserted against MAX_TURNS in
 * afterAll and at every bounded wait boundary.
 */
function boundedEvidence(): string {
  const s = chatSession?.getSnapshot();
  const kinds = new Map<string, number>();
  for (const item of s?.messages ?? []) {
    const key = 'role' in item ? `message:${item.role}` : item.kind;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  return [
    `turns: ${streamedTurns} streamed + ${autoRuns} auto = ${totalTurns()}/${MAX_TURNS}`,
    `turn budget violation: ${turnBudgetViolation ?? 'none'}`,
    `agent ends observed: ${agentEndCount}`,
    `session rebinds: ${sessionGeneration}`,
    `spawn executions: ${spawnExecutionCallIds.size}/${MAX_SPAWNS}`,
    `bound spawn ids: ${[...spawnIds].join(', ') || 'none'}`,
    `tool actions: ${toolActions.join(', ') || 'none'}`,
    `crewUnread: ${s?.crewUnread ?? 'n/a'}`,
    `activeCrew: ${
      (s?.activeCrew ?? []).map((a) => `${a.agentName}:${a.agentId ?? '?'}:${a.status}`).join(', ') || '[]'
    }`,
    `message kinds: ${[...kinds.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `last send done at: ${adapter?.lastSendDoneAt ?? 'never'}`,
    `snapshots recorded: ${snapshots.length}`,
  ].join('; ');
}

beforeAll(async () => {
  pin = resolveRuntimePin();
  process.env.FUNKYOCTOPUS_PROVIDER = pin.provider;
  process.env.FUNKYOCTOPUS_MODEL = pin.id;
  process.env.FUNKYOCTOPUS_VAULT_PATH = await createRuntimeVaultFile();

  ({ PiChat: PiChatClass } = await import('../pi/pi-chat.ts'));
  ({ ModelCatalog: ModelCatalogClass } = await import('../pi/model-catalog.ts'));
  catalog = new ModelCatalogClass();
  await assertRuntimePinAvailable(catalog, pin);
});

afterAll(async () => {
  unsubscribeSession?.();
  unsubscribeSession = null;
  unsubscribeSnapshots?.();
  unsubscribeSnapshots = null;
  adapter?.dispose();
  adapter = null;
  await disposeAllRuntimeChats();
  const counts = runtimeChatCounts();
  console.info(
    `[crew-visibility] turns: ${streamedTurns} streamed + ${autoRuns} auto = ${totalTurns()}/${MAX_TURNS}; ` +
      `agent ends observed: ${agentEndCount}; ` +
      `crew_spawn executions: ${spawnExecutionCallIds.size}/${MAX_SPAWNS}; ` +
      `chats constructed: ${counts.constructed}, disposed: ${counts.disposed}, ` +
      `sessions disposed: ${counts.sessionsDisposed}, still tracked: ${counts.tracked}`,
  );
  // Plan-wide live budget: at most one actual crew_spawn execution per
  // invocation, counted once per toolCallId from public session tool events.
  expect(spawnExecutionCallIds.size).toBeLessThanOrEqual(MAX_SPAWNS);
  // Every run on this session — streamed or auto — fits the turn budget.
  expect(totalTurns()).toBeLessThanOrEqual(MAX_TURNS);
  expect(turnBudgetViolation).toBeNull();
  // Failure-safe teardown accounting must be exact-once and leak-free.
  expect(counts.tracked).toBe(0);
  expect(counts.disposed).toBe(counts.constructed);
  expect(counts.sessionsDisposed).toBeLessThanOrEqual(counts.disposed);
});

describe('Phase 6 — verify the delivered in-session crew visibility contract', () => {
  it('preflights the exact configured pin before any session exists', () => {
    expect(pin).toEqual(resolveRuntimePin());
  });

  it(
    'drives the production parent through the real browser ChatSession service end-to-end',
    async () => {
      const cwd = await createRuntimeTempDirectory('funkyoctopus-phase6-cwd-');
      const sessionDir = await createRuntimeSessionDirectory();
      const probeFiles = [
        'probe-a.txt',
        'probe-b.txt',
        'probe-c.txt',
        'probe-d.txt',
      ];
      for (const name of probeFiles) {
        await writeFile(join(cwd, name), `marker-${name}\n`);
      }

      const chat = trackRuntimeChat(
        new PiChatClass(catalog, undefined, undefined, sessionDir),
      );
      trackedChat = chat;
      // Re-root the production construction path into the isolated cwd; this also
      // builds the session (setRoot reads the transcript), so prewarm is a no-op.
      await chat.setRoot(cwd);
      chat.prewarm();

      let session = await bindLiveListener();
      const sessionFile = session.sessionManager.getSessionFile();
      expect(sessionFile).toBeTruthy();
      expect(session.getActiveToolNames()).toContain('crew_spawn');

      adapter = new RuntimeChatOrchestrator(chat);
      chatSession = new ChatSession(adapter as unknown as ChatOrchestrator);
      // Model the open chat panel: viewing from construction, so observation
      // of results never creates unread.
      chatSession.setCrewViewed(true);
      // Snapshot subscription for lifecycle evidence rather than one final state.
      unsubscribeSnapshots = chatSession.subscribe(() => {
        snapshots.push(chatSession!.getSnapshot());
      });
      // The observation stream is subscribed in the ChatSession constructor —
      // active before any send.

      try {
        // ============ Spawn #1: successful result after the parent turn ends ============
        const actionOne = await promptSpawn(
          'Use the crew_spawn tool exactly once to spawn the scout subagent with: ' +
            'brief "phase6: wait for release then read four probe files", and task ' +
            '{"goal":"Report the contents of probe-a.txt, probe-b.txt, probe-c.txt and probe-d.txt verbatim.",' +
            '"context":["The four probe files exist in the current working directory.",' +
            '"A release sentinel file named phase6-release-1 will appear in the current working directory; wait for it before reading."],' +
            '"instructions":["First run this exact bash command in the current working directory to wait for the release sentinel: ' +
            SENTINEL_ONE_CMD + '",' +
            '"Read probe-a.txt with the read tool, then probe-b.txt, then probe-c.txt, then probe-d.txt, one at a time.",' +
            '"Reply with each file\'s contents verbatim on its own line, prefixed with the file name."]}. ' +
            'Then report the subagent id from the tool result and end your turn. Do not call any other tool.',
          'This is an explicit instruction: you MUST call the crew_spawn tool exactly once with ' +
            'subagent "scout", brief "phase6: wait for release then read four probe files", and the ' +
            'structured task given before (goal, context, instructions including the sentinel bash ' +
            'command). Report the subagent id from the tool result and end your turn.',
          'spawn #1',
        );
        const parentDoneAt = adapter.lastSendDoneAt!;
        expect(parentDoneAt).toBeGreaterThan(0);
        // The spawn call must retain the sentinel bash command in its task.
        expect(JSON.stringify(actionOne.call.args)).toContain(SENTINEL_ONE);
        const spawnOneId = spawnedId(actionOne.result!.details);
        expect(spawnOneId).toMatch(/^scout-[0-9a-f]{8}$/);
        spawnIds.add(spawnOneId!);

        // Active row: provisional row created by the spawn call, then bound by
        // the successful result — recorded across snapshots, not one final state.
        const provisional = snapshots.find((s) =>
          s.activeCrew.some((a) => a.callId === actionOne.call.callId && a.agentId === undefined),
        );
        const bound = snapshots.find((s) => s.activeCrew.some((a) => a.agentId === spawnOneId));
        expect(provisional).toBeDefined();
        expect(bound).toBeDefined();
        expect(bound!.activeCrew.find((a) => a.agentId === spawnOneId)?.status).toBe('running');

        // Release the sentinel ONLY after the parent turn ended and the row was
        // bound: the subagent's first public action is the bounded bash wait, so
        // the successful result is guaranteed to arrive after the request stream.
        await writeFile(join(cwd, SENTINEL_ONE), 'release\n');

        // The successful crew-result arrives through the observation stream —
        // no browser-triggered second model turn. Under pi-crew 1.0.34 the
        // successful cycle statuses are `completed` (accepted here) or
        // `needs_input` (would mean the scout ignored its instructions).
        const sendCallsBefore = adapter.sendCalls;
        await waitForSnapshot(
          chatSession,
          (s) =>
            crewResultEvents(s.messages).some(
              (e) =>
                eventDetails(e).agentId === spawnOneId &&
                (eventDetails(e).status === 'completed' || eventDetails(e).status === 'needs_input'),
            ),
          RESULT_WAIT_TIMEOUT_MS,
          `successful crew-result for ${spawnOneId}`,
        );
        const completed = crewResultEvents(chatSession.getSnapshot().messages).find(
          (e) => eventDetails(e).agentId === spawnOneId,
        );
        expect(completed).toBeDefined();
        expect(eventDetails(completed!).status).toBe('completed');
        expect(completed!.timestamp).toBeGreaterThan(parentDoneAt);
        // Exactly once despite any send+observe overlap.
        expect(
          crewResultEvents(chatSession.getSnapshot().messages).filter((e) => e.id === completed!.id),
        ).toHaveLength(1);

        // 1.0.34: a successful cycle result does NOT close the agent — the
        // row stays active and visible with the completed status until the
        // owner closes it with crew_done. Recorded across snapshots: the
        // owner's triggered turn may close it moments later.
        expect(
          snapshots.some((s) =>
            s.activeCrew.some((a) => a.agentId === spawnOneId && a.status === 'completed'),
          ),
        ).toBe(true);

        // The observation did not trigger a browser-side send, and the open
        // panel semantics mean the result never created unread.
        expect(adapter.sendCalls).toBe(sendCallsBefore);
        expect(chatSession.getSnapshot().crewUnread).toBe(0);

        // Persisted canonical id matches the timeline id.
        const persisted = session.sessionManager
          .getEntries()
          .find(
            (entry): entry is CustomMessageEntry =>
              entry.type === 'custom_message' &&
              entry.customType === 'crew-result' &&
              (entry.details as { agentId?: string }).agentId === spawnOneId,
          );
        expect(persisted).toBeDefined();
        expect(persisted!.id).toBe(completed!.id);

        // Audit/result task + duration correlation via the production projection.
        const auditState = projectCrewAudits(chatSession.getSnapshot().messages);
        const enrichment = auditState.resultEnrichments.get(completed!.id);
        expect(enrichment?.task).toBeTruthy();
        expect(enrichment?.durationMs).toBeGreaterThan(0);

        // ============ Owner closure: crew_done for the exact id ============
        // The result triggered an owner turn of its own; let it finish first.
        const live = session;
        await waitForSnapshot(
          chatSession,
          () => live.isIdle,
          TURN_TIMEOUT_MS,
          'the owner turn pi-crew triggered with the result',
        );
        const closedByTrigger = persistedDoneAck(session, spawnOneId!);
        if (closedByTrigger) {
          toolActions.push(`crew_done:${closedByTrigger.callId}:ok (triggered turn)`);
          expect(closedByTrigger.output).toContain('subagent_id');
        } else {
          const doneAction = await promptToolAction(
            `Call the crew_done tool exactly once for subagent id ${spawnOneId} to close it out. ` +
              `The tool result must acknowledge the subagent id; report it and end your turn with ` +
              `the exact line "${DONE_SUCCESS_MARKER}". Do not call any other tool.`,
            `This is an explicit instruction: you MUST call the crew_done tool exactly once with ` +
              `subagent_id ${spawnOneId}. Report the acknowledged subagent id from the tool result and ` +
              `end your turn with the exact line "${DONE_SUCCESS_MARKER}".`,
            'crew_done',
            'owner crew_done',
          );
          // A successful crew_done carries the 1.0.34 {"subagent_id":...} ack.
          expect(doneAction.result).toBeDefined();
          expect(doneAction.result!.ok).toBe(true);
          expect(doneAction.result!.output).toContain('subagent_id');
          // The model reported the sentinel acknowledgement after the closure.
          await waitForSnapshot(
            chatSession,
            (s) =>
              s.messages.some(
                (item) =>
                  'role' in item &&
                  item.steps.some(
                    (step) => step.kind === 'text' && step.text.includes(DONE_SUCCESS_MARKER),
                  ),
              ),
            DONE_WAIT_TIMEOUT_MS,
            'model-reported phase6 done acknowledgement',
          );
        }

        // The successful crew_done acknowledgement removes the active row.
        await waitForSnapshot(
          chatSession,
          (s) => !s.activeCrew.some((a) => a.agentId === spawnOneId),
          DONE_WAIT_TIMEOUT_MS,
          `active row removed after crew_done for ${spawnOneId}`,
        );
        // Closure removes the row, never the stored result.
        expect(
          crewResultEvents(chatSession.getSnapshot().messages).filter((e) => e.id === completed!.id),
        ).toHaveLength(1);

        // ============ Reopen the same logical parent session ============
        await chat.disposeLiveSession();
        await chatSession.openChat(sessionFile!);
        session = await bindLiveListener();
        // Reopening renders stored transcripts only: no live row is
        // reconstructed and unread is cleared.
        expect(chatSession.getSnapshot().activeCrew).toEqual([]);
        expect(chatSession.getSnapshot().crewUnread).toBe(0);
        // Durable custom event, deduplicated by stable id (one result).
        expect(
          crewResultEvents(chatSession.getSnapshot().messages).filter((e) => e.id === completed!.id),
        ).toHaveLength(1);
      } finally {
        // Evidence before teardown: it reads the adapter's send accounting.
        console.info('[crew-visibility] phase 6 evidence: ' + boundedEvidence());
        unsubscribeSnapshots?.();
        unsubscribeSnapshots = null;
        unsubscribeSession?.();
        unsubscribeSession = null;
        adapter?.dispose();
        adapter = null;
        await disposeChat(chat);
      }
    },
    FILE_TIMEOUT_MS,
  );
});

async function disposeChat(chat: PiChat): Promise<void> {
  await disposeRuntimeChat(chat);
}
