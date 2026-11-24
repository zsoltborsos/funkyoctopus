/**
 * Bounded production-path live canary.
 *
 * The smallest live validation of a candidate embedded SDK, extracted from the
 * opt-in runtime harness into the promotion gate's own seam. It uses the
 * production embedded PiChat construction path, one prompt and at most one
 * model turn, and exact cleanup accounting:
 *
 * - the exact model pin `opencode-go/deepseek-v4.1-flash` is forced through
 *   PiChat's initial-model seam, never env config;
 * - an isolated temp root holds the workspace, the session directory, and the
 *   Vault file, so nothing durable touches the user's real stores;
 * - `setRoot(workspace)` runs before the prompt;
 * - a deny-all ToolGuard blocks every tool call before execution (crew, Hub,
 *   and repository-mutation tools included); if a tool chunk nevertheless
 *   appears the run aborts and rejects;
 * - success requires non-empty assistant text plus a live, settled, exact-model
 *   session that stored the prompt byte-for-byte (the follow-up-capable surface
 *   — proven without a second paid turn). The stream closes on the SDK's
 *   agent_end while isStreaming flips false only later, so the canary waits on
 *   the session's own waitForIdle before verifying; the promotion's AbortSignal
 *   drives session.abort() through a listener during that wait, and if the
 *   session never settles the promotion's cleanup grace yields recovery, never
 *   a second turn or a timer of our own;
 * - cleanup disposes the chat host exactly once, removes the exact temp root,
 *   and verifies it is absent; every cleanup step is attempted and the
 *   failure flavor decides the outcome: a rejected disposal resolves `unsafe`
 *   (a live session may remain — the promotion must never roll back), while a
 *   root removal/absence failure after a successful disposal is an ordinary
 *   `failed` cleanup (rollback safe, candidate still rejected);
 * - every diagnostic is bounded to the reason ceiling before it leaves, even
 *   when an injected ceiling is smaller than the truncation marker itself;
 * - the AbortSignal from the promotion gate is checked before start and between
 *   setup steps and threaded into the turn; an aborted run is never rescued as
 *   success; there is no internal timer — the promotion owns the 120s ceiling.
 *
 * The deterministic suite injects fake fs/chat seams; the production binding
 * constructs the real ModelCatalog/PiChat only when its `createChat` is
 * invoked — the embedded SDK is imported dynamically inside that method, so
 * this module's static import graph stays SDK-free and a promotion engine
 * loaded before the candidate npm install can never cache a pre-install SDK
 * for the canary to reuse.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk } from '../../src/shared/transport/protocol.ts';
import { VaultGuard } from '../../server/src/security/vault.ts';
import { MAX_REASON_BYTES, boundedReason } from './bounded-reason.ts';
import { messageOf } from './errors.ts';
import type { CanaryOutcome } from './promote.ts';
// The shared bounded-diagnostic ceiling/helper live in the SDK-free module so
// promote.ts never imports canary.ts; re-exported here for the suite's/public
// import surface.
export { MAX_REASON_BYTES, boundedReason } from './bounded-reason.ts';

/** The exact model every live canary run is pinned to, regardless of env overrides. */
export const CANARY_MODEL = { provider: 'opencode-go', id: 'deepseek-v4.1-flash' } as const;

/** The single prompt; one model turn at most. */
export const CANARY_PROMPT = 'Reply with exactly: CANARY-OK';

/** Byte ceiling on captured assistant text; exceeding it aborts the run. */
export const MAX_ASSISTANT_BYTES = 64 * 1024;

/** The isolated layout the canary lives in; `root` is removed wholesale. */
export interface CanaryTempRoot {
  root: string;
  workspace: string;
  sessionDir: string;
  vaultFile: string;
}

/** The live-session surface the canary verifies (structural over AgentSession). */
export interface CanarySession {
  /** `undefined` mirrors AgentSession.model under exactOptionalPropertyTypes. */
  model?: { provider: string; id: string } | null | undefined;
  isStreaming: boolean;
  sessionManager: {
    getEntries(): readonly { type: string; message?: { role?: string; content?: unknown } }[];
  };
  /**
   * The SDK's public settle wait: resolves once isStreaming flips false, which
   * happens after the stream closes (agent_end precedes _emitAgentSettled).
   */
  waitForIdle(): Promise<void>;
  /** The SDK's abort: stops the run and awaits settlement (never a new prompt). */
  abort(): Promise<void>;
}

/** The chat surface the canary drives (structural over PiChat). */
export interface CanaryChat {
  setRoot(path: string): Promise<unknown>;
  send(text: string, signal: AbortSignal): AsyncIterable<ChatChunk>;
  liveSession(): Promise<CanarySession | null>;
  disposeLiveSession(): Promise<boolean>;
}

/** Cleanup fs: recursive removal plus an absence probe that fails closed. */
export interface CanaryFs {
  rm(path: string, options: { recursive: true }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface CanaryDeps {
  /** Creates the isolated temp root (workspace + session dir + Vault file). */
  createTempRoot(): Promise<CanaryTempRoot>;
  /** Builds the chat bound to the isolated root (production: pinned PiChat). */
  createChat(root: CanaryTempRoot): Promise<CanaryChat>;
  fs: CanaryFs;
  maxAssistantBytes?: number;
  maxReasonBytes?: number;
}

/**
 * Run the bounded canary against injected seams, honouring the promotion's
 * AbortSignal. Resolves `failed` for run failures and for root-only cleanup
 * failures (disposal succeeded, so rollback is safe); resolves `unsafe` when
 * the live-session disposal itself was rejected — a session may still be
 * running, and the promotion must never roll back or mutate the repo while
 * that ambiguity stands. The canary never rejects: every diagnostic is
 * bounded, every cleanup step is attempted, and the run verdict and cleanup
 * verdict merge below.
 */
export async function runCanary(deps: CanaryDeps, signal: AbortSignal): Promise<CanaryOutcome> {
  const maxAssistantBytes = deps.maxAssistantBytes ?? MAX_ASSISTANT_BYTES;
  const maxReasonBytes = deps.maxReasonBytes ?? MAX_REASON_BYTES;
  const reason = (text: string): string => boundedReason(text, maxReasonBytes);

  if (signal.aborted) {
    return { kind: 'failed', reason: reason('canary aborted before start') };
  }

  const phase = await runCanaryPhase(deps, signal, maxAssistantBytes, maxReasonBytes, reason);
  const cleanupOutcome = await cleanup(phase.chat, phase.tempRoot, deps.fs, maxReasonBytes);
  // Session ambiguity takes precedence over every run verdict: a live session
  // that disposal could not settle must block the repo, not allow a rollback.
  if (cleanupOutcome.kind === 'unsafe') return cleanupOutcome;
  if (cleanupOutcome.kind === 'failed') {
    // Disposal succeeded, so the session is gone and rollback is safe; the
    // candidate is still rejected. Keep both diagnostics when the run failed.
    if (phase.outcome.kind === 'ok') return cleanupOutcome;
    return { kind: 'failed', reason: reason(`${phase.outcome.reason} (${cleanupOutcome.reason})`) };
  }
  return phase.outcome;
}

/**
 * The run phase (setup, turn, verification) with an abort check between every
 * awaited stage. Returns the run verdict plus the handles cleanup needs, and
 * never throws — the caller sees a bounded failed outcome for any error.
 */
async function runCanaryPhase(
  deps: CanaryDeps,
  signal: AbortSignal,
  maxAssistantBytes: number,
  maxReasonBytes: number,
  reason: (text: string) => string,
): Promise<{ tempRoot: CanaryTempRoot | null; chat: CanaryChat | null; outcome: CanaryOutcome }> {
  let tempRoot: CanaryTempRoot | null = null;
  let chat: CanaryChat | null = null;
  try {
    tempRoot = await deps.createTempRoot();
    if (signal.aborted) {
      return {
        tempRoot,
        chat,
        outcome: { kind: 'failed', reason: reason('canary aborted during setup') },
      };
    }

    chat = await deps.createChat(tempRoot);
    if (signal.aborted) {
      return {
        tempRoot,
        chat,
        outcome: { kind: 'failed', reason: reason('canary aborted during chat setup') },
      };
    }

    await chat.setRoot(tempRoot.workspace);
    if (signal.aborted) {
      return {
        tempRoot,
        chat,
        outcome: { kind: 'failed', reason: reason('canary aborted after root selection') },
      };
    }

    const turn = await drainTurn(chat, signal, maxAssistantBytes, maxReasonBytes);
    if (signal.aborted) {
      return {
        tempRoot,
        chat,
        outcome: { kind: 'failed', reason: reason('canary aborted during the model turn') },
      };
    }
    if (turn.kind === 'failed') {
      return { tempRoot, chat, outcome: { kind: 'failed', reason: turn.reason } };
    }

    const session = await chat.liveSession();
    // The settlement wait owns the abort handling from here: a signal already
    // aborted aborts the session immediately, and an abort landing during the
    // wait drives session.abort() through a listener. No internal timer — the
    // promotion owns the 120s ceiling and the cleanup grace.
    const idleVerdict = await awaitSessionIdle(session, signal, reason);
    if (idleVerdict.kind === 'failed') {
      return { tempRoot, chat, outcome: { kind: 'failed', reason: idleVerdict.reason } };
    }
    const verificationFailure = verifySession(session);
    return {
      tempRoot,
      chat,
      outcome:
        verificationFailure === null
          ? { kind: 'ok' }
          : { kind: 'failed', reason: reason(verificationFailure) },
    };
  } catch (error) {
    return {
      tempRoot,
      chat,
      outcome: { kind: 'failed', reason: reason(`canary failed: ${messageOf(error)}`) },
    };
  }
}

type TurnVerdict = { kind: 'ok' } | { kind: 'failed'; reason: string };

/**
 * Wait for the live session to settle (isStreaming false) without sending a
 * second prompt, honouring the promotion's AbortSignal. The stream closes on
 * the SDK's agent_end, but isStreaming flips false only later, in
 * _emitAgentSettled after prompt/post-run finally — so the canary verifies the
 * session only once it is actually idle.
 *
 * While waiting, an abort listener drives session.abort() (the SDK's own abort
 * runs until the session is idle: abortRetry + agent.abort + waitForIdle), so
 * the abort both stops the run and unblocks the wait below. The listener is
 * removed in finally; an already-aborted signal aborts immediately. A wait or
 * abort rejection becomes a bounded run failure — cleanup then decides safe
 * vs unsafe from the disposal. If the session never settles, this await never
 * resolves and the promotion's cleanup grace yields recovery without a
 * rollback: no timer or polling exists here.
 */
async function awaitSessionIdle(
  session: CanarySession | null,
  signal: AbortSignal,
  reason: (text: string) => string,
): Promise<TurnVerdict> {
  if (!session) {
    return { kind: 'failed', reason: reason('no live session after the model turn') };
  }
  let abortError: unknown = null;
  // The observed abort drives, drained after the wait so a rejection is
  // guaranteed visible before the verdict, whatever the microtask ordering of
  // wait vs abort settlement. A definite array keeps every entry thenable.
  const observedAborts: Promise<void>[] = [];
  const onAbort = (): void => {
    // The SDK's own abort() runs until the session is idle (abortRetry +
    // agent.abort + waitForIdle), so this both stops the run and unblocks the
    // wait below — without a second prompt. The rejection is recorded, never
    // an unhandled rejection: the pushed promise stays a resolving one.
    observedAborts.push(
      session.abort().catch((error: unknown) => {
        abortError = error;
      }),
    );
  };
  if (signal.aborted) {
    // Already aborted: never a success. Abort immediately — the same settlement
    // path the abort listener would drive.
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let waitError: unknown = null;
  try {
    await session.waitForIdle();
  } catch (error) {
    waitError = error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  // Drain the observed abort(s) so a rejection is guaranteed visible before
  // the verdict. Only when the wait itself succeeded: a rejected wait is
  // already a failure.
  if (waitError === null) {
    for (const abort of observedAborts) {
      await abort;
    }
  }
  if (waitError !== null) {
    return {
      kind: 'failed',
      reason: reason(`session idle wait failed: ${messageOf(waitError)}`),
    };
  }
  if (abortError !== null) {
    return {
      kind: 'failed',
      reason: reason(`session abort during settlement failed: ${messageOf(abortError)}`),
    };
  }
  if (signal.aborted) {
    return {
      kind: 'failed',
      reason: reason('canary aborted while the session settled'),
    };
  }
  return { kind: 'ok' };
}

/**
 * Drain exactly one turn, bounding captured assistant bytes and refusing to
 * drain past a tool chunk. Aborting the drain (byte ceiling or tool chunk) is
 * what settles the in-flight turn: cleanup's dispose aborts the live session
 * where the production path cooperates.
 */
async function drainTurn(
  chat: CanaryChat,
  signal: AbortSignal,
  maxAssistantBytes: number,
  maxReasonBytes: number,
): Promise<TurnVerdict> {
  let textBytes = 0;
  let sawNonWhitespace = false;
  try {
    for await (const chunk of chat.send(CANARY_PROMPT, signal)) {
      if (chunk.kind === 'text') {
        textBytes += Buffer.byteLength(chunk.delta);
        if (textBytes > maxAssistantBytes) {
          return {
            kind: 'failed',
            reason: boundedReason(
              `assistant text exceeded the ${maxAssistantBytes}-byte ceiling`,
              maxReasonBytes,
            ),
          };
        }
        if (!sawNonWhitespace && /\S/.test(chunk.delta)) sawNonWhitespace = true;
      } else if (chunk.kind === 'tool-call' || chunk.kind === 'tool-result') {
        // The deny-all guard blocks every tool call before execution; a chunk
        // here means the guard was bypassed — abort and reject.
        return {
          kind: 'failed',
          reason: boundedReason(
            chunk.kind === 'tool-call'
              ? `tool call ${chunk.tool} appeared despite the deny-all guard`
              : 'a tool result appeared without a preceding denied call',
            maxReasonBytes,
          ),
        };
      }
    }
  } catch (error) {
    return {
      kind: 'failed',
      reason: boundedReason(`model turn failed: ${messageOf(error)}`, maxReasonBytes),
    };
  }
  // Whitespace is bytes for the ceiling but never counts as an answer: a turn
  // that produced only whitespace fails exactly like an empty one.
  if (textBytes === 0) {
    return {
      kind: 'failed',
      reason: boundedReason('the model produced no assistant text', maxReasonBytes),
    };
  }
  if (!sawNonWhitespace) {
    return {
      kind: 'failed',
      reason: boundedReason('the model produced only whitespace', maxReasonBytes),
    };
  }
  return { kind: 'ok' };
}

/**
 * Post-turn session verification: the exact pin, a settled (non-streaming)
 * session, and the prompt stored byte-for-byte prove a stable session/model/
 * prompt surface that could take a follow-up — without making a second paid
 * turn. Runs only after the settlement wait: the stream may have closed while
 * isStreaming was still true. Returns null when the surface is healthy, else
 * the failure reason.
 */
function verifySession(session: CanarySession | null): string | null {
  if (!session) return 'no live session after the model turn';
  if (!session.model) return 'the live session has no model';
  if (session.model.provider !== CANARY_MODEL.provider || session.model.id !== CANARY_MODEL.id) {
    return `session model is ${session.model.provider}/${session.model.id}, expected ${CANARY_MODEL.provider}/${CANARY_MODEL.id}`;
  }
  if (session.isStreaming) return 'the session is still streaming after the model turn';
  if (storedUserText(session) !== CANARY_PROMPT) {
    return 'the stored prompt does not match what the canary sent';
  }
  return null;
}

/** The stored text of the most recent user message, mirroring the runtime suite. */
function storedUserText(session: CanarySession): string | null {
  const entries = session.sessionManager.getEntries();
  const user = [...entries]
    .reverse()
    .find((entry) => entry.type === 'message' && entry.message?.role === 'user');
  const content = user?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      const record = part as { type?: unknown; text?: unknown };
      if (
        record &&
        typeof record === 'object' &&
        record.type === 'text' &&
        typeof record.text === 'string'
      ) {
        texts.push(record.text);
      }
    }
    return texts.join('');
  }
  return null;
}

/**
 * Dispose the chat host exactly once, remove the exact temp root, and verify
 * it is absent. Every step is attempted even when an earlier one failed, and
 * nothing throws: the failure flavor decides the returned verdict.
 *
 * - a rejected `disposeLiveSession` is `unsafe` — a live session may remain,
 *   so the promotion must not roll back or mutate the repo;
 * - a root removal/absence failure after a successful disposal is an ordinary
 *   `failed` cleanup — rollback is safe, the candidate is still rejected.
 */
async function cleanup(
  chat: CanaryChat | null,
  tempRoot: CanaryTempRoot | null,
  fs: CanaryFs,
  maxReasonBytes: number,
): Promise<CleanupVerdict> {
  let unsafeReason: string | null = null;
  let failedReason: string | null = null;
  if (chat) {
    try {
      await chat.disposeLiveSession();
    } catch (error) {
      unsafeReason ??= boundedReason(
        `canary session disposal failed: ${messageOf(error)}`,
        maxReasonBytes,
      );
    }
  }
  if (tempRoot) {
    try {
      await fs.rm(tempRoot.root, { recursive: true });
      if (await fs.exists(tempRoot.root)) {
        failedReason ??= boundedReason(
          `canary temp root still present after cleanup: ${tempRoot.root}`,
          maxReasonBytes,
        );
      }
    } catch (error) {
      failedReason ??= boundedReason(
        `canary temp root cleanup failed: ${messageOf(error)}`,
        maxReasonBytes,
      );
    }
  }
  if (unsafeReason !== null) return { kind: 'unsafe', reason: unsafeReason };
  if (failedReason !== null) return { kind: 'failed', reason: failedReason };
  return { kind: 'ok' };
}

/** Cleanup flavor; see `cleanup`. `unsafe` outranks `failed` in the merge. */
type CleanupVerdict =
  { kind: 'ok' } | { kind: 'unsafe'; reason: string } | { kind: 'failed'; reason: string };

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The deny-all guard surface (structural over PiChat's ToolGuard, like
 * CanaryChat/CanarySession are over their runtime shapes). Declared here so
 * the production path needs no value import of pi-chat.ts — the guard the
 * canary passes to PiChat is proven structurally compatible at the dynamic
 * import site.
 */
export interface CanaryToolGuard {
  guard(
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined>;
}

/**
 * The deny-all guard for the canary: every tool call is blocked before
 * execution. The isolated Vault file is still genuinely read (VaultGuard.create
 * loads its rules at session construction), so the canary's Vault root is part
 * of the exercised environment, while no tool — crew, Hub, or repository
 * mutation included — ever runs.
 */
async function denyAllGuard(vaultFile: string, basePath: string): Promise<CanaryToolGuard> {
  const vault = await VaultGuard.create(() => Promise.resolve(false), vaultFile, basePath);
  return {
    async guard(callId, tool, args, signal) {
      await vault.guard(callId, tool, args, signal);
      return { block: true, reason: `canary denies all tool calls (${tool})` };
    },
  };
}

/** Production cleanup fs: node `rm` plus a stat-based absence probe. */
export function productionCanaryFs(): CanaryFs {
  return {
    rm: (path, options) => rm(path, options),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if (isEnoent(error)) return false;
        throw error;
      }
    },
  };
}

/** Production binding: real fs layout and the embedded PiChat path. Inert until invoked. */
export function productionCanaryDeps(): CanaryDeps {
  return {
    async createTempRoot() {
      const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-canary-'));
      const workspace = join(root, 'workspace');
      const sessionDir = join(root, 'sessions');
      const vaultDir = join(root, 'vault');
      const vaultFile = join(vaultDir, 'vault.json');
      try {
        await mkdir(workspace, { recursive: true });
        await mkdir(sessionDir, { recursive: true });
        await mkdir(vaultDir, { recursive: true });
        // Empty rules: the deny-all guard is the canary's safety boundary, the
        // Vault file the isolated root the guard reads at construction.
        await writeFile(vaultFile, `${JSON.stringify([], null, 2)}\n`);
      } catch (error) {
        // A partially built root must never leak: remove it best-effort.
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { root, workspace, sessionDir, vaultFile };
    },
    async createChat(tempRoot) {
      // The embedded SDK is loaded only here — after the candidate install and
      // immediately before the canary run, so a pre-install module cache can
      // never leak into the canary. Both constructors are inert: no runtime,
      // session, or model call until the run's first turn.
      const [{ ModelCatalog }, { PiChat }] = await Promise.all([
        import('../../server/src/pi/model-catalog.ts'),
        import('../../server/src/pi/pi-chat.ts'),
      ]);
      const catalog = new ModelCatalog();
      // No await here: PiChat construction is synchronous; the promise wrapper
      // keeps the seam's async surface without an artificial await.
      return Promise.resolve(
        new PiChat(
          catalog,
          undefined,
          () => denyAllGuard(tempRoot.vaultFile, tempRoot.workspace),
          tempRoot.sessionDir,
          { provider: CANARY_MODEL.provider, model: CANARY_MODEL.id },
        ),
      );
    },
    fs: productionCanaryFs(),
  };
}

/** The promotion-gate seam: `(signal: AbortSignal) => Promise<CanaryOutcome>`. */
export function productionRunCanary(): (signal: AbortSignal) => Promise<CanaryOutcome> {
  return (signal) => runCanary(productionCanaryDeps(), signal);
}
