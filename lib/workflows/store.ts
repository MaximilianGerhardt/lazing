/**
 * Workflow run store — Pattern 4 foundation (2026-05-01).
 *
 * CRUD over `workflow_runs`. Writes Drizzle-type-safe, reads into the
 * `WorkflowRun` domain object (data_json → object, status → typed enum).
 *
 * Fail-soft: if a persist operation fails, it throws. The caller
 * (runner) decides whether that makes the workflow stuck — a persist failure is
 * not the same as a domain failure.
 */

import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { workflowRuns, type WorkflowRunStatusValue } from '@/db/schema/workflow_runs';
import { ulid } from '@/lib/ulid';

import type {
  WorkflowId,
  WorkflowRun,
  WorkflowRunStatus,
} from './dsl';

export interface CreateRunInput {
  workflowId: WorkflowId;
  definitionVersion: 'v1' | 'v2' | 'v3';
  workspaceId?: string | null;
  workstreamId?: string | null;
  initialState: string;
  initialData?: Record<string, unknown>;
}

function rowToRun(row: {
  id: string;
  workflowId: string;
  definitionVersion: string;
  workspaceId: string | null;
  workstreamId: string | null;
  currentState: string;
  dataJson: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastTransitionAt: number;
}): WorkflowRun {
  let parsed: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(row.dataJson) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    // corrupted data_json → behave as empty; the runner can detect
    // missing keys itself.
  }

  return {
    id: row.id,
    workflowId: row.workflowId as WorkflowId,
    definitionVersion: row.definitionVersion as 'v1' | 'v2' | 'v3',
    workspaceId: row.workspaceId,
    workstreamId: row.workstreamId,
    currentState: row.currentState,
    data: parsed,
    status: row.status as WorkflowRunStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastTransitionAt: row.lastTransitionAt,
  };
}

export async function createRun(input: CreateRunInput): Promise<WorkflowRun> {
  const db = getDb();
  const now = Date.now();
  const id = `wfr_${ulid()}`;
  const initialData = input.initialData ?? {};

  await db.insert(workflowRuns).values({
    id,
    workflowId: input.workflowId,
    definitionVersion: input.definitionVersion,
    workspaceId: input.workspaceId ?? null,
    workstreamId: input.workstreamId ?? null,
    currentState: input.initialState,
    dataJson: JSON.stringify(initialData),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastTransitionAt: now,
  });

  return {
    id,
    workflowId: input.workflowId,
    definitionVersion: input.definitionVersion,
    workspaceId: input.workspaceId ?? null,
    workstreamId: input.workstreamId ?? null,
    currentState: input.initialState,
    data: initialData,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastTransitionAt: now,
  };
}

export async function loadRun(runId: string): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return rowToRun(row);
}

export interface UpdateStateInput {
  runId: string;
  newState?: string;
  newData?: Record<string, unknown>;
  status?: WorkflowRunStatus;
  /**
   * If `true`, `lastTransitionAt` is set to now. That is the
   * default assumption on a status change OR state change. Only on a
   * pure data update (same state, same status) does the
   * runner pass `false`.
   */
  bumpTransitionTs?: boolean;
}

export async function updateState(input: UpdateStateInput): Promise<void> {
  const db = getDb();
  const now = Date.now();

  const existing = await loadRun(input.runId);
  if (!existing) {
    throw new Error(`workflow run not found: ${input.runId}`);
  }

  const newState = input.newState ?? existing.currentState;
  const status: WorkflowRunStatusValue = (input.status ?? existing.status) as WorkflowRunStatusValue;
  const data = input.newData ?? existing.data;
  const stateChanged = input.newState !== undefined && input.newState !== existing.currentState;
  const statusChanged = input.status !== undefined && input.status !== existing.status;
  const bump = input.bumpTransitionTs ?? (stateChanged || statusChanged);

  await db
    .update(workflowRuns)
    .set({
      currentState: newState,
      dataJson: JSON.stringify(data),
      status,
      updatedAt: now,
      lastTransitionAt: bump ? now : existing.lastTransitionAt,
    })
    .where(eq(workflowRuns.id, input.runId));
}
