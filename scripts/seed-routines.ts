/**
 * scripts/seed-routines.ts
 *
 * Creates the 3 default routines (morning-brief, deadline-watch,
 * heartbeat-stall). Idempotent: checks via SELECT id, skips on a match.
 *
 * Usage:
 *   pnpm tsx scripts/seed-routines.ts
 *
 * Exit 0 even on "already seeded" — so the process can be repeated safely
 * in the deploy step.
 */

import { getDb } from "../db/client";
import { routines } from "../db/schema/routines";
import { ulid } from "../lib/ulid";
import { nextRunAt } from "../lib/routines/scheduler";
import { validateYamlConfig } from "../lib/routines/runner";
import { eq } from "drizzle-orm";

interface SeedSpec {
  id: string;
  name: string;
  workspaceId: string;
  triggerMode: "cron" | "event" | "manual";
  cronExpr: string | null;
  eventMatch: Record<string, unknown> | null;
  yaml: string;
}

// Absolute repo path at seed time. The seed runs via `pnpm tsx` from the
// repo root (process.cwd() == repo). The routine commands are deliberately
// cwd-independent (absolute node-helper path + `git -C`), so they run
// regardless of which directory the routine runner spawns into.
const REPO = process.cwd();

const SEEDS: SeedSpec[] = [
  // -------------------------------------------------------------------------
  // 1) morning-brief — every day 08:00 UTC (10:00 Berlin summer) a
  //    short overview of open tickets + deadlines via push.
  // -------------------------------------------------------------------------
  {
    id: "RTN-seed-morning-brief",
    name: "Morgen-Brief",
    workspaceId: "lazyos",
    triggerMode: "cron",
    cronExpr: "0 8 * * *",
    eventMatch: null,
    yaml: `
id: morning-brief
name: Morgen-Brief
workspace_id: lazyos
description: >
  Täglich 08:00 UTC — scannt offene Tickets, fällige Due-Dates und
  unpushed Commits aller Workspaces. Pusht eine Kurz-Übersicht an
  the owner's iPhone.

pipeline:
  - collect_context:
      commands:
        - node ${REPO}/scripts/routine-db.cjs open-tickets
        - git -C ${REPO} rev-list --count origin/main..HEAD 2>/dev/null || echo 0

  - synthesize_via: senior-dev
  - output_format: markdown
  - push:
      title: "Guten Morgen, Max"
      body: "{routine_name} · {first_line}"
      url: /tickets
      tag: morning-brief
  - delivery: push_send
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 2) deadline-watch — check every 15 min whether tickets are due within
  //    24h. Dedup within 12h per ticket → max 2 pushes per ticket until
  //    due.
  // -------------------------------------------------------------------------
  {
    id: "RTN-seed-deadline-watch",
    name: "Deadline-Watch",
    workspaceId: "lazyos",
    triggerMode: "cron",
    cronExpr: "*/15 * * * *",
    eventMatch: null,
    yaml: `
id: deadline-watch
name: Deadline-Watch
workspace_id: lazyos
description: >
  Viertelstündlich — listet Tickets mit Due-Date innerhalb der nächsten
  24h und pusht eine kompakte Erinnerung. Dedup 12h pro Ticket, damit
  Max nicht mit Wiederholungen bombardiert wird.

pipeline:
  - collect_context:
      commands:
        - node ${REPO}/scripts/routine-db.cjs due-soon

  - synthesize_via: senior-dev
  - output_format: markdown
  - dedup:
      key: deadline-watch-global
      within_hours: 12
  - push:
      title: "Deadline in Sichtweite"
      body: "{first_line}"
      url: /tickets
      tag: deadline-watch
  - delivery: push_send
`.trim(),
  },

  // -------------------------------------------------------------------------
  // 3) heartbeat-stall — event-triggered: reacts to
  //    heartbeat_swept events with status='stale' → asks for action.
  // -------------------------------------------------------------------------
  {
    id: "RTN-seed-heartbeat-stall",
    name: "Heartbeat-Stall-Alert",
    workspaceId: "lazyos",
    triggerMode: "event",
    cronExpr: null,
    eventMatch: {
      eventType: "heartbeat_swept",
      entityType: "workspace",
      payloadMatch: { status: "stale" },
    },
    yaml: `
id: heartbeat-stall
name: Heartbeat-Stall-Alert
workspace_id: lazyos
description: >
  Feuert wenn ein Workspace in den Zustand "stale" fällt (kein Puls seit
  Schwellwert). Schreibt ein decision_request-Event: Repo abgeschaltet
  oder Handlung nötig?

pipeline:
  - collect_context:
      commands:
        - echo "stale workspace detected — see decision payload"

  - synthesize_via: critic
  - output_format: markdown
  - dedup:
      key: heartbeat-stall-alert
      within_hours: 6
  - push:
      title: "Workspace schläft"
      body: "Repo abgeschaltet oder Handlung nötig?"
      url: /observatory
      tag: heartbeat-stall
  - delivery: decision_request
`.trim(),
  },
];

async function main(): Promise<void> {
  const db = getDb();
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;

  for (const seed of SEEDS) {
    // Uniqueness via stable seed IDs — hence idempotent.
    const existing = await db
      .select({ id: routines.id })
      .from(routines)
      .where(eq(routines.id, seed.id))
      .limit(1);

    if (existing.length > 0) {
      skipped += 1;
      process.stdout.write(`[seed] skip ${seed.id} (exists)\n`);
      continue;
    }

    // Validate the YAML before the insert — fails early if a seed is broken.
    try {
      validateYamlConfig(seed.yaml);
    } catch (err) {
      invalid += 1;
      process.stderr.write(
        `[seed] INVALID ${seed.id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    const next = seed.triggerMode === "cron" && seed.cronExpr
      ? nextRunAt(seed.cronExpr, now)
      : null;

    db.insert(routines)
      .values({
        id: seed.id,
        name: seed.name,
        workspaceId: seed.workspaceId,
        yamlConfig: seed.yaml,
        triggerMode: seed.triggerMode,
        cronExpr: seed.cronExpr,
        eventMatch: seed.eventMatch ? JSON.stringify(seed.eventMatch) : null,
        lastRunAt: null,
        nextRunAt: next,
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    inserted += 1;
    process.stdout.write(
      `[seed] + ${seed.id} (trigger=${seed.triggerMode}${seed.cronExpr ? ` "${seed.cronExpr}"` : ""})\n`,
    );
  }

  process.stdout.write(
    `\n[seed] done — inserted=${inserted} skipped=${skipped} invalid=${invalid}\n`,
  );
  process.exit(invalid > 0 ? 1 : 0);
}

// Auto-ID for unreferenced seeds only in case we ever need some without
// a stable ID — currently all fixed.
void ulid;

main().catch((err) => {
  process.stderr.write(
    `[seed] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
