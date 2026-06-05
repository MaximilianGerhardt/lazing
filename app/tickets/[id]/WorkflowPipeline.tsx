"use client";

/**
 * WorkflowPipeline — 5-step FSM visualization in the ticket detail.
 *
 * Steps: draft → review → approved → executed → closed
 * Alt path: rejected (grayed-out red, only shown when state=rejected
 * or there was any reject event in the timeline).
 *
 * Actions:
 *   - state=draft: "Freigabe anfordern" (request_approval)
 *   - state=review: "Freigeben" + "Ablehnen"
 *   - state=approved: "Ausführen" + "Ablehnen"
 *   - state=executed: "Schließen" + "Überarbeitung" (rework → request_approval)
 *   - state=rejected: "Wieder öffnen" (reopen)
 *   - state=closed: no actions
 *
 * Design: pitch-black canvas, 5 state pills in a grid, the active state with
 * a radial glow in --a-now (segment-dependent) or --a-clientb (green)
 * for approved/executed/closed. Rejected gets --a-danger.
 *
 * Deliberately no shadcn/ui — LazyOS has its own component IDs. We build
 * directly with CSS-variable tokens from `app/globals.css`.
 */

import { useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import {
  PIPELINE_STATES,
  STATE_HINT,
  STATE_LABEL,
  transitionForEvent,
  nextState,
  DEFAULT_STATE,
  type Transition,
  type WorkflowState,
} from "@/lib/approvals/fsm";
import type { LazyEvent } from "@/lib/events/types";
import {
  classifyActor,
  type AnswerRequiredRef,
} from "@/lib/tickets/handoff";

interface Props {
  ticketId: string;
  state: WorkflowState;
  /** Accent token name for the active pill (without the `var(--...)` wrap). */
  accentVar?: string;
  /**
   * Ticket timeline (oldest-first) — used to label each pipeline step with the
   * actor that performed the transition INTO that step, so the agent↔human
   * handoff chain is legible at a glance.
   */
  events?: LazyEvent[];
  /** Open answer_required request (blocking question), surfaced as a one-tap CTA. */
  answerRequired?: AnswerRequiredRef | null;
}

const STATES = PIPELINE_STATES;

/** Coarse actor kind that landed the ticket in a given pipeline state. */
type StepActorKind = "user" | "agent" | "system";

/**
 * Walks the FSM event log (oldest-first) and records, per target state, the
 * actor of the LAST transition that entered it. Re-entries (rework cycle:
 * executed → review) overwrite, so the badge always reflects the latest hop.
 */
function stepActorsFromEvents(
  events: ReadonlyArray<LazyEvent>,
): Partial<Record<WorkflowState, StepActorKind>> {
  const out: Partial<Record<WorkflowState, StepActorKind>> = {};
  let cur: WorkflowState = DEFAULT_STATE;
  for (const ev of events) {
    const t = transitionForEvent(ev.eventType);
    if (!t) continue;
    const to = nextState(cur, t);
    if (!to) continue;
    const kind = classifyActor(ev.actor);
    if (kind === "agent") out[to] = "agent";
    else if (kind === "user") out[to] = "user";
    else if (kind === "system") out[to] = "system";
    cur = to;
  }
  return out;
}

const ACTOR_BADGE: Record<StepActorKind, { label: string; accent: string }> = {
  agent: { label: "Agent", accent: "var(--a-now)" },
  user: { label: "Du", accent: "var(--a-warn)" },
  system: { label: "Auto", accent: "var(--ink-3)" },
};

interface ActionDef {
  transition: Transition;
  label: string;
  tone: "primary" | "danger" | "neutral";
  confirm?: boolean;
}

function actionsFor(state: WorkflowState): ActionDef[] {
  switch (state) {
    case "draft":
      return [
        {
          transition: "request_approval",
          label: "Freigabe anfordern",
          tone: "primary",
        },
      ];
    case "review":
      return [
        { transition: "approve", label: "Freigeben", tone: "primary" },
        { transition: "reject", label: "Ablehnen", tone: "danger", confirm: true },
      ];
    case "approved":
      return [
        { transition: "execute", label: "Ausführen", tone: "primary" },
        { transition: "reject", label: "Ablehnen", tone: "danger", confirm: true },
      ];
    case "executed":
      return [
        { transition: "close", label: "Schließen", tone: "primary" },
        {
          transition: "request_approval",
          label: "Überarbeitung anfragen",
          tone: "neutral",
        },
      ];
    case "rejected":
      return [
        { transition: "reopen", label: "Wieder öffnen", tone: "primary" },
      ];
    case "closed":
      return [];
    default:
      return [];
  }
}

export function WorkflowPipeline({
  ticketId,
  state,
  accentVar = "a-clientb",
  events,
  answerRequired,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [commentMode, setCommentMode] = useState<Transition | null>(null);
  const [comment, setComment] = useState("");

  const isRejected = state === "rejected";
  const activeIdx = isRejected
    ? -1
    : STATES.indexOf(state as (typeof STATES)[number]);
  const isClosed = state === "closed";

  const stepActors = stepActorsFromEvents(events ?? []);

  async function runTransition(transition: Transition, withComment?: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/workflow`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transition,
            comment: withComment?.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          body.message ||
          body.error ||
          `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      setComment("");
      setCommentMode(null);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onActionClick(a: ActionDef) {
    if (a.confirm) {
      setCommentMode(a.transition);
      return;
    }
    void runTransition(a.transition);
  }

  const accent = `var(--${accentVar})`;
  // globals.css ships `--gradient-active` (radial in --a-now). For the default
  // segment accent we reuse that token (DRY); for other segment accents we keep
  // the SAME formula but substitute the dynamic accent so the per-step accent
  // stays segment-driven (hard requirement).
  const activeBg =
    accentVar === "a-now"
      ? "var(--gradient-active)"
      : `radial-gradient(circle at center, color-mix(in oklab, ${accent} 22%, transparent) 0%, var(--card-2) 70%)`;

  return (
    <section
      aria-label="Workflow-Pipeline"
      style={containerStyle}
    >
      <header style={headerStyle}>
        <span style={{ fontSize: 11, color: "var(--ink-2)", letterSpacing: 0.5, textTransform: "uppercase" }}>
          Workflow
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {STATE_HINT[state]}
        </span>
      </header>

      <ol style={pipelineStyle} aria-label="Workflow-Schritte">
        {STATES.map((s, i) => {
          const isActive = s === state;
          const isDone = !isRejected && i < activeIdx;
          const isPast = isClosed || isDone;
          const actorKind = stepActors[s];
          const badge = actorKind ? ACTOR_BADGE[actorKind] : null;
          return (
            <li
              key={s}
              style={stepStyle(isActive, isPast, accent, activeBg)}
              aria-current={isActive ? "step" : undefined}
            >
              <span style={stepNumStyle(isActive, isPast, accent)}>
                {i + 1}
              </span>
              <span style={stepLabelStyle(isActive)}>{STATE_LABEL[s]}</span>
              {badge ? (
                <span
                  style={actorBadgeStyle(badge.accent, isActive || isPast)}
                  title={`${badge.label} hat diesen Schritt ausgelöst`}
                >
                  <span aria-hidden style={{ ...badgeDotStyle, background: badge.accent }} />
                  {badge.label}
                </span>
              ) : (
                // Reserve height so steps stay aligned whether or not a step
                // has an actor badge yet (avoids vertical jitter).
                <span aria-hidden style={badgePlaceholderStyle} />
              )}
            </li>
          );
        })}
      </ol>

      {isRejected && (
        <div style={rejectedBannerStyle} role="status">
          <span style={{ color: "var(--a-danger)" }}>●</span>
          Dieses Ticket wurde abgelehnt. Wieder öffnen, um weiter zu arbeiten.
        </div>
      )}

      {commentMode && (
        <div style={commentBoxStyle}>
          <label
            style={{ fontSize: 12, color: "var(--ink-2)" }}
            htmlFor="wf-comment"
          >
            Kommentar (optional)
          </label>
          <textarea
            id="wf-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Warum wird abgelehnt?"
            rows={2}
            style={textareaStyle}
            maxLength={2000}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                setCommentMode(null);
                setComment("");
              }}
              style={btnStyle("neutral")}
              disabled={isPending}
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={() => {
                void runTransition(commentMode, comment);
              }}
              style={btnStyle("danger")}
              disabled={isPending}
            >
              Bestätigen
            </button>
          </div>
        </div>
      )}

      {answerRequired ? (
        <div id="wf-answer-required" style={answerRequiredStyle} role="status">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={answerRequiredEyebrowStyle}>Antwort gefragt</div>
            <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--ink)" }}>
              {answerRequired.preview}
            </p>
          </div>
          {answerRequired.url ? (
            <a href={answerRequired.url} style={answerRequiredCtaStyle}>
              Öffnen
            </a>
          ) : null}
        </div>
      ) : null}

      <div style={actionRowStyle}>
        {actionsFor(state).map((a) => (
          <button
            key={a.transition}
            id={`wf-${a.transition}`}
            type="button"
            onClick={() => onActionClick(a)}
            style={btnStyle(a.tone)}
            disabled={isPending || commentMode !== null}
          >
            {isPending ? "…" : a.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles — inline because we don't want to maintain a global CSS namespace for
// this component. Tokens via CSS variables.
// ---------------------------------------------------------------------------

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "18px 20px",
  borderRadius: 14,
  background: "var(--card)",
  border: "1px solid var(--line)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
};

const pipelineStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: 6,
};

function stepStyle(
  active: boolean,
  past: boolean,
  accent: string,
  activeBg: string,
): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 6,
    padding: "10px 6px",
    borderRadius: 10,
    background: active
      ? activeBg
      : past
        ? "var(--card-2)"
        : "transparent",
    border: active
      ? `1px solid color-mix(in srgb, ${accent} 50%, var(--line-2))`
      : "1px solid var(--line)",
    minWidth: 0,
  };
}

function stepNumStyle(
  active: boolean,
  past: boolean,
  accent: string,
): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: active ? "var(--sheet)" : past ? "var(--ink)" : "var(--ink-3)",
    background: active ? accent : past ? "var(--card-3)" : "transparent",
    border: past && !active ? "1px solid var(--line-2)" : "none",
  };
}

function stepLabelStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    color: active ? "var(--ink)" : "var(--ink-2)",
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  };
}

function actorBadgeStyle(accent: string, prominent: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    padding: "1px 6px",
    borderRadius: 999,
    fontSize: 9,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.04em",
    fontWeight: 600,
    color: accent,
    background: `color-mix(in oklab, ${accent} ${prominent ? 16 : 10}%, transparent)`,
    border: `0.5px solid color-mix(in oklab, ${accent} ${prominent ? 45 : 28}%, transparent)`,
    maxWidth: "100%",
    overflow: "hidden",
  };
}

const badgeDotStyle: CSSProperties = {
  width: 4,
  height: 4,
  borderRadius: 999,
  flexShrink: 0,
};

// Keeps the 5 steps vertically aligned even when some have no actor badge.
const badgePlaceholderStyle: CSSProperties = {
  display: "block",
  height: 13,
};

const rejectedBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--a-danger) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--a-danger) 30%, var(--line-2))",
  fontSize: 12,
  color: "var(--ink)",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

function btnStyle(tone: "primary" | "danger" | "neutral"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "8px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    transition: "background 120ms ease, border-color 120ms ease",
    border: "1px solid var(--line-2)",
  };
  if (tone === "primary") {
    return {
      ...base,
      background: "var(--ink)",
      color: "var(--sheet)",
      border: "1px solid var(--ink)",
    };
  }
  if (tone === "danger") {
    return {
      ...base,
      background: "transparent",
      color: "var(--a-danger)",
      border: "1px solid color-mix(in srgb, var(--a-danger) 50%, var(--line-2))",
    };
  }
  return {
    ...base,
    background: "var(--card)",
    color: "var(--ink)",
  };
}

const commentBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 10,
  background: "var(--card)",
  border: "1px solid var(--line-2)",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--sheet-2)",
  border: "1px solid var(--line)",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
  resize: "vertical",
};

const errorStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--a-danger) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--a-danger) 30%, var(--line-2))",
  color: "var(--ink)",
  fontSize: 12,
};

const answerRequiredStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 14px",
  borderRadius: 10,
  background: "color-mix(in oklab, var(--a-warn) 10%, transparent)",
  border: "1px solid color-mix(in oklab, var(--a-warn) 38%, var(--line-2))",
  // Anchored scroll/focus target from WhoIsUpCard — give it breathing room.
  scrollMarginTop: 80,
};

const answerRequiredEyebrowStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--a-warn)",
  fontWeight: 600,
};

const answerRequiredCtaStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 40,
  padding: "9px 16px",
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  color: "var(--sheet)",
  background: "var(--ink)",
  border: "1px solid var(--ink)",
};

export default WorkflowPipeline;
