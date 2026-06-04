/**
 * lib/deploy/targets.ts
 *
 * Canonical type definitions for the Deployment-Scaffold system (Batch 7e, C5).
 *
 * Design constraints:
 *   - No file-writes, no network calls, no imports from db/* or app-store.
 *   - Secrets/ENV values are NEVER embedded — only key-name strings are carried.
 *   - DeployConfigInput is the single source of truth for all generator functions.
 *   - Actual file-writing is PHASE2_DEPLOY_WRITE (gated / R3 action) — NOT here.
 */

// ---------------------------------------------------------------------------
// Target enum
// ---------------------------------------------------------------------------

/** Supported deployment targets. */
export type DeployTarget =
  | 'vercel'
  | 'docker'
  | 'tailscale'
  | 'caddy-vps';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * All the information a generator needs to produce a target-specific config.
 *
 * Rules:
 *   - `envKeys` lists only the ENV-key *names* — never the values.
 *   - `domain` is optional; generators use a placeholder when absent.
 *   - `agentServerPort` defaults to 4201 per laz.ing convention.
 *   - `webPort` defaults to 4200 per laz.ing convention.
 *   - `cronSchedules` is optional; only used by vercel target.
 */
export interface DeployConfigInput {
  /** Application identifier — used in labels, service names, image tags. */
  appName: string;

  /** Primary web port (default: 4200 — laz.ing convention). */
  webPort: number;

  /** Agent-server sidecar port (default: 4201 — laz.ing convention). */
  agentServerPort: number;

  /**
   * Public-facing domain without protocol (e.g. "app.laz.ing").
   * Optional — generators emit a placeholder when not provided.
   */
  domain?: string;

  /**
   * List of required ENV *key names* (no values).
   * Generators use these to produce .env.example / pre-deploy checklists.
   *
   * Example: ['LAZYOS_AUTH_SECRET', 'LAZYOS_ACCESS_CODE']
   */
  envKeys: string[];

  /**
   * Cron schedules (Vercel only).
   * Maps an API route path to a cron expression.
   *
   * Example: { '/api/routines/sweep': '* * * * *' }
   */
  cronSchedules?: Record<string, string>;

  /**
   * Node.js major version for Dockerfile base image.
   * Defaults to 20 (matches laz.ing production).
   */
  nodeVersion?: number;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** A single in-memory file that a generator wants to write. */
export interface ScaffoldFile {
  /** Target path relative to repo root (e.g. "vercel.json"). */
  path: string;
  /** Full file content as a UTF-8 string. */
  content: string;
}

/** Result of generateDeployScaffold — never writes to disk. */
export interface DeployScaffoldResult {
  /** Files to be written (PHASE2_DEPLOY_WRITE — caller decides). */
  files: ScaffoldFile[];
  /**
   * Human-readable pre-deploy notes/warnings.
   * Must include security warnings for dev-only ENV flags.
   */
  notes: string[];
}
