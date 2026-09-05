"use client";

import { useEffect, useState } from "react";

/** Below this, the workspace becomes a phone application rather than columns. */
export const MOBILE_BREAKPOINT = 900;

/**
 * Tracks a media query.
 *
 * Starts as `null` so the first render can avoid committing to a layout it may
 * have to throw away — the caller decides what to show while it is unknown.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * True on a phone-sized screen.
 *
 * Resolves to the desktop layout until the query has been evaluated, so the
 * server-rendered markup and the first client render agree.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`) === true;
}
