/**
 * Audit-Log-Helper (Phase ORG SP-3 + SP-4).
 *
 * Writes auth/identity/org events into the `audit_log` table.
 * Keep simple: synchronous via better-sqlite3, fail-soft (no throw).
 */

import { getDb } from "@/db/client";
import { auditLog, type AuditLogInsert } from "@/db/schema/audit_log";
import { ulid } from "@/lib/ulid";

export interface WriteAuditInput {
  actor: string;
  action: string;
  orgId?: string | null;
  workspaceId?: string | null;
  targetUserId?: string | null;
  /** Optional ARTIFACT reference for cloud audit. Phase ORG+2. */
  artifactId?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export function writeAudit(input: WriteAuditInput): void {
  try {
    const db = getDb();
    // artifactId is not its own column — we pack it into the payload JSON
    // so audit queries can do `payload->>'artifactId'`.
    const payloadObj: Record<string, unknown> = { ...(input.payload ?? {}) };
    if (input.artifactId) payloadObj.artifactId = input.artifactId;
    const insert: AuditLogInsert = {
      id: `aud_${ulid()}`,
      ts: new Date(),
      actor: input.actor,
      action: input.action,
      orgId: input.orgId ?? null,
      workspaceId: input.workspaceId ?? null,
      targetUserId: input.targetUserId ?? null,
      payload: Object.keys(payloadObj).length > 0
        ? JSON.stringify(payloadObj)
        : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    };
    db.insert(auditLog).values(insert).run();
  } catch (err) {
    console.warn(
      "[audit] write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
