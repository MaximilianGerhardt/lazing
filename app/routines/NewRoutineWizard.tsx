"use client";

/**
 * NewRoutineWizard — 4-Step-Flow zum Erstellen einer Routine.
 *
 * Keine YAML-Editoren, keine Cron-Syntax im Normalfall. Wir generieren YAML
 * server-seitig passend fuer den `validateYamlConfig`-Schema.
 *
 * Steps:
 *   1. Name + Workspace
 *   2. Trigger (Zeit / Event / Manuell) — produziert cron-expr intern
 *   3. Delivery (Push / Ticket / Decision / Log) — mit kontextuellen Feldern
 *   4. Review + Save
 *
 * Design: LazyOS v1.0 — Tokens aus globals.css.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { cronFromSpec, humanizeCron, type WizardCronSpec } from "./schedule-humanize";
import type { RoutineSummary } from "./types";

// ---------------------------------------------------------------------------
// Inline SVG icons — replace pictographic glyphs in the wizard option tiles.
// viewBox 0 0 24 24, stroke=currentColor, round caps, aria-hidden.
// ---------------------------------------------------------------------------

interface TileIconProps {
  size?: number;
}

const TILE_ICON_PROPS = {
  fill: "none" as const,
  viewBox: "0 0 24 24" as const,
  stroke: "currentColor" as const,
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
  focusable: false as const,
};

/** Close (X) — modal dismiss. */
function IconWizardClose({ size = 16 }: TileIconProps) {
  return (
    <svg width={size} height={size} {...TILE_ICON_PROPS}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

/** Clock — time trigger. */
function IconWizardClock({ size = 18 }: TileIconProps) {
  return (
    <svg width={size} height={size} {...TILE_ICON_PROPS}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** Phone with signal — push notification. */
function IconWizardPush({ size = 18 }: TileIconProps) {
  return (
    <svg width={size} height={size} {...TILE_ICON_PROPS}>
      <rect x="6.5" y="3.5" width="11" height="17" rx="2.4" />
      <path d="M11 17.5h2" />
    </svg>
  );
}

/** Ticket / new entry — ticket delivery. */
function IconWizardTicket({ size = 18 }: TileIconProps) {
  return (
    <svg width={size} height={size} {...TILE_ICON_PROPS}>
      <path d="M4 8.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z" />
      <path d="M14 6.5v11" />
    </svg>
  );
}

/** Balance scale — decision request. */
function IconWizardScale({ size = 18 }: TileIconProps) {
  return (
    <svg width={size} height={size} {...TILE_ICON_PROPS}>
      <path d="M12 4v16" />
      <path d="M6 20h12" />
      <path d="M5 7h14" />
      <path d="M5 7 2.5 12.5h5L5 7Z" />
      <path d="M19 7l-2.5 5.5h5L19 7Z" />
    </svg>
  );
}

interface WorkspaceOption {
  id: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (summary: RoutineSummary) => void;
  /** Vorausgewaehlter Workspace — wird in Step 1 voreingetragen. */
  defaultWorkspaceId?: string;
  /** Dropdown-Optionen fuer Workspace-Auswahl. */
  workspaces: readonly WorkspaceOption[];
}

type TriggerKind = "time" | "event" | "manual";
type DeliveryKind = "push" | "ticket" | "decision" | "log";

interface TimeTrigger {
  mode: "daily" | "interval-minutes" | "interval-hours" | "weekly";
  hour: number;
  minute: number;
  every: number;
  atMinute: number;
  dayOfWeek: number;
}

const DEFAULT_TIME: TimeTrigger = {
  mode: "daily",
  hour: 9,
  minute: 0,
  every: 15,
  atMinute: 0,
  dayOfWeek: 1,
};

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
// YAML-Builder — generiert passend zu RoutineConfigSchema.
// ---------------------------------------------------------------------------

interface YamlBuilderInput {
  id: string;
  name: string;
  workspaceId: string;
  description: string;
  deliveryKind: DeliveryKind;
  pushTitle?: string;
  pushBody?: string;
  ticketTitle?: string;
  decisionQuestion?: string;
}

/**
 * Minimales valides YAML passend zu RoutineConfigSchema. Dedup-Step
 * lassen wir weg (kann spaeter im Advanced-Editor hinzugefuegt werden).
 */
function buildYaml(input: YamlBuilderInput): string {
  const escaped = (v: string) =>
    v.replace(/"/g, '\\"').replace(/\n/g, " ").trim();

  const lines: string[] = [
    `id: ${input.id}`,
    `name: ${JSON.stringify(input.name)}`,
    `workspace_id: ${input.workspaceId}`,
  ];
  if (input.description) {
    lines.push(`description: "${escaped(input.description)}"`);
  }
  lines.push("pipeline:");
  // Einfacher Default-Collect: listet offene Tickets.
  lines.push("  - collect_context:");
  lines.push("      commands:");
  lines.push(`        - echo "Routine ${input.name} ausgefuehrt um $(date -u +%FT%TZ)"`);
  lines.push("  - output_format: markdown");

  switch (input.deliveryKind) {
    case "push": {
      const title = input.pushTitle || input.name;
      const body = input.pushBody || input.name;
      lines.push("  - push:");
      lines.push(`      title: ${JSON.stringify(title.slice(0, 80))}`);
      lines.push(`      body: ${JSON.stringify(body.slice(0, 200))}`);
      lines.push(`      url: /`);
      lines.push(`      tag: ${input.id}`);
      lines.push("  - delivery: push_send");
      break;
    }
    case "decision": {
      const title = input.pushTitle || input.name;
      const body = input.decisionQuestion || "Entscheidung erforderlich";
      lines.push("  - push:");
      lines.push(`      title: ${JSON.stringify(title.slice(0, 80))}`);
      lines.push(`      body: ${JSON.stringify(body.slice(0, 200))}`);
      lines.push(`      url: /approvals`);
      lines.push(`      tag: ${input.id}`);
      lines.push("  - delivery: decision_request");
      break;
    }
    case "ticket": {
      lines.push("  - delivery: ticket_create");
      break;
    }
    case "log":
    default: {
      lines.push("  - delivery: stdout");
      break;
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewRoutineWizard(props: Props) {
  const { open, onClose, onCreated, defaultWorkspaceId, workspaces } = props;

  const [step, setStep] = useState(1);

  // Step 1
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(
    defaultWorkspaceId ?? workspaces[0]?.id ?? "lazyos",
  );
  const [description, setDescription] = useState("");

  // Step 2
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("time");
  const [time, setTime] = useState<TimeTrigger>(DEFAULT_TIME);
  const [eventType, setEventType] = useState<string>("");

  // Step 3
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKind>("push");
  const [pushTitle, setPushTitle] = useState("");
  const [pushBody, setPushBody] = useState("");
  const [decisionQuestion, setDecisionQuestion] = useState("");

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset-on-open is implemented by remounting the wizard via `key` in
  // the parent (RoutinesList) — that avoids a setState-in-effect pattern
  // that React treats as a smell. We keep the defaults in the useState
  // initializers instead.

  // ESC close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const cronExpr = useMemo(() => {
    if (triggerKind !== "time") return null;
    const spec: WizardCronSpec =
      time.mode === "daily"
        ? { kind: "daily", hour: time.hour, minute: time.minute }
        : time.mode === "weekly"
          ? {
              kind: "weekly",
              hour: time.hour,
              minute: time.minute,
              dayOfWeek: time.dayOfWeek,
            }
          : time.mode === "interval-minutes"
            ? { kind: "interval-minutes", every: time.every }
            : {
                kind: "interval-hours",
                every: time.every,
                atMinute: time.atMinute,
              };
    return cronFromSpec(spec);
  }, [triggerKind, time]);

  const triggerPreview = useMemo(() => {
    if (triggerKind === "time") return humanizeCron(cronExpr);
    if (triggerKind === "event" && eventType) {
      return {
        icon: "·",
        label: `Bei Event: ${eventType}`,
        kind: "event" as const,
      };
    }
    if (triggerKind === "manual") {
      return { icon: "▶", label: "Nur manuell", kind: "manual" as const };
    }
    return { icon: "·", label: "—", kind: "manual" as const };
  }, [triggerKind, cronExpr, eventType]);

  // ---- Validation per step ----
  const canGoToStep2 = name.trim().length >= 2 && workspaceId;
  const canGoToStep3 =
    (triggerKind === "time" && cronExpr) ||
    (triggerKind === "event" && eventType) ||
    triggerKind === "manual";
  const canSubmit = canGoToStep2 && canGoToStep3;

  // ---- Submit ----
  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // ID fuer YAML: kebab-case Name.
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "routine";

      const yamlConfig = buildYaml({
        id: slug,
        name,
        workspaceId,
        description,
        deliveryKind,
        pushTitle,
        pushBody,
        decisionQuestion,
      });

      const body: Record<string, unknown> = {
        name,
        workspaceId,
        yamlConfig,
        triggerMode:
          triggerKind === "time"
            ? "cron"
            : triggerKind === "event"
              ? "event"
              : "manual",
        active: true,
      };
      if (triggerKind === "time" && cronExpr) {
        body.cronExpr = cronExpr;
      }
      if (triggerKind === "event" && eventType) {
        body.eventMatch = { eventType };
      }

      const res = await fetch("/api/routines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
      }

      const now = Date.now();
      const summary: RoutineSummary = {
        id: json.id,
        name,
        workspaceId,
        triggerMode:
          triggerKind === "time"
            ? "cron"
            : triggerKind === "event"
              ? "event"
              : "manual",
        cronExpr: triggerKind === "time" ? cronExpr : null,
        eventMatch:
          triggerKind === "event" && eventType
            ? JSON.stringify({ eventType })
            : null,
        lastRunAt: null,
        nextRunAt: json.nextRunAt ?? null,
        active: true,
        createdAt: now,
        updatedAt: now,
      };

      onCreated(summary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    name,
    workspaceId,
    description,
    deliveryKind,
    pushTitle,
    pushBody,
    decisionQuestion,
    triggerKind,
    cronExpr,
    eventType,
    onCreated,
    onClose,
  ]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Neue Routine"
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalStyle}>
        <header style={headerStyle}>
          <div>
            <div style={eyebrowStyle}>Schritt {step} von 4</div>
            <h2 style={titleStyle}>
              {step === 1 && "Routine benennen"}
              {step === 2 && "Wann soll sie laufen?"}
              {step === 3 && "Was soll passieren?"}
              {step === 4 && "Pruefen + anlegen"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schliessen"
            style={closeBtnStyle}
          >
            <IconWizardClose />
          </button>
        </header>

        {/* Progress */}
        <div style={progressWrapStyle}>
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              style={{
                ...progressDotStyle,
                background:
                  n === step
                    ? "var(--primary)"
                    : n < step
                      ? "var(--ink-2)"
                      : "var(--ink-4)",
              }}
            />
          ))}
        </div>

        <div style={bodyStyle}>
          {/* ---- Step 1 ---- */}
          {step === 1 && (
            <div style={formStackStyle}>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Name der Routine</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="z.B. Morgen-Brief"
                  autoFocus
                  style={inputStyle}
                />
              </label>

              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Workspace</span>
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  style={selectStyle}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>

              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>
                  Beschreibung (optional)
                </span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Was macht diese Routine?"
                  rows={3}
                  style={textareaStyle}
                />
              </label>
            </div>
          )}

          {/* ---- Step 2 ---- */}
          {step === 2 && (
            <div style={formStackStyle}>
              <div style={radioGroupStyle}>
                {(
                  [
                    {
                      value: "time",
                      label: "Zeit",
                      hint: "Taeglich, woechentlich oder in Intervallen",
                      icon: <IconWizardClock />,
                    },
                    {
                      value: "event",
                      label: "Event",
                      hint: "Wenn etwas Bestimmtes passiert",
                      icon: "·",
                    },
                    {
                      value: "manual",
                      label: "Manuell",
                      hint: "Nur wenn du triggern willst",
                      icon: "▶",
                    },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTriggerKind(opt.value)}
                    aria-pressed={triggerKind === opt.value}
                    style={{
                      ...radioCardStyle,
                      ...(triggerKind === opt.value
                        ? radioCardActiveStyle
                        : {}),
                    }}
                  >
                    <span style={radioIconStyle}>{opt.icon}</span>
                    <span style={radioLabelStyle}>{opt.label}</span>
                    <span style={radioHintStyle}>{opt.hint}</span>
                  </button>
                ))}
              </div>

              {triggerKind === "time" && (
                <div style={formGridStyle}>
                  <label style={fieldStyle}>
                    <span style={fieldLabelStyle}>Wiederholung</span>
                    <select
                      value={time.mode}
                      onChange={(e) =>
                        setTime((t) => ({
                          ...t,
                          mode: e.target.value as TimeTrigger["mode"],
                        }))
                      }
                      style={selectStyle}
                    >
                      <option value="daily">Taeglich</option>
                      <option value="weekly">Woechentlich</option>
                      <option value="interval-minutes">
                        Alle N Minuten
                      </option>
                      <option value="interval-hours">Alle N Stunden</option>
                    </select>
                  </label>

                  {(time.mode === "daily" || time.mode === "weekly") && (
                    <>
                      {time.mode === "weekly" && (
                        <label style={fieldStyle}>
                          <span style={fieldLabelStyle}>Wochentag</span>
                          <select
                            value={time.dayOfWeek}
                            onChange={(e) =>
                              setTime((t) => ({
                                ...t,
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
                            value={time.hour}
                            onChange={(e) =>
                              setTime((t) => ({
                                ...t,
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
                            value={time.minute}
                            onChange={(e) =>
                              setTime((t) => ({
                                ...t,
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

                  {time.mode === "interval-minutes" && (
                    <label style={fieldStyle}>
                      <span style={fieldLabelStyle}>Alle N Minuten</span>
                      <select
                        value={time.every}
                        onChange={(e) =>
                          setTime((t) => ({
                            ...t,
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

                  {time.mode === "interval-hours" && (
                    <>
                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>Alle N Stunden</span>
                        <select
                          value={time.every}
                          onChange={(e) =>
                            setTime((t) => ({
                              ...t,
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
                          value={time.atMinute}
                          onChange={(e) =>
                            setTime((t) => ({
                              ...t,
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

              {triggerKind === "event" && (
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

              <div style={previewBoxStyle}>
                <span style={previewEyebrowStyle}>Vorschau</span>
                <div style={previewLabelStyle}>
                  <span aria-hidden>{triggerPreview.icon}</span>{" "}
                  {triggerPreview.label}
                </div>
              </div>
            </div>
          )}

          {/* ---- Step 3 ---- */}
          {step === 3 && (
            <div style={formStackStyle}>
              <div style={radioGroupStyle}>
                {(
                  [
                    {
                      value: "push",
                      label: "Push",
                      hint: "Push-Notification an dein Geraet",
                      icon: <IconWizardPush />,
                    },
                    {
                      value: "ticket",
                      label: "Ticket",
                      hint: "Neues Ticket im Workspace anlegen",
                      icon: <IconWizardTicket />,
                    },
                    {
                      value: "decision",
                      label: "Entscheidung",
                      hint: "Entscheidung anfordern (Push + Log)",
                      icon: <IconWizardScale />,
                    },
                    {
                      value: "log",
                      label: "Nur loggen",
                      hint: "Output wird nur geloggt, kein Dispatch",
                      icon: "·",
                    },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDeliveryKind(opt.value)}
                    aria-pressed={deliveryKind === opt.value}
                    style={{
                      ...radioCardStyle,
                      ...(deliveryKind === opt.value
                        ? radioCardActiveStyle
                        : {}),
                    }}
                  >
                    <span style={radioIconStyle}>{opt.icon}</span>
                    <span style={radioLabelStyle}>{opt.label}</span>
                    <span style={radioHintStyle}>{opt.hint}</span>
                  </button>
                ))}
              </div>

              {deliveryKind === "push" && (
                <>
                  <label style={fieldStyle}>
                    <span style={fieldLabelStyle}>Push-Titel</span>
                    <input
                      type="text"
                      value={pushTitle}
                      onChange={(e) => setPushTitle(e.target.value)}
                      placeholder={name || "z.B. Morgen-Brief"}
                      maxLength={80}
                      style={inputStyle}
                    />
                  </label>
                  <label style={fieldStyle}>
                    <span style={fieldLabelStyle}>Push-Body</span>
                    <textarea
                      value={pushBody}
                      onChange={(e) => setPushBody(e.target.value)}
                      placeholder="Kurztext, max 200 Zeichen"
                      maxLength={200}
                      rows={2}
                      style={textareaStyle}
                    />
                  </label>
                </>
              )}

              {deliveryKind === "decision" && (
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Entscheidungs-Frage</span>
                  <textarea
                    value={decisionQuestion}
                    onChange={(e) => setDecisionQuestion(e.target.value)}
                    placeholder="Was soll entschieden werden?"
                    rows={2}
                    maxLength={200}
                    style={textareaStyle}
                  />
                </label>
              )}

              {deliveryKind === "ticket" && (
                <p style={hintStyle}>
                  Jeder Run legt ein Ticket im Workspace{" "}
                  <strong>{workspaceId}</strong> an.
                </p>
              )}

              {deliveryKind === "log" && (
                <p style={hintStyle}>
                  Output landet nur im Routine-Run-Log (keine Push, kein
                  Ticket).
                </p>
              )}
            </div>
          )}

          {/* ---- Step 4 ---- */}
          {step === 4 && (
            <div style={formStackStyle}>
              <div style={reviewCardStyle}>
                <div style={reviewRowStyle}>
                  <span style={reviewKeyStyle}>Name</span>
                  <span style={reviewValueStyle}>{name}</span>
                </div>
                <div style={reviewRowStyle}>
                  <span style={reviewKeyStyle}>Workspace</span>
                  <span style={reviewValueStyle}>{workspaceId}</span>
                </div>
                {description && (
                  <div style={reviewRowStyle}>
                    <span style={reviewKeyStyle}>Beschreibung</span>
                    <span style={reviewValueStyle}>{description}</span>
                  </div>
                )}
                <div style={reviewRowStyle}>
                  <span style={reviewKeyStyle}>Trigger</span>
                  <span style={reviewValueStyle}>
                    {triggerPreview.icon} {triggerPreview.label}
                  </span>
                </div>
                <div style={reviewRowStyle}>
                  <span style={reviewKeyStyle}>Delivery</span>
                  <span style={reviewValueStyle}>
                    {deliveryKind === "push" && "Push-Notification"}
                    {deliveryKind === "ticket" && "Ticket anlegen"}
                    {deliveryKind === "decision" && "Entscheidung anfordern"}
                    {deliveryKind === "log" && "Nur loggen"}
                  </span>
                </div>
              </div>
              {error && <div style={errorBannerStyle}>{error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer style={footerStyle}>
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              style={secondaryBtnStyle}
              disabled={submitting}
            >
              Zurueck
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              style={secondaryBtnStyle}
            >
              Abbrechen
            </button>
          )}

          {step < 4 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={
                (step === 1 && !canGoToStep2) ||
                (step === 2 && !canGoToStep3)
              }
              style={primaryBtnStyle}
            >
              Weiter
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !canSubmit}
              style={primaryBtnStyle}
            >
              {submitting ? "legt an …" : "Routine anlegen"}
            </button>
          )}
        </footer>
      </div>
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
  zIndex: 1100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "clamp(16px, 4vw, 48px)",
  overflowY: "auto",
};

const modalStyle: React.CSSProperties = {
  width: "min(640px, 100%)",
  maxHeight: "calc(100vh - 48px)",
  background: "var(--sheet-2)",
  border: "0.5px solid var(--line-2)",
  borderRadius: 18,
  boxShadow: "0 40px 100px -20px rgba(0,0,0,0.7)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "20px 24px 12px",
  display: "flex",
  gap: 16,
  alignItems: "flex-start",
  justifyContent: "space-between",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  letterSpacing: "-0.02em",
  margin: "4px 0 0",
  color: "var(--ink)",
  fontWeight: 600,
  fontFamily: "var(--font-display)",
};

const closeBtnStyle: React.CSSProperties = {
  fontSize: 16,
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
};

const progressWrapStyle: React.CSSProperties = {
  padding: "0 24px 12px",
  display: "flex",
  gap: 6,
};

const progressDotStyle: React.CSSProperties = {
  width: 24,
  height: 4,
  borderRadius: 2,
  transition: "background 200ms ease",
};

const bodyStyle: React.CSSProperties = {
  padding: "16px 24px 20px",
  overflowY: "auto",
  flex: 1,
};

const formStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
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
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  outline: "none",
};

const textareaStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 13.5,
  lineHeight: 1.5,
  resize: "vertical",
  minHeight: 72,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "var(--sheet-3)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 13.5,
  cursor: "pointer",
};

const radioGroupStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
};

const radioCardStyle: React.CSSProperties = {
  padding: "14px 14px",
  borderRadius: 12,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  color: "var(--ink-2)",
  transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
};

const radioCardActiveStyle: React.CSSProperties = {
  background: "var(--card-2)",
  borderColor: "var(--ink-2)",
  color: "var(--ink)",
};

const radioIconStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  marginBottom: 2,
};

const radioLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const radioHintStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--ink-3)",
  lineHeight: 1.4,
};

const previewBoxStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const previewEyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
};

const previewLabelStyle: React.CSSProperties = {
  fontSize: 13.5,
  color: "var(--ink)",
};

const reviewCardStyle: React.CSSProperties = {
  padding: "16px 18px",
  borderRadius: 12,
  background: "var(--card)",
  border: "0.5px solid var(--line)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const reviewRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  fontSize: 13.5,
};

const reviewKeyStyle: React.CSSProperties = {
  minWidth: 110,
  color: "var(--ink-3)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  paddingTop: 2,
};

const reviewValueStyle: React.CSSProperties = {
  color: "var(--ink)",
  flex: 1,
  minWidth: 0,
  wordBreak: "break-word",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--ink-3)",
  lineHeight: 1.5,
};

const errorBannerStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--term-err)",
  background: "rgba(255,69,58,0.08)",
  color: "var(--term-err)",
  fontSize: 12.5,
  fontFamily: "var(--font-mono)",
};

const footerStyle: React.CSSProperties = {
  padding: "14px 24px 18px",
  borderTop: "0.5px solid var(--line)",
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};

const primaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid var(--primary)",
  background: "var(--primary)",
  color: "var(--sheet)",
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
};
