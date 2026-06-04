/**
 * Heartbeat UI helpers — shared between the Observatory grid and the
 * Pulse summary card. Pure functions, no React, safe for SSR.
 */

import type { HeartbeatStatus } from "./evaluator";

export type UiStatus = HeartbeatStatus | "pending";

/** Maps a status to a design-token-backed CSS variable. */
export function statusColor(status: UiStatus): string {
  switch (status) {
    case "alive":
      return "var(--a-clientb)"; // green — healthy
    case "stale":
      return "var(--a-warn)"; // yellow — warning
    case "dormant":
      return "var(--a-north)"; // orange — dormant
    case "error":
      return "var(--a-danger)"; // red — broken
    case "pending":
    default:
      return "var(--ink-3)"; // muted — no signal yet
  }
}

/** Human-facing status label (de-DE). */
export function statusLabel(status: UiStatus): string {
  switch (status) {
    case "alive":
      return "alive";
    case "stale":
      return "stale";
    case "dormant":
      return "dormant";
    case "error":
      return "error";
    case "pending":
    default:
      return "pending";
  }
}

/** Maps workspace accent tokens to CSS vars for the left bar. */
export function accentVar(accent: string): string {
  switch (accent) {
    case "clientb":
      return "var(--a-clientb)";
    case "own":
      return "var(--a-own)";
    case "private":
      return "var(--a-private)";
    case "claude":
      return "var(--e-claude)";
    case "codex":
      return "var(--e-codex)";
    case "error":
      return "var(--a-danger)";
    case "north":
    default:
      return "var(--a-north)";
  }
}

/**
 * Formats `lag_sec` as a human-friendly "vor X" (e.g. "vor 2h", "vor 3d").
 * "—" when we don't have a commit timestamp yet.
 */
export function formatLag(lagSec: number): string {
  if (!lagSec || lagSec <= 0) return "jetzt";
  if (lagSec < 60) return `${lagSec}s`;
  if (lagSec < 3600) return `${Math.floor(lagSec / 60)}m`;
  if (lagSec < 86400) return `${Math.floor(lagSec / 3600)}h`;
  return `${Math.floor(lagSec / 86400)}d`;
}

/** Formats a unix-ms timestamp as localized date/time (de-DE). */
export function formatTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
    });
    const time = d.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${date} ${time}`;
  } catch {
    return "—";
  }
}

/**
 * Returns a 0..1 fill-ratio for the wave-bar visualisation.
 * Scale: 0 at "now", 1 at ">= 7d" — clamped.
 */
export function lagRatio(lagSec: number): number {
  const sevenDays = 7 * 24 * 3600;
  if (lagSec <= 0) return 0;
  if (lagSec >= sevenDays) return 1;
  return lagSec / sevenDays;
}
