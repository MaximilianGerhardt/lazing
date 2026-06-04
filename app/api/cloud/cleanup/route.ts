/**
 * GET/POST /api/cloud/cleanup — periodic cron endpoint.
 *
 * Consolidates magic-token purge, share-token purge,
 * soft-deleted-artifact-storage sweep, audit-log retention.
 *
 * Trigger: daily via a lazyos-routine OR manually through the CLI.
 * Idempotent — calling it multiple times per day only causes empty sweeps.
 */

import { NextResponse, type NextRequest } from "next/server";

import { runCloudCleanup } from "@/lib/cloud/cleanup";
import { writeAudit } from "@/lib/audit/write";
import { currentActor } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const result = await runCloudCleanup();
  if (
    result.steps.magicTokensPurged > 0 ||
    result.steps.shareTokensPurged > 0 ||
    result.steps.softDeletedArtifactsRemoved > 0 ||
    result.steps.auditRowsPruned > 0
  ) {
    writeAudit({
      actor: currentActor(req),
      action: "magic.expired",
      payload: {
        kind: "cloud-cleanup-run",
        ...result.steps,
        errors: result.errors,
      },
    });
  }
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
