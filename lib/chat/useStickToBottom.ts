/**
 * lib/chat/useStickToBottom.ts
 * -----------------------------
 * 2026-05-03 (Bug 2 — "auto-scroll does not reliably jump to the end").
 *
 * Problem with the previous solution in ChatShell.tsx:
 *   - useEffect with dep `[history, agentTurn, isPending, systemMessages]`
 *     fired EVERY time a surface card updated its status
 *     (same item id, new payload). This caused the
 *     stream container to jump back to the bottom EVEN THOUGH the user
 *     is currently scrolling/reading an older card.
 *   - `nearBottomRef` was only updated on a scroll event; on a
 *     re-render WITHOUT an incoming new item the value could be stale.
 *
 * Fix:
 *   - IntersectionObserver on a sentinel div at the end of the stream.
 *     If the sentinel is visible → the user is anchored at the bottom → on
 *     new items we scroll along. If the sentinel is NOT visible
 *     → the user scrolled up → we leave them alone.
 *   - Updating an existing card (same ID, same index) triggers
 *     NO auto-scroll — we scroll only on "new item added to the end"
 *     (= length grew OR the last ID changed).
 *
 * API:
 *   const { containerRef, sentinelRef, isPinned, scrollToBottom } =
 *     useStickToBottom({ items });
 *
 *   <div ref={containerRef} style={{ overflowY: 'auto' }}>
 *     {items.map(...)}
 *     <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
 *   </div>
 *
 * Pure hook, no side effects on import. Idempotent, unmount-safe.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface StickyTrackable {
  id: string;
}

export interface UseStickToBottomOptions<T extends StickyTrackable> {
  /** List of items rendered in the container. */
  items: readonly T[];
  /**
   * Optional: additional character bytes of the currently streaming token.
   * When these change, we scroll only if the user is pinned —
   * this is exactly the live-token-stream situation.
   */
  streamingText?: string;
  /**
   * IntersectionObserver root margin. Default 32px → we consider the
   * user "at the end" when the sentinel is within the bottom 32px.
   */
  rootMarginPx?: number;
}

export interface UseStickToBottomResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** True when the sentinel is currently visible = the user is at the end. */
  isPinned: boolean;
  /** Imperative scroll-to-bottom — e.g. for a down button. */
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
}

export function useStickToBottom<T extends StickyTrackable>(
  opts: UseStickToBottomOptions<T>,
): UseStickToBottomResult {
  const { items, streamingText, rootMarginPx = 32 } = opts;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Pinned state: sentinel visible?
  // Ref + state: ref for synchronous reading in the items effect (avoids
  // stale closure), state for re-render triggering when the caller wants to
  // use the exposed field.
  const isPinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);

  // Track the last "append marker": length + id of the last item.
  // This is the heuristic for "genuinely new items at the end vs. just a
  // payload update of an existing card".
  const lastSignatureRef = useRef<{ length: number; lastId: string | null }>({
    length: items.length,
    lastId: items.length > 0 ? items[items.length - 1].id : null,
  });

  // ------------------------------------------------------------------
  // Imperative scroll-to-bottom — uses scrollIntoView on the sentinel.
  // ------------------------------------------------------------------
  const scrollToBottom = useCallback((opts?: { smooth?: boolean }) => {
    const sentinel = sentinelRef.current;
    if (sentinel) {
      sentinel.scrollIntoView({
        block: 'end',
        behavior: (opts?.smooth ? 'smooth' : 'instant') as ScrollBehavior,
      });
      return;
    }
    // Fallback: container.scrollTop = scrollHeight.
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // ------------------------------------------------------------------
  // IntersectionObserver: sentinel visible = pinned.
  // ------------------------------------------------------------------
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = containerRef.current;
    if (!sentinel || !root) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Test env without IO (old happy-dom): fallback to a scroll listener.
      const onScroll = (): void => {
        const dist = root.scrollHeight - root.scrollTop - root.clientHeight;
        const near = dist <= rootMarginPx;
        isPinnedRef.current = near;
        setIsPinned(near);
      };
      onScroll();
      root.addEventListener('scroll', onScroll, { passive: true });
      return () => root.removeEventListener('scroll', onScroll);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === sentinel) {
            const visible = entry.isIntersecting;
            isPinnedRef.current = visible;
            setIsPinned(visible);
          }
        }
      },
      {
        root,
        rootMargin: `0px 0px ${rootMarginPx}px 0px`,
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [rootMarginPx]);

  // ------------------------------------------------------------------
  // Initial scroll: on first mount + when items switch from 0 to >0.
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    // First-paint scroll (the sentinel is already rendered here).
    scrollToBottom();
    // 2x rAF: correct after image load / font layout.
    let raf1 = 0;
    let raf2 = 0;
    if (typeof requestAnimationFrame !== 'undefined') {
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => scrollToBottom());
      });
    }
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // ------------------------------------------------------------------
  // Items update: scroll ONLY if (a) genuinely new items arrived
  // AND (b) the user was pinned. Updating an existing card
  // triggers no scroll.
  // ------------------------------------------------------------------
  useEffect(() => {
    const lastSig = lastSignatureRef.current;
    const newLength = items.length;
    const newLastId = newLength > 0 ? items[newLength - 1].id : null;
    const grew = newLength > lastSig.length;
    const lastIdChanged = newLastId !== lastSig.lastId;
    const isNewAppend = grew || lastIdChanged;
    lastSignatureRef.current = { length: newLength, lastId: newLastId };
    if (!isNewAppend) return; // pure update — the user should not be scrolled
    if (!isPinnedRef.current) return; // user scrolled up — leave them alone
    // New item at the end: double rAF so the DOM is mounted before
    // we scroll — otherwise scrollHeight is still the old value.
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom());
      });
    } else {
      scrollToBottom();
    }
  }, [items, scrollToBottom]);

  // ------------------------------------------------------------------
  // Streaming token stream: on growing `streamingText` AND pinned user,
  // scroll along. With the pinned check: the user may scroll up, we do not
  // follow them back.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (streamingText === undefined) return;
    if (!isPinnedRef.current) return;
    // No double rAF — we want to follow smoothly.
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => scrollToBottom());
    } else {
      scrollToBottom();
    }
  }, [streamingText, scrollToBottom]);

  return { containerRef, sentinelRef, isPinned, scrollToBottom };
}
