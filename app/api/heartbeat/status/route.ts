/**
 * GET /api/heartbeat/status
 *
 * Read-only projection: latest Heartbeat pro Workspace.
 *
 * Auth: ueber Middleware (Session-Cookie). Kein Bearer noetig — dieser
 * Endpunkt ist fuer den /observatory Client gedacht.
 *
 * Proxied to the VPS when the bridge is configured, otherwise served
 * from the local heartbeat store (which on Vercel is ephemeral and
 * therefore typically empty — degraded path).
 *
 * Shape:
 *   {
 *     now: number,
 *     globals: { alive, stale, dormant, error, total },
 *     workspaces: Array<{
 *       id, label, accent, path,
 *       ts, status, lagSec,
 *       probes: { lastCommitTs?, uncommittedChanges?, unpushedCommits?,
 *                 outdatedDeps?, hasPackageJson, hasVercel },
 *       reasons: string[]
 *     }>
 *   }
 */

import { NextResponse } from "next/server";

import { listLatestHeartbeats } from "@/lib/heartbeat/runner";
import { listWorkspaces } from "@/lib/workspaces";
import { bridgeOrLocal } from "@/lib/vps-bridge/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readHeartbeatLocal(): Promise<Response> {
  const now = Date.now();

  let workspaces;
  try {
    workspaces = await listWorkspaces();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: "workspaces_unavailable",
        message: msg,
        now,
        globals: { alive: 0, stale: 0, dormant: 0, error: 0, pending: 0, total: 0 },
        workspaces: [],
      },
      // 200 so the UI can render "unknown" cards instead of crashing on an
      // HTTP error when the local DB is simply missing on cold-start.
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  const latest = listLatestHeartbeats();
  const byId = new Map(latest.map((h) => [h.workspaceId, h] as const));

  const cards = workspaces.map((ws) => {
    const hb = byId.get(ws.id);
    const probes = hb?.probes ?? {
      hasPackageJson: false,
      hasVercel: false,
    };
    const reasons =
      (hb?.probes as { reasons?: string[] } | undefined)?.reasons ?? [];
    return {
      id: ws.id,
      label: ws.label,
      accent: ws.accent,
      path: ws.path,
      ts: hb?.ts ?? null,
      status: hb?.status ?? ("pending" as const),
      lagSec: hb?.lagSec ?? 0,
      probes: {
        lastCommitTs: probes.lastCommitTs ?? null,
        uncommittedChanges: probes.uncommittedChanges ?? null,
        unpushedCommits: probes.unpushedCommits ?? null,
        outdatedDeps: probes.outdatedDeps ?? null,
        hasPackageJson: probes.hasPackageJson,
        hasVercel: probes.hasVercel,
      },
      reasons,
    };
  });

  const globals = {
    alive: cards.filter((c) => c.status === "alive").length,
    stale: cards.filter((c) => c.status === "stale").length,
    dormant: cards.filter((c) => c.status === "dormant").length,
    error: cards.filter((c) => c.status === "error").length,
    pending: cards.filter((c) => c.status === "pending").length,
    total: cards.length,
  };

  return NextResponse.json(
    {
      ok: true,
      now,
      globals,
      workspaces: cards,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}

export async function GET(): Promise<Response> {
  return bridgeOrLocal<{ ok: boolean; workspaces: unknown[] }>({
    path: "/api/heartbeat/status",
    fallback: () => readHeartbeatLocal(),
    validate: (body): body is { ok: boolean; workspaces: unknown[] } => {
      if (!body || typeof body !== "object") return false;
      return Array.isArray((body as { workspaces?: unknown }).workspaces);
    },
  });
}
