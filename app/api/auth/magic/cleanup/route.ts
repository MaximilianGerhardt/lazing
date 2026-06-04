/**
 * GET/POST /api/auth/magic/cleanup
 * Cron-Endpoint — räumt magic_tokens-Rows wo `purge_after < now`.
 * Idempotent. Wird von Heartbeat/Cron getriggert.
 */

import { NextResponse, type NextRequest } from "next/server";

import { purgeExpiredTokens } from "@/lib/auth/magic-link";
import { writeAudit } from "@/lib/audit/write";
import { currentActor } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const result = purgeExpiredTokens();
  if (result.deleted > 0) {
    writeAudit({
      actor: currentActor(req),
      action: "magic.expired",
      payload: { purged: result.deleted, source: "cleanup-cron" },
    });
  }
  return NextResponse.json({ purged: result.deleted });
}

export const GET = handle;
export const POST = handle;
