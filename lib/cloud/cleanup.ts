/**
 * Cleanup-Cron-Helper (Phase ORG+3 — 2026-04-28).
 *
 * Consolidates all periodic cleanup jobs:
 *   1. Magic tokens: purge where `purge_after < now`
 *   2. Share tokens: purge where expired AND unused for 7d
 *   3. Soft-deleted artifacts: remove storage bytes PERMANENTLY when
 *      `deleted_at < now - 90d` (GDPR retention; default 90 days,
 *      env-configurable via LAZYOS_CLOUD_RETENTION_DAYS)
 *   4. Audit log: prune rows older than
 *      LAZYOS_AUDIT_RETENTION_DAYS (default 730 = 2 years)
 *
 * No throw — all cleanup steps are best-effort. Results are
 * collected as JSON.
 */

import { lt, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { auditLog } from "@/db/schema/audit_log";
import { cloudArtifacts } from "@/db/schema/cloud";
import { purgeExpiredTokens } from "@/lib/auth/magic-link";
import { purgeExpiredShares } from "./share";
import { getStorageBackend, getEncryptedStorageBackend } from "./storage";
import { isEncryptionAvailable } from "@/lib/encryption/master-key";

export interface CleanupResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: {
    magicTokensPurged: number;
    shareTokensPurged: number;
    softDeletedArtifactsRemoved: number;
    softDeletedStorageFreed: number;
    auditRowsPruned: number;
  };
  errors: string[];
}

const DEFAULT_CLOUD_RETENTION_DAYS = 90;
const DEFAULT_AUDIT_RETENTION_DAYS = 730;

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export async function runCloudCleanup(): Promise<CleanupResult> {
  const startedAt = new Date();
  const errors: string[] = [];
  let magicTokensPurged = 0;
  let shareTokensPurged = 0;
  let softDeletedArtifactsRemoved = 0;
  let softDeletedStorageFreed = 0;
  let auditRowsPruned = 0;

  // 1. Magic-Tokens.
  try {
    const r = purgeExpiredTokens(startedAt);
    magicTokensPurged = r.deleted;
  } catch (err) {
    errors.push(`magic-tokens: ${(err as Error).message}`);
  }

  // 2. Share-Tokens.
  try {
    const r = purgeExpiredShares(startedAt);
    shareTokensPurged = r.deleted;
  } catch (err) {
    errors.push(`share-tokens: ${(err as Error).message}`);
  }

  // 3. Soft-deleted artifacts: remove PERMANENTLY per retention.
  try {
    const retentionDays = envDays(
      "LAZYOS_CLOUD_RETENTION_DAYS",
      DEFAULT_CLOUD_RETENTION_DAYS,
    );
    const cutoff = startedAt.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const db = getDb();
    const candidates = db
      .select({
        id: cloudArtifacts.id,
        storagePath: cloudArtifacts.storagePath,
        bytes: cloudArtifacts.bytes,
        encryptionVersion: cloudArtifacts.encryptionVersion,
      })
      .from(cloudArtifacts)
      .where(
        sql`${cloudArtifacts.deletedAt} IS NOT NULL AND ${cloudArtifacts.deletedAt} < ${cutoff}`,
      )
      .all();
    const plain = getStorageBackend();
    const encrypted = isEncryptionAvailable()
      ? getEncryptedStorageBackend()
      : null;
    for (const row of candidates) {
      const backend =
        row.encryptionVersion >= 1 && encrypted ? encrypted : plain;
      try {
        await backend.delete(row.storagePath);
        softDeletedStorageFreed += row.bytes;
      } catch {
        // File may already be gone — no matter, we purge the DB row anyway.
      }
      // Hard-delete the DB row.
      db.$raw
        .prepare("DELETE FROM cloud_artifacts WHERE id = ?")
        .run(row.id);
      softDeletedArtifactsRemoved += 1;
    }
  } catch (err) {
    errors.push(`soft-deleted-artifacts: ${(err as Error).message}`);
  }

  // 4. Audit-Log Prune.
  try {
    const retentionDays = envDays(
      "LAZYOS_AUDIT_RETENTION_DAYS",
      DEFAULT_AUDIT_RETENTION_DAYS,
    );
    const cutoff = new Date(
      startedAt.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    );
    const db = getDb();
    const r = db
      .delete(auditLog)
      .where(lt(auditLog.ts, cutoff))
      .run() as unknown as { changes?: number };
    auditRowsPruned = r.changes ?? 0;
  } catch (err) {
    errors.push(`audit-log: ${(err as Error).message}`);
  }

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: {
      magicTokensPurged,
      shareTokensPurged,
      softDeletedArtifactsRemoved,
      softDeletedStorageFreed,
      auditRowsPruned,
    },
    errors,
  };
}
