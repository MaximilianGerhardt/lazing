'use client';

import { useCallback } from 'react';

export type HapticIntensity = 'light' | 'medium' | 'heavy' | 'success' | 'warning';

const PATTERNS: Record<HapticIntensity, number | number[]> = {
  light: 8,
  medium: 14,
  heavy: 24,
  success: [8, 40, 8],
  warning: [8, 80, 8, 80, 8],
};

/**
 * Pure trigger — extracted so it is unit-testable without a React renderer.
 *
 * Bails silently when:
 *  - SSR (no window)
 *  - navigator.vibrate is unavailable
 *  - prefers-reduced-motion is set
 *  - vibrate() throws (some browsers throw on user-gesture-less calls)
 */
export function triggerHaptic(intensity: HapticIntensity = 'light'): void {
  if (typeof window === 'undefined') return;
  const nav: Navigator | undefined =
    typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.vibrate !== 'function') return;
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return;
  }
  try {
    nav.vibrate(PATTERNS[intensity]);
  } catch {
    /* fail-silent */
  }
}

/**
 * useHaptic — React hook that returns a stable trigger fn.
 */
export function useHaptic() {
  return useCallback((intensity: HapticIntensity = 'light') => {
    triggerHaptic(intensity);
  }, []);
}
