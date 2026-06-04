"use client";

import { useEffect } from "react";

/**
 * Root error boundary — renders its own <html>/<body> since this
 * boundary replaces the root layout on catastrophic errors.
 *
 * EXCEPTION to the Cons.3 hex-hardcode ban: this component renders
 * WITHOUT app/globals.css (the root layout failed). CSS variables are
 * not defined here. Hardcoded hex = failsafe. Do NOT switch to CSS
 * vars — otherwise the user sees an unstyled FOUC or a blank white
 * screen on catastrophic errors.
 */
export default function GlobalError({
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
        entityId: `global-error:${error.digest ?? Date.now()}`,
        eventType: "error_logged",
        actor: "system",
        payload: {
          context: "app/global-error.tsx",
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#070707",
          color: "#F5F5F7",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 420,
              padding: "28px 28px",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 14,
              background: "#0E0E0F",
            }}
          >
            <h1
              style={{
                margin: 0,
                marginBottom: 6,
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              laz.ing
            </h1>
            <p
              style={{
                margin: 0,
                marginBottom: 18,
                fontSize: 13,
                color: "#A1A1A6",
                lineHeight: 1.5,
              }}
            >
              An unexpected error occurred. The error was logged. Reloading may
              help.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                color: "#000",
                background: "#FAFAFA",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
