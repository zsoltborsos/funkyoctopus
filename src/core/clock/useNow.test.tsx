import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow.ts';

function Clock({ interval, active = true }: { interval: number; active?: boolean }) {
  const now = useNow(interval, active);
  return <span aria-label="now">{now}</span>;
}

const shown = () => Number(screen.getByLabelText('now').textContent);

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the time on mount and advances it every interval', () => {
    vi.setSystemTime(2_000_000);
    render(<Clock interval={1_000} />);
    expect(shown()).toBe(2_000_000);
    void act(() => { vi.advanceTimersByTime(1_000); });
    expect(shown()).toBe(2_001_000);
  });

  it('runs no interval while inactive, and re-reads the time when it becomes active', () => {
    const view = render(<Clock interval={5_000} active={false} />);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(3_000_000);
    view.rerender(<Clock interval={5_000} />);
    expect(shown()).toBe(3_000_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops its interval when the last reader unmounts', () => {
    const view = render(<Clock interval={7_000} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
