/**
 * /routines — Routines-Engine Overview
 *
 * Server Component: laedt alle Routinen + kompakte Meta. Client Component
 * `RoutinesList` uebernimmt die komplette Interaktivitaet (Filter,
 * Toggle, Trigger, Details, Wizard).
 */

import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { routines } from "@/db/schema/routines";
import { ContextBand } from "@/lib/ui/cbd";

import { RoutinesHeader } from "./RoutinesHeader";
import type { RoutineSummary } from "./types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function loadRoutines(): Promise<RoutineSummary[]> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: routines.id,
        name: routines.name,
        workspaceId: routines.workspaceId,
        triggerMode: routines.triggerMode,
        cronExpr: routines.cronExpr,
        eventMatch: routines.eventMatch,
        lastRunAt: routines.lastRunAt,
        nextRunAt: routines.nextRunAt,
        active: routines.active,
        createdAt: routines.createdAt,
        updatedAt: routines.updatedAt,
      })
      .from(routines)
      .orderBy(desc(routines.updatedAt));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      workspaceId: r.workspaceId,
      triggerMode: r.triggerMode as "cron" | "manual" | "event",
      cronExpr: r.cronExpr,
      eventMatch: r.eventMatch,
      lastRunAt: r.lastRunAt,
      nextRunAt: r.nextRunAt,
      active: !!r.active,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  } catch {
    return [];
  }
}

export default async function RoutinesPage() {
  const list = await loadRoutines();
  const activeCount = list.filter((r) => r.active).length;

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <section
        style={{
          maxWidth: 1100,
          marginTop: "clamp(24px, 5vw, 60px)",
          padding: "0 clamp(20px, 4vw, 56px)",
        }}
      >
        <ContextBand
          pillVariant="own"
          pillLabel="Routines"
          breadcrumb={`Stream E · ${activeCount} aktiv / ${list.length} gesamt`}
        />

        <RoutinesHeader initial={list} />
      </section>
    </main>
  );
}
