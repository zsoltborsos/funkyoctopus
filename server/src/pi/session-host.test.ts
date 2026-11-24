import { describe, expect, it, vi } from 'vitest';
import {
  AgentSessionRuntime,
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import {
  RawSessionHost,
  RuntimeSessionHost,
  unreachableSessionReplacementFactory,
} from './session-host.ts';

/** A fake AgentSession recording the lifecycle surface the hosts touch. */
class FakeSession {
  readonly abort = vi.fn(() => Promise.resolve());
  readonly dispose = vi.fn();
  readonly bindExtensions = vi.fn(() => Promise.resolve());
  readonly extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn((_event: { type?: string; reason?: string }) => Promise.resolve(undefined)),
  };
}

const asSession = (fake: FakeSession): AgentSession => fake as unknown as AgentSession;

function stubServices(): AgentSessionServices {
  return {
    cwd: '/workspace',
    agentDir: '/agent',
    modelRuntime: {
      settleCredentialWrites: () => Promise.resolve(),
    } as unknown as AgentSessionServices['modelRuntime'],
    settingsManager: {} as unknown as AgentSessionServices['settingsManager'],
    resourceLoader: {} as unknown as AgentSessionServices['resourceLoader'],
    diagnostics: [],
  };
}

function runtimeFor(session: AgentSession): AgentSessionRuntime {
  return new AgentSessionRuntime(session, stubServices(), unreachableSessionReplacementFactory());
}

describe('RuntimeSessionHost', () => {
  it('binds the extension runner exactly once with the headless rpc binding', async () => {
    const fake = new FakeSession();
    const onError = vi.fn();
    const host = await RuntimeSessionHost.create(runtimeFor(asSession(fake)), onError);

    expect(fake.bindExtensions).toHaveBeenCalledTimes(1);
    expect(fake.bindExtensions).toHaveBeenCalledWith({ mode: 'rpc', onError });
    expect(host.session).toBe(asSession(fake));
  });

  it('disposes through the runtime exactly once and is idempotent', async () => {
    const fake = new FakeSession();
    const host = await RuntimeSessionHost.create(runtimeFor(asSession(fake)), () => undefined);

    await host.dispose();
    await host.dispose();

    // The second dispose is a no-op: the runtime (and thus the session) is
    // torn down exactly once.
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('emits session_shutdown before the session is disposed, exactly once', async () => {
    const fake = new FakeSession();
    fake.extensionRunner.hasHandlers.mockReturnValue(true);
    const order: string[] = [];
    fake.extensionRunner.emit.mockImplementation(
      (event: { type?: string; reason?: string }) => {
        order.push(`shutdown:${event.reason}`);
        return Promise.resolve(undefined);
      },
    );
    fake.dispose.mockImplementation(() => {
      order.push('dispose');
    });

    const host = await RuntimeSessionHost.create(runtimeFor(asSession(fake)), () => undefined);
    await host.dispose();
    await host.dispose();

    // RuntimeHost.dispose emits session_shutdown (reason quit) before the
    // session is invalidated, and the idempotence guard keeps it at one emit.
    expect(order).toEqual(['shutdown:quit', 'dispose']);
    expect(fake.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    });
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['new', undefined],
    ['resume', '/sessions/target.jsonl'],
  ] as const)(
    'tears down with reason %s: session_shutdown through the runner, then session.dispose(), once',
    async (reason, targetSessionFile) => {
      const fake = new FakeSession();
      fake.extensionRunner.hasHandlers.mockReturnValue(true);
      const order: string[] = [];
      fake.extensionRunner.emit.mockImplementation((event: { type?: string; reason?: string }) => {
        order.push(`shutdown:${event.reason}`);
        return Promise.resolve(undefined);
      });
      fake.dispose.mockImplementation(() => {
        order.push('dispose');
      });
      const runtime = runtimeFor(asSession(fake));
      const runtimeDispose = vi.spyOn(runtime, 'dispose');

      const host = await RuntimeSessionHost.create(runtime, () => undefined);
      await host.dispose(reason, targetSessionFile);
      await host.dispose(reason, targetSessionFile);

      // Not the runtime's own dispose(), which always says "quit" and makes
      // pi-crew abort every subagent in the process.
      expect(runtimeDispose).not.toHaveBeenCalled();
      expect(order).toEqual([`shutdown:${reason}`, 'dispose']);
      expect(fake.extensionRunner.emit).toHaveBeenCalledWith({
        type: 'session_shutdown',
        reason,
        ...(targetSessionFile ? { targetSessionFile } : {}),
      });
    },
  );

  it('skips the shutdown emit when no extension listens, and still disposes', async () => {
    const fake = new FakeSession();
    const host = await RuntimeSessionHost.create(runtimeFor(asSession(fake)), () => undefined);

    await host.dispose('new');

    expect(fake.extensionRunner.emit).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('defaults to quit, through the runtime', async () => {
    const fake = new FakeSession();
    const runtime = runtimeFor(asSession(fake));
    const runtimeDispose = vi.spyOn(runtime, 'dispose');
    const host = await RuntimeSessionHost.create(runtime, () => undefined);

    await host.dispose();

    expect(runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it('tears the session down as new, never quit, when bindExtensions fails', async () => {
    const fake = new FakeSession();
    fake.bindExtensions.mockRejectedValueOnce(new Error('bind exploded'));
    fake.extensionRunner.hasHandlers.mockReturnValue(true);
    const runtime = runtimeFor(asSession(fake));
    const runtimeDispose = vi.spyOn(runtime, 'dispose');

    await expect(RuntimeSessionHost.create(runtime, () => undefined)).rejects.toThrow(
      'bind exploded',
    );
    // A failed creation must not leak the already-built runtime: it is torn
    // down exactly once before the error propagates. Not as quit: in the crew
    // slot that would make pi-crew abort the subagents it left running.
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeDispose).not.toHaveBeenCalled();
    expect(fake.extensionRunner.emit).toHaveBeenCalledWith({ type: 'session_shutdown', reason: 'new' });
  });

  it('keeps the runtime replacement factory unreachable — invoking it fails loudly', async () => {
    const factory: CreateAgentSessionRuntimeFactory = unreachableSessionReplacementFactory();

    // The runtime stores this factory for /new,/resume,/fork,import; PiChat
    // never calls those, so a call must fail loudly instead of replacing the
    // session behind PiChat's back.
    await expect(
      factory({
        cwd: '/workspace',
        agentDir: '/agent',
        sessionManager: undefined as never,
      }),
    ).rejects.toThrow(/unreachable/);
  });
});

describe('RawSessionHost', () => {
  it('disposes the injected session exactly once and is idempotent', async () => {
    const fake = new FakeSession();
    const host = new RawSessionHost(asSession(fake));

    await host.dispose();
    await host.dispose();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(host.session).toBe(asSession(fake));
  });

  it('ignores the reason: no extension runner is bound', async () => {
    const fake = new FakeSession();
    const host = new RawSessionHost(asSession(fake));

    await host.dispose('resume', '/sessions/target.jsonl');

    expect(fake.extensionRunner.emit).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});
