import type { ReactNode } from 'react';
import type { EngineStatus, EngineType } from './types';

interface EngineProps {
  /** Variant — drives accent colour + border glow. */
  type: EngineType;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** 2-letter avatar token, e.g. "CC". Defaults derived from type. */
  avatar?: string;
  /** Runtime status — `running` pulses, `idle` dims. */
  status: EngineStatus;
  /**
   * Custom status label text. Defaults to
   *   running → "läuft"
   *   idle    → "idle"
   */
  statusLabel?: string;
  /**
   * Meta content (model / skills / context). ReactNode so
   * callers can embed `<b>` highlights or `<br/>` line breaks
   * exactly like the HTML reference.
   */
  meta: ReactNode;
  /**
   * Wave bar heights in 0–100 (%). Defaults to 12 deterministic
   * pseudo-random bars derived from `name` (SSR-safe — same
   * output on server and client hydration).
   */
  waveHeights?: number[];
  className?: string;
}

/** Default number of wave bars matching the design reference. */
const DEFAULT_BAR_COUNT = 12;

/** Wave bar height range when auto-generating (in percent). */
const WAVE_MIN = 30;
const WAVE_MAX = 95;

/**
 * Maps an engine type to its CSS variant class.
 */
function typeClass(type: EngineType): string {
  switch (type) {
    case 'claude':
      return 'cl';
    case 'codex':
      return 'cx';
    case 'local':
      return 'lo';
  }
}

/**
 * Sensible avatar fallback per engine type.
 */
function defaultAvatar(type: EngineType): string {
  switch (type) {
    case 'claude':
      return 'CC';
    case 'codex':
      return 'CX';
    case 'local':
      return 'LO';
  }
}

/**
 * FNV-1a 32-bit hash. Used as a deterministic seed source so
 * that wave heights are identical on server and client — no
 * `Math.random`, no hydration mismatch.
 *
 * FNV-1a is tiny, allocation-free and plenty for "looks
 * random" UI jitter.
 */
function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, emulate wrap-around
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit
  return h >>> 0;
}

/**
 * Mulberry32 PRNG — fast, deterministic, returns [0, 1).
 * Seeded once per name so two Engine cards with the same
 * `name` produce the exact same bar pattern.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the default 12-bar wave pattern, deterministic per
 * `name`. Keeps the design's visual rhythm without needing a
 * client effect.
 */
function generateWaveHeights(name: string): number[] {
  const rand = mulberry32(hashSeed(name));
  const heights: number[] = new Array(DEFAULT_BAR_COUNT);
  for (let i = 0; i < DEFAULT_BAR_COUNT; i++) {
    heights[i] = Math.round(WAVE_MIN + rand() * (WAVE_MAX - WAVE_MIN));
  }
  return heights;
}

/**
 * Clamp a height value into the visually meaningful range
 * and round to an integer percent — keeps the rendered style
 * attribute stable across renders (no floating-point drift).
 */
function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return WAVE_MIN;
  if (h < 0) return 0;
  if (h > 100) return 100;
  return Math.round(h);
}

/**
 * ENG-01 / ENG-02 — Engine Card.
 *
 * Renders an engine (Claude / Codex / Local) with:
 *  - accent-coloured left border + glow (via `.eng.cl|.cx|.lo`)
 *  - avatar tile, name, status dot
 *  - meta line (model · skills · subagents · context)
 *  - wave bars showing live activity / throughput
 *
 * Fully SSR-safe: wave heights are derived deterministically
 * from `name` via FNV-1a + Mulberry32 — no `Math.random`,
 * no `useEffect`, no hydration mismatch. Callers can still
 * pass `waveHeights` explicitly for real-time data binding.
 *
 * Accessibility:
 * - Root element is `<article>` (matches HTML reference).
 * - `aria-label` combines name + status so assistive tech
 *   hears "Claude Code, läuft" without parsing visual state.
 * - Meta is a `<p>` so screen readers announce it as one
 *   paragraph rather than a stream of inline fragments.
 * - Wave bars are purely decorative → `aria-hidden="true"`.
 */
export function Engine({
  type,
  name,
  avatar,
  status,
  statusLabel,
  meta,
  waveHeights,
  className,
}: EngineProps) {
  const classes = ['eng', typeClass(type)];
  if (className) classes.push(className);

  const displayAvatar = avatar ?? defaultAvatar(type);
  const displayStatus = statusLabel ?? (status === 'running' ? 'läuft' : 'idle');
  const statusClass = status === 'idle' ? 'st idle' : 'st';

  const heights =
    waveHeights && waveHeights.length > 0
      ? waveHeights.map(clampHeight)
      : generateWaveHeights(name);

  return (
    <article
      className={classes.join(' ')}
      aria-label={`${name}, ${displayStatus}`}
    >
      <div className="hh">
        <div className="av" aria-hidden="true">
          {displayAvatar}
        </div>
        <div className="nm">{name}</div>
        <div className={statusClass} role="status" aria-live="polite">
          {displayStatus}
        </div>
      </div>
      <p className="mt">{meta}</p>
      <div className="wv" aria-hidden="true">
        {heights.map((h, i) => (
          <i key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
    </article>
  );
}
