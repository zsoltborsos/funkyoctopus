/**
 * Focused PiChat seams for the promotion canary: the explicit initial provider/model
 * (so the canary cannot inherit env config) and the structural ToolGuard
 * surface (so the canary can install a deny-all guard without a VaultGuard).
 *
 * Default behavior — no initial model, production VaultGuard wiring — is
 * asserted unchanged. The SDK is partially mocked exactly as in
 * `session-dir.test.ts`: only `createAgentSession`, `SettingsManager.create`
 * and `DefaultResourceLoader` are faked, so the real construction path of
 * PiChat.createSession runs against the seam under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// The environment's own FUNKYOCTOPUS_PROVIDER/MODEL must not leak into these
// tests: with neither set, pi's settings decide.
vi.mock('../config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.ts')>();
  return { ...actual, config: { ...actual.config, piProvider: undefined, piModel: undefined } };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  class MockResourceLoader {
    readonly reload = vi.fn(() => Promise.resolve());
  }
  return {
    ...actual,
    createAgentSession: vi.fn(),
    SettingsManager: { create: vi.fn(() => ({ reload: vi.fn() })) },
    DefaultResourceLoader: MockResourceLoader,
  };
});

import {
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { PiChat } from './pi-chat.ts';
import type { ModelCatalog } from './model-catalog.ts';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';

const mockedCreateAgentSession = vi.mocked(createAgentSession);
const mockedSettingsCreate = (SettingsManager as unknown as { create: Mock }).create;

/** pi's own settings as the session's SettingsManager reports them. */
function piDefaults(defaults: { provider?: string; model?: string }) {
  mockedSettingsCreate.mockReturnValueOnce({
    reload: vi.fn(),
    getDefaultProvider: () => defaults.provider,
    getDefaultModel: () => defaults.model,
  });
}

/** Just enough SessionManager for the construction/identity reads PiChat makes. */
function scriptedManager() {
  return {
    getSessionFile: () => '/sessions/scripted.jsonl',
    getSessionId: () => 'scripted',
    getCwd: () => '/workspace',
    getSessionName: () => undefined,
    getHeader: () => ({ timestamp: '2026-07-25T10:00:00.000Z' }),
    getEntries: () => [],
    buildContextEntries: () => [],
    getLeafId: () => 'leaf-1',
    isPersisted: () => true,
  };
}

class ScriptedSession {
  readonly isStreaming = false;
  readonly dispose = vi.fn();
  readonly bindExtensions = vi.fn(() => Promise.resolve());
  readonly sessionManager = scriptedManager();
  readonly agent: {
    beforeToolCall?: (context: { toolCall: { id: string; name: string }; args: unknown }, signal?: AbortSignal) => Promise<unknown>;
  } = {};
  private listener: ((event: AgentSessionEvent) => void) | null = null;

  readonly prompt = vi.fn(() => {
    this.listener?.({ type: 'agent_end', messages: [], willRetry: false });
    return Promise.resolve();
  });
  readonly abort = vi.fn(() => Promise.resolve());
  readonly getContextUsage = vi.fn(() => undefined);

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

/** A catalog whose runtime echoes the requested provider/model back. */
function fakeCatalog() {
  const getModel = vi.fn((provider: string, model: string) => ({ provider, id: model }));
  const catalog = {
    getRuntime: () => Promise.resolve({ getModel }),
    resolve: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
  } as unknown as ModelCatalog;
  return { getModel, catalog };
}

const benignGuard = () => Promise.resolve({ guard: () => Promise.resolve(undefined) });

describe('PiChat explicit initial model seam', () => {
  beforeEach(() => {
    mockedCreateAgentSession.mockResolvedValue({
      session: new ScriptedSession() as unknown as AgentSession,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the session on the explicit initial provider/model when given', async () => {
    const { getModel, catalog } = fakeCatalog();
    const chat = new PiChat(
      catalog,
      undefined,
      benignGuard,
      '/tmp/iso-sessions',
      { provider: 'pin-provider', model: 'pin-model' },
    );

    for await (const chunk of chat.send('hello', new AbortController().signal)) void chunk;

    // The seam is consulted at session construction, before any turn options.
    expect(getModel).toHaveBeenCalledWith('pin-provider', 'pin-model');
    expect(mockedCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: { provider: 'pin-provider', id: 'pin-model' } }),
    );
  });

  it("builds the session on pi's default provider/model when no initial model is given", async () => {
    vi.spyOn(SessionManager, 'continueRecent').mockReturnValue(
      scriptedManager() as unknown as SessionManager,
    );
    piDefaults({ provider: 'pi-provider', model: 'pi-model' });
    const { getModel, catalog } = fakeCatalog();
    const chat = new PiChat(catalog, undefined, benignGuard);

    for await (const chunk of chat.send('hello', new AbortController().signal)) void chunk;

    expect(getModel).toHaveBeenCalledWith('pi-provider', 'pi-model');
    expect(mockedCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: { provider: 'pi-provider', id: 'pi-model' } }),
    );
  });

  it('refuses to build a session when neither the environment nor pi settings name a model', async () => {
    piDefaults({});
    const { getModel, catalog } = fakeCatalog();
    const chat = new PiChat(catalog, undefined, benignGuard);

    const turn = (async () => {
      for await (const chunk of chat.send('hello', new AbortController().signal)) void chunk;
    })();

    await expect(turn).rejects.toThrow(/FUNKYOCTOPUS_PROVIDER.*FUNKYOCTOPUS_MODEL.*defaultProvider.*defaultModel/);
    expect(getModel).not.toHaveBeenCalled();
    expect(mockedCreateAgentSession).not.toHaveBeenCalled();
  });

  it('does not read pi default settings when an initial model is pinned', async () => {
    const getDefaultProvider = vi.fn(() => 'pi-provider');
    const getDefaultModel = vi.fn(() => 'pi-model');
    mockedSettingsCreate.mockReturnValueOnce({
      reload: vi.fn(),
      getDefaultProvider,
      getDefaultModel,
    });
    const { getModel, catalog } = fakeCatalog();
    const chat = new PiChat(catalog, undefined, benignGuard, '/tmp/iso-sessions', {
      provider: 'pin-provider',
      model: 'pin-model',
    });

    for await (const chunk of chat.send('hello', new AbortController().signal)) void chunk;

    expect(getModel).toHaveBeenCalledWith('pin-provider', 'pin-model');
    expect(getDefaultProvider).not.toHaveBeenCalled();
    expect(getDefaultModel).not.toHaveBeenCalled();
  });
});

describe('PiChat structural ToolGuard surface', () => {
  beforeEach(() => {
    mockedCreateAgentSession.mockResolvedValue({
      session: new ScriptedSession() as unknown as AgentSession,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs a deny-all structural guard and blocks every tool call before execution', async () => {
    const sessions: ScriptedSession[] = [];
    mockedCreateAgentSession.mockImplementation(() => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve({ session: session as unknown as AgentSession } as never);
    });
    const guard = vi.fn(() => Promise.resolve({ block: true as const, reason: 'canary denies all tool calls' }));
    const { catalog } = fakeCatalog();
    const chat = new PiChat(
      catalog,
      undefined,
      () => Promise.resolve({ guard }),
      '/tmp/iso-sessions',
      { provider: 'pin-provider', model: 'pin-model' },
    );

    for await (const chunk of chat.send('hello', new AbortController().signal)) void chunk;

    // The guard factory returns a plain structural ToolGuard, not a VaultGuard,
    // and PiChat wires it into the agent's pre-execution hook.
    const session = sessions[0]!;
    expect(session.agent.beforeToolCall).toBeDefined();
    await expect(
      session.agent.beforeToolCall!({ toolCall: { id: 'call-1', name: 'bash' }, args: { command: 'ls' } }),
    ).resolves.toEqual({ block: true, reason: 'canary denies all tool calls' });
    expect(guard).toHaveBeenCalledWith('call-1', 'bash', { command: 'ls' }, undefined);
  });
});

describe('PiChat send — abort before the prompt is dispatched', () => {
  beforeEach(() => {
    mockedCreateAgentSession.mockResolvedValue({
      session: new ScriptedSession() as unknown as AgentSession,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never builds a session or dispatches a prompt on a pre-aborted signal', async () => {
    const { catalog } = fakeCatalog();
    const chat = new PiChat(
      catalog,
      undefined,
      benignGuard,
      '/tmp/iso-sessions',
      { provider: 'pin-provider', model: 'pin-model' },
    );
    const controller = new AbortController();
    controller.abort();

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('hello', controller.signal)) chunks.push(chunk);

    expect(chunks).toEqual([]);
    expect(mockedCreateAgentSession).not.toHaveBeenCalled();
  });

  it('does not dispatch a prompt when the signal aborts while the session is being built', async () => {
    const sessions: ScriptedSession[] = [];
    let release: (() => void) | undefined;
    mockedCreateAgentSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          const session = new ScriptedSession();
          sessions.push(session);
          release = () => resolve({ session: session as unknown as AgentSession } as never);
        }),
    );
    const { catalog } = fakeCatalog();
    const chat = new PiChat(
      catalog,
      undefined,
      benignGuard,
      '/tmp/iso-sessions',
      { provider: 'pin-provider', model: 'pin-model' },
    );
    const controller = new AbortController();

    const iterator = chat.send('hello', controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    controller.abort();
    // Let the construction chain reach the gated session factory, then release
    // it: the abort has already landed, so the post-construction check must
    // refuse to dispatch the prompt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release!();
    await first;
    const tail = await iterator.next();

    expect(sessions).toHaveLength(1);
    expect(tail.done).toBe(true);
    // The turn was never started: the check between session construction and
    // the prompt sees the aborted signal.
    expect(sessions[0]!.prompt).not.toHaveBeenCalled();
  });

  it('does not dispatch a prompt when the signal aborts while turn options are applied', async () => {
    const sessions: ScriptedSession[] = [];
    mockedCreateAgentSession.mockImplementation(() => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve({ session: session as unknown as AgentSession } as never);
    });
    let release: (() => void) | undefined;
    const catalog = {
      getRuntime: () =>
        Promise.resolve({
          getModel: vi.fn((provider: string, model: string) => ({ provider, id: model })),
        }),
      resolve: () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
      list: () => Promise.resolve([]),
    } as unknown as ModelCatalog;
    const chat = new PiChat(
      catalog,
      undefined,
      benignGuard,
      '/tmp/iso-sessions',
      { provider: 'pin-provider', model: 'pin-model' },
    );
    const controller = new AbortController();

    const iterator = chat.send('hello', controller.signal, {
      provider: 'other-provider',
      model: 'other-model',
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    // Let the session construction settle so the generator is parked inside
    // applyTurnOptions on the gated model resolution.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    release!();
    await first;
    const tail = await iterator.next();

    expect(tail.done).toBe(true);
    expect(sessions[0]!.prompt).not.toHaveBeenCalled();
  });
});
