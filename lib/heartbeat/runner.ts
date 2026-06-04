/**
 * Heartbeat runner — orchestrates a full workspace sweep.
 *
 * Pipeline:
 *   1. listWorkspaces() — non-archived (fallback: [])
 *   2. parallel probeWorkspace() — 5s timeout per probe
 *   3. evaluateProbe() — pure logic
 *   4. INSERT INTO workspace_heartbeats — append-only audit trail
 *   5. emitEvent('heartbeat_swept') per workspace — for SSE clients
 *
 * Failure policy:
 *   - Individual workspaces may fail (ProbeResult then contains
 *     `error`). The sweep still returns all decisions.
 *   - If the `workspaces` table is missing (Agent 7C not yet run), we
 *     gracefully return an empty array instead of throwing.
 */

import { getDb } from "../../db/client";
import { workspaceHeartbeats } from "../../db/schema/heartbeats";
import { emitEvent, emitErrorEvent } from "../events/emit";
import type { Workspace } from "../events/types";
import { listWorkspaces } from "../workspaces";
import { ulid } from "../ulid";
import { evaluateProbe, type HeartbeatStatus, type StallDecision } from "./evaluator";
import { probeWorkspace, type ProbeResult } from "./probes";

export interface HeartbeatSweepResult {
  decisions: StallDecision[];
  probes: Map<string, ProbeResult>;
}

/**
 * Runs a full heartbeat sweep. Returns the decisions and the raw probes
 * so callers (API route) can surface both.
 */
export async function sweepHeartbeats(
  now: number = Date.now(),
): Promise<HeartbeatSweepResult> {
  const workspaces = await safeListWorkspaces();

  // Parallel probe all workspaces. Each probe has its own 5s timeout and
  // error-capture, so Promise.all never throws.
  const pairs = await Promise.all(
    workspaces.map(async (ws) => {
      const probe = await probeWorkspace(ws.id, ws.path);
      const decision = evaluateProbe(ws.id, probe, now);
      return { ws, probe, decision };
    }),
  );

  // Persist + broadcast. We do this sequentially (SQLite writer lock) but
  // it's fast — a single INSERT per workspace.
  for (const { ws, probe, decision } of pairs) {
    await persistHeartbeat(ws, probe, decision, now);
    await emitHeartbeatEvent(ws, probe, decision);
  }

  return {
    decisions: pairs.map((p) => p.decision),
    probes: new Map(pairs.map((p) => [p.ws.id, p.probe])),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function safeListWorkspaces(): Promise<Workspace[]> {
  try {
    return await listWorkspaces();
  } catch (err) {
    // Graceful fallback if workspaces table is missing (migration race).
    await emitErrorEvent("lazyos", "heartbeat/runner:list_workspaces", err).catch(
      () => void 0,
    );
    return [];
  }
}

async function persistHeartbeat(
  ws: Workspace,
  probe: ProbeResult,
  decision: StallDecision,
  now: number,
): Promise<void> {
  try {
    const db = getDb();
    db.insert(workspaceHeartbeats)
      .values({
        id: ulid(now),
        workspaceId: ws.id,
        ts: now,
        status: decision.status,
        lagSec: decision.lagSec,
        probes: JSON.stringify({ ...probe, reasons: decision.reasons }),
      })
      .run();
  } catch (err) {
    await emitErrorEvent(ws.id, "heartbeat/runner:persist", err).catch(
      () => void 0,
    );
  }
}

async function emitHeartbeatEvent(
  ws: Workspace,
  probe: ProbeResult,
  decision: StallDecision,
): Promise<void> {
  try {
    await emitEvent({
      segmentId: ws.id,
      entityType: "workspace",
      entityId: ws.id,
      eventType: "heartbeat_swept",
      actor: "system",
      payload: {
        status: decision.status,
        lagSec: decision.lagSec,
        reasons: decision.reasons,
        hasPackageJson: probe.hasPackageJson,
        hasVercel: probe.hasVercel,
        uncommittedChanges: probe.uncommittedChanges ?? 0,
        unpushedCommits: probe.unpushedCommits ?? 0,
      },
      sensitivity: "low",
    });
  } catch (err) {
    await emitErrorEvent(ws.id, "heartbeat/runner:emit", err).catch(
      () => void 0,
    );
  }
}

/**
 * Exposes the last heartbeat timestamp for a given workspace (for
 * Observatory /api/health surface). Returns `undefined` when the
 * workspace has never been swept or the table is missing.
 */
export function getLastSweepTs(): number | undefined {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare("SELECT MAX(ts) AS ts FROM workspace_heartbeats")
      .get() as { ts: number | null } | undefined;
    return row?.ts ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the latest heartbeat per workspace — used by the Observatory
 * card grid. Pure read, no sweep.
 */
export interface LatestHeartbeat {
  workspaceId: string;
  ts: number;
  status: HeartbeatStatus;
  lagSec: number;
  probes: ProbeResult & { reasons?: string[] };
}

export function listLatestHeartbeats(): LatestHeartbeat[] {
  try {
    const db = getDb();
    const rows = db.$raw
      .prepare(
        `SELECT h.workspace_id, h.ts, h.status, h.lag_sec, h.probes
           FROM workspace_heartbeats h
           INNER JOIN (
             SELECT workspace_id, MAX(ts) AS max_ts
               FROM workspace_heartbeats
               GROUP BY workspace_id
           ) latest
             ON latest.workspace_id = h.workspace_id
            AND latest.max_ts = h.ts`,
      )
      .all() as Array<{
      workspace_id: string;
      ts: number;
      status: string;
      lag_sec: number;
      probes: string;
    }>;

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      ts: r.ts,
      status: coerceStatus(r.status),
      lagSec: r.lag_sec,
      probes: safeParseProbes(r.probes),
    }));
  } catch {
    return [];
  }
}

function coerceStatus(raw: string): HeartbeatStatus {
  if (
    raw === "alive" ||
    raw === "stale" ||
    raw === "dormant" ||
    raw === "error"
  ) {
    return raw;
  }
  return "error";
}

function safeParseProbes(
  raw: string,
): ProbeResult & { reasons?: string[] } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ProbeResult & { reasons?: string[] };
    }
  } catch {
    // fall-through
  }
  return { hasPackageJson: false, hasVercel: false };
}
