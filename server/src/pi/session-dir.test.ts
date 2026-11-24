import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  // A real class, not a vi.fn implementation: afterEach's restoreAllMocks
  // would otherwise wipe a mockImplementation after the first test.
  class MockResourceLoader {
    readonly reload = vi.fn(() => Promise.resolve());
  }
  return {
    ...actual,
    createAgentSession: vi.fn(),
    SettingsManager: {
      create: vi.fn(() => ({
        reload: vi.fn(),
        // pi's own default model settings: the sessions here take their model from them.
        getDefaultProvider: () => 'example-provider',
        getDefaultModel: () => 'example-model',
      })),
    },
    DefaultResourceLoader: MockResourceLoader,
  };
});

import {
  SessionManager,
  createAgentSession,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { Mock } from 'vitest';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { VaultGuard } from '../security/vault.ts';
import type { ModelCatalog } from './model-catalog.ts';
import { PiChat } from './pi-chat.ts';

const mockedCreateAgentSession = vi.mocked(createAgentSession);
const mockedSettingsCreate = (SettingsManager as unknown as { create: Mock }).create;

/** Just enough SessionManager for the construction/identity reads PiChat makes. */
function scriptedManager(file = '/sessions/scripted.jsonl', cwd = '/workspace') {
  return {
    getSessionFile: () => file,
    getSessionId: () => 'scripted',
    getCwd: () => cwd,
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
  readonly extensionRunner = { hasHandlers: () => false };
  readonly sessionManager = scriptedManager();
  readonly agent: { beforeToolCall?: AgentSession['agent']['beforeToolCall'] } = {};
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

const model = { provider: 'opencode-go', id: 'deepseek-v4-flash' };
const catalog = {
  getRuntime: () => Promise.resolve({ getModel: () => model }),
  resolve: () => Promise.resolve(model),
} as unknown as ModelCatalog;

const scriptedFactory = () => Promise.resolve(new ScriptedSession() as unknown as AgentSession);

beforeEach(() => {
  mockedCreateAgentSession.mockResolvedValue({
    session: new ScriptedSession() as unknown as AgentSession,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PiChat isolated session directory', () => {
  it('threads the session directory through continue, create, open and list construction', async () => {
    const sessionDir = '/tmp/iso-sessions';
    const continueSpy = vi
      .spyOn(SessionManager, 'continueRecent')
      .mockReturnValue(scriptedManager('/sessions/continued.jsonl') as unknown as SessionManager);
    const createSpy = vi
      .spyOn(SessionManager, 'create')
      .mockReturnValue(scriptedManager('/sessions/created.jsonl') as unknown as SessionManager);
    const openSpy = vi
      .spyOn(SessionManager, 'open')
      .mockReturnValue(
        scriptedManager('/sessions/opened.jsonl', tmpdir()) as unknown as SessionManager,
      );
    const sources = {
      projectPaths: () => Promise.resolve([]),
      recentSessions: () => Promise.resolve([]),
    };
    const listSpy = vi
      .spyOn(SessionManager, 'list')
      .mockResolvedValue([] as Awaited<ReturnType<typeof SessionManager.list>>);
    const vaultGuardSpy = vi
      .spyOn(VaultGuard, 'create')
      .mockResolvedValue({ guard: () => Promise.resolve(undefined) } as never);

    const chat = new PiChat(catalog, undefined, undefined, sessionDir, undefined, sources);

    // First construction at the primary root goes through `continueRecent`.
    await chat.setRoot('/tmp/project-a');
    await chat.newChat();
    await chat.openChat('/sessions/opened.jsonl');
    await chat.listChats('/tmp/project-a');

    expect(continueSpy).toHaveBeenCalledWith('/tmp/project-a', sessionDir);
    expect(createSpy).toHaveBeenCalledWith('/tmp/project-a', sessionDir);
    expect(openSpy).toHaveBeenCalledWith('/sessions/opened.jsonl', sessionDir);
    expect(listSpy).toHaveBeenCalledWith('/tmp/project-a', sessionDir);
    // The old production construction is restored: createAgentSession is the
    // single site, fed PiChat's cwd, the SettingsManager built for that root,
    // the reloaded DefaultResourceLoader, and the buildManager's session
    // manager (including the opened session's adopted cwd).
    expect(mockedCreateAgentSession).toHaveBeenCalledTimes(3);
    expect(mockedCreateAgentSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/project-a',
        model,
        settingsManager: expect.anything(),
        resourceLoader: expect.anything(),
        sessionManager: expect.anything(),
      }),
    );
    expect(mockedCreateAgentSession).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ cwd: tmpdir() }),
    );
    expect(mockedSettingsCreate).toHaveBeenCalledWith('/tmp/project-a', expect.any(String));
    expect(mockedSettingsCreate).toHaveBeenCalledWith(tmpdir(), expect.any(String));
    expect(vaultGuardSpy).toHaveBeenCalled();
  });

  it('keeps the default pi session store when no session directory is given', async () => {
    const continueSpy = vi
      .spyOn(SessionManager, 'continueRecent')
      .mockReturnValue(scriptedManager('/sessions/default.jsonl') as unknown as SessionManager);
    vi.spyOn(VaultGuard, 'create').mockResolvedValue({
      guard: () => Promise.resolve(undefined),
    } as never);

    const chat = new PiChat(catalog);
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    expect(continueSpy).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('exposes the live session for inspection and teardown', async () => {
    const session = new ScriptedSession();
    const chat = new PiChat(catalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    await expect(chat.liveSession()).resolves.toBe(session);
    expect(await chat.liveSession()).not.toBeNull();
  });

  it('peeks without constructing: a liveSession before any turn never builds a session', async () => {
    const factory = vi.fn(() =>
      Promise.resolve(new ScriptedSession() as unknown as AgentSession),
    );
    const chat = new PiChat(catalog, factory);

    // Teardown calls this on chats that may never have built — it must not
    // create the very work it is supposed to clean up.
    await expect(chat.liveSession()).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('resolves null when the session never built', async () => {
    const chat = new PiChat(catalog, () =>
      Promise.reject(new Error('provider unreachable')),
    );

    chat.prewarm();
    await expect(chat.liveSession()).resolves.toBeNull();
  });
});

describe('PiChat Vault path override', () => {
  it('routes the production Vault guard through FUNKYOCTOPUS_VAULT_PATH', async () => {
    const vaultOverride = join(tmpdir(), 'iso-vault.json');
    vi.stubEnv('FUNKYOCTOPUS_VAULT_PATH', vaultOverride);
    vi.resetModules();
    const { PiChat: FreshPiChat } = await import('./pi-chat.ts');
    const { VaultGuard: FreshVaultGuard } = await import('../security/vault.ts');
    const createSpy = vi
      .spyOn(FreshVaultGuard, 'create')
      .mockResolvedValue({ guard: () => Promise.resolve(undefined) } as never);

    const chat = new FreshPiChat(
      catalog,
      scriptedFactory,
      undefined,
      undefined,
    );
    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('x', new AbortController().signal)) chunks.push(chunk);

    expect(createSpy).toHaveBeenCalledWith(expect.any(Function), vaultOverride, expect.any(String));
  });

  it('keeps the production default Vault path when no override is set', async () => {
    vi.resetModules();
    const { config } = await import('../config.ts');
    const { DEFAULT_VAULT_PATH } = await import('../security/vault.ts');
    // The sidecar (chat and Helmraiser dispatch alike) routes through this value,
    // so the override must be a no-op by default.
    expect(config.vaultPath).toBe(DEFAULT_VAULT_PATH);
  });
});
