/**
 * /lab Landing-Page (MVP, 2026-05-01).
 *
 * Drei Pattern-Archetypen-Cards mit echten Workspace-Bezügen +
 * Real-Use-Counts der letzten 30 Tage. Workspace-Filter (Dropdown)
 * oben rechts ändert die Counts.
 *
 * Auth ist im Layout abgehandelt — dieser Page läuft nur für
 * admin/founder.
 */

import { getDb } from "@/db/client";

import { PatternArchetype } from "./_components/PatternArchetype";
import { WorkspaceFilter } from "./_components/WorkspaceFilter";
import { ARCHETYPES, MVP_KINDS } from "./_lib/kinds-catalog";

export const dynamic = "force-dynamic";

interface CountRow {
  c: number;
}

interface AccentRow {
  accent: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function countRealUseEvents(
  archetypeId: string,
  workspaceFilter: string | null,
): number {
  const kindsForArchetype = MVP_KINDS.filter((k) => k.archetype === archetypeId).map(
    (k) => k.id,
  );
  if (kindsForArchetype.length === 0) return 0;

  const cutoff = Date.now() - 30 * DAY_MS;
  const placeholders = kindsForArchetype.map(() => "?").join(",");

  const db = getDb();
  const sql = `
    SELECT COUNT(*) AS c
      FROM events e
      LEFT JOIN workspaces w ON w.id = e.segment_id
     WHERE e.event_type = 'chat_message_completed'
       AND e.created_at >= ?
       AND json_extract(e.payload, '$.kind') IN (${placeholders})
       AND (w.sensitivity IS NULL OR w.sensitivity != 'high')
       AND (? IS NULL OR e.segment_id = ?)
  `;

  const row = db.$raw
    .prepare<unknown[], CountRow>(sql)
    .get(cutoff, ...kindsForArchetype, workspaceFilter, workspaceFilter);
  return row?.c ?? 0;
}

function getWorkspaceAccent(workspaceId: string): string | null {
  const db = getDb();
  const row = db.$raw
    .prepare<unknown[], AccentRow>(
      `SELECT accent FROM workspaces WHERE id = ? LIMIT 1`,
    )
    .get(workspaceId);
  return row?.accent ?? null;
}

interface LabPageProps {
  searchParams: Promise<{ workspace?: string }>;
}

export default async function LabPage({
  searchParams,
}: LabPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const selectedWorkspace = params.workspace ?? "";
  const workspaceFilter = selectedWorkspace === "" ? null : selectedWorkspace;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 24,
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 36,
              fontWeight: 600,
              margin: 0,
              letterSpacing: "-0.02em",
              color: "var(--fg, #fff)",
            }}
          >
            Surface-Showcase
          </h1>
          <p
            style={{
              fontSize: 16,
              color: "var(--fg-muted, #999)",
              marginTop: 8,
              marginBottom: 0,
              maxWidth: 640,
              lineHeight: 1.5,
            }}
          >
            Drei Pattern-Archetypen aus Production-Workspaces. Klick auf eine
            Card öffnet die Detail-Ansicht mit Live-Vergleich, Real-Use-Events
            und Token-Audit.
          </p>
        </div>
        <WorkspaceFilter selected={selectedWorkspace} />
      </header>

      <section
        aria-label="Pattern-Archetypen"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 20,
        }}
      >
        {ARCHETYPES.map((archetype) => {
          const count = countRealUseEvents(archetype.id, workspaceFilter);
          const accent = getWorkspaceAccent(archetype.primaryWorkspace);
          return (
            <PatternArchetype
              key={archetype.id}
              archetype={archetype}
              realUseCount={count}
              accent={accent}
            />
          );
        })}
      </section>
    </div>
  );
}
