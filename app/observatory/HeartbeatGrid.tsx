"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  accentVar,
  formatLag,
  formatTs,
  lagRatio,
  statusColor,
  statusLabel,
  type UiStatus,
} from "@/lib/heartbeat/ui";

// ---------------------------------------------------------------------------
// API shapes (mirror of /api/heartbeat/status)
// ---------------------------------------------------------------------------

interface ApiProbes {
  lastCommitTs: number | null;
  uncommittedChanges: number | null;
  unpushedCommits: number | null;
  outdatedDeps: number | null;
  hasPackageJson: boolean;
  hasVercel: boolean;
}

interface ApiWorkspaceCard {
  id: string;
  label: string;
  accent: string;
  path: string;
  ts: number | null;
  status: UiStatus;
  lagSec: number;
  probes: ApiProbes;
  reasons: string[];
}

interface ApiStatusResponse {
  ok: true;
  now: number;
  globals: {
    alive: number;
    stale: number;
    dormant: number;
    error: number;
    pending: number;
    total: number;
  };
  workspaces: ApiWorkspaceCard[];
}

const REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function useHeartbeatStatus(): {
  data: ApiStatusResponse | null;
  error: string | null;
  refresh: () => void;
  lastFetched: number | null;
} {
  const [data, setData] = useState<ApiStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/heartbeat/status", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiStatusResponse | { ok: false; error: string };
      if (!("ok" in json) || !json.ok) {
        const msg = (json as { error?: string }).error ?? "status_error";
        throw new Error(msg);
      }
      if (!cancelledRef.current) {
        setData(json);
        setError(null);
        setLastFetched(Date.now());
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    // Defer initial load to a microtask so the synchronous `setState` inside
    // `load()` does not run during the same commit as the effect body —
    // React 19's `set-state-in-effect` rule otherwise flags this as a
    // cascading render.
    const initial = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelledRef.current = true;
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [load]);

  return { data, error, refresh: () => void load(), lastFetched };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function HeartbeatGrid(): React.JSX.Element {
  const { data, error, refresh, lastFetched } = useHeartbeatStatus();

  const globals = data?.globals ?? {
    alive: 0,
    stale: 0,
    dormant: 0,
    error: 0,
    pending: 0,
    total: 0,
  };

  const sorted = useMemo(() => {
    const cards = data?.workspaces ?? [];
    // alive first, then stale, dormant, error, pending. Within a bucket,
    // most-recent commit first.
    const order: Record<UiStatus, number> = {
      alive: 0,
      stale: 1,
      dormant: 2,
      error: 3,
      pending: 4,
    };
    return [...cards].sort((a, b) => {
      const bucket = order[a.status] - order[b.status];
      if (bucket !== 0) return bucket;
      return (b.ts ?? 0) - (a.ts ?? 0);
    });
  }, [data]);

  return (
    <section style={{ marginBottom: 32 }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 11,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--ink-2)",
              margin: "0 0 4px",
            }}
          >
            Workspace-Heartbeats
          </h2>
          <GlobalSummary globals={globals} />
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            letterSpacing: 0.2,
          }}
        >
          {lastFetched ? (
            <>
              aktualisiert{" "}
              {new Date(lastFetched).toLocaleTimeString("de-DE", {
                hour12: false,
              })}
            </>
          ) : (
            "lade…"
          )}
          {" · "}
          <button
            type="button"
            onClick={refresh}
            style={{
              background: "transparent",
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              padding: "2px 8px",
              fontSize: 11,
              color: "var(--ink-2)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            refresh
          </button>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--a-danger)",
            margin: "0 0 16px",
          }}
        >
          {error}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <HeartbeatSkeleton
          lastFetched={lastFetched}
          hasInitialLoad={data !== null}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 16,
          }}
        >
          {sorted.map((card) => (
            <EngineCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Heartbeat Skeleton (empty state)
// ---------------------------------------------------------------------------

/**
 * Instead of a "no workspaces yet" text, shows three skeleton cards + a
 * readable hint that the engine is running. The countdown to the next
 * refresh (REFRESH_MS = 30s) helps Max gauge whether it is just waiting
 * or truly nothing is coming back.
 */
function HeartbeatSkeleton({
  lastFetched,
  hasInitialLoad,
}: {
  lastFetched: number | null;
  hasInitialLoad: boolean;
}): React.JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nextRefreshInSec = lastFetched
    ? Math.max(0, Math.ceil((lastFetched + REFRESH_MS - now) / 1000))
    : Math.ceil(REFRESH_MS / 1000);

  const message = hasInitialLoad
    ? `Heartbeat-Engine läuft alle 30s. Nächste Probe: in ${nextRefreshInSec}s.`
    : "Heartbeat-Engine startet — erste Probe läuft gerade.";

  const hint =
    "Workspaces erscheinen hier automatisch nach dem ersten Discovery-Run.";

  return (
    <div>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          margin: "0 0 6px",
          fontVariantNumeric: "tabular-nums",
        }}
        aria-live="polite"
      >
        {message}
      </p>
      <p
        style={{
          fontSize: 12,
          color: "var(--ink-3)",
          margin: "0 0 16px",
        }}
      >
        {hint} Manuell:{" "}
        <code style={{ color: "var(--ink-2)" }}>
          pnpm tsx scripts/discover-workspaces.ts
        </code>
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 16,
        }}
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <style jsx>{`
        @keyframes hbtShimmer {
          0% {
            background-position: -200% 0;
          }
          100% {
            background-position: 200% 0;
          }
        }
      `}</style>
    </div>
  );
}

function SkeletonCard(): React.JSX.Element {
  return (
    <article
      style={{
        position: "relative",
        padding: "14px 16px 16px 20px",
        borderRadius: "var(--radius-md)",
        background: "var(--card)",
        border: "0.5px dashed var(--line)",
        overflow: "hidden",
        minHeight: 160,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: "var(--line)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SkeletonBar width="60%" height={14} />
        <SkeletonBar width="40%" height={10} />
        <SkeletonBar width="100%" height={4} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "8px 14px",
            marginTop: 8,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <SkeletonBar width="60%" height={8} />
              <SkeletonBar width="45%" height={10} />
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function SkeletonBar({
  width,
  height,
}: {
  width: string | number;
  height: number;
}): React.JSX.Element {
  return (
    <span
      style={{
        display: "block",
        width,
        height,
        borderRadius: 3,
        background:
          "linear-gradient(90deg, var(--line) 0%, var(--line-2) 50%, var(--line) 100%)",
        backgroundSize: "200% 100%",
        animation: "hbtShimmer 1.8s ease-in-out infinite",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Global Summary
// ---------------------------------------------------------------------------

function GlobalSummary({
  globals,
}: {
  globals: ApiStatusResponse["globals"];
}): React.JSX.Element {
  const chips: Array<[UiStatus, number]> = [
    ["alive", globals.alive],
    ["stale", globals.stale],
    ["dormant", globals.dormant],
    ["error", globals.error],
  ];
  if (globals.pending > 0) chips.push(["pending", globals.pending]);

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--ink-3)" }}>
        {globals.total} Workspace{globals.total === 1 ? "" : "s"}
      </span>
      {chips.map(([status, count]) => (
        <span
          key={status}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: "var(--radius-pill)",
            background: "var(--card)",
            border: "1px solid var(--line)",
            color: count > 0 ? statusColor(status) : "var(--ink-3)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 11,
            letterSpacing: 0.3,
            textTransform: "uppercase",
          }}
        >
          <Dot status={status} />
          {statusLabel(status)} {count}
        </span>
      ))}
    </div>
  );
}

function Dot({ status }: { status: UiStatus }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: statusColor(status),
        boxShadow:
          status === "alive"
            ? `0 0 8px ${statusColor(status)}`
            : "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Engine Card (one per workspace)
// ---------------------------------------------------------------------------

function EngineCard({ card }: { card: ApiWorkspaceCard }): React.JSX.Element {
  const router = useRouter();
  const accent = accentVar(card.accent);
  const status = card.status;
  const color = statusColor(status);
  const alert = status === "dormant" || status === "error";
  const href = `/workspaces/${encodeURIComponent(card.id)}`;

  const handleClick = useCallback(() => {
    router.push(href);
  }, [router, href]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        router.push(href);
      }
    },
    [router, href],
  );

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`${card.label} — ${statusLabel(status)}, ${formatLag(card.lagSec)} — Workspace oeffnen`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        position: "relative",
        padding: "14px 16px 16px 20px",
        borderRadius: "var(--radius-md)",
        background: "var(--card)",
        border: "1px solid var(--line)",
        overflow: "hidden",
        cursor: "pointer",
        transition: "border-color 200ms ease, background 200ms ease",
        outline: "none",
      }}
      // Inline :focus-visible via data attribute is not possible with inline styles;
      // we use onFocus/onBlur to toggle a visible ring instead.
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow =
          "0 0 0 2px var(--primary)";
        (e.currentTarget as HTMLElement).style.borderColor = "var(--primary)";
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = "";
        (e.currentTarget as HTMLElement).style.borderColor = "var(--line)";
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--line-2)";
        (e.currentTarget as HTMLElement).style.background = "var(--card-2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--line)";
        (e.currentTarget as HTMLElement).style.background = "var(--card)";
      }}
    >
      {/* Status accent bar — communicates workspace colour + alert state */}
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: alert ? color : accent,
          boxShadow: alert ? `0 0 12px ${color}` : "none",
          animation: alert ? "hbtPulseGlow 1.8s ease-in-out infinite" : "none",
        }}
      >
        {/* Accessible status text for screen readers (replaces aria-hidden accent bar) */}
        <span
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          {statusLabel(status)}
        </span>
      </span>

      {/* Header: label + status pill */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: -0.1,
              color: "var(--ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {card.label}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={card.path}
          >
            {shortenPath(card.path)}
          </div>
        </div>
        <StatusPill status={status} />
      </header>

      {/* Wave bar — lag visualisation */}
      <WaveBar lagSec={card.lagSec} status={status} />

      {/* Probe grid */}
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px 14px",
          margin: "12px 0 0",
          fontSize: 11,
          color: "var(--ink-2)",
        }}
      >
        <Probe label="Last commit" value={formatTs(card.probes.lastCommitTs)} />
        <Probe label="Lag" value={formatLag(card.lagSec)} />
        <Probe
          label="Uncommitted"
          value={numOrDash(card.probes.uncommittedChanges)}
          tone={
            (card.probes.uncommittedChanges ?? 0) > 20 ? "warn" : "neutral"
          }
        />
        <Probe
          label="Unpushed"
          value={numOrDash(card.probes.unpushedCommits)}
          tone={(card.probes.unpushedCommits ?? 0) > 10 ? "warn" : "neutral"}
        />
        {card.probes.hasPackageJson ? (
          <Probe
            label="Outdated deps"
            value={numOrDash(card.probes.outdatedDeps)}
            tone={(card.probes.outdatedDeps ?? 0) > 0 ? "warn" : "neutral"}
          />
        ) : (
          <Probe label="Runtime" value="—" />
        )}
        <Probe
          label="Vercel"
          value={card.probes.hasVercel ? "linked" : "—"}
        />
      </dl>

      {/* Reasons — only shown when non-empty */}
      {card.reasons.length > 0 ? (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 10,
            color: alert ? color : "var(--ink-3)",
            letterSpacing: 0.3,
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
          title={card.reasons.join(" · ")}
        >
          {card.reasons.slice(0, 2).join(" · ")}
          {card.reasons.length > 2 ? ` · +${card.reasons.length - 2}` : ""}
        </p>
      ) : null}

      <style jsx>{`
        @keyframes hbtPulseGlow {
          0%,
          100% {
            opacity: 0.6;
            box-shadow: 0 0 10px ${color};
          }
          50% {
            opacity: 1;
            box-shadow: 0 0 20px ${color};
          }
        }
      `}</style>
    </article>
  );
}

function StatusPill({ status }: { status: UiStatus }): React.JSX.Element {
  const color = statusColor(status);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: "var(--radius-pill)",
        background: "var(--card-2)",
        border: `1px solid ${color}`,
        color,
        fontSize: 10,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        fontFamily: "var(--font-mono)",
        flexShrink: 0,
      }}
    >
      <Dot status={status} />
      {statusLabel(status)}
    </span>
  );
}

function Probe({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "warn";
}): React.JSX.Element {
  return (
    <div>
      <dt
        style={{
          fontSize: 9,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 2,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontSize: 12,
          color: tone === "warn" ? "var(--a-warn)" : "var(--ink)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function WaveBar({
  lagSec,
  status,
}: {
  lagSec: number;
  status: UiStatus;
}): React.JSX.Element {
  const ratio = lagRatio(lagSec);
  // Green (<24h), yellow (24h-7d), red (>7d). Pending/error — muted.
  const color =
    status === "pending"
      ? "var(--ink-3)"
      : status === "error"
        ? "var(--a-danger)"
        : ratio < 1 / 7
          ? "var(--a-clientb)"
          : ratio < 1
            ? "var(--a-warn)"
            : "var(--a-danger)";

  const width = `${Math.max(4, Math.round((1 - ratio) * 100))}%`;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: "100%",
        height: 4,
        background: "var(--line)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width,
          background: color,
          transition: "width 400ms ease, background 400ms ease",
        }}
      />
    </div>
  );
}

function numOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("de-DE");
}

function shortenPath(p: string): string {
  if (!p) return "—";
  // Display helper: collapse the (host-specific) projects root to `./`. The
  // optional NEXT_PUBLIC_LAZYOS_PROJECTS_ROOT lets self-hosters set their
  // exact root; otherwise we generically collapse any `.../projects/` prefix.
  const publicRoot = process.env.NEXT_PUBLIC_LAZYOS_PROJECTS_ROOT;
  if (publicRoot) {
    const prefix = publicRoot.replace(/\/+$/, "") + "/";
    if (p.startsWith(prefix)) return "./" + p.slice(prefix.length);
  }
  return p.replace(/^.*\/projects\//, "./");
}
