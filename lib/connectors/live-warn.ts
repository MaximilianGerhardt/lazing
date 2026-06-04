/**
 * Connector LIVE-Mode One-Shot Warn-State — Stream X1 · 2026-05-28.
 *
 * Owner-Direktive #3 (verbatim, N1):
 *   'Alle 3 parallel LIVE flippen"
 *
 * So this does not accidentally incur cost, laz.ing shows a
 * `<surface:live-warn>` card on the VERY FIRST LIVE run of a workspace. As soon
 * as the owner clicks 'OK weiter" or 'Nein, ich prüfe erst", we persist
 * an acknowledgement belief in workspace_beliefs (topic='live-warn-acked').
 * The trigger check is idempotent: clicking twice does not create two beliefs —
 * upsertBelief routes through the supersede mechanism from beliefs-repo.ts
 * (append-only, the old row is retained).
 *
 * Public API:
 *   isLiveWarnAcked(workspaceId)            → boolean
 *   recordLiveWarnAck(workspaceId, decision)→ Belief (verbatim acknowledgement)
 *
 * Design principles:
 *   N1 (Detail preservation): belief / rationale verbatim — no truncation.
 *   N6:                       isLiveWarnAcked is a deterministic read.
 *   N9 (ManifestCoord):       scoped to workspaceId — no cross-scope leak.
 *   N10:                      content_hash via upsertBelief (sha256 canonical).
 *
 * Dependencies: lib/reasoning/beliefs-repo (upsertBelief + listBeliefs),
 *               db/client (getDb for the raw better-sqlite3 handle).
 */

import { getDb } from "@/db/client";
import { listBeliefs, upsertBelief, type Belief } from "@/lib/reasoning/beliefs-repo";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Single canonical topic. Do NOT change without a migration. */
export const LIVE_WARN_TOPIC = "live-warn-acked";

export type LiveWarnDecision = "ack" | "decline";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Has the owner of this workspace already seen + responded to the LIVE-mode
 * warn surface? Returns true ONLY for a positive acknowledgement (decision='ack').
 *
 * Rationale: a 'decline' must NOT silence the warning — if the owner declined,
 * we want the warning to re-appear next time they go LIVE. So we treat the
 * 'decline' beliefs as "not acknowledged" for purposes of suppressing the
 * surface.
 *
 * Fail-soft: any DB error → returns false (re-show the warning). Better to
 * over-warn than to silently hide.
 */
export function isLiveWarnAcked(workspaceId: string): boolean {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return false;
  }
  try {
    const raw = getDb().$raw as unknown as import("better-sqlite3").Database;
    const beliefs = listBeliefs(raw, workspaceId);
    // listBeliefs returns only ACTIVE beliefs (latest per supersede-chain).
    // We accept the most-recent live-warn-acked belief — if its content
    // encodes a positive ack, the surface stays hidden.
    const latest = beliefs.find((b) => b.topic === LIVE_WARN_TOPIC);
    if (!latest) return false;
    // Belief text format encodes the decision verbatim — match prefix.
    return latest.belief.startsWith("ack:");
  } catch {
    return false;
  }
}

/**
 * Record an acknowledgement (or decline) decision for the LIVE-mode warn
 * surface. Idempotent: each call inserts ONE new belief row that supersedes
 * the previous topic-row (if any). Returns the newly-inserted belief.
 *
 * The verbatim N1 belief text is:
 *   'ack: LIVE-Mode bestätigt'   when decision='ack'
 *   'decline: LIVE-Mode pausiert' when decision='decline'
 *
 * The rationale always carries the canonical owner-directive context so the
 * WHY of this entry stays readable later in beliefHistory().
 */
export function recordLiveWarnAck(
  workspaceId: string,
  decision: LiveWarnDecision,
): Belief {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("recordLiveWarnAck: workspaceId required");
  }
  if (decision !== "ack" && decision !== "decline") {
    throw new Error("recordLiveWarnAck: decision must be 'ack' | 'decline'");
  }

  const raw = getDb().$raw as unknown as import("better-sqlite3").Database;

  // Find an existing topic row (if any) for supersede-chain continuity.
  const existing = listBeliefs(raw, workspaceId).find(
    (b) => b.topic === LIVE_WARN_TOPIC,
  );

  const belief =
    decision === "ack"
      ? "ack: LIVE-Mode bestätigt"
      : "decline: LIVE-Mode pausiert";
  const rationale =
    decision === "ack"
      ? "Owner hat die LIVE-Mode-Warn-Surface bewusst quittiert. Provider-Budgets gesetzt? — wurde explizit OK gegeben. Stream X1, Owner-Direktive #3."
      : "Owner hat die LIVE-Mode-Warn-Surface explizit zurückgewiesen — Provider-Budgets sollen zuerst geprüft werden. Warnung erscheint beim nächsten LIVE-Lauf erneut. Stream X1, Owner-Direktive #3.";

  return upsertBelief(raw, {
    workspaceId,
    topic: LIVE_WARN_TOPIC,
    belief,
    rationale,
    source: "user",
    supersedesId: existing?.id ?? null,
  });
}
