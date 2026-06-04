/**
 * Sensitivity-floor enforcement.
 *
 *   autoUpgrade():   @private → always sensitivity=high, regardless of caller
 *   signPayload():   Produces an HMAC over the canonical payload JSON
 *                    for high-sensitivity events. Attached as `event.signature`.
 *   verifyPayload(): Constant-time signature check for replay/integrity.
 *
 * The HMAC secret is `LAZYOS_AUTH_SECRET` (reused — single-user model,
 * no need for a separate "event integrity" secret). If the secret is
 * unset we DO NOT block: we just skip signing and surface that via
 * `signed: false` in the return tuple so emitEvent can log it.
 */

import { hmacSha256Hex, hmacSha256Verify } from "./crypto";
import type { SegmentId, Sensitivity } from "../events/types";

/**
 * Force sensitivity upgrade for known sensitive workspaces.
 *
 * Floor policy (Sprint 2 · 7C):
 *   - 'private' → always 'high' (Max's personal matters)
 *   - 'example-app-*' → always 'high' (external client context)
 *   - '@private' (legacy) → always 'high'
 *   - '@system'  (legacy) → default 'medium'
 *   - otherwise: requested or 'low'
 */
export function autoUpgrade(
  segmentId: SegmentId,
  requested: Sensitivity | undefined,
): Sensitivity {
  if (segmentId === "private" || segmentId === "@private") return "high";
  if (segmentId.startsWith("example-app-")) return "high";
  if (requested) return requested;
  if (segmentId === "@system") return "medium";
  return "low";
}

/**
 * Canonical string for signing. We do NOT rely on `JSON.stringify`
 * key ordering — we build a sorted representation so different
 * serializations of the same logical payload yield the same signature.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

export interface SignableFields {
  id: string;
  createdAt: number;
  segmentId: SegmentId;
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  sensitivity: Sensitivity;
}

function signingMessage(f: SignableFields): string {
  return canonicalize({
    id: f.id,
    createdAt: f.createdAt,
    segmentId: f.segmentId,
    entityType: f.entityType,
    entityId: f.entityId,
    eventType: f.eventType,
    actor: f.actor,
    payload: f.payload,
    sensitivity: f.sensitivity,
  });
}

export interface SignResult {
  signed: boolean;
  signature?: string;
}

export async function signPayload(
  fields: SignableFields,
): Promise<SignResult> {
  const secret = process.env.LAZYOS_AUTH_SECRET;
  if (!secret || secret.length < 16) return { signed: false };
  const signature = await hmacSha256Hex(secret, signingMessage(fields));
  return { signed: true, signature };
}

export async function verifyPayload(
  fields: SignableFields,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) return false;
  const secret = process.env.LAZYOS_AUTH_SECRET;
  if (!secret || secret.length < 16) return false;
  return hmacSha256Verify(secret, signingMessage(fields), signature);
}
