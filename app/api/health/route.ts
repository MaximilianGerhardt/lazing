/**
 * GET /api/health
 *
 * Aggregated health snapshot — Phase 6.
 *
 * status:
 *   - database=error           → "unhealthy"   (HTTP 503)
 *   - recentErrors > 5 in 5min → "degraded"    (HTTP 200)
 *   - otherwise                → "healthy"     (HTTP 200)
 */

import { NextResponse } from "next/server";
import { and, gte, eq } from "drizzle-orm";

import { getDb, getDbPath } from "../../../db/client";
import { broadcast } from "../../../lib/events/broadcast";
import { emitErrorEvent } from "../../../lib/events/emit";
import { getSegmentCounts } from "../../../lib/events/project";
import { events } from "../../../db/schema/events";
import * as pushStore from "../../../lib/pwa/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIVE_MIN_MS = 5 * 60 * 1000;

type OverallStatus = "healthy" | "degraded" | "unhealthy";

interface HealthChecks {
  database: "ok" | "error";
  anthropicKey: "set" | "missing";
  vapidKey: "set" | "missing";
  authSecret: "set" | "missing";
  recentErrors: number;
  memoryUsage: { rss: number; heap: number };
}

function mbOf(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function hasEnv(name: string, minLen = 1): "set" | "missing" {
  const v = process.env[name];
  return typeof v === "string" && v.length >= minLen ? "set" : "missing";
}

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  let databaseCheck: "ok" | "error" = "ok";
  let eventCount = 0;
  let segmentCounts: Awaited<ReturnType<typeof getSegmentCounts>> | null = null;
  let pushSubscriptions = 0;
  let recentErrors = 0;
  let dbError: string | undefined;

  try {
    const db = getDb();
    const row = db.$raw
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get() as { n: number };
    eventCount = row.n;
    segmentCounts = await getSegmentCounts();

    const cutoff = Date.now() - FIVE_MIN_MS;
    const errorRows = db
      .select()
      .from(events)
      .where(
        and(eq(events.eventType, "error_logged"), gte(events.createdAt, cutoff)),
      )
      .all();
    recentErrors = errorRows.length;
  } catch (err) {
    databaseCheck = "error";
    dbError = err instanceof Error ? err.message : String(err);
    try {
      await emitErrorEvent("@system", "api/health:db", err);
    } catch {
      // best-effort
    }
  }

  try {
    const subs = await pushStore.list();
    pushSubscriptions = subs.length;
  } catch {
    // nice-to-have
  }

  const memRss =
    typeof process !== "undefined" && process.memoryUsage
      ? process.memoryUsage()
      : { rss: 0, heapUsed: 0 };

  const checks: HealthChecks = {
    database: databaseCheck,
    anthropicKey: hasEnv("ANTHROPIC_API_KEY", 10),
    vapidKey: hasEnv("VAPID_PRIVATE_KEY", 10),
    authSecret: hasEnv("LAZYOS_AUTH_SECRET", 16),
    recentErrors,
    memoryUsage: { rss: mbOf(memRss.rss), heap: mbOf(memRss.heapUsed) },
  };

  let status: OverallStatus = "healthy";
  if (databaseCheck === "error") status = "unhealthy";
  else if (recentErrors > 5) status = "degraded";

  const segments = segmentCounts
    ? Object.entries(segmentCounts).map(([id, c]) => ({
        id,
        total: c.total,
        open: c.open,
      }))
    : [];

  const chatModel = process.env.LAZYOS_ANTHROPIC_MODEL ?? "claude-opus-4-8";

  const body = {
    status,
    timestamp: new Date().toISOString(),
    segments,
    eventCount,
    pushSubscriptions,
    dbPath: getDbPath(),
    uptime: Math.round(process.uptime()),
    broadcast: { listeners: broadcast.size },
    latencyMs: Date.now() - startedAt,
    checks,
    // Legacy top-level fields kept for backwards compat with existing clients.
    anthropicKey: checks.anthropicKey === "set",
    chatModel,
    version: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
      deployedAt:
        process.env.VERCEL_GIT_COMMIT_AUTHOR_DATE ??
        process.env.VERCEL_DEPLOYMENT_CREATED_AT ??
        new Date().toISOString(),
    },
    ...(dbError ? { error: dbError } : {}),
  };

  const httpStatus = status === "unhealthy" ? 503 : 200;
  return NextResponse.json(body, { status: httpStatus });
}
