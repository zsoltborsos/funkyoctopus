import { useCallback, useSyncExternalStore } from 'react';

/** One shared ticking clock per interval: every component on it re-renders together. */
interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/**
 * The current time, refreshed every `intervalMs` while `active`. Rendering
 * reads a stored timestamp, never `Date.now()`, so renders stay pure. While
 * inactive no interval runs and the value is not kept fresh: callers render no
 * time then. Becoming active re-reads the time at once.
 */
export function useNow(intervalMs: number, active = true): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active) return () => undefined;
      const clock = clockFor(intervalMs);
      clock.listeners.add(listener);
      if (clock.timer === null) {
        // The clock sat idle: what it holds is stale.
        clock.now = Date.now();
        clock.timer = setInterval(() => {
          clock.now = Date.now();
          for (const notify of [...clock.listeners]) notify();
        }, intervalMs);
      }
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.timer !== null) {
          clearInterval(clock.timer);
          clock.timer = null;
        }
      };
    },
    [intervalMs, active],
  );
  return useSyncExternalStore(subscribe, () => clockFor(intervalMs).now);
}
