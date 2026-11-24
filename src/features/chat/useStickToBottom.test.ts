import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOTTOM_THRESHOLD_PX, isAtBottom, useStickToBottom } from './useStickToBottom.ts';

describe('isAtBottom', () => {
  it('is true exactly at the end and within the threshold of it', () => {
    expect(isAtBottom({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 })).toBe(true);
    expect(
      isAtBottom({ scrollTop: 1600 - BOTTOM_THRESHOLD_PX, scrollHeight: 2000, clientHeight: 400 }),
    ).toBe(true);
  });

  it('is false one pixel beyond the threshold', () => {
    expect(
      isAtBottom({ scrollTop: 1599 - BOTTOM_THRESHOLD_PX, scrollHeight: 2000, clientHeight: 400 }),
    ).toBe(false);
  });

  it('is true when there is nothing to scroll', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

function TestTranscript({ content, sessionKey }: { content: number; sessionKey: string }) {
  const { containerProps, atBottom, jumpToLatest } = useStickToBottom<HTMLDivElement>(
    content,
    sessionKey,
  );
  return createElement(
    'section',
    null,
    createElement('div', { ...containerProps, 'aria-label': 'Transcript' }, createElement('div')),
    createElement('output', null, atBottom ? 'following' : 'detached'),
    createElement('button', { onClick: jumpToLatest }, 'Jump to latest'),
  );
}

/** Browser-like clamping, but no automatic scroll events: tests deliver those explicitly. */
function layOut(el: HTMLElement) {
  const metrics = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => {
        metrics.scrollTop = Math.max(
          0,
          Math.min(value, Math.max(0, metrics.scrollHeight - metrics.clientHeight)),
        );
      },
    },
  });
  return metrics;
}

function mountTranscript() {
  const view = render(createElement(TestTranscript, { content: 0, sessionKey: 'first' }));
  const transcript = screen.getByLabelText('Transcript');
  const metrics = layOut(transcript);
  const jump = () => fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
  jump();
  expect(transcript.scrollTop).toBe(1600);
  return {
    transcript,
    metrics,
    jump,
    rerender: (content: number, sessionKey = 'first') =>
      view.rerender(createElement(TestTranscript, { content, sessionKey })),
  };
}

const expectFollowing = (following: boolean): void => {
  expect(screen.getByRole('status').textContent).toBe(following ? 'following' : 'detached');
};

describe('useStickToBottom', () => {
  let resize: () => void;

  beforeEach(() => {
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe = vi.fn<ResizeObserver['observe']>();
      unobserve = vi.fn<ResizeObserver['unobserve']>();
      disconnect = vi.fn<ResizeObserver['disconnect']>();
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('follows content changes and observed content resizes', () => {
    const { transcript, metrics, rerender } = mountTranscript();
    metrics.scrollHeight = 2400;
    rerender(1);
    expect(transcript.scrollTop).toBe(2000);
    metrics.scrollHeight = 2800;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2400);
    expectFollowing(true);
  });

  it.each(['wheel up', 'touch drag'])('detaches on %s before a scroll event', (gesture) => {
    const { transcript, metrics, rerender } = mountTranscript();
    if (gesture === 'wheel up') fireEvent.wheel(transcript, { deltaY: -120 });
    else fireEvent.touchMove(transcript);
    expectFollowing(false);
    metrics.scrollHeight = 2400;
    rerender(1);
    act(() => resize());
    expect(transcript.scrollTop).toBe(1600);
    expectFollowing(false);
  });

  it('does not detach on wheel down', () => {
    const { transcript, metrics } = mountTranscript();
    fireEvent.wheel(transcript, { deltaY: 120 });
    metrics.scrollHeight = 2400;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2000);
    expectFollowing(true);
  });

  it('detaches on upward scrollbar or keyboard movement and resumes exactly within the threshold', () => {
    const { transcript, metrics, rerender } = mountTranscript();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    metrics.scrollHeight = 2400;
    rerender(1);
    act(() => resize());
    expect(transcript.scrollTop).toBe(100);

    transcript.scrollTop = 2000 - BOTTOM_THRESHOLD_PX;
    fireEvent.scroll(transcript);
    expectFollowing(true);
    metrics.scrollHeight = 2800;
    rerender(2);
    expect(transcript.scrollTop).toBe(2400);
  });

  it('jumps back to latest and follows subsequent growth', () => {
    const { transcript, metrics, jump, rerender } = mountTranscript();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    jump();
    expect(transcript.scrollTop).toBe(1600);
    expectFollowing(true);
    metrics.scrollHeight = 2400;
    rerender(1);
    expect(transcript.scrollTop).toBe(2000);
  });

  it('keeps following when growth overtakes its own scroll at an unchanged position', () => {
    const { transcript, metrics, rerender } = mountTranscript();
    metrics.scrollHeight = 2400;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2000);

    // More reflow lands before the browser delivers that programmatic scroll.
    metrics.scrollHeight = 2463;
    fireEvent.scroll(transcript);
    expectFollowing(true);
    expect(transcript.scrollTop).toBe(2063);
    fireEvent.scroll(transcript);
    act(() => resize());
    expectFollowing(true);

    metrics.scrollHeight = 2600;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2200);
    metrics.scrollHeight = 2800;
    rerender(1);
    expect(transcript.scrollTop).toBe(2400);
  });

  it('keeps following when a delayed scroll advanced since the previous event', () => {
    const { transcript, metrics } = mountTranscript();
    fireEvent.scroll(transcript);
    metrics.scrollHeight = 2400;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2000);
    metrics.scrollHeight = 2463;
    fireEvent.scroll(transcript);
    expectFollowing(true);
    expect(transcript.scrollTop).toBe(2063);
  });

  it('detects upward movement after an undelivered programmatic scroll', () => {
    const { transcript, metrics, rerender } = mountTranscript();
    metrics.scrollHeight = 2400;
    act(() => resize());
    expect(transcript.scrollTop).toBe(2000);
    transcript.scrollTop = 1900;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    metrics.scrollHeight = 2800;
    act(() => resize());
    rerender(1);
    expect(transcript.scrollTop).toBe(1900);
    expectFollowing(false);
  });

  it('leaves a detached reader alone during downward movement until within the threshold', () => {
    const { transcript } = mountTranscript();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    transcript.scrollTop = 1000;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    expect(transcript.scrollTop).toBe(1000);
    transcript.scrollTop = 1600 - BOTTOM_THRESHOLD_PX;
    fireEvent.scroll(transcript);
    expectFollowing(true);
  });

  it('resets a detached view to the end of a shorter session', () => {
    const { transcript, metrics, rerender } = mountTranscript();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expectFollowing(false);
    metrics.scrollHeight = 1000;
    rerender(1, 'second');
    expect(transcript.scrollTop).toBe(600);
    expectFollowing(true);
    metrics.scrollHeight = 1200;
    act(() => resize());
    expect(transcript.scrollTop).toBe(800);
  });
});
