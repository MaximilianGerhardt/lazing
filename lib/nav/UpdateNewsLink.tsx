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

export function UpdateNewsLink({ onClick }: { onClick?: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/system/version", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (alive && j) setInfo(j);
      })
      .catch(() => {
        /* offline / unavailable → just show the release-notes link */
      });
    return () => {
      alive = false;
    };
  }, []);

  const updateAvailable = info?.updateAvailable === true;

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
        {updateAvailable ? (
          <span
            aria-label="update available"
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
          ? `Update available${info?.latest ? ` (v${info.latest})` : ""} · run ./start`
          : info?.version
            ? `v${info.version} · release notes`
            : "Release notes"}
      </span>
    </Link>
  );
}
