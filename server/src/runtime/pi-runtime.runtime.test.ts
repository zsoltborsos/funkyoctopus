/**
 * Phase 4 — real pi runtime coverage, opt-in via `npm run test:runtime`.
 *
 * Nine scenarios exercise the production PiChat construction path against the
 * real embedded pi runtime and the exact pinned model. Structural exclusion is
 * enforced by vitest configs: the default `npm test` and `npm run verify`
 * never discover a `*.runtime.test.ts` file and never contact a model.
 *
 * Isolation and bounds:
 * - every scenario uses its own temp cwd, session store and Vault file;
 * - the pin is resolved by `resolveRuntimePin()` and preflighted before any
 *   session exists — exact model and auth or hard stop, no fallback;
 * - at most two prompt attempts elicit a required tool call;
 * - a full run is capped at MAX_TURNS cheap-model turns and TURN_TIMEOUT_MS
 *   per turn; every chat is tracked in a central registry and disposed exactly
 *   once, by the scenario afterAll or the file-level teardown on failure.
 */

import { existsSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentSession,
  ExtensionAPI,
  SessionEntry,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ChatChunk, ChatStep } from '../../../src/shared/transport/protocol.ts';
import { toMessages } from '../pi/session-transcript.ts';
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
  withCompactionTimeout,
} from '../test/runtime-env.ts';
import { assertRuntimePinAvailable, resolveRuntimePin } from '../test/runtime-preflight.ts';

// Dynamic imports only — `config.ts` snapshots its env at import, so the pin
// and Vault env must be set before the production modules are evaluated.
let PiChatClass: typeof PiChat;
let ModelCatalogClass: typeof ModelCatalog;
let catalog: ModelCatalog;
let pin: { provider: string; id: string };
let pinnedModel: NonNullable<Awaited<ReturnType<ModelCatalog['resolve']>>>;

// Turn budget. The nine scenarios need at least one real turn each and several
// need two, plus the sanctioned retries: one tool-elicitation retry where
// the model must call a specific tool (scenarios 3, 8, 9), one model-flake
// retry (scenario 2) and one compaction retry (scenario 7). Worst case that is
// 18 drains (2+2+2+2+2+3+2+3); the two observed full runs used 15. The cap is a
// bounded-spend guard, not a target — 20 leaves one spare turn above the worst
// case while keeping the run inside the cheap-model token budget. It
// intentionally exceeds the original "roughly 12" estimate: a lower cap would fail the
// suite whenever every sanctioned retry fires.
const MAX_TURNS = 20;
const TURN_TIMEOUT_MS = 120_000;
const COMPACTION_TIMEOUT_MS = 180_000;

let turnsUsed = 0;

function reserveTurn(): void {
  turnsUsed += 1;
  if (turnsUsed > MAX_TURNS) {
    throw new Error(`runtime suite exceeded its ${MAX_TURNS}-turn budget`);
  }
}

/** Stream one real turn, capped and aborted on timeout. */
async function drain(
  chat: PiChat,
  text: string,
  opts: { onChunk?: (chunk: ChatChunk) => void } = {},
): Promise<ChatChunk[]> {
  reserveTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of chat.send(text, controller.signal)) {
      chunks.push(chunk);
      opts.onChunk?.(chunk);
    }
  } catch (error) {
    throw new Error(
      `turn failed for "${text.slice(0, 64)}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) {
    throw new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s: "${text.slice(0, 64)}"`);
  }
  return chunks;
}

/** Like `drain`, but aborts intentionally once the first text delta arrives. */
async function drainUntilFirstText(chat: PiChat, text: string): Promise<ChatChunk[]> {
  reserveTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const chunks: ChatChunk[] = [];
  let textStarted = false;
  try {
    for await (const chunk of chat.send(text, controller.signal)) {
      chunks.push(chunk);
      if (chunk.kind === 'text' && !textStarted) {
        textStarted = true;
        controller.abort();
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return chunks;
}

/** Resolve every pending Vault approval-request chunk per the given policy. */
async function drainWithApprovalPolicy(
  chat: PiChat,
  text: string,
  approved: boolean,
): Promise<ChatChunk[]> {
  reserveTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of chat.send(text, controller.signal)) {
      chunks.push(chunk);
      if (chunk.kind === 'approval-request') {
        chat.resolveApproval(chunk.requestId, approved);
      }
    }
  } catch (error) {
    throw new Error(
      `approval turn failed for "${text.slice(0, 64)}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) {
    throw new Error(`approval turn timed out: "${text.slice(0, 64)}"`);
  }
  return chunks;
}

/** Up to `attempts` prompts until the chunk predicate holds; fails otherwise. */
async function promptForToolCall(
  chat: PiChat,
  text: string,
  retryText: string,
  predicate: (chunks: ChatChunk[]) => boolean,
): Promise<ChatChunk[]> {
  let last: ChatChunk[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await drain(chat, attempt === 0 ? text : retryText);
    if (predicate(last)) return last;
  }
  const summary = last
    .map((c) => JSON.stringify(c).slice(0, 160))
    .join('\n');
  throw new Error(`model did not satisfy the tool predicate in 2 attempts.\nChunks:\n${summary}`);
}

function toolCall(chunks: ChatChunk[], tool: string) {
  return chunks.find(
    (c): c is Extract<ChatChunk, { kind: 'tool-call' }> => c.kind === 'tool-call' && c.tool === tool,
  );
}

function toolResult(chunks: ChatChunk[], callId: string) {
  return chunks.find(
    (c): c is Extract<ChatChunk, { kind: 'tool-result' }> =>
      c.kind === 'tool-result' && c.callId === callId,
  );
}

/** The stored text of the most recent user message, byte-for-byte. */
function storedUserText(session: {
  sessionManager: { getEntries(): { type: string; message?: { role?: string; content?: unknown } }[] };
}): string {
  const entries = session.sessionManager.getEntries();
  const message = [...entries]
    .reverse()
    .find((e) => e.type === 'message' && e.message?.role === 'user')?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part as { type?: string; text?: string })
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  return '';
}

/**
 * Dispose a tracked chat exactly once. Delegates to the central registry in
 * `runtime-env`, so a double disposal (e.g. a scenario afterAll running after
 * an eager in-test dispose) is a no-op, and the file-level teardown catches any
 * chat a failing test never got to dispose.
 */
async function disposeChat(chat: PiChat): Promise<void> {
  await disposeRuntimeChat(chat);
}

/** The session under test must be built on the exact configured pin — never a fallback. */
function assertPinned(session: AgentSession | null): asserts session is AgentSession {
  expect(session).not.toBeNull();
  expect(session!.model?.provider).toBe(pin.provider);
  expect(session!.model?.id).toBe(pin.id);
}

/** Per-scenario fixture bundle. */
interface RuntimeFixture {
  cwd: string;
  sessionDir: string;
  chat: PiChat;
}

async function makeFixture(options: {
  settings?: { compaction: { keepRecentTokens: number; enabled: boolean } };
  /** Subdir of cwd the shared temp Vault escalates; written before session build. */
  escalate?: string;
} = {}): Promise<RuntimeFixture> {
  const cwd = await createRuntimeTempDirectory('funkyoctopus-runtime-cwd-');
  const sessionDir = await createRuntimeSessionDirectory();
  if (options.settings) {
    // Written before the session is built: `SettingsManager.create` snapshots
    // the project-local `.pi/settings.json` at session construction.
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'settings.json'), `${JSON.stringify(options.settings, null, 2)}\n`);
  }
  if (options.escalate) {
    // The production Vault guard reads its rules at session construction too,
    // so the escalation rule must exist before `setRoot` builds the session.
    const target = join(cwd, options.escalate);
    await mkdir(target, { recursive: true });
    await writeFile(
      process.env.FUNKYOCTOPUS_VAULT_PATH!,
      `${JSON.stringify([{ target, action: 'escalate' }], null, 2)}\n`,
    );
  }
  const chat = trackRuntimeChat(new PiChatClass(catalog, undefined, undefined, sessionDir));
  // Re-root the production construction path into the isolated cwd: the default
  // session would otherwise live at the primary workspace root.
  await chat.setRoot(cwd);
  return { cwd, sessionDir, chat };
}

beforeAll(async () => {
  pin = resolveRuntimePin();
  process.env.FUNKYOCTOPUS_PROVIDER = pin.provider;
  process.env.FUNKYOCTOPUS_MODEL = pin.id;
  const vaultPath = await createRuntimeVaultFile([
    { target: join(await createRuntimeTempDirectory('funkyoctopus-runtime-guarded-'), 'guarded'), action: 'escalate' },
  ]);
  process.env.FUNKYOCTOPUS_VAULT_PATH = vaultPath;

  ({ PiChat: PiChatClass } = await import('../pi/pi-chat.ts'));
  ({ ModelCatalog: ModelCatalogClass } = await import('../pi/model-catalog.ts'));
  catalog = new ModelCatalogClass();
  await assertRuntimePinAvailable(catalog, pin);
  pinnedModel = (await catalog.resolve(pin.provider, pin.id))!;
});

afterAll(async () => {
  // Failure-safe teardown: any chat a scenario never disposed is caught here.
  await disposeAllRuntimeChats();
  const counts = runtimeChatCounts();
  console.info(
    `[runtime] turns used: ${turnsUsed}/${MAX_TURNS}; chats constructed: ${counts.constructed}, ` +
      `chats disposed: ${counts.disposed}, sessions disposed: ${counts.sessionsDisposed}, ` +
      `still tracked: ${counts.tracked}`,
  );
  // Every constructed tracked chat must be teardown-processed exactly once; a
  // never-built chat simply has no session to dispose, so sessions <= chats.
  expect(counts.tracked).toBe(0);
  expect(counts.disposed).toBe(counts.constructed);
  expect(counts.sessionsDisposed).toBeLessThanOrEqual(counts.disposed);
});

describe('Phase 4 runtime suite', () => {
  it('preflights the exact configured pin before any session exists', () => {
    // The configured pin — the FUNKYOCTOPUS_RUNTIME_MODEL override or the
    // accepted default — is what every session is built on; never hardcoded.
    expect(pin).toEqual(resolveRuntimePin());
    expect(pinnedModel?.provider).toBe(pin.provider);
    expect(pinnedModel?.id).toBe(pin.id);
  });

  describe('scenario 1 — construction without a model call', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      fixture = await makeFixture();
      fixture.chat.prewarm();
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('builds against the isolated session dir, pins the exact model, loads default + crew/web tools and the global AGENTS.md', async () => {
      const session = await fixture.chat.liveSession();
      assertPinned(session);

      const tools = session.getActiveToolNames();
      for (const tool of ['read', 'bash', 'edit', 'write']) {
        expect(tools).toContain(tool);
      }
      expect(tools.some((tool) => tool.startsWith('crew_'))).toBe(true);
      expect(tools).toContain('web_search');
      expect(tools).toContain('fetch_content');

      // FO injects nothing (T3 L1, 2026-10-19): pi itself puts the owner's
      // global AGENTS.md — where `lb brief` is asked for — into the prompt.
      const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
      const globalAgents = join(getAgentDir(), 'AGENTS.md');
      if (existsSync(globalAgents)) {
        expect(session.systemPrompt).toContain(`<project_instructions path="${globalAgents}">`);
      }

      const current = await fixture.chat.current();
      expect(current?.path).toContain(fixture.sessionDir);
      // No file yet by design: pi batches persistence until the first assistant
      // message arrives (scenario 2 proves the file appears after a real turn).
      expect(current?.messageCount).toBe(0);
    });
  });

  describe('scenario 2 — streaming, usage and persistence', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('streams text and usage, writes a session file and stores the prompt byte-for-byte', async () => {
      const prompt = 'Reply with exactly: STREAMED';
      // The cheap pinned model occasionally answers with a thinking-only turn;
      // one bounded retry is allowed before the assertion stands.
      let chunks: ChatChunk[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        chunks = await drain(fixture.chat, prompt);
        if (chunks.some((c) => c.kind === 'text') && chunks.some((c) => c.kind === 'usage')) {
          break;
        }
      }

      expect(chunks.some((c) => c.kind === 'text')).toBe(true);
      expect(chunks.some((c) => c.kind === 'usage')).toBe(true);

      const session = await fixture.chat.liveSession();
      const file = session!.sessionManager.getSessionFile();
      expect(file).toBeTruthy();
      await expect(access(file!)).resolves.toBeUndefined();

      expect(storedUserText(session!)).toBe(prompt);
    });
  });

  describe('scenario 3 — real read tool and projection', () => {
    let fixture: RuntimeFixture;
    const FIXTURE_TEXT = 'octopus fixture content line\n';
    beforeAll(async () => {
      fixture = await makeFixture();
      await writeFile(join(fixture.cwd, 'fixture.txt'), FIXTURE_TEXT);
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('reads a known fixture via the read tool and projects the stored tool step', async () => {
      const target = join(fixture.cwd, 'fixture.txt');
      const chunks = await promptForToolCall(
        fixture.chat,
        `Use the read tool to read the file at "${target}" and quote its content.`,
        `This is an explicit instruction: you MUST call the read tool with the file path "${target}". Nothing else.`,
        (cs) => cs.some((c) => c.kind === 'tool-call' && c.tool === 'read'),
      );

      const call = toolCall(chunks, 'read');
      expect(call).toBeDefined();
      const result = toolResult(chunks, call!.callId);
      expect(result).toBeDefined();
      expect(result!.ok).toBe(true);
      expect(result!.output).toContain('octopus fixture content');

      const session = await fixture.chat.liveSession();
      const messages = toMessages(session!.sessionManager.buildContextEntries());
      const steps = messages.flatMap((m) => m.steps);
      const projectedCall = steps.find(
        (s): s is Extract<ChatStep, { kind: 'tool-call' }> =>
          s.kind === 'tool-call' && s.tool === 'read',
      );
      expect(projectedCall).toBeDefined();
      const projectedResult = steps.find(
        (s): s is Extract<ChatStep, { kind: 'tool-result' }> =>
          s.kind === 'tool-result' && s.callId === projectedCall!.callId,
      );
      expect(projectedResult).toBeDefined();
      expect(projectedResult!.output).toContain('octopus fixture content');
    });
  });

  describe('scenario 4 — approval allow and deny through the production Vault guard', () => {
    let fixture: RuntimeFixture;
    let guardedDir: string;
    beforeAll(async () => {
      fixture = await makeFixture({ escalate: 'guarded' });
      guardedDir = join(fixture.cwd, 'guarded');
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('approves one escalation (file written) and denies a fresh one (file blocked)', async () => {
      const allowedFile = join(guardedDir, 'allowed.txt');
      const allowChunks = await drainWithApprovalPolicy(
        fixture.chat,
        `Use the write tool to create the file at "${allowedFile}" with content "approved".`,
        true,
      );
      expect(allowChunks.some((c) => c.kind === 'approval-request')).toBe(true);
      const allowCall = toolCall(allowChunks, 'write') ?? toolCall(allowChunks, 'bash');
      expect(allowCall).toBeDefined();
      const allowResult = toolResult(allowChunks, allowCall!.callId);
      expect(allowResult?.ok).toBe(true);
      await expect(access(allowedFile)).resolves.toBeUndefined();

      const deniedFile = join(guardedDir, 'denied.txt');
      const denyChunks = await drainWithApprovalPolicy(
        fixture.chat,
        `Use the write tool to create the file at "${deniedFile}" with content "denied".`,
        false,
      );
      expect(denyChunks.some((c) => c.kind === 'approval-request')).toBe(true);
      const vaultDenial = denyChunks.find(
        (c): c is Extract<ChatChunk, { kind: 'tool-result' }> =>
          c.kind === 'tool-result' && c.ok === false && /[Vv]ault/i.test(c.error ?? ''),
      );
      expect(vaultDenial).toBeDefined();
      await expect(access(deniedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('scenario 5 — cancellation and reuse', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('aborts after the first streamed text and completes a short follow-up on the same chat', async () => {
      const chunks = await drainUntilFirstText(
        fixture.chat,
        'Write a 400-word essay about deep-sea octopuses.',
      );
      expect(chunks.some((c) => c.kind === 'text')).toBe(true);

      // The queue closes on abort while the session is still settling; wait for
      // idle so the follow-up prompt is not rejected as "already processing".
      const session = await fixture.chat.liveSession();
      await session!.abort();

      const follow = await drain(fixture.chat, 'Reply with exactly: REUSED');
      const followText = follow
        .filter((c) => c.kind === 'text')
        .map((c) => c.delta)
        .join('');
      expect(followText).toContain('REUSED');
    });
  });

  describe('scenario 6 — persistence and reopen', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('reopens the written session, recovers the prior turn and continues it', async () => {
      const prompt = 'Reply with exactly: PERSISTED';
      await drain(fixture.chat, prompt);

      const original = await fixture.chat.liveSession();
      const file = original!.sessionManager.getSessionFile();
      expect(file).toBeTruthy();
      // The file is single-manager: dispose the live session before reopening.
      await disposeChat(fixture.chat);

      const reopened = trackRuntimeChat(
        new PiChatClass(catalog, undefined, undefined, fixture.sessionDir),
      );
      const transcript = await reopened.openChat(file!);
      expect(
        transcript.some(
          (item) =>
            'role' in item &&
            item.role === 'user' &&
            item.steps.some((s) => s.kind === 'text' && s.text === prompt),
        ),
      ).toBe(true);
      // The reopened construction path must hold the same exact pin.
      assertPinned(await reopened.liveSession());

      const again = await drain(reopened, 'Reply with exactly: CONTINUED');
      expect(again.some((c) => c.kind === 'text')).toBe(true);
      await disposeChat(reopened);
    });
  });

  describe('scenario 7 — manual compaction then continuation', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      // A real session uses the global settings (keepRecentTokens 20k), which a
      // small chat can never reach. A project-local `.pi/settings.json` override
      // is pi's own supported mechanism, so compaction stays on the production
      // construction path while the threshold fits the cheap pin's context.
      fixture = await makeFixture({
        settings: { compaction: { keepRecentTokens: 800, enabled: true } },
      });
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('compacts a real turn, records the compaction entry, then completes a second turn', async () => {
      await drain(
        fixture.chat,
        'Write at least 400 words about octopus camouflage and conclude it with the word DONE.',
      );
      await drain(fixture.chat, 'Reply with exactly: SECOND');

      const session = await fixture.chat.liveSession();
      let compaction;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          // Timer-safe: the deadline timer is always cleared, and the compaction
          // is aborted only when the deadline actually expires.
          compaction = await withCompactionTimeout(
            () => session!.compact('One-line summary.'),
            () => session!.abortCompaction(),
            COMPACTION_TIMEOUT_MS,
          );
          break;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('Nothing to compact')) {
            throw error;
          }
          // The cheap pinned model can answer tersely, leaving the session under
          // the keep-recent budget. Give it one more real turn of context.
          await drain(
            fixture.chat,
            'Write another 300 words about octopus arms and conclude with the word MORE.',
          );
        }
      }
      expect(compaction).toBeTruthy();
      expect(
        session!.sessionManager.getEntries().some((e) => e.type === 'compaction'),
      ).toBe(true);

      const second = await drain(fixture.chat, 'Reply with exactly: SECOND');
      expect(second.some((c) => c.kind === 'text')).toBe(true);

      const messages = toMessages(session!.sessionManager.buildContextEntries());
      expect(
        messages.some((m) => m.steps.some((s) => s.kind === 'text' && s.text.includes('compacted'))),
      ).toBe(true);
    });
  });

  describe('scenario 8 — tool error recovery', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('forces a failing shell command, observes the error result, then completes a healthy follow-up', async () => {
      const chunks = await promptForToolCall(
        fixture.chat,
        'Run exactly this shell command with the bash tool and report the result: false',
        'This is an explicit instruction: you MUST run the bash tool with the command "false" and report the exit code.',
        (cs) => cs.some((c) => c.kind === 'tool-result' && c.ok === false),
      );

      const bashCall = toolCall(chunks, 'bash');
      expect(bashCall).toBeDefined();
      const bashResult = toolResult(chunks, bashCall!.callId);
      expect(bashResult).toBeDefined();
      expect(bashResult!.ok).toBe(false);

      const follow = await drain(fixture.chat, 'Reply with exactly: RECOVERED');
      expect(follow.some((c) => c.kind === 'text')).toBe(true);
    });
  });

  describe('scenario 9 — injected inline extension custom_message', () => {
    let fixture: RuntimeFixture;
    beforeAll(async () => {
      // No makeFixture here: the injected-session path builds its own chat, and
      // building a throwaway production chat first would leak it when replaced.
      const cwd = await createRuntimeTempDirectory('funkyoctopus-runtime-cwd-');
      const sessionDir = await createRuntimeSessionDirectory();
      const { getAgentDir, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } =
        await import('@earendil-works/pi-coding-agent');
      const agentDir = getAgentDir();
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: [
          {
            name: 'runtime-probe-inline',
            factory: (pi: ExtensionAPI) => {
              pi.registerTool({
                name: 'runtime_probe',
                label: 'Runtime Probe',
                description:
                  'Sends a deterministic runtime-probe custom message and reports it. ' +
                  'Use it exactly once when asked.',
                parameters: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
                execute: (
                  _id: string,
                  params: { text: string },
                  _signal: unknown,
                  _onUpdate: unknown,
                ) =>
                  Promise.resolve((() => {
                    pi.sendMessage({
                      customType: 'runtime-probe',
                      content: `probe:${params.text}. Reply with exactly ACK-PROBE and do not call any more tools.`,
                      display: true,
                    });
                    return { content: [{ type: 'text', text: `probe sent: ${params.text}` }], details: {} };
                  })()),
              } as unknown as ToolDefinition);
            },
          },
        ],
      });
      await loader.reload();

      const factory = async (root: string): Promise<AgentSession> => {
        const result = await createAgentSession({
          model: pinnedModel,
          modelRuntime: await catalog.getRuntime(),
          cwd: root,
          sessionManager: SessionManager.create(root, sessionDir),
          resourceLoader: loader,
        });
        return result.session;
      };
      const chat = trackRuntimeChat(
        new PiChatClass(catalog, factory, undefined, sessionDir),
      );
      await chat.setRoot(cwd);
      fixture = { cwd, sessionDir, chat };
    });
    afterAll(async () => {
      await disposeChat(fixture.chat);
    });

    it('persists the runtime-probe custom_message, drops it from the projection, and keeps the extension active', async () => {
      const session = await fixture.chat.liveSession();
      assertPinned(session);
      expect(session.getActiveToolNames()).toContain('runtime_probe');

      const chunks = await promptForToolCall(
        fixture.chat,
        'Call the runtime_probe tool with text "probe-1" and nothing else.',
        'This is an explicit instruction: you MUST call the runtime_probe tool with text "probe-1".',
        (cs) => cs.some((c) => c.kind === 'tool-call' && c.tool === 'runtime_probe'),
      );
      expect(toolCall(chunks, 'runtime_probe')).toBeDefined();

      const entries = session.sessionManager.getEntries();
      const custom = entries.find(
        (e): e is Extract<SessionEntry, { type: 'custom_message' }> =>
          e.type === 'custom_message' && e.customType === 'runtime-probe',
      );
      expect(custom).toBeDefined();
      expect(JSON.stringify(custom!.content)).toContain('probe:probe-1');

      // The transcript projection deliberately drops custom_message entries:
      // they are extension plumbing, not conversation.
      const messages = toMessages(session.sessionManager.buildContextEntries());
      expect(JSON.stringify(messages)).not.toContain('probe:probe-1');

      const follow = await drain(fixture.chat, 'Reply with exactly: EXTENDED');
      expect(follow.some((c) => c.kind === 'text')).toBe(true);
      expect((await fixture.chat.liveSession())!.getActiveToolNames()).toContain('runtime_probe');
    });
  });
});
