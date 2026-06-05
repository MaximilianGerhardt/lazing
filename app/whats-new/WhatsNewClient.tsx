"use client";

/**
 * Top of the /whats-new page: shows the installed version, and — when a newer
 * GitHub release exists — a one-click "Update now" button (POST
 * /api/system/update, localhost only). Visiting this page marks the current
 * version as "seen", which clears the "new" dot on the nav item.
 */

import { useCallback, useEffect, useState } from "react";

import { WHATS_NEW_SEEN_KEY } from "@/lib/nav/UpdateNewsLink";

interface VersionInfo {
  version?: string;
  latest?: string | null;
  updateAvailable?: boolean | null;
}

export function WhatsNewClient(): React.JSX.Element {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [state, setState] = useState<"idle" | "updating" | "started" | "error" | "local-only">(
    "idle",
  );

  useEffect(() => {
    let alive = true;
    void fetch("/api/system/version", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (!alive || !j) return;
        setInfo(j);
        // Mark this version's notes as seen → clears the nav dot.
        if (j.version) {
          try {
            localStorage.setItem(WHATS_NEW_SEEN_KEY, j.version);
            window.dispatchEvent(new Event("lazyos:whatsnew:seen"));
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (): Promise<void> => {
    setState("updating");
    try {
      const res = await fetch("/api/system/update", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 403) {
        setState("local-only");
        return;
      }
      const j = (await res.json().catch(() => null)) as { started?: boolean } | null;
      setState(j?.started ? "started" : "error");
    } catch {
      setState("error");
    }
  }, []);

  if (!info) return <></>;

  const updateAvailable = info.updateAvailable === true;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 14px",
        margin: "0 0 20px",
        borderRadius: 10,
        border: "0.5px solid color-mix(in oklab, var(--ink, #f5f5f5) 12%, transparent)",
        background: "color-mix(in oklab, #ffffff 2%, transparent)",
        fontSize: 13,
      }}
      data-test="whatsnew-version"
    >
      <span style={{ opacity: 0.8 }}>
        Installed: <strong>v{info.version}</strong>
        {info.latest ? <span style={{ opacity: 0.6 }}> · latest v{info.latest}</span> : null}
      </span>

      {updateAvailable ? (
        state === "started" ? (
          <span style={{ color: "var(--a-now, #c9ff4d)" }}>
            Updating in the background — the app will rebuild &amp; restart.
          </span>
        ) : state === "local-only" ? (
          <span style={{ opacity: 0.8 }}>
            Run <code>scripts/lazyos-update.sh</code> on the host (update is
            local-machine only).
          </span>
        ) : state === "error" ? (
          <span style={{ opacity: 0.8 }}>
            Couldn&apos;t start the update — run <code>./start</code> or{" "}
            <code>scripts/lazyos-update.sh</code>.
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void update()}
            disabled={state === "updating"}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              color: "#070707",
              background:
                "linear-gradient(135deg, var(--a-now, #c9ff4d) 0%, color-mix(in oklab, var(--a-now, #c9ff4d) 70%, #6effe0) 100%)",
            }}
            data-test="whatsnew-update-now"
          >
            {state === "updating" ? "Starting…" : "Update now"}
          </button>
        )
      ) : (
        <span style={{ opacity: 0.6 }}>You&apos;re up to date.</span>
      )}
    </div>
  );
}
