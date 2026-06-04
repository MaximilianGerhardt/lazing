"use client";

/**
 * /lab live-tab panel — wave 7 (2026-05-01)
 *
 * Renders the real card via renderSurface() with a mock payload. Until now
 * the live tab only shows JSON-pretty (see samplePayloadFor). Wave 7 mounts
 * the SurfaceRenderer directly — so the reviewer sees the real pixel state,
 * not just the data schema.
 *
 * Fallback: if `surfaceKind` is null (the kind has no direct surface-tag
 * representation, e.g. sub-workstream), we show the JSON-pretty further
 * down.
 */

import type { ReactNode } from "react";

import { renderSurface } from "../../../lib/chat/SurfaceRenderer";
import type { SurfaceKind } from "../../../lib/chat/surface-parser";

interface Props {
  surfaceKind: SurfaceKind | null;
  payload: Record<string, unknown>;
  jsonFallbackTitle: string;
  jsonFallback: ReactNode;
}

export function LiveSurfacePanel({
  surfaceKind,
  payload,
  jsonFallbackTitle,
  jsonFallback,
}: Props): ReactNode {
  if (!surfaceKind) {
    return jsonFallback;
  }
  const node = renderSurface(surfaceKind, payload);
  if (!node) {
    return jsonFallback;
  }
  return (
    <section className="lab-live-panel" aria-label={jsonFallbackTitle}>
      <header className="lab-live-panel__header">
        <span className="lab-live-panel__badge">Live</span>
        <span className="lab-live-panel__title">
          surface:{surfaceKind} · echtes Card-Rendering
        </span>
      </header>
      <div className="lab-live-panel__stage">{node}</div>
    </section>
  );
}
