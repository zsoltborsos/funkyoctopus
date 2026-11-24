import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ago } from './session-label.ts';

describe('ago', () => {
  const NOW = '2026-10-19T12:00:00.000Z';
  const before = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it('is coarse: now under a minute, then minutes, hours and days', () => {
    expect(ago(before(30_000))).toBe('now');
    expect(ago(before(5 * MINUTE))).toBe('5m');
    expect(ago(before(59 * MINUTE))).toBe('59m');
    expect(ago(before(HOUR))).toBe('1h');
    expect(ago(before(23 * HOUR))).toBe('23h');
    expect(ago(before(DAY))).toBe('1d');
    expect(ago(before(40 * DAY))).toBe('40d');
  });

  it('says nothing for a time it cannot read or one in the future', () => {
    expect(ago('not a date')).toBe('');
    expect(ago(before(-MINUTE))).toBe('');
  });
});
