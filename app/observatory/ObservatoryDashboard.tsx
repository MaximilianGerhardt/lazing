"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { BRAND_NAME } from "@/lib/brand";
import { Engine } from "@/lib/ui/eng/Engine";
import { HeartbeatPulse } from "@/lib/ui/hbt/HeartbeatPulse";
import { Pipeline } from "@/lib/ui/pip/Pipeline";
import type { PipelineStepProps, StepStatus } from "@/lib/ui/pip/Step";

import { HeartbeatGrid } from "./HeartbeatGrid";

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  segments: Array<{ id: string; total: number; open: number }>;
  eventCount: number;
  pushSubscriptions: number;
  checks: {
    database: "ok" | "error";
    anthropicKey: "set" | "missing";
    vapidKey: "set" | "missing";
    authSecret: "set" | "missing";
    recentErrors: number;
    memoryUsage: { rss: number; heap: number };
  };
  version: { commit: string; deployedAt: string };
  uptime: number;
}

interface LazyEventLite {
  id: string;
  createdAt: number;
  segmentId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string;
  sensitivity: "low" | "medium" | "high";
}

const MAX_EVENTS = 20;
const HEALTH_REFRESH_MS = 5000;

function eventTypeToStepStatus(eventType: string): StepStatus {
  switch (eventType) {
    case "closed":
    case "approved":
    case "decision_made":
      return "done";
    case "error_logged":
    case "rejected":
      return "running"; // styled via stepStatus override below
    case "status_changed":
    case "assigned":
    case "fix_agent_triggered":
      return "running";
    default:
      return "waiting";
  }
}

function eventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "error_logged":
      return "err";
    case "decision_made":
      return "ok";
    case "status_changed":
      return "run";
    case "created":
      return "new";
    case "closed":
      return "ok";
    default:
      return eventType.slice(0, 4);
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("de-DE", { hour12: false });
}

export function ObservatoryDashboard(): React.JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [events, setEvents] = useState<LazyEventLite[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // ---- Health polling (every 5s) ----
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/health", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const json = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(json);
          setFetchError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    const id = setInterval(load, HEALTH_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- SSE event stream ----
  useEffect(() => {
    const es = new EventSource("/api/events/stream?limit=20", {
      withCredentials: true,
    });
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as LazyEventLite;
        setEvents((prev) => {
          const next = [ev, ...prev.filter((e) => e.id !== ev.id)];
          return next.slice(0, MAX_EVENTS);
        });
      } catch {
        // ignore malformed
      }
    };
    es.onerror = () => {
      // Browser auto-reconnects; we just note the state.
      setFetchError("SSE reconnect…");
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  const steps: PipelineStepProps[] = useMemo(
    () =>
      events.slice(0, MAX_EVENTS).map((ev, idx) => ({
        num: events.length - idx,
        title: `${ev.eventType} · ${ev.entityType}:${ev.entityId}`,
        subtitle: (
          <>
            {ev.segmentId} · {ev.actor}
            {" · "}
            <b>{fmtTime(ev.createdAt)}</b>
          </>
        ),
        status: eventTypeToStepStatus(ev.eventType),
        statusLabel: eventTypeLabel(ev.eventType),
      })),
    [events],
  );

  const segCount = health?.segments.length ?? 0;
  const serverStatus: "running" | "idle" =
    health?.status === "unhealthy" ? "idle" : "running";
  const serverStatusLabel =
    health?.status === "healthy"
      ? "healthy"
      : health?.status === "degraded"
        ? "degraded"
        : health?.status === "unhealthy"
          ? "unhealthy"
          : "loading…";

  return (
    <main
      style={{
        padding: "24px 20px 64px",
        maxWidth: 1040,
        margin: "0 auto",
        color: "var(--ink)",
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: -0.2,
          }}
        >
          Observatory
        </h1>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          Live-Status &middot; aktualisiert alle 5 Sekunden
        </p>
      </header>

      {fetchError ? (
        <p
          role="alert"
          style={{ fontSize: 12, color: "var(--a-north)", margin: "8px 0 16px" }}
        >
          {fetchError}
        </p>
      ) : null}

      {/* Top row: pulse + stats */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 24,
          alignItems: "center",
          marginBottom: 32,
        }}
      >
        <HeartbeatPulse
          count={segCount}
          label="SEGMENTE"
          ariaLabel={`${segCount} aktive Segmente`}
          size={96}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          <Stat
            label="Events total"
            value={health?.eventCount ?? "—"}
          />
          <Stat
            label="Push-Subs"
            value={health?.pushSubscriptions ?? "—"}
          />
          <Stat
            label="Recent errors (5m)"
            value={health?.checks.recentErrors ?? "—"}
            tone={
              (health?.checks.recentErrors ?? 0) > 5 ? "warn" : "neutral"
            }
          />
          <Stat
            label="Uptime"
            value={health ? formatUptime(health.uptime) : "—"}
          />
        </div>
      </section>

      {/* Workspace-Heartbeats — one card per discovered project */}
      <HeartbeatGrid />

      {/* Engine card for server */}
      <section style={{ marginBottom: 32 }}>
        <Engine
          type="local"
          name={`${BRAND_NAME} Server`}
          status={serverStatus}
          statusLabel={serverStatusLabel}
          meta={
            <>
              DB: <b>{health?.checks.database ?? "…"}</b> · RSS:{" "}
              <b>{health?.checks.memoryUsage.rss ?? "—"} MB</b> · Heap:{" "}
              <b>{health?.checks.memoryUsage.heap ?? "—"} MB</b>
              <br />
              Anthropic: <b>{health?.checks.anthropicKey ?? "…"}</b> · VAPID:{" "}
              <b>{health?.checks.vapidKey ?? "…"}</b> · Auth-Secret:{" "}
              <b>{health?.checks.authSecret ?? "…"}</b>
              <br />
              Commit: <b>{(health?.version.commit ?? "dev").slice(0, 7)}</b>
            </>
          }
        />
      </section>

      {/* Event stream as pipeline */}
      <section>
        <h2
          style={{
            fontSize: 11,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--ink-2)",
            margin: "0 0 12px",
          }}
        >
          Live-Events (letzte {MAX_EVENTS})
        </h2>
        {steps.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Warte auf Events…
          </p>
        ) : (
          <Pipeline steps={steps} ariaLabel="Live-Events" />
        )}
      </section>

      <LogoutButton />
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "warn";
}): React.JSX.Element {
  return (
    <div
      style={{
        padding: "12px 14px",
        border: "1px solid var(--line)",
        borderRadius: 12,
        background: "var(--card)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          marginTop: 2,
          color: tone === "warn" ? "var(--a-north)" : "var(--ink)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function LogoutButton(): React.JSX.Element {
  const [pending, setPending] = useState(false);
  return (
    <div style={{ marginTop: 48 }}>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await fetch("/api/auth/logout", {
              method: "POST",
              credentials: "same-origin",
            });
          } finally {
            window.location.href = "/login";
          }
        }}
        style={{
          padding: "8px 14px",
          fontSize: 12,
          color: "var(--ink-2)",
          background: "transparent",
          border: "1px solid var(--line-2)",
          borderRadius: 8,
          cursor: pending ? "progress" : "pointer",
        }}
      >
        {pending ? "…" : "Logout"}
      </button>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  return `${Math.floor(sec / 86400)}d`;
}
