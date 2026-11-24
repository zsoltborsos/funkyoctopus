import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { LiveCrewAgent } from './crew-live.ts';
import { CrewStrip } from './CrewStrip.tsx';

const agent = (overrides: Partial<LiveCrewAgent> = {}): LiveCrewAgent => ({
  key: 'c1',
  callId: 'c1',
  agentName: 'scout',
  status: 'running',
  startedAt: Date.now() - 45_000,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CrewStrip', () => {
  it('hides when there are no agents and no unread', () => {
    const { container } = render(<CrewStrip agents={[]} unread={0} />);
    expect(container.innerHTML).toBe('');
  });

  it('stays visible for terminal-only unread even with no active agents', () => {
    render(<CrewStrip agents={[]} unread={3} />);
    expect(screen.getByRole('region', { name: 'Active crew' })).toBeInTheDocument();
    expect(screen.getByLabelText('Unread crew updates').textContent).toContain('3 unread');
  });

  it('renders one compact row per agent with status, name, task, id and elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    render(
      <CrewStrip
        agents={[agent({ task: 'read probe', agentId: 'scout-1', startedAt: 100_000 })]}
        unread={0}
      />,
    );
    const region = screen.getByRole('region', { name: 'Active crew' });
    expect(region.textContent).toContain('RUNNING');
    expect(region.textContent).toContain('scout');
    expect(region.textContent).toContain('read probe');
    expect(region.textContent).toContain('scout-1');
    // 100s elapsed → 1m 40s
    expect(region.textContent).toContain('1m 40s');
  });

  it('ticking updates the elapsed time client-side', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    render(<CrewStrip agents={[agent({ startedAt: 100_000 })]} unread={0} />);
    expect(screen.getByRole('region', { name: 'Active crew' }).textContent).toContain('1m 40s');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('region', { name: 'Active crew' }).textContent).toContain('2m 40s');
  });

  it('marks waiting agents visually distinct', () => {
    render(<CrewStrip agents={[agent({ status: 'waiting' })]} unread={0} />);
    const region = screen.getByRole('region', { name: 'Active crew' });
    expect(region.textContent).toContain('WAITING');
  });

  it('shows needs_input with the waiting presentation and human text', () => {
    render(<CrewStrip agents={[agent({ status: 'needs_input' })]} unread={0} />);
    const region = screen.getByRole('region', { name: 'Active crew' });
    expect(region.textContent).toContain('NEEDS INPUT');
    const row = region.firstElementChild as HTMLElement;
    expect(row.textContent).toContain('⏳');
    expect(row.textContent).not.toContain('✅');
  });

  it('shows completed with a success mark and text', () => {
    render(<CrewStrip agents={[agent({ status: 'completed' })]} unread={0} />);
    const region = screen.getByRole('region', { name: 'Active crew' });
    expect(region.textContent).toContain('COMPLETED');
    const row = region.firstElementChild as HTMLElement;
    expect(row.textContent).toContain('✅');
  });

  it('exposes no controls — no buttons, links or forms', () => {
    render(<CrewStrip agents={[agent()]} unread={1} />);
    expect(document.querySelector('button')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
  });

  it('cleans up the elapsed timer on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(<CrewStrip agents={[agent()]} unread={0} />);
    unmount();
    // Advancing time after unmount must not throw or update anything.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});

describe('CrewStrip interval lifecycle', () => {
  it('keeps no interval while hidden or unread-only', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { unmount } = render(<CrewStrip agents={[]} unread={0} />);
    expect(intervalSpy).not.toHaveBeenCalled();
    unmount();
    render(<CrewStrip agents={[]} unread={2} />);
    expect(intervalSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();
  });

  it('starts exactly one interval when agents appear and cleans it when they leave', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { rerender } = render(<CrewStrip agents={[]} unread={1} />);
    expect(intervalSpy).not.toHaveBeenCalled();

    rerender(<CrewStrip agents={[agent()]} unread={1} />);
    expect(intervalSpy).toHaveBeenCalledTimes(1);

    rerender(<CrewStrip agents={[]} unread={1} />);
    expect(clearSpy).toHaveBeenCalled();
    intervalSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('cleans the interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<CrewStrip agents={[agent()]} unread={0} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
