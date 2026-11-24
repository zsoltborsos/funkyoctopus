import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandChild } from './run-command.ts';
import { runCommand } from './run-command.ts';

/** Scriptable fake child: records kills and lets the test drive events. */
class FakeChild implements CommandChild {
  readonly pid = 4242;
  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stdout', cb });
    },
  };
  readonly stderr = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.dataHandlers.push({ stream: 'stderr', cb });
    },
  };
  private readonly dataHandlers: { stream: 'stdout' | 'stderr'; cb: (chunk: Buffer) => void }[] = [];
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private readonly closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  kills: string[] = [];

  constructor(
    private readonly honorSignals = true,
    private readonly syncClose = false,
  ) {}

  on(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === 'error') this.errorHandlers.push(listener as (error: Error) => void);
    if (event === 'close') this.closeHandlers.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(signal?: NodeJS.Signals): boolean {
    const name = signal ?? 'SIGTERM';
    this.kills.push(name);
    if (this.honorSignals) {
      if (this.syncClose) this.emitClose(null, name);
      else queueMicrotask(() => this.emitClose(null, name));
    }
    return true;
  }

  emitStdout(chunk: string): void {
    this.emitData('stdout', chunk);
  }

  emitStderr(chunk: string): void {
    this.emitData('stderr', chunk);
  }

  emitClose(code: number | null, signal: string | null): void {
    for (const listener of [...this.closeHandlers]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorHandlers]) listener(error);
  }

  private emitData(stream: 'stdout' | 'stderr', chunk: string): void {
    const buffer = Buffer.from(chunk);
    for (const handler of this.dataHandlers) {
      if (handler.stream === stream) handler.cb(buffer);
    }
  }
}

function enoentError(): Error {
  return Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runCommand outcomes', () => {
  it('resolves with exit facts and bounded output on success', async () => {
    const child = new FakeChild();
    const pendingFirst = runCommand(
      { spawn: () => child },
      { command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 1_000 },
    );
    child.emitClose(0, null);
    const outcome = await pendingFirst;
    expect(outcome).toMatchObject({ kind: 'exit', code: 0, signal: null });
    if (outcome.kind === 'exit') {
      expect(outcome.facts.stdout).toBe('');
      expect(outcome.facts.log).toBe('');
    }
    // stdout data arrives before close and is retained.
    const child2 = new FakeChild();
    const pending = runCommand(
      { spawn: () => child2 },
      { command: 'pi', args: ['--version'], timeoutMs: 1_000 },
    );
    child2.emitStdout('v0.84.1\n');
    child2.emitClose(0, null);
    const result = await pending;
    if (result.kind === 'exit') {
      expect(result.facts.stdout).toBe('v0.84.1\n');
      expect(result.facts.droppedBytes).toBe(0);
    }
  });

  it('records a nonzero exit code', async () => {
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'npm', args: ['ls'], timeoutMs: 1_000 });
    child.emitStderr('problems found\n');
    child.emitClose(1, null);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'exit', code: 1, signal: null });
    if (outcome.kind === 'exit') expect(outcome.facts.stderr).toBe('problems found\n');
  });

  it('records a signal kill through the exit facts', async () => {
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'npm', args: ['install'], timeoutMs: 1_000 });
    child.emitClose(null, 'SIGKILL');
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'exit', code: null, signal: 'SIGKILL' });
  });

  it('reports a synchronous spawn failure as an error outcome', async () => {
    const outcome = await runCommand(
      { spawn: () => {
        throw enoentError();
      } },
      { command: 'missing', args: [], timeoutMs: 1_000 },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.code).toBe('ENOENT');
      expect(outcome.message).toContain('ENOENT');
    }
  });

  it('reports an asynchronous error event with its code', async () => {
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'npm', args: ['i'], timeoutMs: 1_000 });
    child.emitError(enoentError());
    const outcome = await pending;
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.code).toBe('ENOENT');
  });
});

describe('runCommand timeout and abort', () => {
  it('terminates a hung child on timeout: SIGTERM first, then SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['install'], timeoutMs: 100, killGraceMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    child.emitClose(null, 'SIGKILL');
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('timeout');
    // No timers survive the settle.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at SIGTERM when the child honors it', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(true);
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['install'], timeoutMs: 100, killGraceMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await pending;
    expect(child.kills).toEqual(['SIGTERM']);
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates on external abort and detaches its listener afterwards', async () => {
    const child = new FakeChild(true);
    const controller = new AbortController();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['i'], timeoutMs: 1_000, signal: controller.signal },
    );
    controller.abort();
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('aborted');
    expect(child.kills).toEqual(['SIGTERM']);
    // The abort listener was removed on settle: a later abort is inert.
    child.kills.length = 0;
    controller.abort();
    expect(child.kills).toEqual([]);
  });

  it('aborting an already-settled run changes nothing', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const controller = new AbortController();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'pi', args: ['--version'], timeoutMs: 100, signal: controller.signal },
    );
    child.emitClose(0, null);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'exit', code: 0 });
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timeout timer when the child finishes first', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'git', args: ['status'], timeoutMs: 1_000 });
    child.emitClose(0, null);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a pre-aborted signal when kill closes the child synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(true, true);
    const controller = new AbortController();
    controller.abort();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['i'], timeoutMs: 1_000, signal: controller.signal },
    );
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('aborted');
    expect(child.kills).toEqual(['SIGTERM']);
    // No SIGKILL escalates and no timers survive the settle.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles safely when the timeout SIGTERM closes the child synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(true, true);
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['install'], timeoutMs: 100, killGraceMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('timeout');
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the first termination reason when timeout and abort race before close', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const controller = new AbortController();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['install'], timeoutMs: 100, killGraceMs: 50, signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(100); // timeout fires first
    controller.abort(); // abort arrives before the child closes
    expect(child.kills).toEqual(['SIGTERM']); // one termination, one SIGTERM, one grace timer
    child.emitClose(null, 'SIGTERM');
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('timeout');
    // The later abort is inert (listener detached) and nothing is killed after settle.
    child.kills.length = 0;
    controller.abort();
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the first termination reason when abort arrives before the timeout', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const controller = new AbortController();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'npm', args: ['install'], timeoutMs: 100, killGraceMs: 50, signal: controller.signal },
    );
    controller.abort(); // abort first
    await vi.advanceTimersByTimeAsync(30);
    expect(child.kills).toEqual(['SIGTERM']); // one termination, one SIGTERM before the grace elapses
    await vi.advanceTimersByTimeAsync(70); // grace (50ms) then timeout (100ms) both elapse
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']); // child ignored SIGTERM, so it escalates once
    child.emitClose(null, 'SIGKILL');
    const outcome = await pending;
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') expect(outcome.reason).toBe('aborted');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles once and reports the error when error and close arrive back-to-back', async () => {
    let settles = 0;
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'npm', args: ['i'], timeoutMs: 1_000 }).then(
      (outcome) => {
        settles += 1;
        return outcome;
      },
    );
    child.emitError(enoentError());
    child.emitClose(1, null);
    const outcome = await pending;
    expect(settles).toBe(1);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.code).toBe('ENOENT');
  });

  it('settles once with the exit outcome when close arrives before a later error', async () => {
    let settles = 0;
    const child = new FakeChild();
    const pending = runCommand({ spawn: () => child }, { command: 'npm', args: ['i'], timeoutMs: 1_000 }).then(
      (outcome) => {
        settles += 1;
        return outcome;
      },
    );
    child.emitClose(0, null);
    child.emitError(enoentError());
    const outcome = await pending;
    expect(settles).toBe(1);
    expect(outcome).toMatchObject({ kind: 'exit', code: 0 });
  });
});

describe('runCommand output bounds', () => {
  it('retains only the bounded tail of stdout, stderr, and the combined log', async () => {
    const child = new FakeChild();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'noisy', args: [], timeoutMs: 1_000, maxOutputBytes: 16 },
    );
    child.emitStdout('a'.repeat(100));
    child.emitStderr('b'.repeat(50));
    child.emitClose(0, null);
    const outcome = await pending;
    expect(outcome.kind).toBe('exit');
    if (outcome.kind === 'exit') {
      expect(outcome.facts.stdout).toBe('a'.repeat(16));
      expect(outcome.facts.stderr).toBe('b'.repeat(16));
      // The combined log is the tail across both streams in arrival order.
      expect(outcome.facts.log).toBe('b'.repeat(16));
      expect(outcome.facts.droppedBytes).toBe(84 + 34);
    }
  });

  it('keeps interleaved chunks in arrival order within the bound', async () => {
    const child = new FakeChild();
    const pending = runCommand(
      { spawn: () => child },
      { command: 'mix', args: [], timeoutMs: 1_000, maxOutputBytes: 8 },
    );
    child.emitStdout('1');
    child.emitStderr('2');
    child.emitStdout('345');
    child.emitClose(0, null);
    const outcome = await pending;
    if (outcome.kind === 'exit') {
      expect(outcome.facts.log).toBe('12345');
      expect(outcome.facts.stdout).toBe('1345');
      expect(outcome.facts.stderr).toBe('2');
      expect(outcome.facts.droppedBytes).toBe(0);
    }
  });
});
