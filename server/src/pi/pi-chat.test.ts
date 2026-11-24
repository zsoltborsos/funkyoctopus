import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { ChatChunk, ChatSessionInfo } from '../../../src/shared/transport/protocol.ts';
import { config } from '../config.ts';
import { FOLDER_NOT_FOUND, wireErrorCode } from '../../../src/shared/transport/errors.ts';
import type { ProjectPaths } from '../projects/registry.ts';
import { PiChat, type PiChatHistorySources } from './pi-chat.ts';
import type { ModelCatalog } from './model-catalog.ts';

/** Just enough SessionManager for the transcript/identity reads PiChat makes. */
function scriptedManager(
  file = '/sessions/scripted.jsonl',
  entries: unknown[] = [],
  cwd = '/workspace',
) {
  return {
    getSessionFile: () => file,
    getSessionId: () => 'scripted',
    getCwd: () => cwd,
    getSessionName: () => undefined,
    getHeader: () => ({ timestamp: '2026-07-25T10:00:00.000Z' }),
    getEntries: () => entries,
    buildContextEntries: () => [],
    // The live leaf is the current tip — the last appended entry.
    getLeafId: () => ((entries.at(-1) as { id?: string } | undefined)?.id ?? 'leaf-1'),
    isPersisted: () => true,
  };
}

/**
 * History sources that never leave the test: no Leeboard CLI, no owner store.
 * Tests that need an index or recent rows pass their own into the suite's
 * `sources()` builder below; this default answers as an empty index.
 */
function hermeticSources(): PiChatHistorySources {
  return {
    projectPaths: () => Promise.resolve([]),
    recentSessions: () => Promise.resolve([]),
  };
}

/** A role-custom message plus its persisted entry, as pi writes them. */
interface ScriptedCustom {
  message: {
    role: 'custom';
    customType: string;
    content: unknown;
    display: boolean;
    details: unknown;
    timestamp: number;
  };
  entry: {
    type: 'custom_message';
    id: string;
    customType: string;
    content: unknown;
    display: boolean;
    details: unknown;
    timestamp: string;
  };
}

const scriptedCustom = (
  id: string,
  ts: number,
  overrides: Record<string, unknown> = {},
): ScriptedCustom => ({
  message: {
    role: 'custom',
    customType: 'crew-result',
    content: 'result body',
    display: true,
    details: { agentId: 'scout-1' },
    timestamp: ts,
    ...(overrides),
  },
  entry: {
    type: 'custom_message',
    id,
    customType: 'crew-result',
    content: 'result body',
    display: true,
    details: { agentId: 'scout-1' },
    timestamp: new Date(ts).toISOString(),
    ...(overrides),
  },
});

class ScriptedSession {
  isStreaming = false;
  readonly dispose = vi.fn();
  readonly entries: unknown[] = [];
  readonly sessionManager = scriptedManager('/sessions/scripted.jsonl', this.entries);
  readonly agent: { beforeToolCall?: AgentSession['agent']['beforeToolCall'] } = {};
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  /** When set, the turn completes a compaction before the agent ends. */
  constructor(
    private readonly compaction?: { aborted: boolean; willRetry: boolean },
    private readonly customs: ScriptedCustom[] = [],
  ) {}

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** A custom message_end arriving after the request stream has closed. */
  emitCustom(custom: ScriptedCustom): void {
    // pi appends the custom_message entry right after _emit (the listener runs
    // before persistence), so the entry is written before any microtask that
    // reads getEntries() back.
    this.emit({ type: 'message_end', message: custom.message } as never);
    this.appendEntry(custom.entry);
  }

  /** Append a persisted entry under the current tip, forming a parent chain. */
  appendEntry(entry: unknown): void {
    const last = this.entries.at(-1) as { id?: string } | undefined;
    this.entries.push({ ...(entry as object), parentId: last?.id ?? null });
  }

  /**
   * One run nobody's `prompt` started: what pi-crew's `triggerTurn` delivery
   * looks like on the session. Synchronous; emits the same event kinds as a
   * client turn, so the shared mapping path is exercised end to end.
   */
  runTriggered(): void {
    this.emit({ type: 'agent_start' } as never);
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'report: ' },
    } as never);
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'done' },
    } as never);
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
    } as never);
    this.emit({
      type: 'tool_execution_start',
      toolCallId: 'crew-call-1',
      toolName: 'read',
      args: { path: 'probe.txt' },
    } as never);
    this.emit({
      type: 'tool_execution_end',
      toolCallId: 'crew-call-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'probe output' }] },
      isError: false,
    } as never);
    this.emit({ type: 'agent_end', messages: [], willRetry: false } as never);
    this.emit({ type: 'agent_settled' } as never);
  }

  readonly prompt = vi.fn(() =>
    Promise.resolve()
      .then(() => {
        // pi rejects an unqualified prompt while any run is active.
        if (this.isStreaming) throw new Error('Agent is already processing.');
        // A started run announces itself, exactly as pi does.
        this.emit({ type: 'agent_start' } as never);
        // Role-custom message_ends (and their persisted entries) land first, in
        // their own microtask, so the deferred id-readback chunk pushes before
        // agent_end closes the request stream.
        for (const custom of this.customs) {
          this.emit({ type: 'message_end', message: custom.message } as never);
          this.appendEntry(custom.entry);
        }
        this.emit({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'edit',
          args: { path: 'src/App.tsx' },
        });
        this.emit({
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'edit',
          result: {
            content: [{ type: 'text', text: 'Successfully replaced 1 block.' }],
            details: { diff: '-old\n+new' },
          },
          isError: false,
        });
        if (this.compaction) {
          this.emit({
            type: 'compaction_end',
            reason: 'threshold',
            result: undefined,
            ...this.compaction,
          });
        }
      })
      .then(() => {
        this.emit({ type: 'agent_end', messages: [], willRetry: false });
        // The run settles only after its end event, again as pi does.
        this.emit({ type: 'agent_settled' } as never);
      }),
  );
  readonly abort = vi.fn(() => Promise.resolve());
  readonly waitForIdle = vi.fn(() => Promise.resolve());
  readonly getContextUsage = vi.fn(() => ({ tokens: 1234, contextWindow: 200_000, percent: 0.617 }));
  // Minimal model/effort surface, for `applyTurnOptions` assertions.
  model: { provider: string; id: string } | null = null;
  readonly setModel = vi.fn();
  thinkingLevel = 'medium';
  getAvailableThinkingLevels = (): string[] => ['medium', 'high'];
  readonly setThinkingLevel = vi.fn();

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('PiChat tool stream', () => {
  it('creates the next sidecar session at a newly selected project root', async () => {
    const roots: string[] = [];
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, (root) => {
      roots.push(root);
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });

    for await (const chunk of chat.send('first', new AbortController().signal)) {
      void chunk;
    }
    await chat.setRoot('/tmp/selected-project');
    for await (const chunk of chat.send('second', new AbortController().signal)) {
      void chunk;
    }

    expect(roots.at(-1)).toBe('/tmp/selected-project');
    expect(sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('starts a new chat by disposing the live session and building a fresh one', async () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    await chat.newChat();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();
  });

  it('builds every live session through the one construction site', async () => {
    // Every path that needs a session — first turn, re-root, new chat, open —
    // builds it through the one construction site, asserted rather than trusted.
    const built: string[] = [];
    const chat = new PiChat({} as ModelCatalog, (root) => {
      built.push(root);
      return Promise.resolve(new ScriptedSession() as unknown as AgentSession);
      }, undefined, undefined, undefined, hermeticSources());
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      scriptedManager('/sessions/stored.jsonl', [], tmpdir()) as unknown as SessionManager,
    );

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    await chat.setRoot('/tmp/selected-project');
    await chat.newChat();
    await chat.openChat('/sessions/stored.jsonl');
    await chat.current();

    expect(built).toEqual([
      config.primaryWorkspaceRoot,
      '/tmp/selected-project',
      '/tmp/selected-project',
      tmpdir(),
    ]);
    vi.restoreAllMocks();
  });

  it('re-roots without throwing when the previous session never built', async () => {
    let attempt = 0;
    const chat = new PiChat({} as ModelCatalog, () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('provider unreachable'))
        : Promise.resolve(new ScriptedSession() as unknown as AgentSession);
    });

    chat.prewarm();
    await expect(chat.setRoot('/tmp/another-project')).resolves.toEqual([]);
  });

  it('maps a scripted pi tool call and result and runs the turn to completion', async () => {
    const scripted = new ScriptedSession();
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(scripted as unknown as AgentSession),
    );
    const chunks: ChatChunk[] = [];

    for await (const chunk of chat.send('edit the app', new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(scripted.prompt).toHaveBeenCalledWith('edit the app');
    expect(chunks).toEqual([
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'edit',
        summary: 'edit: src/App.tsx',
        args: { path: 'src/App.tsx' },
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        ok: true,
        output: 'Successfully replaced 1 block.',
        diff: '-old\n+new',
        details: { diff: '-old\n+new' },
      },
      { kind: 'usage', tokens: 1234, contextWindow: 200_000, percent: 0.617 },
    ]);
  });

  it('hands composer images to pi as image content alongside the typed text', async () => {
    const scripted = new ScriptedSession();
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(scripted as unknown as AgentSession),
    );

    for await (const _chunk of chat.send('what is this?', new AbortController().signal, {
      images: [
        { mimeType: 'image/png', data: 'AAA' },
        { mimeType: 'image/jpeg', data: 'BBB' },
      ],
    })) {
      void _chunk;
    }

    expect(scripted.prompt).toHaveBeenCalledWith('what is this?', {
      images: [
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
        { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
      ],
    });
  });

  it('dispatches a bare one-argument prompt when a turn carries no images', async () => {
    const scripted = new ScriptedSession();
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(scripted as unknown as AgentSession),
    );

    for await (const _chunk of chat.send('no pictures', new AbortController().signal, {
      images: [],
    })) {
      void _chunk;
    }

    // One argument, not `(text, { images: [] })`: the empty-array call is a
    // different code path in pi and the prompt-text contract is per-argument.
    expect(scripted.prompt.mock.calls).toEqual([['no pictures']]);
  });
});

describe('PiChat streaming teardown', () => {
  const chatWith = () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });
    return { chat, sessions };
  };

  it('aborts a streaming session before disposing it on swap', async () => {
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    sessions[0]!.isStreaming = true;
    const order: string[] = [];
    sessions[0]!.abort.mockImplementation(() => {
      order.push('abort');
      return Promise.resolve();
    });
    sessions[0]!.dispose.mockImplementation(() => {
      order.push('dispose');
    });

    await chat.setRoot('/tmp/other');

    // In-flight work settles before session_shutdown/dispose — no hanging
    // stream is torn down mid-flight.
    expect(order).toEqual(['abort', 'dispose']);
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts a streaming session before explicit disposeLiveSession teardown', async () => {
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    sessions[0]!.isStreaming = true;
    const order: string[] = [];
    sessions[0]!.abort.mockImplementation(() => {
      order.push('abort');
      return Promise.resolve();
    });
    sessions[0]!.dispose.mockImplementation(() => {
      order.push('dispose');
    });

    expect(await chat.disposeLiveSession()).toBe(true);

    expect(order).toEqual(['abort', 'dispose']);
  });

  it('still disposes and reports when abort rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    sessions[0]!.isStreaming = true;
    sessions[0]!.abort.mockRejectedValueOnce(new Error('abort exploded'));

    await chat.setRoot('/tmp/other');

    // host.dispose still runs even though abort rejected, the failure is
    // reported, and the next session is unaffected.
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('abort exploded'));
    errorSpy.mockRestore();
  });

  it('skips abort for a quiet session', async () => {
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;

    await chat.setRoot('/tmp/other');

    expect(sessions[0]!.abort).not.toHaveBeenCalled();
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the host and caches nothing when vault installation fails', async () => {
    const sessions: ScriptedSession[] = [];
    let vaultFails = true;
    const chat = new PiChat(
      {} as ModelCatalog,
      () => {
        const session = new ScriptedSession();
        sessions.push(session);
        return Promise.resolve(session as unknown as AgentSession);
      },
      () => {
        if (vaultFails) {
          vaultFails = false;
          return Promise.reject(new Error('vault exploded'));
        }
        return Promise.resolve({ guard: () => Promise.resolve(undefined) } as never);
      },
    );

    await expect(
      chat.send('probe', new AbortController().signal)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('vault exploded');
    // The built host is disposed exactly once on the failed install path.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);

    // Nothing is cached: the next turn builds and keeps a fresh host.
    for await (const chunk of chat.send('again', new AbortController().signal)) void chunk;
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();
  });
});

describe('PiChat turn guard', () => {
  const catalogWith = (resolve: ReturnType<typeof vi.fn>) => ({ resolve }) as unknown as ModelCatalog;

  it('rejects a second client send while one is running, leaving the first turn untouched', async () => {
    // Park the first send inside its session build: its guard is held for the
    // whole construction, so the second send races a genuinely running turn.
    let releaseSession!: (session: AgentSession) => void;
    const session = new ScriptedSession();
    const chat = new PiChat(
      catalogWith(vi.fn(() => Promise.resolve({ provider: 'x', id: 'grok' }))),
      () => new Promise<AgentSession>((resolve) => (releaseSession = resolve)),
    );
    const approvals = (
      chat as unknown as { approvals: { setEmitter: ReturnType<typeof vi.fn> } }
    ).approvals;
    const setEmitter = vi.spyOn(approvals, 'setEmitter');

    const first: ChatChunk[] = [];
    const drained = (async () => {
      for await (const chunk of chat.send('first', new AbortController().signal)) {
        first.push(chunk);
      }
    })();

    const second = chat.send('second', new AbortController().signal, {
      provider: 'x',
      model: 'grok',
      effort: 'high',
    });
    await expect(second[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      message: 'a turn is already running',
      code: 'turn_in_progress',
    });
    // The rejected send never touched the running turn's approval channel.
    expect(setEmitter).not.toHaveBeenCalled();
    // …nor resolved a model for its own options.
    expect(second[Symbol.asyncIterator]()).toBeDefined();
    expect(releaseSession).toBeDefined();

    releaseSession(session as unknown as AgentSession);
    await drained;

    // The first turn completed normally: its own emitter install and the final
    // cleanup, nothing more.
    const calls = setEmitter.mock.calls.map((call) => call[0] !== null);
    expect(calls).toEqual([true, false]);
    // The rejected send's options were never applied to the live session.
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
    expect(first.length).toBeGreaterThan(0);
  });

  it('a send rejected mid-turn leaves the running turn’s pending Vault approval, model and effort alone', async () => {
    const session = new ScriptedSession();
    session.setModel.mockImplementation((model: { provider: string; id: string }) => {
      session.model = model;
      return Promise.resolve();
    });
    // The first turn escalates two tool calls to the Vault, each waiting on
    // its verdict: the second is raised after the rejected send, so it proves
    // the channel is still the first turn's.
    const decisions: unknown[] = [];
    session.prompt.mockImplementation(async () => {
      session.isStreaming = true;
      session.emit({ type: 'agent_start' } as never);
      for (const id of ['call-vault-1', 'call-vault-2']) {
        decisions.push(
          await session.agent.beforeToolCall!(
            { toolCall: { id, name: 'read' }, args: { path: '/vault/secret' } } as never,
            undefined,
          ),
        );
      }
      session.isStreaming = false;
      session.emit({ type: 'agent_end', messages: [], willRetry: false });
      session.emit({ type: 'agent_settled' } as never);
    });
    const resolve = vi.fn((provider: string, id: string) => Promise.resolve({ provider, id }));
    const chat: PiChat = new PiChat(
      catalogWith(resolve),
      () => Promise.resolve(session as unknown as AgentSession),
      // A Vault guard that escalates every call through PiChat's own broker.
      () =>
        Promise.resolve({
          guard: async (callId: string, tool: string, args: unknown, signal?: AbortSignal) => {
            const broker = (chat as unknown as {
              approvals: { request: (r: unknown, s?: AbortSignal) => Promise<boolean> };
            }).approvals;
            const approved = await broker.request({ callId, tool, target: '/vault', args }, signal);
            return approved ? undefined : { block: true as const, reason: 'denied' };
          },
        }),
    );

    const first: ChatChunk[] = [];
    const drained = (async () => {
      for await (const chunk of chat.send('first', new AbortController().signal, {
        provider: 'x',
        model: 'first-model',
        effort: 'medium',
      })) {
        first.push(chunk);
      }
    })();
    await vi.waitFor(() => expect(first.some((c) => c.kind === 'approval-request')).toBe(true));

    const second = chat.send('second', new AbortController().signal, {
      provider: 'x',
      model: 'second-model',
      effort: 'high',
    });
    await expect(second[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'turn_in_progress',
    });

    // The pending approval still resolves the first turn's tool call, and the
    // next escalation still reaches the first turn's stream.
    const requestOf = (callId: string): string => {
      const chunk = first.find((c) => c.kind === 'approval-request' && c.callId === callId);
      return chunk?.kind === 'approval-request' ? chunk.requestId : '';
    };
    expect(chat.resolveApproval(requestOf('call-vault-1'), true)).toBe(true);
    await vi.waitFor(() =>
      expect(first.filter((c) => c.kind === 'approval-request')).toHaveLength(2),
    );
    expect(chat.resolveApproval(requestOf('call-vault-2'), false)).toBe(true);
    await drained;
    expect(decisions).toEqual([undefined, { block: true, reason: 'denied' }]);
    expect(first.filter((c) => c.kind === 'approval-request')).toEqual([
      expect.objectContaining({ callId: 'call-vault-1', target: '/vault' }),
      expect.objectContaining({ callId: 'call-vault-2', target: '/vault' }),
    ]);
    // Only the first turn's model and effort ever reached the session.
    expect(resolve.mock.calls).toEqual([['x', 'first-model']]);
    expect(session.setModel).toHaveBeenCalledOnce();
    expect(session.model).toEqual({ provider: 'x', id: 'first-model' });
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
    expect(session.thinkingLevel).toBe('medium');
  });

  it('a pre-aborted send fails the guard without touching anything', async () => {
    let released = false;
    const chat = new PiChat(
      {} as ModelCatalog,
      () => new Promise<AgentSession>((resolve) => {
        released = true;
        resolve(new ScriptedSession() as unknown as AgentSession);
      }),
    );
    const controller = new AbortController();
    controller.abort();
    for await (const chunk of chat.send('never', controller.signal)) void chunk;
    expect(released).toBe(false);

    // The aborted send claimed nothing, so a later send is not locked out.
    for await (const chunk of chat.send('after', new AbortController().signal)) void chunk;
  });
});

describe('PiChat shared session observation', () => {
  const chatWith = () => {
    const sessions: ScriptedSession[] = [];
    // openChat reads the project-path index: fakes keep it off the owner's Leeboard.
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    }, undefined, undefined, undefined, hermeticSources());
    return { chat, sessions };
  };

  /** An observation subscriber collecting chunks, skipping send-stream noise. */
  function collect(chat: PiChat): { seen: ChatChunk[]; stop: () => void } {
    const controller = new AbortController();
    const seen: ChatChunk[] = [];
    const iterator = chat.observe(controller.signal)[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return;
        seen.push(value);
      }
    })().catch(() => undefined);
    return { seen, stop: () => controller.abort() };
  }

  const control = (seen: ChatChunk[]): ChatChunk[] =>
    seen.filter((c) =>
      c.kind === 'session-changed' || c.kind === 'turn-started' || c.kind === 'turn-ended',
    );

  it('a client send observes turn-started/ended with its origin, never into its own stream', async () => {
    const { chat } = chatWith();
    const { seen, stop } = collect(chat);

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('mine', new AbortController().signal, {}, 'browser-1')) {
      chunks.push(chunk);
    }
    // The turn-ended broadcast runs in the send generator's finally, after the
    // last pull; let that land before stopping.
    await vi.waitFor(() => expect(control(seen)).toHaveLength(2));
    stop();

    expect(control(seen)).toEqual([
      { kind: 'turn-started', origin: 'browser-1' },
      { kind: 'turn-ended', origin: 'browser-1' },
    ]);
    // A client turn is not wrapped or broadcast: no agent-chunk reaches
    // observers at all.
    expect(seen.filter((c) => c.kind === 'agent-chunk')).toEqual([]);
    // The sender's own stream carries no control events, only its mapped
    // turn output, unchanged.
    expect(chunks.filter((c) => 'origin' in c)).toEqual([]);
    expect(chunks).toEqual([
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'edit',
        summary: 'edit: src/App.tsx',
        args: { path: 'src/App.tsx' },
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        ok: true,
        output: 'Successfully replaced 1 block.',
        diff: '-old\n+new',
        details: { diff: '-old\n+new' },
      },
      { kind: 'usage', tokens: 1234, contextWindow: 200_000, percent: 0.617 },
    ]);
  });

  it('a run no client send started observes origin agent', async () => {
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('warm', new AbortController().signal)) void chunk;
    const { seen, stop } = collect(chat);
    const session = sessions[0]!;

    session.emit({ type: 'agent_start' } as never);
    session.emit({ type: 'agent_settled' } as never);

    await vi.waitFor(() =>
      expect(control(seen)).toEqual([
        { kind: 'turn-started', origin: 'agent' },
        { kind: 'turn-ended', origin: 'agent' },
      ]),
    );
    stop();
  });

  it('a triggered run streams its wrapped chunks to every observer in order', async () => {
    const { chat, sessions } = chatWith();
    // Warm-up so no client send is in flight, as in production between turns.
    for await (const chunk of chat.send('warm', new AbortController().signal)) void chunk;
    const first = collect(chat);
    const second = collect(chat);
    const session = sessions[0]!;

    session.runTriggered();

    const expected: ChatChunk[] = [
      { kind: 'turn-started', origin: 'agent' },
      { kind: 'agent-chunk', origin: 'agent', chunk: { kind: 'text', delta: 'report: ' } },
      { kind: 'agent-chunk', origin: 'agent', chunk: { kind: 'text', delta: 'done' } },
      { kind: 'agent-chunk', origin: 'agent', chunk: { kind: 'thinking', delta: 'hmm' } },
      {
        kind: 'agent-chunk',
        origin: 'agent',
        chunk: {
          kind: 'tool-call',
          callId: 'crew-call-1',
          tool: 'read',
          summary: 'read: probe.txt',
          args: { path: 'probe.txt' },
        },
      },
      {
        kind: 'agent-chunk',
        origin: 'agent',
        chunk: { kind: 'tool-result', callId: 'crew-call-1', ok: true, output: 'probe output' },
      },
      {
        kind: 'agent-chunk',
        origin: 'agent',
        chunk: { kind: 'usage', tokens: 1234, contextWindow: 200_000, percent: 0.617 },
      },
      { kind: 'turn-ended', origin: 'agent' },
    ];
    await vi.waitFor(() => expect(first.seen).toEqual(expected));
    // Fan-out: every subscriber sees the same ordered sequence.
    await vi.waitFor(() => expect(second.seen).toEqual(expected));
    first.stop();
    second.stop();
  });

  it('an external run still reports its end when a client send began waiting mid-run', async () => {
    const { chat, sessions } = chatWith();
    for await (const chunk of chat.send('warm', new AbortController().signal)) void chunk;
    const session = sessions[0]!;
    const { seen, stop } = collect(chat);

    // pi-crew starts a run while nobody is sending. The deferred idle promise
    // is armed first so the client send below genuinely waits on the run.
    let releaseRun!: () => void;
    session.waitForIdle.mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseRun = () => {
          session.isStreaming = false;
          resolve();
        };
      }),
    );
    session.isStreaming = true;
    session.emit({ type: 'agent_start' } as never);

    const drained = (async () => {
      for await (const chunk of chat.send('queued after trigger', new AbortController().signal)) {
        void chunk;
      }
    })();
    await vi.waitFor(() => expect(session.waitForIdle).toHaveBeenCalled());

    // The run ends while the send is waiting: membership was captured at
    // start, so the external end still broadcasts.
    session.emit({ type: 'agent_settled' } as never);
    releaseRun();
    await drained;

    const agentEvents = (chunk: ChatChunk): boolean =>
      (chunk.kind === 'turn-started' || chunk.kind === 'turn-ended') && chunk.origin === 'agent';
    expect(control(seen).filter(agentEvents)).toEqual([
      { kind: 'turn-started', origin: 'agent' },
      { kind: 'turn-ended', origin: 'agent' },
    ]);
    stop();
  });

  it('newChat, openChat and setRoot observe session-changed with origin and session info', async () => {
    const { chat } = chatWith();
    const { seen, stop } = collect(chat);
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      scriptedManager('/sessions/stored.jsonl', [], '/tmp') as unknown as SessionManager,
    );

    await chat.newChat('cli-1');
    await chat.setRoot('/tmp/root', 'cli-1');
    await chat.openChat('/sessions/stored.jsonl', 'browser-1');

    const changes = () => control(seen).filter((c) => c.kind === 'session-changed');
    await vi.waitFor(() => expect(changes().map((c) => c.origin)).toEqual(['cli-1', 'cli-1', 'browser-1']));
    for (const change of changes()) {
      expect(change.kind === 'session-changed' && change.session).toMatchObject({
        path: expect.stringContaining('.jsonl'),
        id: 'scripted',
      });
    }
    stop();
    vi.restoreAllMocks();
  });

  it('a setRoot to the current root swaps nothing and announces nothing', async () => {
    const { chat } = chatWith();
    const { seen, stop } = collect(chat);

    await chat.setRoot('/tmp/root', 'cli-1');
    // Every browser tab re-applies its project on mount. That is not a switch:
    // announced, it would make every other tab reload and cancel its turn.
    await chat.setRoot('/tmp/root', 'browser-2');
    // A later real change still lands, so the stream was live throughout.
    await chat.newChat('cli-1');

    const changes = () => control(seen).filter((c) => c.kind === 'session-changed');
    await vi.waitFor(() => expect(changes()).toHaveLength(2));
    expect(changes().map((c) => c.origin)).toEqual(['cli-1', 'cli-1']);
    stop();
  });

  it('transcript reads back the live session without building one', async () => {
    let built = 0;
    const chat = new PiChat({} as ModelCatalog, () => {
      built += 1;
      return Promise.resolve(new ScriptedSession() as unknown as AgentSession);
    });

    await expect(chat.transcript()).resolves.toEqual([]);
    expect(built).toBe(0);

    // With a session live, the same call returns its timeline.
    for await (const chunk of chat.send('warm', new AbortController().signal)) void chunk;
    const items = await chat.transcript();
    expect(Array.isArray(items)).toBe(true);
    expect(built).toBe(1);
  });
});

describe('PiChat send during an extension-triggered run', () => {
  // pi-crew 1.0.34 delivers crew results with { deliverAs: 'steer',
  // triggerTurn: true }, so an idle session starts a run of its own; pi rejects
  // an unqualified prompt while any run is active.
  const streamingChat = async () => {
    const sessions: ScriptedSession[] = [];
    const resolve = vi.fn(() => Promise.resolve({ provider: 'x', id: 'grok' }));
    const chat = new PiChat({ resolve } as unknown as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    const session = sessions[0]!;
    // The warm-up turn already ran its own setup; only a new send's behaviour
    // is under test.
    resolve.mockClear();
    session.setModel.mockClear();
    session.setThinkingLevel.mockClear();
    const approvals = (
      chat as unknown as { approvals: { setEmitter: ReturnType<typeof vi.fn> } }
    ).approvals;
    const setEmitter = vi.spyOn(approvals, 'setEmitter');
    setEmitter.mockClear();
    session.isStreaming = true;
    let finishRun!: () => void;
    session.waitForIdle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRun = () => {
            session.isStreaming = false;
            resolve();
          };
        }),
    );
    return { chat, session, finishRun: () => finishRun(), resolve, setEmitter };
  };

  it('waits for the running turn to end before prompting', async () => {
    const { chat, session, finishRun, resolve, setEmitter } = await streamingChat();

    const chunks: ChatChunk[] = [];
    const drained = (async () => {
      for await (
        const chunk of chat.send('crew_done please', new AbortController().signal, {
          provider: 'x',
          model: 'grok',
          effort: 'high',
        })
      ) {
        chunks.push(chunk);
      }
    })();
    await vi.waitFor(() => expect(session.waitForIdle).toHaveBeenCalled());
    expect(session.prompt).toHaveBeenCalledTimes(1);
    // While the run is still going, the waiting send has applied nothing:
    // no model resolution, no effort switch, no approval channel.
    expect(resolve).not.toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
    expect(setEmitter).not.toHaveBeenCalled();

    finishRun();
    await drained;

    // Only after the wait do the turn options and the approval emitter bind —
    // to this turn, not to the run it waited out.
    expect(resolve).toHaveBeenCalledWith('x', 'grok');
    expect(session.setModel).toHaveBeenCalled();
    expect(session.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(setEmitter.mock.calls.map((call) => call[0] !== null)).toEqual([true, false]);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenLastCalledWith('crew_done please');
    expect(chunks.some((chunk) => chunk.kind === 'tool-call')).toBe(true);
  });

  it('waits again when a run starts while the turn options are being applied', async () => {
    const { chat, session } = await streamingChat();
    session.isStreaming = false;
    // The model switch is genuinely async; pi-crew starts a run inside it.
    let finishSecondRun!: () => void;
    session.setModel.mockImplementationOnce(async () => {
      await Promise.resolve();
      session.isStreaming = true;
      session.waitForIdle.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSecondRun = () => {
              session.isStreaming = false;
              resolve();
            };
          }),
      );
    });

    const drained = (async () => {
      for await (
        const chunk of chat.send('after a switch', new AbortController().signal, {
          provider: 'x',
          model: 'grok',
        })
      ) {
        void chunk;
      }
    })();
    await vi.waitFor(() => expect(session.isStreaming).toBe(true));
    await vi.waitFor(() => expect(session.waitForIdle).toHaveBeenCalled());
    // Nothing was prompted into the run that started mid-switch.
    expect(session.prompt).toHaveBeenCalledTimes(1);

    finishSecondRun();
    await drained;
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenLastCalledWith('after a switch');
  });

  it('never prompts when the send is cancelled while waiting', async () => {
    const { chat, session } = await streamingChat();

    const controller = new AbortController();
    const drained = (async () => {
      for await (const chunk of chat.send('cancelled', controller.signal)) void chunk;
    })();
    await vi.waitFor(() => expect(session.waitForIdle).toHaveBeenCalled());
    controller.abort();
    await drained;

    expect(session.prompt).toHaveBeenCalledTimes(1);
    // The run the cockpit did not start is left alone.
    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe('PiChat session lifecycle host', () => {
  it('never constructs during liveSession/disposeLiveSession inspection and disposes exactly once', async () => {
    const built: string[] = [];
    const chat = new PiChat({} as ModelCatalog, (root) => {
      built.push(root);
      return Promise.resolve(new ScriptedSession() as unknown as AgentSession);
    });

    // Inspection must never build: cleanup may not create work.
    expect(await chat.liveSession()).toBeNull();
    expect(await chat.disposeLiveSession()).toBe(false);
    expect(built).toHaveLength(0);

    // A real turn builds one host; explicit cleanup disposes it exactly once
    // and is idempotent (a second cleanup finds nothing).
    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    expect(built).toHaveLength(1);
    expect(await chat.liveSession()).not.toBeNull();
    expect(await chat.disposeLiveSession()).toBe(true);
    expect(await chat.disposeLiveSession()).toBe(false);

    // The next turn rebuilds on demand.
    for await (const chunk of chat.send('second', new AbortController().signal)) void chunk;
    expect(built).toHaveLength(2);
  });

  it('disposes the previous host exactly once when opening a stored chat', async () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
      }, undefined, undefined, undefined, hermeticSources());
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      scriptedManager('/sessions/stored.jsonl', [], tmpdir()) as unknown as SessionManager,
    );

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    await chat.openChat('/sessions/stored.jsonl');

    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('disposes each previous host exactly once across re-root and new chat', async () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    await chat.setRoot('/tmp/selected-project');
    await chat.newChat();

    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[2]?.dispose).not.toHaveBeenCalled();
  });
});

describe('PiChat tool-result details', () => {
  it('carries JSON-safe tool-result details on the wire', async () => {
    const session = new ScriptedSession();
    session.prompt.mockImplementation(() =>
      Promise.resolve()
        .then(() => {
          session.emit({
            type: 'tool_execution_start',
            toolCallId: 'call-9',
            toolName: 'crew_spawn',
            args: { subagent: 'scout' },
          });
          session.emit({
            type: 'tool_execution_end',
            toolCallId: 'call-9',
            toolName: 'crew_spawn',
            result: {
              content: [{ type: 'text', text: 'ok' }],
              details: { id: 'scout-1' },
            },
            isError: false,
          });
          return Promise.resolve();
        })
        .then(() => {
          session.emit({ type: 'agent_end', messages: [], willRetry: false });
        }),
    );
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) chunks.push(chunk);

    const result = chunks.find(
      (c): c is Extract<ChatChunk, { kind: 'tool-result' }> =>
        c.kind === 'tool-result' && c.callId === 'call-9',
    );
    expect(result).toMatchObject({ ok: true, output: 'ok', details: { id: 'scout-1' } });
  });

  it('never lets cyclic tool-result details cross the wire', async () => {
    const cyclic: Record<string, unknown> = { list: [1] };
    cyclic.self = cyclic;
    const session = new ScriptedSession();
    session.prompt.mockImplementation(() =>
      Promise.resolve()
        .then(() => {
          session.emit({ type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'edit', args: { path: 'x' } });
          session.emit({
            type: 'tool_execution_end',
            toolCallId: 'call-9',
            toolName: 'edit',
            result: { content: [{ type: 'text', text: 'ok' }], details: cyclic },
            isError: false,
          });
          return Promise.resolve();
        })
        .then(() => {
          session.emit({ type: 'agent_end', messages: [], willRetry: false });
        }),
    );
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) chunks.push(chunk);

    const result = chunks.find(
      (c): c is Extract<ChatChunk, { kind: 'tool-result' }> =>
        c.kind === 'tool-result' && c.callId === 'call-9',
    );
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result?.details).toEqual({ list: [1], self: null });
  });
});

describe('PiChat custom message mapping', () => {
  it('maps a role-custom message_end once (never message_start) with the persisted entry id', async () => {
    const custom = scriptedCustom('entry-1', 1234);
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(new ScriptedSession(undefined, [custom]) as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) {
      chunks.push(chunk);
    }

    const customChunks = chunks.filter((c) => c.kind === 'custom-message');
    // Exactly one custom-message chunk — message_start is never mapped, so the
    // event cannot double-emit.
    expect(customChunks).toHaveLength(1);
    expect(customChunks[0]).toEqual({
      kind: 'custom-message',
      id: 'entry-1',
      customType: 'crew-result',
      display: true,
      content: 'result body',
      details: { agentId: 'scout-1' },
      timestamp: 1234,
    });
  });

  it('preserves display:false custom messages on the wire', async () => {
    const custom = scriptedCustom('entry-hidden', 2345, { display: false });
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(new ScriptedSession(undefined, [custom]) as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) {
      chunks.push(chunk);
    }

    const customChunks = chunks.filter((c) => c.kind === 'custom-message');
    expect(customChunks).toHaveLength(1);
    expect(customChunks[0]).toMatchObject({ id: 'entry-hidden', display: false });
  });

  it('skips the live chunk when no persisted entry matches — canonical readback recovers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The event is emitted but no entry is appended — pi never persisted it.
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      const custom = scriptedCustom('never-written', 3456);
      session.prompt.mockImplementation(() =>
        Promise.resolve()
          .then(() => {
            session.emit({ type: 'message_end', message: custom.message } as never);
            return Promise.resolve();
          })
          .then(() => {
            session.emit({ type: 'agent_end', messages: [], willRetry: false });
          }),
      );
      return Promise.resolve(session as unknown as AgentSession);
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) {
      chunks.push(chunk);
    }

    // No persisted entry, no irreconcilable chunk: emitting a made-up id here
    // would duplicate against canonical readback. The skip is warned boundedly.
    expect(chunks.filter((c) => c.kind === 'custom-message')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('crew-result'));
    warnSpy.mockRestore();
  });

  it('gives chat.send and the observation stream the same canonical id for the same event', async () => {
    const session = new ScriptedSession(undefined, [scriptedCustom('entry-1', 1111)]);
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    const controller = new AbortController();
    const observer = chat.observe(controller.signal)[Symbol.asyncIterator]();

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) {
      chunks.push(chunk);
    }

    const sendCustom = chunks.find((c) => c.kind === 'custom-message');
    const observed = await observer.next();
    expect(sendCustom).toMatchObject({ kind: 'custom-message', id: 'entry-1' });
    expect(observed.value).toMatchObject({ kind: 'custom-message', id: 'entry-1' });
    controller.abort();
  });

  it('resolves a new identical message to its own entry on a resumed session with history', async () => {
    const historical = scriptedCustom('historical', 1111);
    const fresh = scriptedCustom('fresh', 2222);
    const session = new ScriptedSession();
    // The session is resumed with a historical crew-result already persisted.
    session.entries.push(historical.entry);
    session.prompt.mockImplementation(() =>
      Promise.resolve()
        .then(() => {
          session.emit({ type: 'message_end', message: fresh.message } as never);
          session.entries.push(fresh.entry);
          return Promise.resolve();
        })
        .then(() => {
          session.emit({ type: 'agent_end', messages: [], willRetry: false });
        }),
    );
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) chunks.push(chunk);

    // The live chunk resolves to the NEW entry id — the historical entry is
    // pre-claimed at arming and cannot collapse with the new event.
    const live = chunks.find((c) => c.kind === 'custom-message');
    expect(live).toMatchObject({ kind: 'custom-message', id: 'fresh' });
  });

  it('keeps historical readback distinct from a new identical live message', async () => {
    const historical = scriptedCustom('historical', 1111);
    const fresh = scriptedCustom('fresh', 2222);
    const session = new ScriptedSession();
    session.entries.push(historical.entry);
    session.prompt.mockImplementation(() =>
      Promise.resolve()
        .then(() => {
          session.emit({ type: 'message_end', message: fresh.message } as never);
          session.appendEntry(fresh.entry);
          return Promise.resolve();
        })
        .then(() => {
          session.emit({ type: 'agent_end', messages: [], willRetry: false });
        }),
    );
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );
    for await (const chunk of chat.send('ask', new AbortController().signal)) void chunk;

    // Canonical readback still contains both, distinct.
    const controller = new AbortController();
    const iterator = chat.observe(controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect([first.value, second.value].map((v) => (v as { id?: string }).id)).toEqual([
      'historical',
      'fresh',
    ]);
    controller.abort();
  });

  it('shares the new canonical id across send and observe on a resumed session', async () => {
    const historical = scriptedCustom('historical', 1111);
    const fresh = scriptedCustom('fresh', 2222);
    const session = new ScriptedSession();
    session.entries.push(historical.entry);
    session.prompt.mockImplementation(() =>
      Promise.resolve()
        .then(() => {
          session.emit({ type: 'message_end', message: fresh.message } as never);
          session.entries.push(fresh.entry);
          return Promise.resolve();
        })
        .then(() => {
          session.emit({ type: 'agent_end', messages: [], willRetry: false });
        }),
    );
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    const controller = new AbortController();
    const observer = chat.observe(controller.signal)[Symbol.asyncIterator]();
    // Activate the generator before the turn: the live arm push must land in
    // the observation queue while chat.send maps the same event object.
    const livePush = observer.next();

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) chunks.push(chunk);

    const sendCustom = chunks.find((c) => c.kind === 'custom-message');
    expect(sendCustom).toMatchObject({ id: 'fresh' });
    // The observation stream's live delivery of the SAME event carries the same
    // canonical id — never the pre-claimed historical one. The send's own
    // turn-started/ended control events arrive first and are skipped.
    let observed = await livePush;
    while (
      (observed.value as ChatChunk | undefined)?.kind === 'turn-started' ||
      (observed.value as ChatChunk | undefined)?.kind === 'turn-ended'
    ) {
      observed = await observer.next();
    }
    expect(observed.value).toMatchObject({ id: 'fresh' });
    controller.abort();
  });

  it('does not pre-claim the entry appended after arming on a fresh session', async () => {
    // A fresh session seeds from an empty history; the first live event's entry
    // is appended after arming and must still resolve.
    const custom = scriptedCustom('first-entry', 5555);
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(new ScriptedSession(undefined, [custom]) as unknown as AgentSession),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) chunks.push(chunk);

    expect(chunks.filter((c) => c.kind === 'custom-message').map((c) => c.id)).toEqual([
      'first-entry',
    ]);
  });

  it('gives two distinct identical events distinct canonical entry ids', async () => {
    const sameMs = 9999;
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(
        new ScriptedSession(undefined, [
          scriptedCustom('entry-a', sameMs),
          scriptedCustom('entry-b', sameMs),
        ]) as unknown as AgentSession,
      ),
    );

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('ask', new AbortController().signal)) {
      chunks.push(chunk);
    }

    const customChunks = chunks.filter((c) => c.kind === 'custom-message');
    // Same semantic fields, same millisecond, different events: append order
    // resolves each to its own entry.
    expect(customChunks.map((c) => c.id)).toEqual(['entry-a', 'entry-b']);
  });
});

describe('PiChat observation stream', () => {
  it('yields persisted readback and live customs that arrive after the request stream closes', async () => {
    const session = new ScriptedSession(undefined, [scriptedCustom('during-turn', 1111)]);
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

    for await (const chunk of chat.send('ask', new AbortController().signal)) void chunk;

    const controller = new AbortController();
    const iterator = chat.observe(controller.signal)[Symbol.asyncIterator]();

    // Readback: the persisted custom_message entry from the completed turn.
    const readback = await iterator.next();
    expect(readback.done).toBe(false);
    expect(readback.value).toMatchObject({ kind: 'custom-message', id: 'during-turn' });

    // A custom event arriving after the request stream closed is delivered.
    const late = scriptedCustom('after-turn', 2222);
    session.emitCustom(late);
    const live = await iterator.next();
    expect(live.value).toMatchObject({ kind: 'custom-message', id: 'after-turn' });

    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('stops delivering after abort and cleans up its subscription', async () => {
    const session = new ScriptedSession();
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );
    for await (const chunk of chat.send('ask', new AbortController().signal)) void chunk;

    const controller = new AbortController();
    const iterator = chat.observe(controller.signal)[Symbol.asyncIterator]();
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });

    // After cleanup, a live custom event reaches nobody.
    session.emitCustom(scriptedCustom('dropped', 3333));
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('re-subscribes cleanly across a session swap and reconciles readback by id', async () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    });

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    sessions[0]!.emitCustom(scriptedCustom('s1-event', 4444));

    const first = chat.observe(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(first.next()).resolves.toMatchObject({ done: false, value: expect.objectContaining({ id: 's1-event' }) });
    await first.return?.(undefined);

    await chat.setRoot('/tmp/other');
    sessions[1]!.emitCustom(scriptedCustom('s2-event', 5555));

    // The browser re-subscribes after the swap; readback + live follow the new
    // session, and the stable id reconciles against what the browser holds.
    const second = chat.observe(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(second.next()).resolves.toMatchObject({ done: false, value: expect.objectContaining({ id: 's2-event' }) });
    await second.return?.(undefined);
  });
});

describe('PiChat branch-scoped transcript projection', () => {
  it('passes the live leaf id when projecting a reopened transcript', async () => {
    const session = new ScriptedSession();
    const getLeafId = vi.spyOn(session.sessionManager, 'getLeafId');
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
      undefined,
      undefined,
      undefined,
      hermeticSources(),
    );
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      scriptedManager('/sessions/leaf.jsonl', [], tmpdir()) as unknown as SessionManager,
    );

    await chat.openChat('/sessions/leaf.jsonl');

    // Production must not infer the current leaf from append order: the raw
    // durable projection is branch-scoped via the live leaf id.
    expect(getLeafId).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('PiChat observation branch scoping', () => {
  it('never yields abandoned-branch customs in the observe readback, and live delivery keeps working', async () => {
    const session = new ScriptedSession();
    // Forked raw entries: an abandoned branch custom plus the active tip.
    session.entries.push({
      type: 'custom_message',
      id: 'aband-1',
      parentId: null,
      customType: 'crew-result',
      content: 'abandoned body',
      display: true,
      details: { agentId: 'aband', status: 'done' },
      timestamp: '2026-07-25T10:00:01.000Z',
    });
    session.entries.push({
      type: 'custom_message',
      id: 'leaf-1',
      parentId: 'base',
      customType: 'crew-result',
      content: 'active body',
      display: true,
      details: { agentId: 'active', status: 'done' },
      timestamp: '2026-07-25T10:00:02.000Z',
    });
    const chat = new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );
    for await (const chunk of chat.send('warm', new AbortController().signal)) void chunk;

    const controller = new AbortController();
    const iterator = chat.observe(controller.signal)[Symbol.asyncIterator]();

    // Readback: only the active-path custom is yielded — the abandoned branch
    // must not reintroduce immediately after a branch-scoped open.
    const readback = await iterator.next();
    expect(readback.value).toMatchObject({ id: 'leaf-1', customType: 'crew-result' });

    // A live custom event is still delivered; readback/live dedup by stable id
    // is unchanged (the browser dedups against what it already holds).
    const late = scriptedCustom('live-1', 3333);
    session.emitCustom(late);
    const live = await iterator.next();
    expect(live.value).toMatchObject({ id: 'live-1' });
    expect(String(live.value?.id)).not.toBe('aband-1');
    controller.abort();
  });
});

describe('PiChat provider errors', () => {
  /**
   * A turn whose assistant message_end carries pi's stop reason — the only
   * place a provider failure is reported. pi ends the request stream normally
   * afterwards (agent_end), which is exactly why a silent turn looked healthy.
   */
  class EndingSession {
    isStreaming = false;
    readonly dispose = vi.fn();
    readonly abort = vi.fn(() => Promise.resolve());
    readonly sessionManager = scriptedManager();
    readonly agent: { beforeToolCall?: AgentSession['agent']['beforeToolCall'] } = {};
    readonly getContextUsage = vi.fn(() => undefined);
    private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

    constructor(private readonly end: { stopReason: string; errorMessage?: string }) {}

    readonly prompt = vi.fn(() =>
      Promise.resolve().then(() => {
        this.emit({
          type: 'message_end',
          message: { role: 'assistant', content: [], ...this.end },
        } as never);
        this.emit({ type: 'agent_end', messages: [], willRetry: false });
      }),
    );

    emit(event: AgentSessionEvent): void {
      for (const listener of this.listeners) listener(event);
    }

    subscribe(listener: (event: AgentSessionEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  }

  const drain = async (chat: PiChat): Promise<ChatChunk[]> => {
    const chunks: ChatChunk[] = [];
    for await (const chunk of chat.send('hello', new AbortController().signal)) chunks.push(chunk);
    return chunks;
  };

  const chatOver = (session: EndingSession): PiChat =>
    new PiChat({} as ModelCatalog, () =>
      Promise.resolve(session as unknown as AgentSession),
    );

  it('fails the turn with the provider’s own message when pi ends the assistant message in error', async () => {
    const session = new EndingSession({
      stopReason: 'error',
      errorMessage: 'OAuth refresh failed for anthropic: token expired',
    });

    await expect(drain(chatOver(session))).rejects.toThrow(
      'OAuth refresh failed for anthropic: token expired',
    );
  });

  it('still logs the per-turn timing line when the turn ends in a provider error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = new EndingSession({ stopReason: 'error', errorMessage: 'provider exploded' });

    await expect(drain(chatOver(session))).rejects.toThrow('provider exploded');

    expect(info).toHaveBeenCalledWith(expect.stringContaining('[chat] session='));
    info.mockRestore();
  });

  it('keeps the reason and drops the stack trace pi appends to the message', async () => {
    const session = new EndingSession({
      stopReason: 'error',
      errorMessage:
        'OAuth refresh failed for anthropic: Refresh token expired; stack=Error: HTTP request failed at postJson (/x/anthropic.js:155:15)',
    });

    await expect(drain(chatOver(session))).rejects.toThrow(
      /^OAuth refresh failed for anthropic: Refresh token expired$/,
    );
  });

  it('falls back to a generic provider error when pi reports no message', async () => {
    const session = new EndingSession({ stopReason: 'error' });

    await expect(drain(chatOver(session))).rejects.toThrow('provider error');
  });

  it('does not fail the turn on an aborted assistant message — an abort is not an error', async () => {
    const session = new EndingSession({ stopReason: 'aborted' });

    await expect(drain(chatOver(session))).resolves.toEqual([]);
  });

  it('completes a normal turn whose assistant message stops cleanly', async () => {
    const session = new EndingSession({ stopReason: 'stop' });

    await expect(drain(chatOver(session))).resolves.toEqual([]);
  });
});

describe('PiChat moved-folder history', () => {
  /** Real dirs the index maps onto; the old paths deliberately do not exist. */
  let currentRoot = '';
  let oldRoot = '';
  let existingSibling = '';

  const index = (): ProjectPaths[] => [
    { name: 'moved', path: currentRoot, oldPaths: [oldRoot] },
  ];

  const sourcesWith = (overrides: Partial<PiChatHistorySources> = {}): PiChatHistorySources => ({
    projectPaths: vi.fn(() => Promise.resolve(index())),
    recentSessions: vi.fn(() => Promise.resolve([] as ChatSessionInfo[])),
    ...overrides,
  });

  const infoRow = (over: Partial<ChatSessionInfo>): ChatSessionInfo => ({
    path: '/sessions/x.jsonl',
    engine: 'pi',
    id: 'x',
    cwd: oldRoot,
    title: 'title',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    currentRoot = await mkdtemp(join(tmpdir(), 'funkyoctopus-moved-current-'));
    existingSibling = join(currentRoot, 'kept-sub');
    await mkdir(existingSibling, { recursive: true });
    oldRoot = join(currentRoot, '..', 'funkyoctopus-moved-old-nonexistent');
  });

  afterEach(async () => {
    await rm(currentRoot, { recursive: true, force: true });
  });

  it('reopens a chat recorded at a dead old path rooted at the mapped folder', async () => {
    const roots: string[] = [];
    /** First open reads the header cwd; the reopen pass gets the override. */
    const openSpy = vi
      .spyOn(SessionManager, 'open')
      .mockImplementation(((_path: string, _dir?: string, cwd?: string) =>
        scriptedManager('/sessions/stored.jsonl', [], cwd ?? oldRoot)) as unknown as
        typeof SessionManager.open);
    const chat = new PiChat({} as ModelCatalog, (root) => {
      roots.push(root);
      return Promise.resolve(new ScriptedSession() as unknown as AgentSession);
    }, undefined, undefined, undefined, sourcesWith());

    await chat.openChat('/sessions/stored.jsonl');

    // The session factory receives the mapped root, and the same session file
    // is reopened with pi's cwd override so its tools run at the mapped folder.
    expect(roots.at(-1)).toBe(currentRoot);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(openSpy.mock.calls[1]).toEqual(['/sessions/stored.jsonl', undefined, currentRoot]);
    vi.restoreAllMocks();
  });

  it('rejects folder_not_found for an unmappable dead cwd and keeps the live session', async () => {
    const sessions: ScriptedSession[] = [];
    const chat = new PiChat({} as ModelCatalog, () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return Promise.resolve(session as unknown as AgentSession);
    }, undefined, undefined, undefined, sourcesWith({
      projectPaths: () => Promise.resolve([]),
    }));
    vi.spyOn(SessionManager, 'open').mockReturnValue(
      scriptedManager('/sessions/gone.jsonl', [], '/no/such/folder/anywhere') as unknown as SessionManager,
    );

    for await (const chunk of chat.send('first', new AbortController().signal)) void chunk;
    const error = await chat.openChat('/sessions/gone.jsonl').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('folder no longer exists: /no/such/folder/anywhere');
    expect(wireErrorCode(error)).toBe(FOLDER_NOT_FOUND);
    // The live session is untouched: not disposed, no replacement built.
    expect(await chat.liveSession()).not.toBeNull();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.dispose).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('merges a known project’s old-path chats into its list with movedFrom set', async () => {
    // The mock returns promises directly: `SessionManager.list` is async, so
    // the implementation itself needs no await.
    vi
      .spyOn(SessionManager, 'list')
      .mockImplementation(((cwd: string) =>
        Promise.resolve(cwd === oldRoot
          ? [sessionInfo({ path: '/sessions/old.jsonl', cwd: join(oldRoot, 'vanish') })]
          : [
              sessionInfo({
                path: '/sessions/new.jsonl',
                cwd: currentRoot,
                modified: new Date('2026-06-01T00:00:00.000Z'),
              }),
            ])));
    const sources = sourcesWith();
    const chat = new PiChat({} as ModelCatalog, undefined, undefined, undefined, undefined, sources);

    const rows = await chat.listChats(currentRoot);

    expect(sources.projectPaths).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      expect.objectContaining({ path: '/sessions/new.jsonl', messageCount: 3, cwd: currentRoot }),
      expect.objectContaining({
        path: '/sessions/old.jsonl',
        cwd: currentRoot,
        movedFrom: join(oldRoot, 'vanish'),
      }),
    ]);
    vi.restoreAllMocks();
  });

  it('flags gone and moved rows in the global list, once per call', async () => {
    const sources = sourcesWith({
      recentSessions: () =>
        Promise.resolve([
          infoRow({ path: '/sessions/live.jsonl', cwd: currentRoot, id: 'live' }),
          infoRow({ path: '/sessions/moved.jsonl', cwd: oldRoot, id: 'moved' }),
          infoRow({ path: '/sessions/lost.jsonl', cwd: '/no/such/folder/anywhere', id: 'lost' }),
        ]),
    });
    const chat = new PiChat({} as ModelCatalog, undefined, undefined, undefined, undefined, sources);

    const rows = await chat.listChats(null);

    expect(sources.projectPaths).toHaveBeenCalledTimes(1);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // An existing cwd passes through unmapped and unflagged.
    expect(byId.get('live')).toEqual({
      path: '/sessions/live.jsonl',
      engine: 'pi',
      id: 'live',
      cwd: currentRoot,
      title: 'title',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    });
    expect(byId.get('moved')).toMatchObject({ cwd: currentRoot, movedFrom: oldRoot });
    expect(byId.get('lost')).toMatchObject({ cwd: '/no/such/folder/anywhere', folderGone: true });
    // The global listing stays message-count-free — reading whole files is
    // exactly what this path exists to avoid.
    expect(rows.every((row) => row.messageCount === undefined)).toBe(true);
  });
});

/** A pi `SessionInfo` shaped listing fixture — `listChats` projects these. */
function sessionInfo(over: {
  path: string;
  cwd: string;
  modified?: Date;
}): {
  path: string;
  id: string;
  cwd: string;
  firstMessage: string;
  allMessagesText: string;
  created: Date;
  modified: Date;
  messageCount: number;
} {
  return {
    id: 'x',
    firstMessage: 'a past conversation',
    allMessagesText: 'a past conversation',
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:00:00.000Z'),
    messageCount: 3,
    ...over,
  };
}

describe('PiChat slash commands (T2.4b)', () => {
  const collect = async (stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> => {
    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  };
  const over = (session: ScriptedSession): PiChat =>
    new PiChat({} as ModelCatalog, () => Promise.resolve(session as unknown as AgentSession));

  it('ends the turn of an extension command pi handled without a run, and the next send works', async () => {
    const session = new ScriptedSession();
    const chat = over(session);
    // What pi's prompt() does with a registered extension command: runs its handler, starts no run.
    session.prompt.mockImplementationOnce(() => Promise.resolve());

    // Before the fix this never ended: the turn waited for an agent_end that never came.
    expect(await collect(chat.send('/todos', new AbortController().signal))).toEqual([]);
    expect(chat.busy()).toBe(false);

    const next = await collect(chat.send('hello', new AbortController().signal));
    expect(session.prompt).toHaveBeenLastCalledWith('hello');
    expect(next.at(-1)).toMatchObject({ kind: 'usage' });
  });

  it('streams a run the command set going without awaiting it, to that run’s end', async () => {
    const session = new ScriptedSession();
    const chat = over(session);
    session.prompt.mockImplementationOnce(() => {
      // pi marks the run streaming before its agent_start, then prompt() returns.
      session.isStreaming = true;
      return Promise.resolve();
    });

    const turn = collect(chat.send('/kick', new AbortController().signal));
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith('/kick'));
    session.emit({ type: 'agent_start' } as never);
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'kicked' } } as never);
    session.isStreaming = false;
    session.emit({ type: 'agent_end', messages: [], willRetry: false } as never);

    expect(await turn).toEqual([
      { kind: 'text', delta: 'kicked' },
      { kind: 'usage', tokens: 1234, contextWindow: 200_000, percent: 0.617 },
    ]);
  });

  it('lists the session’s commands after FO’s built-ins', async () => {
    const session = Object.assign(new ScriptedSession(), {
      extensionRunner: { getRegisteredCommands: () => [{ invocationName: 'todos', description: 'Show todos' }] },
      promptTemplates: [{ name: 'review', description: 'Review', argumentHint: '<ref>' }],
      resourceLoader: { getSkills: () => ({ skills: [{ name: 'tdd', description: 'Test first' }], diagnostics: [] }) },
    });
    const listed = await over(session).commands();
    expect(listed.state).toBe('live');
    expect(listed.commands.map((command) => `${command.source}:${command.name}:${command.kind}`)).toEqual([
      'builtin:compact:action',
      'builtin:rename:action',
      'extension:todos:text',
      'template:review:text',
      'skill:skill:tdd:text',
    ]);
  });

  it('compacts as a turn: busy meanwhile, sends refused, and the end announced', async () => {
    let finish: () => void = () => undefined;
    const compact = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const session = Object.assign(new ScriptedSession(), { compact });
    const chat = over(session);
    const observed: ChatChunk[] = [];
    const watch = new AbortController();
    void (async () => {
      for await (const chunk of chat.observe(watch.signal)) observed.push(chunk);
    })();

    const done = chat.compact('keep the API notes', 'tab-1');
    await vi.waitFor(() => expect(compact).toHaveBeenCalledWith('keep the API notes'));
    expect(chat.busy()).toBe(true);
    await expect(chat.send('meanwhile', new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'turn_in_progress',
    });
    await expect(chat.compact(undefined)).rejects.toMatchObject({ code: 'turn_in_progress' });

    finish();
    await done;
    expect(chat.busy()).toBe(false);
    await vi.waitFor(() =>
      expect(observed.filter((chunk) => chunk.kind === 'turn-started' || chunk.kind === 'turn-ended')).toEqual([
        { kind: 'turn-started', origin: 'tab-1' },
        { kind: 'turn-ended', origin: 'tab-1' },
      ]),
    );
    watch.abort();
  });

  it('refuses to compact while a run streams (pi would abort it)', async () => {
    const compact = vi.fn(() => Promise.resolve());
    const session = Object.assign(new ScriptedSession(), { compact });
    const chat = over(session);
    await chat.commands().catch(() => undefined); // builds the session
    session.isStreaming = true;
    await expect(chat.compact(undefined)).rejects.toMatchObject({ code: 'turn_in_progress' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('renames through pi and answers the session as now titled', async () => {
    const session = new ScriptedSession();
    let name: string | undefined;
    const setSessionName = vi.fn((next: string) => {
      name = next;
    });
    Object.assign(session, { setSessionName });
    Object.assign(session.sessionManager, { getSessionName: () => name });
    const info = await over(session).rename('Slash palette');
    expect(setSessionName).toHaveBeenCalledWith('Slash palette');
    expect(info).toMatchObject({ title: 'Slash palette', id: 'scripted' });
  });
});
