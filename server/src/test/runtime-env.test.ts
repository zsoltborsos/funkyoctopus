import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PiChat } from '../pi/pi-chat.ts';
import {
  disposeRuntimeChat,
  runtimeChatCounts,
  trackRuntimeChat,
  withCompactionTimeout,
} from './runtime-env.ts';

/** A model-free PiChat stand-in: just enough of the surface teardown touches. */
function fakeChat(session: AgentSession | null) {
  return {
    liveSession: vi.fn(() => Promise.resolve(session)),
    // disposeRuntimeChat now tears down through PiChat.disposeLiveSession.
    disposeLiveSession: vi.fn(() => {
      if (!session) return Promise.resolve(false);
      session.dispose();
      return Promise.resolve(true);
    }),
  } as unknown as PiChat;
}

function fakeSession() {
  const dispose = vi.fn();
  const session = {
    isStreaming: false,
    abort: vi.fn(() => Promise.resolve()),
    dispose,
  } as unknown as AgentSession;
  return { session, dispose };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runtime chat registry', () => {
  it('counts duplicate registration once and teardown-processes exactly once', async () => {
    const before = runtimeChatCounts();
    const { session, dispose } = fakeSession();
    const chat = fakeChat(session);

    trackRuntimeChat(chat);
    trackRuntimeChat(chat); // same instance — must not double-count

    expect(runtimeChatCounts().constructed - before.constructed).toBe(1);
    expect(runtimeChatCounts().tracked - before.tracked).toBe(1);

    expect(await disposeRuntimeChat(chat)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtimeChatCounts().disposed - before.disposed).toBe(1);
    expect(runtimeChatCounts().sessionsDisposed - before.sessionsDisposed).toBe(1);
    expect(runtimeChatCounts().tracked - before.tracked).toBe(0);

    // A second disposal is a no-op: not counted, session not touched again.
    expect(await disposeRuntimeChat(chat)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtimeChatCounts().disposed - before.disposed).toBe(1);
  });

  it('teardown-processes a never-built chat without counting a session disposal', async () => {
    const before = runtimeChatCounts();
    const chat = fakeChat(null);

    trackRuntimeChat(chat);
    expect(await disposeRuntimeChat(chat)).toBe(true);

    expect(runtimeChatCounts().disposed - before.disposed).toBe(1);
    expect(runtimeChatCounts().sessionsDisposed - before.sessionsDisposed).toBe(0);
    expect(runtimeChatCounts().tracked - before.tracked).toBe(0);
  });
});

describe('opt-in runtime discovery contract', () => {
  it('default vitest never discovers *.runtime.test.ts; only the opt-in runtime config does', async () => {
    // The runtime suites are live/model-bound by design. Structural opt-in is a
    // config contract: `npm test`/`npm run verify` must never find them, and
    // `npm run test:runtime` must find exactly the `*.runtime.test.ts` set.
    // jsdom rewrites `import.meta.url` to the browser base URL, so resolve the
    // config files from the vitest working directory (the repo root) instead.
    const defaultConfig = await readFile(join(process.cwd(), 'vite.config.ts'), 'utf8');
    const runtimeConfig = await readFile(join(process.cwd(), 'vitest.runtime.config.ts'), 'utf8');
    expect(defaultConfig).toContain("exclude: [...configDefaults.exclude, '**/*.runtime.test.ts'],");
    expect(runtimeConfig).toContain("include: ['server/**/*.runtime.test.ts'],");
  });
});

describe('withCompactionTimeout', () => {
  it('clears the deadline timer when the compaction wins', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();

    const result = await withCompactionTimeout(
      () => Promise.resolve('summarized'),
      abort,
      60_000,
    );
    expect(result).toBe('summarized');

    // The timer must be gone: advancing past the deadline fires nothing.
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts and rejects only when the deadline actually expires', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const pending = withCompactionTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 120_000)),
      abort,
      60_000,
    );

    const assertion = expect(pending).rejects.toThrow(/timed out after/);
    vi.advanceTimersByTime(60_000);
    await assertion;
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
