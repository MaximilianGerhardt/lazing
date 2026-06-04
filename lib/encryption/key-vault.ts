/**
 * Key-Vault (Phase ORG+1).
 *
 * Fetches the DEK for a workspace. If absent: lazy-create
 * (random DEK + wrap with master KEK + DB insert). DEK plaintext lives
 * only briefly in memory; in-process LRU cache, never persistent.
 *
 * If the master KEK is not set: throw — the caller must check via
 * `isEncryptionAvailable()` beforehand.
 */

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  workspaceKeys,
  type WorkspaceKeyRow,
} from "@/db/schema/workspace_keys";
import { ulid } from "@/lib/ulid";

import { aesGcmDecrypt, aesGcmEncrypt, newDek } from "./aes-gcm";
import { getMasterKey } from "./master-key";

/** Small per-process LRU cache. Workspace DEKs are small (32 bytes). */
const dekCache = new Map<string, Buffer>();
const MAX_CACHE_SIZE = 50;

function cachePut(workspaceId: string, dek: Buffer): void {
  if (dekCache.size >= MAX_CACHE_SIZE) {
    const first = dekCache.keys().next().value;
    if (first !== undefined) dekCache.delete(first);
  }
  dekCache.set(workspaceId, dek);
}

function findActiveKeyRow(workspaceId: string): WorkspaceKeyRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(workspaceKeys)
    .where(eq(workspaceKeys.workspaceId, workspaceId))
    .orderBy(sql`${workspaceKeys.keyVersion} DESC`)
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/**
 * Get-or-create for a workspace's DEK. Returns a 32-byte buffer.
 * @throws if the master KEK is unavailable or wrap/unwrap fails
 */
export function getWorkspaceDek(workspaceId: string): Buffer {
  const cached = dekCache.get(workspaceId);
  if (cached) return cached;

  const master = getMasterKey();
  if (!master) {
    throw new Error(
      "encryption-not-configured: LAZYOS_MASTER_KEK not set — set 64-hex-char env to enable",
    );
  }

  const existing = findActiveKeyRow(workspaceId);
  if (existing) {
    const wrapped = Buffer.from(existing.wrappedDek, "base64url");
    const dek = aesGcmDecrypt(master.buffer, wrapped);
    if (dek.length !== 32) {
      throw new Error(
        `unwrap returned wrong DEK length ${dek.length} for workspace ${workspaceId}`,
      );
    }
    cachePut(workspaceId, dek);
    return dek;
  }

  // Lazy-create.
  const dek = newDek();
  const wrapped = aesGcmEncrypt(master.buffer, dek);
  const wrappedB64 = wrapped.toString("base64url");

  const db = getDb();
  const now = new Date();
  db.insert(workspaceKeys)
    .values({
      id: `wsk_${ulid()}`,
      workspaceId,
      wrappedDek: wrappedB64,
      keyVersion: 1,
      createdAt: now,
      rotatedAt: null,
    })
    .run();

  cachePut(workspaceId, dek);
  return dek;
}

/** Test-Helper. */
export function _clearDekCacheForTests(): void {
  dekCache.clear();
}
