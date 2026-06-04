/**
 * Shared types for the Phase-Vers diagnostics system.
 *
 * `VersionManifest` is the single source of truth for build-time
 * version data. Written by the generator (scripts/generate-version-manifest.ts),
 * read by the server (/api/version, /api/diagnostics), and
 * rendered by the client (lib/ui/dgn/*).
 *
 * `DiagnosticsLayerStatus` is the per-layer tuple that implements the
 * failure-isolation strategy from the synthesis spec:
 *   - Promise.allSettled over all layers
 *   - each layer has its own `state`, can time out without taking the
 *     rest down.
 */

export interface VersionManifest {
  commitSha: string;
  shortSha: string;
  buildId: string;
  buildTime: string;
  schemaHash: string;
  swVersion: string;
  nodeVersion: string;
  vercelDeploymentId: string | null;
  vercelEnv: string;
  treeDirty: boolean;
}

export type LayerState = "ok" | "warn" | "error" | "timeout" | "stale";

export interface DiagnosticsLayer {
  state: LayerState;
  /** Menschen-lesbares Label, in `de`. */
  label: string;
  /** Optional: kurzer Detail-String fuer den UI-Tooltip. */
  detail?: string;
  /** Beobachtungs-Zeitpunkt (ms) — fuer Stale-Detection im Client. */
  observedAt: number;
}

export interface DbLayer extends DiagnosticsLayer {
  schemaVersion: number | null;
  schemaHash: string | null;
  appliedAt: number | null;
  lastEventId: string | null;
}

export interface ServerLayer extends DiagnosticsLayer {
  buildId: string;
  shortSha: string;
  nodeVersion: string;
  vercelEnv: string;
  buildTime: string;
}

export interface DiagnosticsResponse {
  /** Overall status: the worst individual status of the layers. */
  overall: LayerState;
  /** ISO-8601, when the snapshot was generated. */
  generatedAt: string;
  server: ServerLayer;
  db: DbLayer;
  /** Layer for "this response itself answered" — trivially ok. */
  api: DiagnosticsLayer;
  /** Optional: consumer hint when something should be merged. */
  hint: string | null;
}

/**
 * Per-source timeout budgets from the synthesis spec (point 3).
 *   server-side: <=2s per source
 *   cli/subprocess: <=1.5s
 */
export const LAYER_TIMEOUTS = {
  db: 2_000,
  server: 1_500,
} as const;
