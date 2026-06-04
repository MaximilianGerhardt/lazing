/**
 * Geteilte Typen zwischen Server- und Client-Komponenten der Routines-Seite.
 * Keine Business-Logik hier — nur shape.
 */

export interface RoutineSummary {
  id: string;
  name: string;
  workspaceId: string;
  triggerMode: "cron" | "manual" | "event";
  cronExpr: string | null;
  eventMatch: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  // SAR-2 / migration 0099 — plan-dispatch binding (optional, missing = 'shell').
  actionKind?: string | null;
  sopId?: string | null;
  sopName?: string | null;
  goalPrompt?: string | null;
  skillBindingsJson?: string | null;
  mcpToolAllowlistJson?: string | null;
}

export interface RoutineRunSummary {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  error: string | null;
  deliveryRef: string | null;
}
