#!/usr/bin/env tsx
/**
 * Drift-Verifikations-CLI für Reasoning-Audit (Pattern 5 Welle 3, 2026-05-01).
 *
 * Wählt unverified Audit-Rows (verified_status IS NULL) der letzten N Stunden
 * mit Filter auf High-Stake-Phasen (default: synthesis, cross-roast).
 * Pro Row: spawnt Re-Run mit identischem System+User-Prompt, vergleicht
 * Outputs via Embedding-Cosine, schreibt verified_status zurück.
 *
 * Aufruf:
 *   tsx scripts/verify-reasoning-drift.ts --max=50 --since-hours=24
 *   tsx scripts/verify-reasoning-drift.ts --phase=synthesis
 *
 * Cost-Cap: env LAZYOS_DRIFT_MAX_PER_RUN (default 100). Break wenn überschritten.
 *
 * Single-Pass: kein Loop. Wird per systemd-timer täglich 03:00 UTC getriggert.
 *
 * Emittet 'drift_verify_batch'-Event auf segments 'lazyos' mit Summary.
 */

import { and, gte, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { reasoningAudit } from "@/db/schema/reasoning_audit";
import { verifyOne, type DriftDecision } from "@/lib/audit/reasoning-verify";
import { emitEvent } from "@/lib/events/emit";

interface CliArgs {
  max: number;
  sinceHours: number;
  phases: string[];
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    max: 50,
    sinceHours: 24,
    phases: ["synthesis", "cross-roast"],
  };
  for (const raw of argv) {
    if (raw.startsWith("--max=")) {
      const n = Number.parseInt(raw.slice("--max=".length), 10);
      if (Number.isFinite(n) && n > 0) out.max = n;
    } else if (raw.startsWith("--since-hours=")) {
      const n = Number.parseInt(raw.slice("--since-hours=".length), 10);
      if (Number.isFinite(n) && n > 0) out.sinceHours = n;
    } else if (raw.startsWith("--phase=")) {
      out.phases = raw
        .slice("--phase=".length)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const costCap = Number.parseInt(
    process.env.LAZYOS_DRIFT_MAX_PER_RUN ?? "100",
    10,
  );
  const cap = Number.isFinite(costCap) && costCap > 0 ? costCap : 100;

  const sinceMs = Date.now() - args.sinceHours * 60 * 60_000;
  const since = new Date(sinceMs);

  console.log(
    `[drift-verify] start max=${args.max} since-hours=${args.sinceHours} phases=${args.phases.join(",")} cap=${cap}`,
  );

  const db = getDb();
  // Drizzle: SELECT id WHERE verified_status IS NULL AND phase IN (?) AND ts >= ?
  const candidates = db
    .select({ id: reasoningAudit.id })
    .from(reasoningAudit)
    .where(
      and(
        isNull(reasoningAudit.verifiedStatus),
        inArray(reasoningAudit.phase, args.phases),
        gte(reasoningAudit.ts, since),
      ),
    )
    .orderBy(sql`${reasoningAudit.ts} DESC`)
    .limit(args.max)
    .all();

  console.log(`[drift-verify] candidates=${candidates.length}`);

  let ok = 0;
  let drift = 0;
  let fabricated = 0;
  let errors = 0;
  let processed = 0;

  for (const { id } of candidates) {
    if (processed >= cap) {
      console.log(`[drift-verify] cap reached (${cap}) — stopping`);
      break;
    }
    processed += 1;
    try {
      const decision: DriftDecision | null = await verifyOne(id);
      if (!decision) {
        console.log(`[drift-verify] ${id} → not-found`);
        continue;
      }
      switch (decision.status) {
        case "ok":
          ok += 1;
          break;
        case "drift":
          drift += 1;
          break;
        case "fabricated":
          fabricated += 1;
          break;
      }
      console.log(
        `[drift-verify] ${id} → ${decision.status} sim=${decision.similarity.toFixed(3)} note="${decision.note}"`,
      );
    } catch (err) {
      errors += 1;
      console.warn(
        `[drift-verify] ${id} → ERROR: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const summary = { ok, drift, fabricated, errors, total: processed };
  console.log(`[drift-verify] done ${JSON.stringify(summary)}`);

  // Event auf 'lazyos' segment für Inbox/Push-Konsum.
  try {
    await emitEvent({
      segmentId: "lazyos",
      entityType: "workspace",
      entityId: "lazyos",
      eventType: "drift_verify_batch",
      actor: "system",
      payload: summary,
    });
  } catch (err) {
    console.warn(
      `[drift-verify] event-emit failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(
    "[drift-verify] fatal:",
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
});
