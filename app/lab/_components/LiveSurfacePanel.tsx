"use client";

/**
 * /lab Live-Tab Panel — Welle 7 (2026-05-01)
 *
 * Rendert die echte Card via renderSurface() mit Mock-Payload. Bisher zeigt
 * der Live-Tab nur JSON-Pretty (siehe samplePayloadFor). Welle 7 mountet
 * den SurfaceRenderer direkt — so sieht der Reviewer den echten Pixel-
 * State, nicht nur das Datenschema.
 *
 * Fallback: wenn `surfaceKind` null ist (Kind hat keine direkte Surface-
 * Tag-Repräsentation, z.B. sub-workstream), zeigen wir den JSON-Pretty
 * weiter unten.
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
