import { describe, expect, it, vi } from 'vitest';
import { HelmraiserDesktopNotifier, type SpawnLike } from './desktop-notifier.ts';
import type { HelmraiserEvent } from '../../../src/shared/transport/protocol.ts';

const AWAITING: HelmraiserEvent = {
  kind: 'helmraiser-event',
  event: 'awaiting',
  runId: 'r1',
  task: 't',
  title: 'Prepare the release',
};
const FAILED: HelmraiserEvent = { ...AWAITING, event: 'failed', runId: 'r2', title: 'Build broke' };
const LANDED: HelmraiserEvent = { ...AWAITING, event: 'landed', runId: 'r3', title: 'Release out' };

const ENOENT = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
const EACCES = Object.assign(new Error('spawn notify-send EACCES'), { code: 'EACCES' });

interface FakeChild {
  emitError(error: NodeJS.ErrnoException): void;
}

/**
 * A spawn fake capturing every call; each returned child records its 'error'
 * listener so a test can fire any failure code at it.
 */
function spawnCapture(options: { throws?: Error } = {}): {
  spawn: SpawnLike;
  calls: { bin: string; args: string[]; opts: unknown }[];
  children: FakeChild[];
} {
  const calls: { bin: string; args: string[]; opts: unknown }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = ((bin: string, args: readonly string[], opts: unknown) => {
    calls.push({ bin, args: [...args], opts });
    if (options.throws) throw options.throws;
    const listeners: ((error: NodeJS.ErrnoException) => void)[] = [];
    children.push({
      emitError: (error) => listeners.forEach((listener) => listener(error)),
    });
    return {
      once(event: string, listener: (error: NodeJS.ErrnoException) => void) {
        if (event === 'error') listeners.push(listener);
      },
    } as unknown as ReturnType<SpawnLike>;
  }) as SpawnLike;
  return { spawn, calls, children };
}

describe('HelmraiserDesktopNotifier', () => {
  it('does nothing when disabled', () => {
    const { spawn, calls } = spawnCapture();
    const notifier = new HelmraiserDesktopNotifier(false, spawn, vi.fn());
    notifier.notify(AWAITING);
    expect(calls).toEqual([]);
  });

  it('spawns the exact argv for the failure and landed events, with no shell', () => {
    const { spawn, calls } = spawnCapture();
    const notifier = new HelmraiserDesktopNotifier(true, spawn, vi.fn());
    notifier.notify(FAILED);
    notifier.notify(LANDED);
    expect(calls).toEqual([
      { bin: 'notify-send', args: ['--app-name', 'FunkyOctopus', 'Helmraiser: run failed', 'Build broke'], opts: { stdio: 'ignore' } },
      { bin: 'notify-send', args: ['--app-name', 'FunkyOctopus', 'Helmraiser: run landed', 'Release out'], opts: { stdio: 'ignore' } },
    ]);
  });

  it('logs a missing binary once across repeated notifications (error event)', () => {
    const { spawn, calls, children } = spawnCapture();
    const logError = vi.fn();
    const notifier = new HelmraiserDesktopNotifier(true, spawn, logError);
    notifier.notify(AWAITING);
    notifier.notify(FAILED);
    children[0]?.emitError(ENOENT);
    children[1]?.emitError(ENOENT);
    expect(calls).toHaveLength(2);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('notify-send is not available'));
  });

  it('logs once for a synchronous ENOENT and ignores other failures', () => {
    const { spawn, calls } = spawnCapture({ throws: ENOENT });
    const logError = vi.fn();
    const notifier = new HelmraiserDesktopNotifier(true, spawn, logError);
    notifier.notify(AWAITING);
    notifier.notify(FAILED);
    expect(calls).toHaveLength(2);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('stays silent for non-ENOENT spawn errors', () => {
    const { spawn, children } = spawnCapture();
    const logError = vi.fn();
    const notifier = new HelmraiserDesktopNotifier(true, spawn, logError);
    notifier.notify(AWAITING);
    children[0]?.emitError(EACCES);
    expect(logError).not.toHaveBeenCalled();
  });
});
