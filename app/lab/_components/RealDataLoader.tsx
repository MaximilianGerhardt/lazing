/**
 * /lab real-data loader (MVP, 2026-05-01).
 *
 * Server component: loads redacted real events from the DB and renders
 * them as a list. The foundation MVP shows a JSON-pretty render — refactor
 * wave 3 mounts the real <SurfaceRenderer> here.
 *
 * Privacy: loadRealEvents already filters sensitivity='high' in the SQL +
 * runs every payload string through redactPii. Nothing is passed on here
 * that has not gone through the 4 defense layers.
 */

import { loadRealEvents, type RealEvent } from "../_lib/load-real-events";

export interface RealDataLoaderProps {
  kind: string;
  workspaceId?: string;
  limit?: number;
}

export function RealDataLoader({
  kind,
  workspaceId,
  limit = 5,
}: RealDataLoaderProps): React.JSX.Element {
  const events = loadRealEvents(kind, { workspaceId, limit });

  if (events.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          background: "var(--sheet-2)",
          border: "1px dashed var(--line)",
          borderRadius: "var(--radius-lg)",
          fontFamily: "var(--font-display)",
          color: "var(--fg-muted, #999)",
          textAlign: "center",
        }}
      >
        Keine Real-Use-Events für <code style={{ color: "var(--fg, #fff)" }}>{kind}</code>
        {workspaceId ? <> im Workspace <code>{workspaceId}</code></> : null}.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 12,
          color: "var(--fg-muted, #999)",
        }}
      >
        {events.length} Event{events.length === 1 ? "" : "s"} (redacted, sensitivity=low)
      </div>
      {events.map((ev) => (
        <RealEventCard key={ev.id} event={ev} />
      ))}
    </div>
  );
}

function RealEventCard({ event }: { event: RealEvent }): React.JSX.Element {
  const accent = event.workspaceAccent ?? "rgba(255,255,255,0.3)";
  const dt = new Date(event.createdAt).toISOString().replace("T", " ").slice(0, 16);

  return (
    <article
      style={{
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderLeft: `3px solid ${accent}`,
        borderRadius: "var(--radius-lg)",
        padding: 20,
        fontFamily: "var(--font-display)",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg, #fff)" }}>
            {event.workspaceLabel}
          </span>
          {event.ticketId ? (
            <span style={{ fontSize: 11, color: "var(--fg-muted, #999)" }}>
              Ticket {event.ticketId}
            </span>
          ) : null}
        </div>
        <span style={{ fontSize: 11, color: "var(--fg-muted, #999)", fontFamily: "monospace" }}>
          {dt}
        </span>
      </header>

      <pre
        style={{
          margin: 0,
          padding: 12,
          background: "var(--sheet-3)",
          borderRadius: 8,
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--fg-muted, #C0C0C0)",
          overflowX: "auto",
          maxHeight: 200,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </article>
  );
}
