/**
 * /lab pattern-archetype card (MVP, 2026-05-01).
 *
 * A card on the landing page: shows one of the three archetypes
 * (Coding/Planning/Bug-Fix) with workspace accent, real-use count and
 * click-through to the primary kind.
 *
 * Server component — no interactivity other than the link.
 */

import Link from "next/link";

import type { ArchetypeMeta } from "../_lib/kinds-catalog";

export interface PatternArchetypeProps {
  archetype: ArchetypeMeta;
  /** Number of real-use events in the last 30d for the subline. */
  realUseCount: number;
  accent: string | null;
}

export function PatternArchetype({
  archetype,
  realUseCount,
  accent,
}: PatternArchetypeProps): React.JSX.Element {
  const accentColor = accent ?? "rgba(255,255,255,0.5)";

  return (
    <Link
      href={`/lab/${archetype.primaryKindId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: "var(--radius-lg)",
        textDecoration: "none",
        color: "inherit",
        fontFamily: "var(--font-display)",
        transition: "border-color 200ms ease, transform 200ms ease",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-muted, #999)",
          }}
        >
          {archetype.label}
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1.2,
            color: "var(--fg, #fff)",
          }}
        >
          {archetype.primaryWorkspaceLabel}
        </span>
      </div>

      <p
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--fg-muted, #B0B0B0)",
          margin: 0,
        }}
      >
        {archetype.description}
      </p>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginTop: "auto",
          paddingTop: 12,
          borderTop: "1px solid var(--line)",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--fg-muted, #999)" }}>
          {realUseCount} Real-Use-Events
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: accentColor,
          }}
        >
          Öffnen →
        </span>
      </div>
    </Link>
  );
}
