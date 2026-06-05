"use client";

/**
 * Drawer footer item: "What's new" + an "Update available" signal.
 *
 * Consumes GET /api/system/version (version + best-effort updateAvailable) and
 * links the whats-new page. When a newer release exists upstream, it shows a
 * green dot + hint. The actual update is `./start` (or scripts/lazyos-update.sh)
 * — a one-click in-app self-update is a deliberate follow-up (it rebuilds +
 * restarts the server).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { IconHow } from "./icons";

interface VersionInfo {
  version?: string;
  updateAvailable?: boolean | null;
  latest?: string | null;
}

/** localStorage key: the app version whose what's-new the user has already seen. */
export const WHATS_NEW_SEEN_KEY = "lazyos:whatsnew:seen";

export function UpdateNewsLink({ onClick }: { onClick?: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [seen, setSeen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    try {
      setSeen(localStorage.getItem(WHATS_NEW_SEEN_KEY));
    } catch {
      /* localStorage unavailable */
    }
    void fetch("/api/system/version", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (alive && j) setInfo(j);
      })
      .catch(() => {
        /* offline / unavailable → just show the release-notes link */
      });
    // Refresh the seen-marker when the what's-new page writes it (same tab).
    const onSeen = (): void => {
      try {
        setSeen(localStorage.getItem(WHATS_NEW_SEEN_KEY));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("lazyos:whatsnew:seen", onSeen);
    return () => {
      alive = false;
      window.removeEventListener("lazyos:whatsnew:seen", onSeen);
    };
  }, []);

  const updateAvailable = info?.updateAvailable === true;
  // Unseen news = a shipped version whose notes the user hasn't opened yet.
  const unseenNews = Boolean(info?.version && info.version !== seen);
  const dot = updateAvailable || unseenNews;

  return (
    <Link
      href="/whats-new"
      className="topnav-drawer-tools-link"
      onClick={onClick}
      data-testid="drawer-tools-whatsnew"
    >
      <span className="topnav-drawer-tools-ico" aria-hidden="true">
        <IconHow size={18} />
      </span>
      <span className="topnav-drawer-tools-label">
        What&apos;s new
        {dot ? (
          <span
            aria-label={updateAvailable ? "update available" : "new since your last visit"}
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--a-now, #c9ff4d)",
              marginLeft: 7,
              verticalAlign: "middle",
            }}
          />
        ) : null}
      </span>
      <span className="topnav-drawer-tools-meta">
        {updateAvailable
          ? `Update available${info?.latest ? ` (v${info.latest})` : ""} · tap to update`
          : unseenNews
            ? `What's new in v${info?.version}`
            : info?.version
              ? `v${info.version} · release notes`
              : "Release notes"}
      </span>
    </Link>
  );
}
