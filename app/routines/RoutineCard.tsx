"use client";

/**
 * RoutineCard — eine Zeile in der Routines-Liste.
 *
 * Zeigt:
 *   - Name + Workspace-Pill + Aktiv-Dot
 *   - Lesbaren Trigger-Text (Cron → "Jeden Tag um 08:00", *\/15 → "Alle 15 Minuten")
 *   - Letzter Run + Status, naechster Run (bei cron)
 *   - Delivery-Badge(s) (push / ticket / decision …) — abgeleitet aus YAML
 *   - Aktiv-Toggle (optimistisch) + "Jetzt triggern" + "Details"
 *
 * Zustands-Wechsel werden vom Parent orchestriert (List). Diese Komponente
 * ist praesentativ + dispatcht nur Intents.
 *
 * Design: LazyOS v1.0 — Tokens aus globals.css, keine Hex-Hardcodes.
 */

import { useMemo } from "react";

import type { RoutineSummary } from "./types";
import {
  formatRelativeGerman,
  humanizeTrigger,
} from "./schedule-humanize";

interface Props {
  routine: RoutineSummary;
  /** YAML-geparste Delivery-Badges aus der Routine (best-effort, kann leer sein). */
  deliveryBadges?: readonly string[];
  /** Optional: Ergebnis des letzten manuellen Triggers, inline angezeigt. */
  lastTriggerResult?: {
    status: string;
    deliveryRef?: string | null;
    error?: string | null;
  } | null;
  /** Ist gerade eine Aktion (Toggle/Trigger) fuer diese Routine in-flight? */
  busy?: boolean;
  onToggleActive: (routine: RoutineSummary) => void;
  onTriggerNow: (routine: RoutineSummary) => void;
  onOpenDetails: (routine: RoutineSummary) => void;
}

// ---------------------------------------------------------------------------
// Workspace-Pill Farb-Mapping (identisch zu bisheriger Convention).
// ---------------------------------------------------------------------------

function accentForWorkspace(id: string): string {
  if (id === "private") return "var(--a-private)";
  if (id === "demo-client" || id === "clientb") return "var(--a-clientb)";
  if (id === "tap" || id.startsWith("trusted-ai") || id === "north") {
    return "var(--a-north)";
  }
  return "var(--a-own)";
}

// Delivery-Badge → Kurz-Label + Farbe
const DELIVERY_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  push_send: {
    label: "Push",
    color: "var(--a-north)",
    bg: "rgba(255,159,10,0.12)",
  },
  decision_request: {
    label: "Entscheidung",
    color: "var(--a-warn)",
    bg: "rgba(255,214,10,0.14)",
  },
  ticket_create: {
    label: "Ticket",
    color: "var(--a-clientb)",
    bg: "rgba(48,209,88,0.12)",
  },
  memory_write: {
    label: "Memory",
    color: "var(--a-own)",
    bg: "rgba(191,90,242,0.12)",
  },
  stdout: {
    label: "Log",
    color: "var(--ink-3)",
    bg: "rgba(255,255,255,0.04)",
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoutineCard(props: Props) {
  const {
    routine,
    deliveryBadges,
    lastTriggerResult,
    busy = false,
    onToggleActive,
    onTriggerNow,
    onOpenDetails,
  } = props;

  const accent = accentForWorkspace(routine.workspaceId);

  const schedule = useMemo(
    () =>
      humanizeTrigger({
        triggerMode: routine.triggerMode,
        cronExpr: routine.cronExpr,
        eventMatch: routine.eventMatch,
      }),
    [routine.triggerMode, routine.cronExpr, routine.eventMatch],
  );

  const statusColor = routine.active
    ? "var(--term-ok)"
    : "var(--ink-3)";

  const badges = deliveryBadges ?? [];

  return (
    <article
      style={cardStyle}
      aria-label={`Routine ${routine.name}`}
    >
      <div style={mainColStyle}>
        {/* Titel-Zeile: Dot + Name + Workspace-Pill */}
        <div style={titleRowStyle}>
          <span
            aria-hidden
            title={routine.active ? "aktiv" : "inaktiv"}
            style={{
              ...statusDotStyle,
              background: statusColor,
              boxShadow: routine.active
                ? "0 0 0 4px rgba(48,209,88,0.14)"
                : "none",
            }}
          />
          <h3 style={titleStyle}>{routine.name}</h3>
          <span
            style={{
              ...workspacePillStyle,
              color: accent,
              borderColor: accent,
            }}
            title={`Workspace: ${routine.workspaceId}`}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: accent,
              }}
            />
            {routine.workspaceId}
          </span>
          {!routine.active && (
            <span style={inactiveTagStyle}>inaktiv</span>
          )}
        </div>

        {/* Trigger — lesbar, nicht raw cron */}
        <div style={triggerRowStyle}>
          <span aria-hidden style={triggerIconStyle}>
            {schedule.icon}
          </span>
          <span style={triggerLabelStyle}>{schedule.label}</span>
        </div>

        {/* Meta-Zeile: Letzter Run · Naechster Run · Delivery-Badges */}
        <div style={metaRowStyle}>
          <span style={metaItemStyle}>
            <span style={metaLabelStyle}>Zuletzt</span>
            <span style={metaValueStyle}>
              {formatRelativeGerman(routine.lastRunAt)}
              {lastTriggerResult && (
                <span
                  style={{
                    marginLeft: 6,
                    color:
                      lastTriggerResult.status === "success"
                        ? "var(--term-ok)"
                        : lastTriggerResult.status === "skipped"
                          ? "var(--ink-3)"
                          : "var(--term-err)",
                  }}
                >
                  ·{" "}
                  {lastTriggerResult.status === "success"
                    ? "Erfolg"
                    : lastTriggerResult.status === "skipped"
                      ? "uebersprungen"
                      : "Fehler"}
                </span>
              )}
            </span>
          </span>

          {routine.triggerMode === "cron" && routine.nextRunAt && (
            <span style={metaItemStyle}>
              <span style={metaLabelStyle}>Naechster</span>
              <span style={metaValueStyle}>
                {formatRelativeGerman(routine.nextRunAt)}
              </span>
            </span>
          )}

          {badges.length > 0 && (
            <span style={metaItemStyle}>
              <span style={metaLabelStyle}>Delivery</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {badges.map((b) => {
                  const meta = DELIVERY_META[b] ?? {
                    label: b,
                    color: "var(--ink-2)",
                    bg: "rgba(255,255,255,0.06)",
                  };
                  return (
                    <span
                      key={b}
                      style={{
                        ...deliveryPillStyle,
                        color: meta.color,
                        background: meta.bg,
                      }}
                    >
                      {meta.label}
                    </span>
                  );
                })}
              </span>
            </span>
          )}
        </div>

        {lastTriggerResult?.error && (
          <div style={errorBannerStyle} title={lastTriggerResult.error}>
            {lastTriggerResult.error.slice(0, 160)}
          </div>
        )}
      </div>

      <div style={actionColStyle}>
        {/* Toggle */}
        <label
          style={toggleWrapStyle}
          title={routine.active ? "Deaktivieren" : "Aktivieren"}
        >
          <input
            type="checkbox"
            checked={routine.active}
            disabled={busy}
            onChange={() => onToggleActive(routine)}
            style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
          />
          <span
            aria-hidden
            style={{
              ...toggleTrackStyle,
              background: routine.active
                ? "var(--term-ok)"
                : "var(--ink-4)",
            }}
          >
            <span
              style={{
                ...toggleThumbStyle,
                transform: routine.active
                  ? "translateX(18px)"
                  : "translateX(0)",
              }}
            />
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {routine.active ? "Aktiv" : "Aus"}
          </span>
        </label>

        <button
          type="button"
          onClick={() => onTriggerNow(routine)}
          disabled={busy}
          style={primaryBtnStyle}
        >
          {busy ? "laeuft …" : "Jetzt triggern"}
        </button>

        <button
          type="button"
          onClick={() => onOpenDetails(routine)}
          style={secondaryBtnStyle}
        >
          Details
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  padding: "18px 20px",
  borderRadius: 14,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  display: "flex",
  flexWrap: "wrap",
  gap: 20,
  alignItems: "flex-start",
  justifyContent: "space-between",
};

const mainColStyle: React.CSSProperties = {
  flex: "1 1 360px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const titleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const statusDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
  transition: "background 200ms ease, box-shadow 200ms ease",
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--ink)",
  letterSpacing: "-0.01em",
  margin: 0,
  fontFamily: "var(--font-sans)",
};

const workspacePillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 10px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "lowercase",
};

const inactiveTagStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  background: "var(--card-2)",
  color: "var(--ink-3)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const triggerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13.5,
  color: "var(--ink)",
};

const triggerIconStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
  color: "var(--ink-2)",
};

const triggerLabelStyle: React.CSSProperties = {
  color: "var(--ink)",
  letterSpacing: "-0.005em",
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 18,
  rowGap: 10,
  fontSize: 12,
  color: "var(--ink-2)",
};

const metaItemStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const metaLabelStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

const metaValueStyle: React.CSSProperties = {
  color: "var(--ink-2)",
};

const deliveryPillStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 6,
  fontSize: 10.5,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const errorBannerStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--term-err)",
  background: "rgba(255,69,58,0.08)",
  color: "var(--term-err)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
};

const actionColStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexShrink: 0,
  flexWrap: "wrap",
};

const toggleWrapStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  userSelect: "none",
};

const toggleTrackStyle: React.CSSProperties = {
  width: 38,
  height: 22,
  borderRadius: 999,
  padding: 2,
  transition: "background 180ms ease",
  position: "relative",
};

const toggleThumbStyle: React.CSSProperties = {
  display: "block",
  width: 18,
  height: 18,
  borderRadius: "50%",
  // Toggle-Thumb nutzt --ink (=#F5F5F7, Apple-Pure-White-Pendant) — UI-Primitive.
  // Stuft sich gegen den Dark-Track ab; bleibt unverändert bei Branding.
  background: "var(--ink)",
  transition: "transform 180ms cubic-bezier(0.4, 0, 0.2, 1)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
};

const primaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--primary)",
  background: "var(--primary)",
  color: "var(--sheet)",
  cursor: "pointer",
  transition:
    "opacity 120ms ease, transform 120ms ease, background 120ms ease",
};

const secondaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
};
