import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandChild } from './run-command.ts';
import {
  EMBEDDED_SDK_PACKAGE,
  STABLE_LATEST_READ_TIMEOUT_MS,
  parseNpmLatestJson,
  readStableLatest,
} from './detect.ts';

/**
 * Scriptable fake child mirroring the run-command.test.ts pattern: the
 * production registry reader is tested hermetically with an injected spawn,
 * so no default test ever runs a real `npm view`.
 */
class FakeChild implements CommandChild {
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
  private readonly closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  kills: string[] = [];

  on(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === 'close') {
      this.closeHandlers.push(listener as (code: number | null, signal: string | null) => void);
    }
  }

  kill(signal?: NodeJS.Signals): boolean {
    const name = signal ?? 'SIGTERM';
    this.kills.push(name);
    queueMicrotask(() => this.emitClose(null, name));
    return true;
  }

  emitStdout(chunk: string): void {
    for (const handler of this.dataHandlers) {
      if (handler.stream === 'stdout') handler.cb(Buffer.from(chunk));
    }
  }

  emitClose(code: number | null, signal: string | null): void {
    for (const listener of [...this.closeHandlers]) listener(code, signal);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseNpmLatestJson', () => {
  it('parses the JSON-wrapped string npm view --json prints', () => {
    expect(parseNpmLatestJson('"0.85.0"')).toBe('0.85.0');
    expect(parseNpmLatestJson('"0.85.0"\n')).toBe('0.85.0');
  });

  it('rejects unquoted, malformed, and non-string JSON', () => {
    expect(parseNpmLatestJson('0.85.0')).toBeNull();
    expect(parseNpmLatestJson('{')).toBeNull();
    expect(parseNpmLatestJson('')).toBeNull();
    expect(parseNpmLatestJson('{"latest":"0.85.0"}')).toBeNull();
  });
});

describe('readStableLatest', () => {
  it('runs the bounded npm view read and returns the parsed stable latest', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const child = new FakeChild();
    const read = readStableLatest({
      spawn: (command, args) => {
        calls.push({ command, args });
        return child;
      },
    });
    const pending = read();
    child.emitStdout('"0.85.0"');
    child.emitClose(0, null);
    expect(await pending).toBe('0.85.0');
    expect(calls).toEqual([
      { command: 'npm', args: ['view', EMBEDDED_SDK_PACKAGE, 'dist-tags.latest', '--json'] },
    ]);
  });

  it('returns null on a nonzero exit', async () => {
    const child = new FakeChild();
    const read = readStableLatest({ spawn: () => child });
    const pending = read();
    child.emitClose(1, null);
    expect(await pending).toBeNull();
  });

  it('returns null on a malformed registry body', async () => {
    const child = new FakeChild();
    const read = readStableLatest({ spawn: () => child });
    const pending = read();
    child.emitStdout('{ broken');
    child.emitClose(0, null);
    expect(await pending).toBeNull();
  });

  it('bounds the read at the configured ceiling and terminates the child', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const read = readStableLatest({ spawn: () => child });
    const pending = read();
    await vi.advanceTimersByTimeAsync(STABLE_LATEST_READ_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(child.kills).toContain('SIGTERM');
  });
});
