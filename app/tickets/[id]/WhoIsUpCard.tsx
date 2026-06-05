"use client";

/**
 * WhoIsUpCard — "Wer ist dran?" handoff banner on the ticket detail.
 *
 * Makes the autonomous handoff legible: the FSM has agent↔human transitions
 * (`lib/approvals/fsm.ts`) and an auto-advance cron, but that only becomes
 * *valuable to a human* if the UI answers one question at a glance — do I need
 * to act, or is the swarm still working? This banner is that answer, plus a
 * one-tap jump straight to the action the operator should take.
 *
 * The derivation is pure (`lib/tickets/handoff.deriveTicketHandoff`) and runs
 * server-side; this client component only renders it + owns the smooth-scroll
 * jump to the matching `WorkflowPipeline` action anchor.
 *
 * Styling: inline CSSProperties + var() design tokens only (no globals.css).
 */

import { type CSSProperties } from "react";

import type { TicketHandoff } from "@/lib/tickets/handoff";

interface Props {
  handoff: TicketHandoff;
  /** Accent token name (without `var(--…)`), for the user-act emphasis. */
  accentVar?: string;
}

function jumpTo(anchor: string | null) {
  if (!anchor) return;
  const id = anchor.replace(/^#/, "");
  const el =
    typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!el) return;
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "center",
  });
  // Briefly focus so keyboard users land on the action too.
  if (el instanceof HTMLElement) {
    const prevTabIndex = el.getAttribute("tabindex");
    if (prevTabIndex === null) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }
}

export function WhoIsUpCard({ handoff, accentVar = "a-now" }: Props) {
  const { tone, line, responsible, answerRequired, actionAnchor, actionLabel } =
    handoff;

  // Tone → accent. "act" uses the user-attention warm token (consistent with
  // the user-actor accent --a-warn used in the thread), "wait" the segment
  // accent, "done" a muted ink.
  const accent =
    tone === "act"
      ? "var(--a-warn)"
      : tone === "wait"
        ? `var(--${accentVar})`
        : "var(--ink-3)";

  const isAct = tone === "act";

  return (
    <section
      aria-label="Wer ist dran"
      style={{
        ...cardStyle,
        background: isAct
          ? `color-mix(in oklab, ${accent} 9%, var(--card))`
          : "var(--card)",
        borderColor: isAct
          ? `color-mix(in oklab, ${accent} 42%, var(--line-2))`
          : "var(--line)",
      }}
    >
      <span
        aria-hidden
        style={{
          ...dotStyle,
          background: accent,
          boxShadow: isAct
            ? `0 0 0 4px color-mix(in oklab, ${accent} 18%, transparent)`
            : "none",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={eyebrowStyle}>
          {responsible === "user"
            ? "Du bist dran"
            : responsible === "agent"
              ? "Agent ist dran"
              : "Abgeschlossen"}
        </div>
        <div style={{ ...lineStyle, color: isAct ? "var(--ink)" : "var(--ink-2)" }}>
          {line}
        </div>
        {answerRequired ? (
          <p style={answerPreviewStyle}>{answerRequired.preview}</p>
        ) : null}
      </div>

      {actionAnchor && actionLabel ? (
        <button
          type="button"
          onClick={() => jumpTo(actionAnchor)}
          style={{
            ...ctaStyle,
            background: isAct ? "var(--ink)" : "var(--card-2)",
            color: isAct ? "var(--sheet)" : "var(--ink)",
            border: isAct ? "1px solid var(--ink)" : "1px solid var(--line-2)",
          }}
        >
          {actionLabel}
          <span aria-hidden style={{ marginLeft: 2 }}>
            ↓
          </span>
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 16px",
  borderRadius: 14,
  border: "1px solid var(--line)",
};

const dotStyle: CSSProperties = {
  flexShrink: 0,
  width: 10,
  height: 10,
  borderRadius: 999,
};

const eyebrowStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--ink-3)",
  marginBottom: 3,
};

const lineStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: "-0.01em",
  lineHeight: 1.3,
};

const answerPreviewStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--ink-2)",
};

const ctaStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "9px 16px",
  minHeight: 40,
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  letterSpacing: "-0.01em",
  transition: "background 120ms ease, border-color 120ms ease",
};

export default WhoIsUpCard;
