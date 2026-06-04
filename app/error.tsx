"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Renders a compact error page
 * and forwards the error into the event log via /api/events/emit
 * (best-effort — if the emit fails we just render the UI).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch("/api/events/emit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmentId: "@system",
        entityType: "note",
        entityId: `route-error:${error.digest ?? Date.now()}`,
        eventType: "error_logged",
        actor: "system",
        payload: {
          context: "route/error.tsx",
          message: error.message,
          digest: error.digest,
          stack: error.stack,
        },
      }),
    }).catch(() => {
      /* best-effort */
    });
  }, [error]);

  return (
    <main
      style={{
        minHeight: "60vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          padding: "24px 24px",
          border: "1px solid var(--line)",
          borderRadius: 14,
          background: "var(--sheet-2)",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          Something went wrong.
        </h2>
        <p
          style={{
            margin: "6px 0 18px",
            fontSize: 13,
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          The error was written to the event log. You can reload the view — if it
          recurs, open the Observatory for details.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "8px 14px",
            fontSize: 13,
            color: "var(--screen)",
            background: "var(--primary)",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
