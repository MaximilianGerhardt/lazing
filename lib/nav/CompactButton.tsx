'use client';

/**
 * Phase CTX — compact button in the TopNav.
 *
 * Click → POST /api/ctx/compact-snapshot with the current workspace →
 * the snapshot block lands at the top of the plan file. A toast confirms with a summary.
 *
 * The actual `/compact` command must be run by the user in terminal Claude
 * — we only deliver the fresh state so the compact does not
 * lose continuity.
 */

import { useState, useTransition, type CSSProperties } from "react";

import { useCurrentWorkspace } from "@/lib/nav/hooks";

export function CompactButton(): React.JSX.Element {
  const currentWorkspace = useCurrentWorkspace();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);

  const trigger = (): void => {
    if (!currentWorkspace?.id) return;
    setToast(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/ctx/compact-snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ workspaceId: currentWorkspace.id }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            hint?: string;
          };
          setToast(`Fehler: ${j.hint ?? `HTTP ${res.status}`}`);
          window.setTimeout(() => setToast(null), 3500);
          return;
        }
        const j = (await res.json()) as { summary?: string; planPath?: string };
        setToast(`Snapshot in ${j.planPath ?? "plan-file"} geschrieben.`);
        window.setTimeout(() => setToast(null), 4500);
      } catch (err) {
        setToast(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
        window.setTimeout(() => setToast(null), 3500);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={trigger}
        disabled={pending || !currentWorkspace?.id}
        className="topnav-gear topnav-compact"
        aria-label={`Snapshot vor Compact · ${currentWorkspace?.label ?? ""}`}
        title={`Snapshot vor Compact · schreibt aktuellen Stand ins Plan-File · Workspace ${currentWorkspace?.label ?? ""}`}
        style={{ opacity: pending ? 0.6 : 1 }}
      >
        <svg
          width="18"
          height="18"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M21 8v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
          <polyline points="17 12 12 7 7 12" />
          <line x1="12" y1="7" x2="12" y2="20" />
        </svg>
      </button>
      {toast ? (
        <div role="status" style={toastStyle}>
          {toast}
        </div>
      ) : null}
    </>
  );
}

const toastStyle: CSSProperties = {
  position: "fixed",
  top: 56,
  right: 12,
  maxWidth: "min(380px, calc(100vw - 24px))",
  padding: "10px 14px",
  borderRadius: 10,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 92%, transparent)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.04em",
  color: "var(--ink)",
  zIndex: 1000,
  boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
};
