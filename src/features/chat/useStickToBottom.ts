import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type TouchEvent,
  type WheelEvent,
} from 'react';

/** How far from the end (px) still counts as "reading the latest". */
export const BOTTOM_THRESHOLD_PX = 32;

/** The three numbers a scroll container needs to say whether it is at its end. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Pure: is this scroll position within the threshold of the end? */
export const isAtBottom = (m: ScrollMetrics): boolean =>
  m.scrollHeight - m.scrollTop - m.clientHeight <= BOTTOM_THRESHOLD_PX;

/** Spread onto the scroll container (`overflow-y-auto`). */
export interface StickToBottomContainerProps<T extends HTMLElement> {
  ref: RefObject<T | null>;
  onScroll: () => void;
  onWheel: (e: WheelEvent<T>) => void;
  onTouchMove: (e: TouchEvent<T>) => void;
}

export interface StickToBottom<T extends HTMLElement> {
  containerProps: StickToBottomContainerProps<T>;
  /** True while the view follows the tail; false once the reader scrolled up. */
  atBottom: boolean;
  /** Scroll to the end and resume following (the "jump to latest" action). */
  jumpToLatest: () => void;
}

/**
 * Keep a scroll container pinned to its end while content streams in, unless
 * the reader has scrolled up to look at something.
 *
 * `content` is whatever identity changes when the transcript changes (the
 * messages array); `sessionKey` identifies the open conversation, and a change
 * to it always lands at the end — reopening a stored chat starts at its latest
 * turn, not its first.
 *
 * The reader's intent is read two ways. An upward wheel or a touch drag stops
 * following *synchronously*, in the input event itself — the `scroll` event
 * only reports at the next frame, and a chunk landing in that window would
 * re-pin the view before the reader's scroll was ever seen, which during dense
 * streaming makes scrolling up feel impossible. The `scroll` event then keeps
 * the state honest either way: moving up away from the tail (scrollbar drag,
 * keyboard) stops following, coming back within the threshold resumes it.
 * A delayed event from our own scroll can be overtaken by content growth:
 * if the position has not moved up, keep following and close the new gap.
 * Late height changes that no snapshot announces (images, fonts) are covered
 * by a ResizeObserver on the content when the platform has one.
 */
export function useStickToBottom<T extends HTMLElement>(
  content: unknown,
  sessionKey: unknown,
): StickToBottom<T> {
  const ref = useRef<T>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror for the effects, so following is decided from the latest scroll
  // event rather than from a render-time snapshot.
  const following = useRef(true);
  const lastScrollTop = useRef(0);

  const scrollToEnd = useCallback((): void => {
    const el = ref.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
    }
  }, []);

  const onScroll = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    const movedUp = el.scrollTop < lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    const near = isAtBottom(el);
    if (following.current && !movedUp && !near) {
      scrollToEnd();
      return;
    }
    following.current = near;
    setAtBottom(near);
  }, [scrollToEnd]);

  // Stop following on a reader's gesture — but only when there is something
  // above to scroll to; otherwise no scroll will ever follow to put the state
  // right again, and the jump affordance would strand.
  const leave = useCallback((): void => {
    const el = ref.current;
    if (!el || el.scrollTop <= 0) return;
    following.current = false;
    setAtBottom(false);
  }, []);
  const onWheel = useCallback(
    (e: WheelEvent<T>): void => {
      // Only an upward wheel is a "let me read" signal; wheeling down while
      // pinned is a no-op and must not unpin.
      if (e.deltaY < 0) leave();
    },
    [leave],
  );
  // A touch drag's direction is not known from one event; stop following on
  // any drag and let the scroll event re-engage if it ends at the tail.
  const onTouchMove = useCallback((): void => leave(), [leave]);

  const jumpToLatest = useCallback((): void => {
    following.current = true;
    setAtBottom(true);
    scrollToEnd();
  }, [scrollToEnd]);

  // A different conversation: land at its end regardless of where the
  // previous one was being read. The state follows in the same render; the
  // scroll waits for the new content's layout.
  const [shownSession, setShownSession] = useState(sessionKey);
  if (shownSession !== sessionKey) {
    setShownSession(sessionKey);
    setAtBottom(true);
  }
  useLayoutEffect(() => {
    following.current = true;
    scrollToEnd();
  }, [sessionKey, scrollToEnd]);

  // Content changed: follow the tail only while the reader is there.
  useLayoutEffect(() => {
    if (following.current) scrollToEnd();
  }, [content, scrollToEnd]);

  useEffect(() => {
    const inner = ref.current?.firstElementChild;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToEnd();
    });
    // Observe the content wrapper, not the container: the container's own
    // size is constant while the transcript grows inside it. The caller keeps
    // one stable child for this.
    observer.observe(inner);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  return { containerProps: { ref, onScroll, onWheel, onTouchMove }, atBottom, jumpToLatest };
}
