"use client";

/**
 * RoutinesList — Top-Level Client-Komponente fuer /routines.
 *
 * Orchestriert:
 *   - Filter-Leiste (Status-Tabs + Workspace-Filter)
 *   - Header mit "+ Neue Routine"-Button
 *   - Liste von RoutineCards
 *   - Details-Panel (Slideout rechts)
 *   - New-Routine-Wizard (Modal zentriert)
 *
 * Per-Routine-State (toggle-busy, trigger-busy, last-trigger-result) lebt
 * hier — nicht in den Karten — damit bei Re-Renders keine Props-Drift passiert.
 *
 * Workspace-Kontext: Default-Filter ist der aktuell aktive Workspace (via
 * `useCurrentWorkspace`). User kann auf "Alle Workspaces" wechseln.
 *
 * Design: LazyOS v1.0 — Tokens aus globals.css.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useCurrentWorkspace, useWorkspaces } from "@/lib/nav/hooks";
import { useToast } from "@/lib/ui/tst/useToast";

import { NewRoutineWizard } from "./NewRoutineWizard";
import { OPEN_WIZARD_EVENT } from "./RoutinesHeader";
import { RoutineCard } from "./RoutineCard";
import { RoutineDetailsPanel } from "./RoutineDetailsPanel";
import type { RoutineSummary } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  initial: RoutineSummary[];
}

type StatusFilter = "all" | "active" | "inactive" | "event-only";
const ALL_WORKSPACES = "__all__";

interface TriggerResult {
  status: string;
  output?: string;
  deliveryRef?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoutinesList({ initial }: Props) {
  const currentWorkspace = useCurrentWorkspace();
  const { workspaces: allWorkspaces } = useWorkspaces();
  const toast = useToast();

  const [list, setList] = useState<RoutineSummary[]>(initial);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Default: aktueller Workspace, aber mit "Alle" als Option.
  const [workspaceFilter, setWorkspaceFilter] = useState<string>(
    currentWorkspace.id,
  );

  // Keep workspace filter in sync when user wechselt global den Workspace.
  // Nur wenn der User noch nicht explizit "Alle" oder einen anderen Filter
  // gesetzt hat — wir pruefen das, indem wir ein letztes bekanntes Current
  // merken.
  const [lastSyncedWorkspace, setLastSyncedWorkspace] = useState(
    currentWorkspace.id,
  );
  useEffect(() => {
    if (currentWorkspace.id !== lastSyncedWorkspace) {
      // Wenn User auf seinem alten Workspace-Filter war, folge.
      if (workspaceFilter === lastSyncedWorkspace) {
        setWorkspaceFilter(currentWorkspace.id);
      }
      setLastSyncedWorkspace(currentWorkspace.id);
    }
  }, [currentWorkspace.id, lastSyncedWorkspace, workspaceFilter]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Bumped each time the wizard opens so React remounts the component
  // and resets its internal step/form state — avoids setState-in-effect.
  const [wizardKey, setWizardKey] = useState(0);

  // Header lives in a separate component — it dispatches a custom event
  // when the user clicks "+ Neue Routine". We listen here so the wizard
  // state can live co-located with the rest of the list orchestration.
  useEffect(() => {
    const open = () => {
      setWizardKey((k) => k + 1);
      setWizardOpen(true);
    };
    window.addEventListener(OPEN_WIZARD_EVENT, open);
    return () => window.removeEventListener(OPEN_WIZARD_EVENT, open);
  }, []);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [triggerResults, setTriggerResults] = useState<
    Map<string, TriggerResult>
  >(new Map());

  // --------- Workspace-Dropdown-Options ---------
  // Basis: aus der Nav-API (live-discovered). Wir zeigen nur Workspaces, in
  // denen Routinen existieren, plus den aktuellen (falls leer) plus "Alle".
  const workspaceOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ id: string; label: string }> = [
      { id: ALL_WORKSPACES, label: "Alle Workspaces" },
    ];
    // Workspaces mit Routinen.
    const routineWorkspaces = new Set(list.map((r) => r.workspaceId));
    for (const ws of allWorkspaces) {
      if (routineWorkspaces.has(ws.id) || ws.id === currentWorkspace.id) {
        if (!seen.has(ws.id)) {
          options.push({ id: ws.id, label: ws.label });
          seen.add(ws.id);
        }
      }
    }
    // Orphan-Workspaces (in Routinen, aber nicht in Nav-API).
    for (const id of routineWorkspaces) {
      if (!seen.has(id)) {
        options.push({ id, label: id });
        seen.add(id);
      }
    }
    return options;
  }, [list, allWorkspaces, currentWorkspace.id]);

  // --------- Wizard-Workspace-Options ---------
  const wizardWorkspaceOptions = useMemo(() => {
    // Wizard: alle bekannten Workspaces der Nav-API.
    return allWorkspaces.map((ws) => ({ id: ws.id, label: ws.label }));
  }, [allWorkspaces]);

  // --------- Filter ---------
  const filtered = useMemo(() => {
    return list.filter((r) => {
      if (
        workspaceFilter !== ALL_WORKSPACES &&
        r.workspaceId !== workspaceFilter
      ) {
        return false;
      }
      switch (statusFilter) {
        case "active":
          return r.active;
        case "inactive":
          return !r.active;
        case "event-only":
          return r.triggerMode === "event";
        case "all":
        default:
          return true;
      }
    });
  }, [list, statusFilter, workspaceFilter]);

  // --------- Helpers ---------
  const setBusy = useCallback((id: string, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // --------- Actions ---------
  const toggleActive = useCallback(
    async (r: RoutineSummary) => {
      setBusy(r.id, true);
      const nextActive = !r.active;
      // Optimistisch.
      setList((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, active: nextActive } : x)),
      );
      try {
        const res = await fetch(
          `/api/routines/${encodeURIComponent(r.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ active: nextActive }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.ok(nextActive ? "Routine aktiviert" : "Routine deaktiviert", r.name);
      } catch (err) {
        // Revert.
        setList((prev) =>
          prev.map((x) =>
            x.id === r.id ? { ...x, active: r.active } : x,
          ),
        );
        toast.err("Toggle fehlgeschlagen", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(r.id, false);
      }
    },
    [setBusy, toast],
  );

  const triggerNow = useCallback(
    async (r: RoutineSummary) => {
      setBusy(r.id, true);
      try {
        const res = await fetch(
          `/api/routines/${encodeURIComponent(r.id)}/trigger`,
          { method: "POST" },
        );
        const json = (await res.json()) as TriggerResult;
        setTriggerResults((prev) => {
          const next = new Map(prev);
          next.set(r.id, json);
          return next;
        });
        setList((prev) =>
          prev.map((x) =>
            x.id === r.id ? { ...x, lastRunAt: Date.now() } : x,
          ),
        );
        if (json.status === "failure" || json.error) {
          toast.err("Trigger fehlgeschlagen", json.error ?? r.name);
        } else {
          toast.ok("Routine getriggert", r.name);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setTriggerResults((prev) => {
          const next = new Map(prev);
          next.set(r.id, { status: "failure", error: errMsg });
          return next;
        });
        toast.err("Trigger fehlgeschlagen", errMsg);
      } finally {
        setBusy(r.id, false);
      }
    },
    [setBusy, toast],
  );

  const handleCreated = useCallback((summary: RoutineSummary) => {
    setList((prev) => [summary, ...prev]);
    setWizardOpen(false);
  }, []);

  const handleSaved = useCallback((next: RoutineSummary) => {
    setList((prev) => prev.map((x) => (x.id === next.id ? next : x)));
  }, []);

  const handleDeleted = useCallback((id: string) => {
    const deleted = list.find((x) => x.id === id);
    setList((prev) => prev.filter((x) => x.id !== id));
    setDetailId(null);
    toast.ok("Routine gelöscht", deleted?.name);
  }, [list, toast]);

  const detail = useMemo(
    () => list.find((r) => r.id === detailId) ?? null,
    [list, detailId],
  );

  const activeCount = useMemo(
    () => list.filter((r) => r.active).length,
    [list],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Filter-Leiste */}
      <div style={filterBarStyle}>
        <div style={tabRowStyle} role="tablist">
          {(
            [
              { value: "all", label: "Alle", count: list.length },
              { value: "active", label: "Aktiv", count: activeCount },
              {
                value: "inactive",
                label: "Inaktiv",
                count: list.length - activeCount,
              },
              {
                value: "event-only",
                label: "Nur Event",
                count: list.filter((r) => r.triggerMode === "event").length,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={statusFilter === tab.value}
              onClick={() => setStatusFilter(tab.value)}
              style={{
                ...tabBtnStyle,
                ...(statusFilter === tab.value ? tabBtnActiveStyle : {}),
              }}
            >
              {tab.label}
              <span
                style={{
                  ...tabCountStyle,
                  color:
                    statusFilter === tab.value
                      ? "var(--ink)"
                      : "var(--ink-3)",
                }}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <label style={workspaceFilterWrapStyle}>
          <span style={workspaceFilterLabelStyle}>Workspace</span>
          <select
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            style={workspaceFilterSelectStyle}
          >
            {workspaceOptions.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Liste / Empty */}
      {filtered.length === 0 ? (
        <EmptyState
          kind={list.length === 0 ? "none" : "filtered"}
          onCreate={() => setWizardOpen(true)}
          onClearFilter={() => {
            setStatusFilter("all");
            setWorkspaceFilter(ALL_WORKSPACES);
          }}
        />
      ) : (
        <div style={listStyle}>
          {filtered.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              lastTriggerResult={triggerResults.get(r.id) ?? null}
              busy={busyIds.has(r.id)}
              onToggleActive={toggleActive}
              onTriggerNow={triggerNow}
              onOpenDetails={(rt) => setDetailId(rt.id)}
            />
          ))}
        </div>
      )}

      {/* Floating create-Button (unten rechts auf Mobile wuerde ein FAB sein;
          Desktop: der Header-Button reicht. Den FAB lassen wir hier weg fuer
          Zeichen-Economy.) */}

      {/* Details-Panel */}
      {detail && (
        <RoutineDetailsPanel
          routineId={detail.id}
          initial={detail}
          onClose={() => setDetailId(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onTriggerNow={() => triggerNow(detail)}
        />
      )}

      {/* New-Routine-Wizard — remounted per open to reset internal state */}
      <NewRoutineWizard
        key={wizardKey}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={handleCreated}
        defaultWorkspaceId={
          workspaceFilter !== ALL_WORKSPACES
            ? workspaceFilter
            : currentWorkspace.id
        }
        workspaces={wizardWorkspaceOptions}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Empty-State
// ---------------------------------------------------------------------------

function EmptyState(props: {
  kind: "none" | "filtered";
  onCreate: () => void;
  onClearFilter: () => void;
}) {
  if (props.kind === "filtered") {
    return (
      <div style={emptyBoxStyle}>
        <div style={emptyIconStyle} aria-hidden>
          ◌
        </div>
        <h3 style={emptyTitleStyle}>Keine Routinen in diesem Filter</h3>
        <p style={emptyTextStyle}>
          Fuer die aktuelle Kombination aus Status und Workspace gibt es
          nichts anzuzeigen.
        </p>
        <button
          type="button"
          onClick={props.onClearFilter}
          style={emptyBtnStyle}
        >
          Filter zuruecksetzen
        </button>
      </div>
    );
  }
  return (
    <div style={emptyBoxStyle}>
      <div style={emptyIconStyle} aria-hidden>
        ⟲
      </div>
      <h3 style={emptyTitleStyle}>Noch keine Routinen</h3>
      <p style={emptyTextStyle}>
        Routinen laufen automatisch — planen den Tag oder reagieren auf
        Events. Du kannst sie jederzeit pausieren oder loeschen.
      </p>
      <button
        type="button"
        onClick={props.onCreate}
        style={emptyBtnStyle}
      >
        + Erste Routine anlegen
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const filterBarStyle: React.CSSProperties = {
  marginTop: 28,
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 0",
  borderBottom: "0.5px solid var(--line)",
};

const tabRowStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: 2,
  padding: 3,
  borderRadius: 10,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
};

const tabBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition: "background 120ms ease, color 120ms ease",
};

const tabBtnActiveStyle: React.CSSProperties = {
  background: "var(--card-2)",
  color: "var(--ink)",
};

const tabCountStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontFamily: "var(--font-mono)",
  padding: "0 4px",
  minWidth: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const workspaceFilterWrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

const workspaceFilterLabelStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
};

const workspaceFilterSelectStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  cursor: "pointer",
};

const listStyle: React.CSSProperties = {
  marginTop: 20,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const emptyBoxStyle: React.CSSProperties = {
  marginTop: 40,
  padding: "72px 24px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 10,
  borderRadius: 14,
  background: "var(--card)",
  border: "0.5px dashed var(--line-2)",
};

const emptyIconStyle: React.CSSProperties = {
  fontSize: 32,
  color: "var(--ink-3)",
  lineHeight: 1,
};

const emptyTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: "-0.01em",
  color: "var(--ink)",
  margin: 0,
  fontFamily: "var(--font-display)",
};

const emptyTextStyle: React.CSSProperties = {
  fontSize: 13.5,
  color: "var(--ink-2)",
  maxWidth: 420,
  lineHeight: 1.55,
  margin: 0,
};

const emptyBtnStyle: React.CSSProperties = {
  marginTop: 8,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--card-2)",
  color: "var(--ink)",
  cursor: "pointer",
};
