/**
 * Hermetic fake-model canary suite.
 *
 * Deterministic coverage of the bounded production-path live canary with an
 * injected chat/fs world: success, pre-abort, abort during setup and during
 * the turn, empty and whitespace-only completion, provider/auth failure,
 * tool-attempt denial and rejection, wrong model, streaming/follow-up-state
 * failure, real-SDK settlement ordering (the stream closes on agent_end while
 * isStreaming flips false only later — success waits on waitForIdle), the
 * settlement wait's abort handling, workspace-before-prompt ordering, exactly
 * one send, the assistant byte cap, setup failures, and exact cleanup
 * accounting. Cleanup failures
 * resolve by flavor — a rejected disposal is `unsafe` (session ambiguity),
 * a root-only failure after a successful disposal is an ordinary `failed`
 * cleanup — and every diagnostic stays within its byte ceiling even under an
 * injected ceiling smaller than the truncation marker.
 *
 * No real ModelCatalog, PiChat, SDK session, or model call is constructed by
 * this suite; the production binding is only proven inert until invoked.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk } from '../../src/shared/transport/protocol.ts';
import {
  CANARY_MODEL,
  CANARY_PROMPT,
  MAX_REASON_BYTES,
  productionRunCanary,
  runCanary,
  type CanaryChat,
  type CanaryDeps,
  type CanaryFs,
  type CanarySession,
  type CanaryTempRoot,
} from './canary.ts';

/** The happy-path session: exact pin, settled, prompt stored byte-for-byte. */
function defaultSession(): CanarySession {
  return {
    model: { provider: CANARY_MODEL.provider, id: CANARY_MODEL.id },
    isStreaming: false,
    sessionManager: {
      getEntries: () => [
        { type: 'message', message: { role: 'user', content: CANARY_PROMPT } },
      ],
    },
    waitForIdle: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
  };
}

interface WorldOverrides {
  tempRootError?: Error;
  chatError?: Error;
  setRootError?: Error;
  sendError?: Error;
  sendImpl?: (text: string, signal: AbortSignal) => AsyncIterable<ChatChunk>;
  session?: CanarySession | null;
  sessionError?: Error;
  disposeError?: Error;
  rmError?: Error;
  existsError?: Error;
  existsResult?: boolean;
}

/** A canned async-iterable of chunks for the fake send (await satisfies the lint rule). */
function cannedSend(...chunks: ChatChunk[]): (text: string, signal: AbortSignal) => AsyncIterable<ChatChunk> {
  return async function* () {
    await Promise.resolve();
    for (const chunk of chunks) yield chunk;
  };
}

/** A fake send that rejects on the first pull (hand-rolled to satisfy lint). */
function failingSend(error: Error): (text: string, signal: AbortSignal) => AsyncIterable<ChatChunk> {
  const iterator: AsyncIterator<ChatChunk> = {
    next() {
      return Promise.reject(error);
    },
  };
  return () => ({
    [Symbol.asyncIterator]() {
      return iterator;
    },
  });
}

function makeWorld(overrides: WorldOverrides = {}) {
  const tempRoot: CanaryTempRoot = {
    root: '/tmp/canary-root',
    workspace: '/tmp/canary-root/workspace',
    sessionDir: '/tmp/canary-root/sessions',
    vaultFile: '/tmp/canary-root/vault/vault.json',
  };
  const chat = {
    setRoot: vi.fn((_path: string) => {
      const error = overrides.setRootError;
      return error ? Promise.reject(error) : Promise.resolve(undefined);
    }),
    send: vi.fn((text: string, signal: AbortSignal) => {
      const error = overrides.sendError;
      if (error) return failingSend(error)(text, signal);
      const impl = overrides.sendImpl;
      return impl ? impl(text, signal) : cannedSend()(text, signal);
    }),
    liveSession: vi.fn(() => {
      const error = overrides.sessionError;
      if (error) return Promise.reject(error);
      return Promise.resolve(overrides.session !== undefined ? overrides.session : defaultSession());
    }),
    disposeLiveSession: vi.fn(() => {
      const error = overrides.disposeError;
      return error ? Promise.reject(error) : Promise.resolve(true);
    }),
  } satisfies CanaryChat;
  const fs = {
    rm: vi.fn(() => {
      const error = overrides.rmError;
      return error ? Promise.reject(error) : Promise.resolve();
    }),
    exists: vi.fn(() => {
      const error = overrides.existsError;
      if (error) return Promise.reject(error);
      return Promise.resolve(overrides.existsResult ?? false);
    }),
  } satisfies CanaryFs;
  const deps = {
    createTempRoot: vi.fn(() => {
      const error = overrides.tempRootError;
      return error ? Promise.reject(error) : Promise.resolve(tempRoot);
    }),
    createChat: vi.fn(() => {
      const error = overrides.chatError;
      return error ? Promise.reject(error) : Promise.resolve(chat);
    }),
    fs,
  } satisfies CanaryDeps;
  return { chat, fs, deps, tempRoot };
}

describe('canary — success', () => {
  it('completes on a non-empty assistant turn with an exact-model, follow-up-capable session', async () => {
    const world = makeWorld({
      sendImpl: cannedSend(
        { kind: 'text', delta: 'CANARY-OK' },
        { kind: 'usage', tokens: 12, contextWindow: 200_000, percent: 0.1 },
      ),
    });

    const outcome = await runCanary(world.deps, new AbortController().signal);

    expect(outcome).toEqual({ kind: 'ok' });
    // Isolated roots: the chat factory receives the temp workspace, session
    // dir, and Vault file as one disposable root.
    expect(world.deps.createChat).toHaveBeenCalledWith(world.tempRoot);
    expect(world.chat.setRoot).toHaveBeenCalledWith(world.tempRoot.workspace);
  });

  it('calls setRoot(workspace) before the prompt, and sends exactly one prompt turn', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
    });

    const outcome = await runCanary(world.deps, new AbortController().signal);

    expect(outcome).toEqual({ kind: 'ok' });
    // Workspace-before-prompt ordering: setRoot must precede the single send.
    expect(world.chat.setRoot.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      world.chat.send.mock.invocationCallOrder[0] ?? 0,
    );
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    expect(world.chat.send).toHaveBeenCalledWith(CANARY_PROMPT, expect.any(AbortSignal));
  });

  it('disposes the chat exactly once, removes the exact temp root, and verifies it is absent', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
    });

    const outcome = await runCanary(world.deps, new AbortController().signal);

    expect(outcome).toEqual({ kind: 'ok' });
    // Exact cleanup accounting: one host dispose, one recursive rm of the
    // single root, one absence probe.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledWith(world.tempRoot.root, { recursive: true });
    expect(world.fs.exists).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).toHaveBeenCalledWith(world.tempRoot.root);
  });
});

describe('canary — abort', () => {
  it('fails before creating anything when the signal is already aborted', async () => {
    const world = makeWorld();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runCanary(world.deps, controller.signal);

    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('aborted') });
    expect(world.deps.createTempRoot).not.toHaveBeenCalled();
    expect(world.deps.createChat).not.toHaveBeenCalled();
    // Nothing was created, so nothing may be cleaned up.
    expect(world.chat.disposeLiveSession).not.toHaveBeenCalled();
    expect(world.fs.rm).not.toHaveBeenCalled();
  });

  it('fails and cleans up when aborted after temp-root setup while the chat is constructed', async () => {
    const world = makeWorld();
    const controller = new AbortController();
    let chatBuilt = false;
    world.deps.createChat = vi.fn(async () => {
      // The production path constructs the chat while the promotion's abort
      // fires; the canary must await the construction settling, then clean up.
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      chatBuilt = true;
      return world.chat;
    });

    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;

    expect(chatBuilt).toBe(true);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('aborted') });
    // The never-prompted chat is still disposed and the root removed.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledWith(world.tempRoot.root, { recursive: true });
    expect(world.fs.exists).toHaveBeenCalledWith(world.tempRoot.root);
  });

  it('never rescues a turn aborted mid-stream as success, even when text was produced', async () => {
    const world = makeWorld({
      sendImpl: async function* (_text, signal) {
        yield { kind: 'text', delta: 'partial answer before abort' };
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { kind: 'text', delta: 'completed after abort' };
      },
    });
    const controller = new AbortController();

    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('aborted') });
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    // Cleanup still settles: dispose, remove, verify absent.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).toHaveBeenCalledTimes(1);
  });
});

describe('canary — completion failures', () => {
  it('fails on an empty completion (no assistant text at all)', async () => {
    const world = makeWorld();
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('no assistant text') });
  });

  it('fails when the turn produced only usage, never text', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'usage', tokens: 12, contextWindow: 200_000, percent: 0.1 }),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('no assistant text') });
  });

  it('aborts the turn and rejects when the assistant text exceeds the byte ceiling', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'abcdefghijklmnopqrstuvwxyz0123456789' }),
    });
    const outcome = await runCanary({ ...world.deps, maxAssistantBytes: 16 }, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('ceiling') });
    // The single in-flight send is aborted by refusing to drain; cleanup disposes.
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
  });

  it('fails with a bounded reason when the provider rejects the turn', async () => {
    const world = makeWorld({ sendError: new Error('provider unreachable: connection refused') });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('provider unreachable') });
  });

  it('fails with a bounded reason when authentication is missing', async () => {
    const world = makeWorld({
      sendError: new Error('no authentication for opencode-go/deepseek-v4-flash'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('no authentication for opencode-go/deepseek-v4-flash'),
    });
  });

  it('bounds oversized generic failure diagnostics to the reason ceiling', async () => {
    const huge = `x${'y'.repeat(MAX_REASON_BYTES * 4)}z`;
    const world = makeWorld({ sendError: new Error(`diagnostics flood: ${huge}`) });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('truncated');
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(MAX_REASON_BYTES);
    }
  });
});

describe('canary — tool attempt denial and rejection', () => {
  it('rejects when a tool-call chunk appears despite the deny-all guard', async () => {
    const world = makeWorld({
      sendImpl: cannedSend(
        { kind: 'tool-call', callId: 'call-1', tool: 'bash', summary: 'bash: ls' },
        { kind: 'text', delta: 'this must never be reached' },
      ),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('bash') });
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('guard') });
    // The turn is aborted by refusing to drain; no second send ever starts.
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
  });

  it('rejects when a tool-result chunk appears without a preceding denied call', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'tool-result', callId: 'call-9', ok: true, output: 'leaked' }),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('tool result') });
  });
});

describe('canary — real-SDK settlement ordering', () => {
  it('waits for the live session to settle after the stream closes, then verifies success', async () => {
    // The production ordering this regresses: PiChat's stream closes on the
    // SDK's agent_end event, but isStreaming flips false only later, in
    // _emitAgentSettled after prompt/post-run finally. The immediate
    // verification used to see a still-streaming session and fail every live
    // run; the canary must await the session's actual idle state instead.
    let resolveIdle: (() => void) | undefined;
    const session = {
      ...defaultSession(),
      isStreaming: true,
      waitForIdle: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveIdle = () => {
              session.isStreaming = false;
              resolve();
            };
          }),
      ),
      abort: vi.fn(() => Promise.resolve()),
    };
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session,
    });
    const controller = new AbortController();

    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The drain ended, but the canary must be awaiting the session's idle
    // state — it must not verify (and fail) a still-streaming session, and it
    // must not send a second prompt to learn the state.
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    expect(session.isStreaming).toBe(true);
    resolveIdle!();
    const outcome = await pending;

    expect(outcome).toEqual({ kind: 'ok' });
    // The settlement wait's abort listener is removed in finally: a later
    // abort must not reach the session.
    controller.abort();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it('fails with a bounded reason when the session idle wait itself rejects', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: {
        ...defaultSession(),
        waitForIdle: vi.fn(() => Promise.reject(new Error('idle wait exploded'))),
      },
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('idle wait exploded') });
    // A rejected settlement wait is a bounded run failure; cleanup then decides
    // safe vs unsafe from the disposal, exactly like any other run failure.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
  });

  it('aborts the live session when the promotion signal fires during the idle wait, and never succeeds', async () => {
    let resolveIdle: (() => void) | undefined;
    const session = {
      ...defaultSession(),
      waitForIdle: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveIdle = resolve;
          }),
      ),
      abort: vi.fn(() => {
        // The SDK's own abort() drives settlement; the idle wait then resolves.
        resolveIdle?.();
        return Promise.resolve();
      }),
    };
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session,
    });
    const controller = new AbortController();

    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('aborted') });
    // The abort drove the session's own abort; no success, no second prompt.
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    // Cleanup still settles: dispose, remove, verify absent.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).toHaveBeenCalledTimes(1);
  });

  it('aborts the live session immediately when the signal is already aborted before the idle wait', async () => {
    const session = {
      ...defaultSession(),
      abort: vi.fn(() => Promise.resolve()),
    };
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session,
    });
    // Gate the live-session peek: the promotion abort lands between the drain
    // and the settlement wait, so the wait starts with an already-aborted
    // signal and must abort the session immediately, not wait indefinitely.
    let releaseSession: (() => void) | undefined;
    world.chat.liveSession = vi.fn(
      () =>
        new Promise<CanarySession>((resolve) => {
          releaseSession = () => resolve(session);
        }),
    );
    const controller = new AbortController();
    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    releaseSession!();
    const outcome = await pending;

    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('aborted') });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(world.chat.send).toHaveBeenCalledTimes(1);
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected settlement abort as a bounded run failure', async () => {
    let resolveIdle: (() => void) | undefined;
    const session = {
      ...defaultSession(),
      waitForIdle: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveIdle = resolve;
          }),
      ),
      abort: vi.fn(() => {
        // Settlement still proceeds (the SDK settles after the abort drive),
        // but the abort call itself reports failure — the observed rejection
        // must surface as a bounded run failure, never as success.
        resolveIdle?.();
        return Promise.reject(new Error('settlement abort exploded'));
      }),
    };
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session,
    });
    const controller = new AbortController();
    const pending = runCanary(world.deps, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('settlement abort exploded') });
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('abort') });
  });
});

describe('canary — session verification', () => {
  it('fails when the live session is on a different model than the pin', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: {
        ...defaultSession(),
        model: { provider: 'other-provider', id: 'other-model' },
      },
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('other-provider/other-model') });
  });

  it('fails when the live session carries no model at all', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: { ...defaultSession(), model: null },
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('no model') });
  });

  it('fails when the session is still streaming after the turn (no follow-up capability)', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: { ...defaultSession(), isStreaming: true },
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('still streaming') });
  });

  it('fails when there is no live session after the turn', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: null,
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('no live session') });
  });

  it('fails when the stored user prompt does not match what the canary sent', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: {
        ...defaultSession(),
        sessionManager: {
          getEntries: () => [
            { type: 'message', message: { role: 'user', content: 'something else entirely' } },
          ],
        },
      },
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('stored prompt') });
  });

  it('fails with a bounded reason when live-session inspection itself errors', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      sessionError: new Error('session inspection exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('session inspection exploded') });
    // The turn completed but the run must still be cleaned up.
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
  });
});

describe('canary — cleanup failures resolve by flavor', () => {
  it('resolves unsafe when chat disposal fails, still removing and verifying the root', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      disposeError: new Error('dispose exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    // A rejected disposal means a live session may still be running: the
    // promotion must never roll back while that ambiguity stands.
    expect(outcome).toEqual({ kind: 'unsafe', reason: expect.stringContaining('dispose exploded') });
    // Best-effort: removal and absence verification still ran.
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).toHaveBeenCalledTimes(1);
  });

  it('resolves failed when the temp-root removal fails after a successful disposal', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      rmError: new Error('rm exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    // Disposal succeeded, so the session is gone and rollback is safe; the
    // candidate is still rejected.
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('rm exploded') });
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).not.toHaveBeenCalled();
  });

  it('resolves failed when the temp root is still present after removal', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      existsResult: true,
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('still present') });
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).toHaveBeenCalledTimes(1);
  });

  it('resolves failed when the absence probe itself errors', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      existsError: new Error('exists exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('exists exploded') });
  });

  it('keeps unsafe when the root cleanup also fails — session ambiguity outranks root leakage', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      disposeError: new Error('dispose exploded'),
      rmError: new Error('rm exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'unsafe', reason: expect.stringContaining('dispose exploded') });
    // Every cleanup step was still attempted: disposal, then root removal (the
    // absence probe belongs to the removal's success path and did not run).
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
    expect(world.fs.exists).not.toHaveBeenCalled();
  });

  it('never resolves ok when cleanup failed after a successful run', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      rmError: new Error('rm exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('rm exploded');
  });

  it('combines a failed run with a failed cleanup into one bounded reason', async () => {
    const world = makeWorld({
      sendError: new Error('provider unreachable: connection refused'),
      rmError: new Error('rm exploded'),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('provider unreachable');
      expect(outcome.reason).toContain('rm exploded');
    }
  });
});

describe('canary — bounded diagnostics', () => {
  it.each([1, 2, 15, 16, MAX_REASON_BYTES])('bounds a failed reason to a %i-byte ceiling even below the marker size', async (max) => {
    const world = makeWorld({
      sendError: new Error('provider unreachable with a very long diagnostic tail'),
    });
    const outcome = await runCanary({ ...world.deps, maxReasonBytes: max }, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(max);
    }
  });

  it('bounds the pre-abort reason to an injected tiny ceiling', async () => {
    const world = makeWorld();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCanary({ ...world.deps, maxReasonBytes: 4 }, controller.signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(4);
    }
  });

  it('bounds a session-verification failure to an injected tiny ceiling', async () => {
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      session: {
        ...defaultSession(),
        model: { provider: 'other-provider-with-a-very-long-name', id: 'other-model' },
      },
    });
    const outcome = await runCanary({ ...world.deps, maxReasonBytes: 8 }, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(8);
    }
  });

  it('bounds an oversized disposal-failure diagnostic to the reason ceiling', async () => {
    const huge = `x${'y'.repeat(MAX_REASON_BYTES * 4)}z`;
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      disposeError: new Error(`dispose flood: ${huge}`),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome.kind).toBe('unsafe');
    if (outcome.kind === 'unsafe') {
      expect(outcome.reason).toContain('truncated');
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(MAX_REASON_BYTES);
    }
  });

  it('bounds an oversized root-cleanup failure diagnostic to the reason ceiling', async () => {
    const huge = `x${'y'.repeat(MAX_REASON_BYTES * 4)}z`;
    const world = makeWorld({
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
      rmError: new Error(`rm flood: ${huge}`),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('truncated');
      expect(Buffer.byteLength(outcome.reason)).toBeLessThanOrEqual(MAX_REASON_BYTES);
    }
  });
});

describe('canary — whitespace-only assistant text', () => {
  it('fails when the turn produced only whitespace, never an answer', async () => {
    const world = makeWorld({ sendImpl: cannedSend({ kind: 'text', delta: ' \t\n ' }) });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('whitespace') });
  });

  it('succeeds when non-whitespace text was emitted after leading whitespace', async () => {
    const world = makeWorld({ sendImpl: cannedSend({ kind: 'text', delta: '  CANARY-OK  ' }) });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'ok' });
  });

  it('still counts whitespace bytes toward the assistant byte ceiling', async () => {
    const world = makeWorld({ sendImpl: cannedSend({ kind: 'text', delta: `${' '.repeat(20)}x` }) });
    const outcome = await runCanary({ ...world.deps, maxAssistantBytes: 16 }, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('ceiling') });
  });
});

describe('canary — setup failures', () => {
  it('fails with a bounded reason when the temp root cannot be created', async () => {
    const world = makeWorld({ tempRootError: new Error('temp root exploded') });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('temp root exploded') });
    // Nothing was created, so nothing may be removed.
    expect(world.fs.rm).not.toHaveBeenCalled();
  });

  it('fails with a bounded reason when the chat factory fails, and cleans up the created root', async () => {
    const world = makeWorld({ chatError: new Error('chat factory exploded') });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('chat factory exploded') });
    // The root was created before the factory failure; it is removed and
    // verified absent, but no chat exists to dispose.
    expect(world.chat.disposeLiveSession).not.toHaveBeenCalled();
    expect(world.fs.rm).toHaveBeenCalledWith(world.tempRoot.root, { recursive: true });
    expect(world.fs.exists).toHaveBeenCalledWith(world.tempRoot.root);
  });

  it('fails with a bounded reason when setRoot fails, and cleans up', async () => {
    const world = makeWorld({
      setRootError: new Error('root selection exploded'),
      sendImpl: cannedSend({ kind: 'text', delta: 'CANARY-OK' }),
    });
    const outcome = await runCanary(world.deps, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', reason: expect.stringContaining('root selection exploded') });
    expect(world.chat.send).not.toHaveBeenCalled();
    expect(world.chat.disposeLiveSession).toHaveBeenCalledTimes(1);
    expect(world.fs.rm).toHaveBeenCalledTimes(1);
  });
});

describe('canary — production binding', () => {
  it('constructs nothing until invoked and fails cleanly on a pre-aborted signal', async () => {
    const run = productionRunCanary();
    const controller = new AbortController();
    controller.abort();
    // A pre-aborted run never reaches temp-root creation, PiChat construction,
    // or a model call: no fs writes, no sessions, no network.
    await expect(run(controller.signal)).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringContaining('aborted'),
    });
  });
});
