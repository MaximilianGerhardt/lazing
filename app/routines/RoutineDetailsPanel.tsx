"use client";

/**
 * RoutineDetailsPanel — slideout from the right with routine details.
 *
 * Shows:
 *   - description (from YAML)
 *   - schedule — dropdown selector (daily / interval / weekday / event / manual)
 *   - advanced toggle shows raw cron + raw YAML for power users
 *   - pretty-printed pipeline steps (read-only)
 *   - run history (last 20)
 *   - "Jetzt triggern" button prominent top right
 *   - delete button at the bottom with confirm
 *
 * Persists schedule-dropdown changes via `PATCH /api/routines/:id`.
 *
 * Design: LazyOS v1.0 — tokens from globals.css.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useToast } from "@/lib/ui/tst/useToast";
import type { RoutineRunSummary, RoutineSummary } from "./types";
import {
  cronFromSpec,
  humanizeCron,
  humanizeTrigger,
  type EventMatchShape,
  type WizardCronSpec,
} from "./schedule-humanize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  routineId: string;
  /** Summary from the list — merged with the loaded full detail. */
  initial: RoutineSummary;
  onClose: () => void;
  onSaved: (next: RoutineSummary) => void;
  onDeleted: (id: string) => void;
  onTriggerNow: () => void;
}

interface FullRoutine extends RoutineSummary {
  yamlConfig: string;
  description: string | null;
  parsedPipeline: ParsedPipelineStep[];
  // SAR-2: plan-dispatch binding (resolved from API)
  actionKind: string;
  sopId: string | null;
  sopName: string | null;
  goalPrompt: string | null;
  skillBindingsJson: string | null;
  mcpToolAllowlistJson: string | null;
}

interface ParsedPipelineStep {
  kind: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Known event types — dropdown for event triggers.
// This is a curated list of the common event types; anyone who needs their own
// can use the advanced toggle.
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "workspace_heartbeat.stale", label: "Workspace: Heartbeat veraltet" },
  { value: "ticket.created", label: "Ticket erstellt" },
  { value: "ticket.resolved", label: "Ticket geloest" },
  { value: "decision.requested", label: "Entscheidung angefordert" },
  { value: "decision.approved", label: "Entscheidung genehmigt" },
  { value: "work_product.created", label: "Work-Product erstellt" },
  { value: "error.emitted", label: "Fehler aufgetreten" },
];

// ---------------------------------------------------------------------------
// Schedule form state (derived from the routine, converted back to cron on save).
// ---------------------------------------------------------------------------

type ScheduleMode = "daily" | "interval-minutes" | "interval-hours" | "weekly";

interface CronFormState {
  mode: ScheduleMode;
  hour: number;
  minute: number;
  every: number;
  atMinute: number;
  dayOfWeek: number;
}

const DEFAULT_CRON_FORM: CronFormState = {
  mode: "daily",
  hour: 8,
  minute: 0,
  every: 15,
  atMinute: 0,
  dayOfWeek: 1,
};

function deriveCronForm(cronExpr: string | null): CronFormState {
  if (!cronExpr) return DEFAULT_CRON_FORM;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return DEFAULT_CRON_FORM;
  const [m, h, dom, mon, dow] = parts;
  // daily
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT_CRON_FORM, mode: "daily", minute: Number(m), hour: Number(h) };
  }
  // weekly
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
    return {
      ...DEFAULT_CRON_FORM,
      mode: "weekly",
      minute: Number(m),
      hour: Number(h),
      dayOfWeek: Number(dow),
    };
  }
  // interval-minutes
  const stepMin = m.match(/^\*\/(\d+)$/);
  if (stepMin && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...DEFAULT_CRON_FORM,
      mode: "interval-minutes",
      every: Number(stepMin[1]),
    };
  }
  // interval-hours
  const stepHour = h.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(m) && stepHour && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...DEFAULT_CRON_FORM,
      mode: "interval-hours",
      atMinute: Number(m),
      every: Number(stepHour[1]),
    };
  }
  return DEFAULT_CRON_FORM;
}

function cronFromForm(form: CronFormState): string {
  const spec: WizardCronSpec =
    form.mode === "daily"
      ? { kind: "daily", hour: form.hour, minute: form.minute }
      : form.mode === "weekly"
        ? {
            kind: "weekly",
            hour: form.hour,
            minute: form.minute,
            dayOfWeek: form.dayOfWeek,
          }
        : form.mode === "interval-minutes"
          ? { kind: "interval-minutes", every: form.every }
          : {
              kind: "interval-hours",
              every: form.every,
              atMinute: form.atMinute,
            };
  return cronFromSpec(spec);
}

// ---------------------------------------------------------------------------
// YAML pipeline pretty-printer.
// ---------------------------------------------------------------------------

/**
 * Extract readable pipeline steps from YAML text via regex.
 * Robust against our seed format (see scripts/seed-routines.ts).
 * We do not load a full YAML lib in the client here — the runner validates
 * server-side, the UI only shows the structure.
 */
function parsePipelineSteps(yaml: string): ParsedPipelineStep[] {
  const steps: ParsedPipelineStep[] = [];
  const lines = yaml.split("\n");
  let inPipeline = false;
  let currentKind: string | null = null;
  let currentDetailLines: string[] = [];
  const flush = () => {
    if (currentKind) {
      steps.push({
        kind: currentKind,
        detail: currentDetailLines.join(" · ").slice(0, 140),
      });
    }
    currentKind = null;
    currentDetailLines = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^pipeline\s*:/.test(line)) {
      inPipeline = true;
      continue;
    }
    if (!inPipeline) continue;
    if (/^\S/.test(line) && line && !line.startsWith("-")) {
      // leaves the pipeline block
      flush();
      inPipeline = false;
      continue;
    }
    const stepMatch = line.match(/^\s*-\s*([a-z_]+)\s*:?\s*(.*)$/);
    if (stepMatch) {
      flush();
      currentKind = stepMatch[1];
      if (stepMatch[2]) currentDetailLines.push(stepMatch[2]);
      continue;
    }
    if (currentKind && line.trim()) {
      const trimmed = line.trim();
      if (trimmed.length < 120) currentDetailLines.push(trimmed);
    }
  }
  flush();
  return steps;
}

/**
 * Returns a relative time string ("in 2 Stunden", "in 3 Tagen") for a
 * future Unix timestamp (ms). Intended only for nextRunAt.
 */
function formatRelative(tsMs: number): string {
  const diff = tsMs - Date.now();
  if (diff <= 0) return "jetzt faellig";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min} Min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `in ${hrs} Std`;
  const days = Math.floor(hrs / 24);
  return `in ${days} Tag${days === 1 ? "" : "en"}`;
}

/**
 * Renders a JSON array OR JSON map as a read-only pill row.
 * isMap=true: JSON is { "<key>": "<value>" } — shows "key: value".
 * isMap=false: JSON is string[] — shows each value as a pill.
 * Parse error → render nothing (no empty UI).
 */
function BindingPills({
  label,
  raw,
  isMap,
}: {
  label: string;
  raw: string;
  isMap: boolean;
}): React.JSX.Element | null {
  let pills: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (isMap && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      pills = Object.entries(parsed as Record<string, string>).map(
        ([k, v]) => `${k}: ${v}`,
      );
    } else if (Array.isArray(parsed)) {
      pills = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return null;
  }
  if (pills.length === 0) return null;
  return (
    <div style={bindingColStyle}>
      <span style={bindingLabelStyle}>{label}</span>
      <div style={pillRowStyle}>
        {pills.map((p) => (
          <span key={p} style={pillStyle}>
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}

function extractDescription(yaml: string): string | null {
  const m = yaml.match(/^\s*description\s*:\s*([^\n]+(?:\n\s{2,}[^\n]+)*)/m);
  if (!m) return null;
  return m[1]
    .replace(/^\s*>\s*/, "")
    .replace(/\n\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoutineDetailsPanel(props: Props) {
  const { routineId, initial, onClose, onSaved, onDeleted, onTriggerNow } =
    props;
  const toast = useToast();

  const [full, setFull] = useState<FullRoutine | null>(null);
  const [runs, setRuns] = useState<RoutineRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // Trigger-Mode + Form-State.
  const [triggerMode, setTriggerMode] = useState<
    "cron" | "event" | "manual"
  >(initial.triggerMode);
  const [cronForm, setCronForm] = useState<CronFormState>(() =>
    deriveCronForm(initial.cronExpr),
  );
  const [rawCron, setRawCron] = useState<string>(initial.cronExpr ?? "");
  const [eventType, setEventType] = useState<string>("");
  const [rawYaml, setRawYaml] = useState<string>("");

  // --------- Lifecycle: ESC close ---------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // --------- Load full detail + history ---------
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [fullRes, runsRes] = await Promise.all([
          fetch(`/api/routines/${encodeURIComponent(routineId)}`),
          fetch(
            `/api/routines/${encodeURIComponent(routineId)}/runs?limit=20`,
          ),
        ]);
        const fullJson = await fullRes.json();
        const runsJson = await runsRes.json();
        if (cancelled) return;

        if (!fullRes.ok || !fullJson.routine) {
          throw new Error(
            fullJson.message ?? fullJson.error ?? `HTTP ${fullRes.status}`,
          );
        }

        const r = fullJson.routine;
        const yaml: string = r.yamlConfig ?? "";
        const parsedPipeline = parsePipelineSteps(yaml);
        const description = extractDescription(yaml);

        const merged: FullRoutine = {
          ...initial,
          id: r.id,
          name: r.name,
          workspaceId: r.workspaceId,
          triggerMode: r.triggerMode,
          cronExpr: r.cronExpr,
          eventMatch: r.eventMatch,
          active: !!r.active,
          lastRunAt: r.lastRunAt ?? initial.lastRunAt,
          nextRunAt: r.nextRunAt ?? initial.nextRunAt,
          createdAt: r.createdAt ?? initial.createdAt,
          updatedAt: r.updatedAt ?? initial.updatedAt,
          yamlConfig: yaml,
          description,
          parsedPipeline,
          // SAR-2: plan-dispatch binding
          actionKind: r.actionKind ?? "shell",
          sopId: r.sopId ?? null,
          sopName: r.sopName ?? null,
          goalPrompt: r.goalPrompt ?? null,
          skillBindingsJson: r.skillBindingsJson ?? null,
          mcpToolAllowlistJson: r.mcpToolAllowlistJson ?? null,
        };

        setFull(merged);
        setRawYaml(yaml);
        setTriggerMode(merged.triggerMode);
        setCronForm(deriveCronForm(merged.cronExpr));
        setRawCron(merged.cronExpr ?? "");
        if (merged.eventMatch) {
          try {
            const m = JSON.parse(merged.eventMatch) as EventMatchShape;
            setEventType(m.eventType ?? "");
          } catch {
            setEventType("");
          }
        }
        setRuns(runsJson.runs ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // `initial` deliberately NOT in deps — only routineId triggers a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineId]);

  // --------- Computed: current trigger preview ---------
  const triggerPreview = useMemo(() => {
    if (triggerMode === "cron") {
      const expr = advanced ? rawCron : cronFromForm(cronForm);
      return humanizeCron(expr);
    }
    if (triggerMode === "event") {
      return humanizeTrigger({
        triggerMode: "event",
        cronExpr: null,
        eventMatch: { eventType },
      });
    }
    return humanizeTrigger({
      triggerMode: "manual",
      cronExpr: null,
      eventMatch: null,
    });
  }, [triggerMode, cronForm, rawCron, advanced, eventType]);

  // --------- Save ---------
  const save = useCallback(async () => {
    if (!full) return;
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = { triggerMode };

    if (triggerMode === "cron") {
      const expr = advanced ? rawCron.trim() : cronFromForm(cronForm);
      if (!expr) {
        setError("Cron-Expression fehlt.");
        setSaving(false);
        return;
      }
      body.cronExpr = expr;
      body.eventMatch = null;
    } else if (triggerMode === "event") {
      if (!eventType) {
        setError("Event-Typ auswaehlen.");
        setSaving(false);
        return;
      }
      body.eventMatch = { eventType };
      body.cronExpr = null;
    } else {
      body.cronExpr = null;
      body.eventMatch = null;
    }

    if (advanced && rawYaml && rawYaml !== full.yamlConfig) {
      body.yamlConfig = rawYaml;
    }

    try {
      const res = await fetch(
        `/api/routines/${encodeURIComponent(routineId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
      }
      const r = json.routine ?? {};
      const nextSummary: RoutineSummary = {
        ...full,
        triggerMode: r.triggerMode ?? triggerMode,
        cronExpr: r.cronExpr ?? null,
        eventMatch: r.eventMatch ?? null,
        nextRunAt: r.nextRunAt ?? full.nextRunAt,
        updatedAt: r.updatedAt ?? Date.now(),
      };
      onSaved(nextSummary);
      setFull((prev) =>
        prev
          ? {
              ...prev,
              ...nextSummary,
              // RoutineSummary has optional plan-dispatch fields; FullRoutine
              // requires non-optional actionKind — preserve prev value.
              actionKind: prev.actionKind,
              yamlConfig: r.yamlConfig ?? prev.yamlConfig,
            }
          : prev,
      );
      toast.ok("Gespeichert", full.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.err("Speichern fehlgeschlagen", msg);
    } finally {
      setSaving(false);
    }
  }, [
    full,
    triggerMode,
    advanced,
    rawCron,
    cronForm,
    eventType,
    rawYaml,
    routineId,
    onSaved,
    toast,
  ]);

  // --------- Delete ---------
  const doDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/routines/${encodeURIComponent(routineId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          (json as { message?: string }).message ?? `HTTP ${res.status}`,
        );
      }
      onDeleted(routineId);
      // toast fired in RoutinesList.handleDeleted after panel unmounts
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.err("Löschen fehlgeschlagen", msg);
      setDeleting(false);
    }
  }, [routineId, onDeleted, toast]);

  // --------- Manual-Trigger ---------
  const triggerManual = useCallback(async () => {
    setTriggering(true);
    try {
      onTriggerNow();
    } finally {
      setTriggering(false);
    }
  }, [onTriggerNow]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Routine-Details ${initial.name}`}
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside style={panelStyle}>
        <header style={headerStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={eyebrowStyle}>Routine · {initial.id}</div>
            <h2 style={titleStyle}>{initial.name}</h2>
            {full?.description && (
              <p style={descStyle}>{full.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schliessen"
            style={closeBtnStyle}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div style={actionBarStyle}>
          <button
            type="button"
            onClick={triggerManual}
            disabled={triggering}
            style={primaryBtnStyle}
          >
            {triggering ? "laeuft …" : "Jetzt triggern"}
          </button>
          <span style={{ flex: 1 }} />
          <span style={previewPillStyle}>
            <span aria-hidden>{triggerPreview.icon}</span>
            {triggerPreview.label}
          </span>
        </div>

        {loading ? (
          <div style={loadingStyle}>lade Konfiguration …</div>
        ) : (
          <div style={bodyStyle}>
            {/* Schedule */}
            <section style={sectionStyle}>
              <h3 style={sectionTitleStyle}>Zeitplan</h3>

              <div style={segmentedStyle}>
                {(["cron", "event", "manual"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTriggerMode(mode)}
                    aria-pressed={triggerMode === mode}
                    style={{
                      ...segmentedBtnStyle,
                      ...(triggerMode === mode ? segmentedBtnActiveStyle : {}),
                    }}
                  >
                    {mode === "cron"
                      ? "Zeitgesteuert"
                      : mode === "event"
                        ? "Event-getriggert"
                        : "Nur manuell"}
                  </button>
                ))}
              </div>

              {triggerMode === "cron" && !advanced && (
                <div style={formGridStyle}>
                  <label style={fieldStyle}>
                    <span style={fieldLabelStyle}>Wiederholung</span>
                    <select
                      value={cronForm.mode}
                      onChange={(e) =>
                        setCronForm((f) => ({
                          ...f,
                          mode: e.target.value as ScheduleMode,
                        }))
                      }
                      style={selectStyle}
                    >
                      <option value="daily">Taeglich</option>
                      <option value="weekly">Woechentlich</option>
                      <option value="interval-minutes">Alle N Minuten</option>
                      <option value="interval-hours">Alle N Stunden</option>
                    </select>
                  </label>

                  {(cronForm.mode === "daily" ||
                    cronForm.mode === "weekly") && (
                    <>
                      {cronForm.mode === "weekly" && (
                        <label style={fieldStyle}>
                          <span style={fieldLabelStyle}>Wochentag</span>
                          <select
                            value={cronForm.dayOfWeek}
                            onChange={(e) =>
                              setCronForm((f) => ({
                                ...f,
                                dayOfWeek: Number(e.target.value),
                              }))
                            }
                            style={selectStyle}
                          >
                            <option value={1}>Montag</option>
                            <option value={2}>Dienstag</option>
                            <option value={3}>Mittwoch</option>
                            <option value={4}>Donnerstag</option>
                            <option value={5}>Freitag</option>
                            <option value={6}>Samstag</option>
                            <option value={0}>Sonntag</option>
                          </select>
                        </label>
                      )}
                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>Uhrzeit (UTC)</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <select
                            value={cronForm.hour}
                            onChange={(e) =>
                              setCronForm((f) => ({
                                ...f,
                                hour: Number(e.target.value),
                              }))
                            }
                            style={selectStyle}
                          >
                            {Array.from({ length: 24 }, (_, i) => (
                              <option key={i} value={i}>
                                {i.toString().padStart(2, "0")}
                              </option>
                            ))}
                          </select>
                          <select
                            value={cronForm.minute}
                            onChange={(e) =>
                              setCronForm((f) => ({
                                ...f,
                                minute: Number(e.target.value),
                              }))
                            }
                            style={selectStyle}
                          >
                            {[0, 15, 30, 45].map((m) => (
                              <option key={m} value={m}>
                                {m.toString().padStart(2, "0")}
                              </option>
                            ))}
                          </select>
                        </div>
                      </label>
                    </>
                  )}

                  {cronForm.mode === "interval-minutes" && (
                    <label style={fieldStyle}>
                      <span style={fieldLabelStyle}>Alle N Minuten</span>
                      <select
                        value={cronForm.every}
                        onChange={(e) =>
                          setCronForm((f) => ({
                            ...f,
                            every: Number(e.target.value),
                          }))
                        }
                        style={selectStyle}
                      >
                        {[5, 10, 15, 20, 30].map((n) => (
                          <option key={n} value={n}>
                            Alle {n} Min
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {cronForm.mode === "interval-hours" && (
                    <>
                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>Alle N Stunden</span>
                        <select
                          value={cronForm.every}
                          onChange={(e) =>
                            setCronForm((f) => ({
                              ...f,
                              every: Number(e.target.value),
                            }))
                          }
                          style={selectStyle}
                        >
                          {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                            <option key={n} value={n}>
                              Alle {n} Std
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>Zur Minute</span>
                        <select
                          value={cronForm.atMinute}
                          onChange={(e) =>
                            setCronForm((f) => ({
                              ...f,
                              atMinute: Number(e.target.value),
                            }))
                          }
                          style={selectStyle}
                        >
                          {[0, 15, 30, 45].map((m) => (
                            <option key={m} value={m}>
                              :{m.toString().padStart(2, "0")}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              )}

              {triggerMode === "cron" && advanced && (
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Cron-Expression (raw)</span>
                  <input
                    type="text"
                    value={rawCron}
                    onChange={(e) => setRawCron(e.target.value)}
                    placeholder="0 8 * * *"
                    style={inputStyle}
                  />
                  <span style={hintStyle}>
                    Format: Minute Stunde Tag Monat Wochentag (alle UTC)
                  </span>
                </label>
              )}

              {triggerMode === "event" && (
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Bei welchem Event?</span>
                  <select
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="">— auswaehlen —</option>
                    {KNOWN_EVENT_TYPES.map((et) => (
                      <option key={et.value} value={et.value}>
                        {et.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {triggerMode === "manual" && (
                <p style={hintStyle}>
                  Routine laeuft nur wenn du &bdquo;Jetzt triggern&ldquo;
                  klickst oder sie per CLI/API aufrufst.
                </p>
              )}

              <button
                type="button"
                onClick={() => setAdvanced((a) => !a)}
                style={linkBtnStyle}
              >
                {advanced
                  ? "Einfache Ansicht"
                  : "Erweitert (Cron + YAML-Editor)"}
              </button>
            </section>

            {/* Advanced YAML-Editor */}
            {advanced && (
              <section style={sectionStyle}>
                <h3 style={sectionTitleStyle}>YAML-Konfiguration</h3>
                <textarea
                  value={rawYaml}
                  onChange={(e) => setRawYaml(e.target.value)}
                  spellCheck={false}
                  rows={14}
                  style={textareaStyle}
                />
                <span style={hintStyle}>
                  Aenderungen am YAML werden beim Speichern validiert. Syntax-
                  Fehler fuehren zu HTTP 400.
                </span>
              </section>
            )}

            {/* Naechster Run — nur bei aktiver Cron-Routine mit bekanntem nextRunAt */}
            {full && full.triggerMode === "cron" && full.nextRunAt && full.active && (
              <section style={sectionStyle}>
                <h3 style={sectionTitleStyle}>Naechster Run</h3>
                <div style={nextRunRowStyle}>
                  <span style={nextRunTsStyle}>
                    {new Date(full.nextRunAt).toLocaleString("de-DE", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                  <span style={nextRunRelStyle}>
                    {formatRelative(full.nextRunAt)}
                  </span>
                </div>
              </section>
            )}

            {/* Plan-Dispatch Binding — nur bei action_kind='plan-dispatch' */}
            {!advanced && full && full.actionKind === "plan-dispatch" && (
              <section style={sectionStyle}>
                <h3 style={sectionTitleStyle}>Plan-Dispatch</h3>

                {/* SOP-Name */}
                {full.sopName && (
                  <div style={bindingRowStyle}>
                    <span style={bindingLabelStyle}>SOP</span>
                    <span style={bindingValueStyle}>{full.sopName}</span>
                  </div>
                )}

                {/* Goal-Prompt — full detail preserved (N1) */}
                {full.goalPrompt && (
                  <div style={bindingColStyle}>
                    <span style={bindingLabelStyle}>Ziel-Prompt</span>
                    <p style={goalPromptStyle}>{full.goalPrompt}</p>
                  </div>
                )}

                {/* Skills — parsed JSON-Array → read-only Pills */}
                {full.skillBindingsJson && (
                  <BindingPills
                    label="Skills"
                    raw={full.skillBindingsJson}
                    isMap
                  />
                )}

                {/* MCP-Tool-Allowlist — parsed JSON-Array → read-only Pills */}
                {full.mcpToolAllowlistJson && (
                  <BindingPills
                    label="MCP-Tools"
                    raw={full.mcpToolAllowlistJson}
                    isMap={false}
                  />
                )}
              </section>
            )}

            {/* Pipeline — Read-only */}
            {!advanced && full?.parsedPipeline && full.parsedPipeline.length > 0 && (
              <section style={sectionStyle}>
                <h3 style={sectionTitleStyle}>Pipeline-Schritte</h3>
                <ol style={pipelineListStyle}>
                  {full.parsedPipeline.map((step, idx) => (
                    <li key={idx} style={pipelineItemStyle}>
                      <span style={pipelineStepNumStyle}>{idx + 1}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={pipelineKindStyle}>
                          {step.kind.replace(/_/g, " ")}
                        </div>
                        {step.detail && (
                          <div style={pipelineDetailStyle}>{step.detail}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* Run History */}
            <section style={sectionStyle}>
              <h3 style={sectionTitleStyle}>Run-History · letzte {runs.length}</h3>
              {runs.length === 0 ? (
                <p style={hintStyle}>Noch keine Runs aufgezeichnet.</p>
              ) : (
                <ul style={runListStyle}>
                  {runs.map((run) => {
                    const statusColor =
                      run.status === "success"
                        ? "var(--term-ok)"
                        : run.status === "skipped"
                          ? "var(--ink-3)"
                          : run.status === "running"
                            ? "var(--a-warn)"
                            : "var(--term-err)";
                    const duration =
                      run.finishedAt && run.startedAt
                        ? `${Math.max(
                            0,
                            Math.round((run.finishedAt - run.startedAt) / 100) / 10,
                          )}s`
                        : "—";
                    return (
                      <li key={run.id} style={runItemStyle}>
                        <span
                          aria-hidden
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: statusColor,
                            flexShrink: 0,
                          }}
                        />
                        <span style={runTsStyle}>
                          {new Date(run.startedAt).toLocaleString("de-DE", {
                            dateStyle: "short",
                            timeStyle: "medium",
                          })}
                        </span>
                        <span style={{ ...runStatusStyle, color: statusColor }}>
                          {run.status}
                        </span>
                        <span style={runDurStyle}>{duration}</span>
                        {run.deliveryRef && (
                          <span style={runRefStyle}>{run.deliveryRef}</span>
                        )}
                        {run.error && (
                          <span
                            title={run.error}
                            style={runErrorStyle}
                          >
                            {run.error.slice(0, 48)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {error && <div style={errorBannerStyle}>{error}</div>}

            {/* Footer — primary action: save. Danger zone separated on the left. */}
            <footer style={footerStyle}>
              {/* Danger zone: delete — visually demoted, clearly separated */}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {!confirmDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    style={dangerBtnStyle}
                  >
                    Loeschen
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={doDelete}
                      disabled={deleting}
                      style={dangerConfirmBtnStyle}
                    >
                      {deleting ? "loesche …" : "Wirklich loeschen?"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      style={secondaryBtnStyle}
                    >
                      Abbrechen
                    </button>
                  </>
                )}
              </div>

              {/* Primary action */}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                style={saveBtnStyle}
              >
                {saving ? "speichert …" : "Speichern"}
              </button>
            </footer>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.72)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  zIndex: 1000,
  display: "flex",
  justifyContent: "flex-end",
};

const panelStyle: React.CSSProperties = {
  width: "min(640px, 100%)",
  height: "100%",
  background: "var(--sheet-2)",
  borderLeft: "0.5px solid var(--line-2)",
  boxShadow: "-40px 0 100px -20px rgba(0,0,0,0.7)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "20px 24px 16px",
  borderBottom: "0.5px solid var(--line)",
  display: "flex",
  gap: 16,
  alignItems: "flex-start",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: "var(--fs-caption)",  /* 11px caption token — uppercase+spacing OK */
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  letterSpacing: "-0.02em",
  margin: "4px 0 6px",
  color: "var(--ink)",
  fontWeight: 600,
  fontFamily: "var(--font-display)",
};

const descStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-2)",
  lineHeight: 1.55,
  margin: 0,
};

const closeBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 16,
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const actionBarStyle: React.CSSProperties = {
  padding: "14px 24px",
  borderBottom: "0.5px solid var(--line)",
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const previewPillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--on-card)",
  fontSize: "var(--fs-body)",
  fontFamily: "var(--font-mono)",
};

const bodyStyle: React.CSSProperties = {
  padding: "20px 24px 0",
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 28,
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "var(--fs-caption)",  /* 11px caption token — uppercase+spacing OK */
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
  fontFamily: "var(--font-mono)",
};

const segmentedStyle: React.CSSProperties = {
  display: "inline-flex",
  padding: 3,
  borderRadius: 10,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  alignSelf: "flex-start",
};

const segmentedBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: "var(--fs-body)",
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  transition: "background 120ms ease, color 120ms ease",
};

const segmentedBtnActiveStyle: React.CSSProperties = {
  background: "var(--card-2)",
  color: "var(--ink)",
};

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 12,
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "var(--fs-label)",  /* 11px label token — form-label uppercase+spacing OK */
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

const selectStyle: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  outline: "none",
};

const textareaStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  lineHeight: 1.55,
  resize: "vertical",
  minHeight: 220,
  outline: "none",
};

const hintStyle: React.CSSProperties = {
  fontSize: "var(--fs-body)",  /* ≥13px — readable hint text */
  color: "var(--ink-3)",
  lineHeight: "var(--lh-body)",
};

const linkBtnStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--ink-2)",
  fontSize: "var(--fs-body)",
  cursor: "pointer",
  textDecoration: "underline",
  textDecorationColor: "var(--line-2)",
  textUnderlineOffset: 3,
};

const pipelineListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const pipelineItemStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
};

const pipelineStepNumStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "var(--card-2)",
  color: "var(--ink-2)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const pipelineKindStyle: React.CSSProperties = {
  fontSize: "var(--fs-body)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  textTransform: "lowercase",
};

const pipelineDetailStyle: React.CSSProperties = {
  fontSize: "var(--fs-body)",  /* ≥13px — readable detail text */
  color: "var(--on-card)",     /* --ink-2: ~8:1 on card */
  fontFamily: "var(--font-mono)",
  marginTop: 3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const runListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const runItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  fontSize: "var(--fs-body)",  /* ≥13px — readable run status */
  flexWrap: "wrap",
};

const runTsStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--on-card)",  /* --ink-2: readable on card */
};

const runStatusStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  textTransform: "lowercase",
};

const runDurStyle: React.CSSProperties = {
  color: "var(--on-card)",  /* --ink-2: readable on card */
  fontFamily: "var(--font-mono)",
};

const runRefStyle: React.CSSProperties = {
  color: "var(--ink-3)",
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 200,
};

const runErrorStyle: React.CSSProperties = {
  color: "var(--term-err)",
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 240,
};

const errorBannerStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--term-err)",
  background: "rgba(255,69,58,0.08)",
  color: "var(--term-err)",
  fontSize: "var(--fs-body)",
  fontFamily: "var(--font-mono)",
};

const footerStyle: React.CSSProperties = {
  padding: "16px 0 24px",
  borderTop: "0.5px solid var(--line)",
  marginTop: 4,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  position: "sticky",
  bottom: 0,
  background:
    "linear-gradient(to top, var(--sheet-2) 70%, transparent)",
};

const loadingStyle: React.CSSProperties = {
  padding: "60px 24px",
  textAlign: "center",
  color: "var(--ink-3)",
  fontSize: 13,
};

// -- Buttons (reused) --

const primaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "9px 16px",
  borderRadius: 10,
  border: "1px solid var(--primary)",
  background: "var(--primary)",
  color: "var(--sheet)",
  cursor: "pointer",
};

/** Brand-gradient save button — the only primary action in the footer. */
const saveBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  padding: "10px 22px",
  borderRadius: 10,
  border: "none",
  background: "linear-gradient(135deg, var(--a-own) 0%, var(--a-private) 100%)",
  color: "var(--primary)",
  cursor: "pointer",
  letterSpacing: "-0.01em",
  transition: "opacity 240ms cubic-bezier(0.16, 1, 0.3, 1)",
};

const secondaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "9px 16px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
};

const dangerBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--term-err)",
  cursor: "pointer",
};

const dangerConfirmBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--term-err)",
  background: "rgba(255,69,58,0.12)",
  color: "var(--term-err)",
  cursor: "pointer",
};

// -- NextRunAt display --

const nextRunRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const nextRunTsStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  color: "var(--ink)",
};

const nextRunRelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  color: "var(--ink-3)",
};

// -- Plan-Dispatch Binding --

const bindingRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const bindingColStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const bindingLabelStyle: React.CSSProperties = {
  fontSize: "var(--fs-label)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
};

const bindingValueStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  color: "var(--ink)",
  padding: "6px 10px",
  borderRadius: 8,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  alignSelf: "flex-start",
};

const goalPromptStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  color: "var(--on-card)",
  lineHeight: "var(--lh-body)",
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const pillRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const pillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--on-card)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-body)",
  whiteSpace: "nowrap",
};
