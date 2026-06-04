"use client";

/**
 * WorkflowPipeline — 5-Step FSM-Visualisierung im Ticket-Detail.
 *
 * Steps: draft → review → approved → executed → closed
 * Alt-Pfad: rejected (ausgegraut-rot, wird nur gezeigt wenn state=rejected
 * oder irgendein Reject-Event in der Timeline war).
 *
 * Actions:
 *   - state=draft: "Freigabe anfordern" (request_approval)
 *   - state=review: "Freigeben" + "Ablehnen"
 *   - state=approved: "Ausführen" + "Ablehnen"
 *   - state=executed: "Schließen" + "Überarbeitung" (Rework → request_approval)
 *   - state=rejected: "Wieder öffnen" (reopen)
 *   - state=closed: keine Actions
 *
 * Design: Pitch-Black Canvas, 5 State-Pills im Grid, aktiver State mit
 * radialem Glow in --a-now (segment-abhängig) oder --a-clientb (grün)
 * für approved/executed/closed. Rejected bekommt --a-danger.
 *
 * Bewusst keine shadcn/ui — LazyOS hat eigene Component-IDs. Wir bauen
 * direkt mit CSS-Variablen-Tokens aus `app/globals.css`.
 */

import { useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import {
  PIPELINE_STATES,
  STATE_HINT,
  STATE_LABEL,
  type Transition,
  type WorkflowState,
} from "@/lib/approvals/fsm";

interface Props {
  ticketId: string;
  state: WorkflowState;
  /** Accent-Token-Name für die aktive Pille (ohne `var(--...)`-Wrap). */
  accentVar?: string;
}

const STATES = PIPELINE_STATES;

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
          return (
            <li
              key={s}
              style={stepStyle(isActive, isPast, accent)}
              aria-current={isActive ? "step" : undefined}
            >
              <span style={stepNumStyle(isActive, isPast, accent)}>
                {i + 1}
              </span>
              <span style={stepLabelStyle(isActive)}>{STATE_LABEL[s]}</span>
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

      <div style={actionRowStyle}>
        {actionsFor(state).map((a) => (
          <button
            key={a.transition}
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
// Styles — Inline weil wir keinen Global-CSS-Namespace für diese Komponente
// pflegen wollen. Tokens via CSS-Variablen.
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
): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "10px 6px",
    borderRadius: 10,
    background: active
      ? `radial-gradient(circle at center, color-mix(in srgb, ${accent} 22%, transparent) 0%, var(--card-2) 70%)`
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

export default WorkflowPipeline;
