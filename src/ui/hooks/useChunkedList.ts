import { useEffect, useRef, useState } from "react";

export const DEFAULT_INITIAL_CHUNK = 60;
export const DEFAULT_CHUNK_INCREMENT = 40;

export function getNextChunkCount(currentCount: number, increment: number, total: number): number {
  return Math.min(Math.max(currentCount + increment, 0), total);
}

export interface UseChunkedListOptions {
  initialCount?: number;
  chunkSize?: number;
  rootMargin?: string;
  resetKey?: unknown;
}

/**
 * Progressively appends items to the rendered slice as the user scrolls.
 *
 * Renders an initial bounded batch (60 items) rather than mounting thousands of
 * heavy DOM elements on first paint. Uses an IntersectionObserver on a bottom
 * sentinel to append the next batch (40 items) before the user reaches the end.
 */
export function useChunkedList<T>(
  items: T[],
  options?: UseChunkedListOptions,
) {
  const initialCount = options?.initialCount ?? DEFAULT_INITIAL_CHUNK;
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_INCREMENT;
  const rootMargin = options?.rootMargin ?? "600px 0px";
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(initialCount);
  }, [options?.resetKey, initialCount]);

  useEffect(() => {
    if (visibleCount >= items.length) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const scrollRoot = sentinel.closest("[data-page-scroll-root]");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) => getNextChunkCount(prev, chunkSize, items.length));
        }
      },
      {
        root: scrollRoot instanceof Element ? scrollRoot : null,
        rootMargin,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chunkSize, items.length, rootMargin, visibleCount]);

  const visibleItems = items.slice(0, visibleCount);
  const hasMoreChunks = visibleCount < items.length;

  return {
    visibleItems,
    visibleCount,
    hasMoreChunks,
    sentinelRef,
  };
}
