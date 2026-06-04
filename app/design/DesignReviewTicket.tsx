"use client";

import { useState } from "react";
import { TicketSurface, type TicketReviewFeedback } from "@/lib/ui/tck";

interface ApiResult {
  eventId?: string;
  triggered?: boolean;
  error?: string;
}

export function DesignReviewTicket() {
  const [submitted, setSubmitted] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [apiResult, setApiResult] = useState<ApiResult | null>(null);

  async function handleFeedback(feedback: TicketReviewFeedback) {
    setLastAction(feedback.quickAction ?? "none");
    const ticketId = "TCK-PHASE-1";
    const submittedAt = Date.now();
    const requestBody = { ticketId, ...feedback };

    let result: ApiResult = {};
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const json = (await res.json().catch(() => ({}))) as ApiResult;
      result = res.ok ? json : { error: json.error ?? `HTTP ${res.status}` };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "network error" };
    }

    setApiResult(result);

    // Local copy of the last feedback event — useful for debugging
    // and as a fallback when the API does not respond.
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "lazyos.last-feedback",
          JSON.stringify({
            ticketId,
            quickAction: feedback.quickAction ?? null,
            text: feedback.text ?? null,
            checkedItems: feedback.checkedItems ?? [],
            submittedAt,
            eventId: result.eventId ?? null,
            triggered: result.triggered ?? false,
            error: result.error ?? null,
          }),
        );
      }
    } catch {
      // localStorage can throw in private mode — do not block
    }

    setSubmitted(true);
  }

  if (submitted) {
    const ok = !apiResult?.error;
    return (
      <div
        role="status"
        style={{
          padding: "20px 24px",
          borderRadius: 14,
          background: ok
            ? "color-mix(in oklab, var(--a-clientb) 10%, transparent)"
            : "color-mix(in oklab, var(--a-danger) 12%, transparent)",
          border: ok
            ? "0.5px solid color-mix(in oklab, var(--a-clientb) 28%, transparent)"
            : "0.5px solid color-mix(in oklab, var(--a-danger) 36%, transparent)",
          color: "var(--ink)",
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        <div
          style={{
            color: ok ? "var(--a-clientb)" : "var(--a-danger)",
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          {ok ? "Feedback angekommen." : "Feedback lokal gesichert."}
        </div>
        <div style={{ color: "var(--ink-2)", fontSize: 13 }}>
          Action: <b style={{ color: "var(--ink)" }}>{lastAction ?? "none"}</b>
          {apiResult?.eventId ? (
            <>
              {" · "}Event: <code style={{ color: "var(--ink)" }}>{apiResult.eventId}</code>
            </>
          ) : null}
          {apiResult?.triggered ? (
            <>
              {" · "}
              <b style={{ color: "var(--a-clientb)" }}>Fix-Agent getriggert</b>
              {" (Phase 5 spawnt den echten Claude-Agent)"}
            </>
          ) : null}
          {apiResult?.error ? (
            <>
              {" · "}Fehler: <code style={{ color: "var(--a-danger)" }}>{apiResult.error}</code>
            </>
          ) : null}
          {" · "}lokal unter{" "}
          <code style={{ color: "var(--ink)" }}>lazyos.last-feedback</code>.
        </div>
      </div>
    );
  }

  return (
    <TicketSurface
      id="TCK-PHASE-1"
      status="open"
      prio="REVIEW"
      title="Phase 1 · Component-Library · Sichtprüfung"
      body="Alle 16 LazyOS-Kategorien rendern auf dieser Seite. Bitte prüf die Punkte unten oder klick direkt Ok/Anpassen/Verwerfen."
      segment="lazyOS · Eigene"
      assignee="senior-dev (×10)"
      due="jetzt"
      reviewChecklist={[
        { id: "c1", label: "Canvas atmet", detail: "Drei radiale Glows (orange/violett/grün) + Grain sichtbar, fix beim Scrollen." },
        { id: "c2", label: "Typografie SF Pro", detail: "Display-Headlines in SF Pro Display, nicht Inter-Fallback." },
        { id: "c3", label: "Pills + Accent-Dot", detail: "Alle 7 Pill-Varianten inkl. Glow-Dot links." },
        { id: "c4", label: "Decision-Card Recommended", detail: "Recommended-Option orange hervorgehoben, Counter nur wo real." },
        { id: "c5", label: "Ticket Left-Bar-Glow", detail: "Orange (P1), Grün (Done), Rot (Eskal), Grau (Wait)." },
        { id: "c6", label: "Terminal + Engine", detail: "Shell-Farben, Wave-Bars bei Claude/Codex-Engines." },
        { id: "c7", label: "Heartbeat pulsiert", detail: "Violett-Core + 2 Ripple-Wellen, kein Flackern." },
        { id: "c8", label: "PWA installierbar", detail: "Auf iPhone: Safari → Teilen → Home-Bildschirm → Push aktivieren." },
      ]}
      testTargetUrl="/"
      testTargetLabel="Zurück zur Startseite (Push aktivieren)"
      onFeedbackSubmit={handleFeedback}
    />
  );
}
