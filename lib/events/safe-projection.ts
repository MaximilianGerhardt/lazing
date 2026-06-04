/**
 * Safe-Projection-Wrapper
 * -----------------------
 * Views (`/`, `/decisions`, `/lanes`, `/calendar`) call the event
 * projections through this, so a transient DB error does not crash the page
 * completely. Semantics: on error → empty result +
 * error log (NO longer: fallback theater with demo data).
 *
 * Sprint 2 · Section 7C: `fallback-data.ts` was removed. If the
 * DB is empty, the pages look empty — that is the truth state
 * until the user creates real tickets (or the dev seed runs).
 */

import { emitErrorEvent } from "./emit";
import {
  getSegmentCounts,
  projectDecisions,
  projectTickets,
} from "./project";
import type {
  DecisionProjection,
  TicketProjection,
  WorkspaceId,
} from "./types";

export async function safeProjectTickets(
  workspaceId?: WorkspaceId,
): Promise<TicketProjection[]> {
  try {
    return await projectTickets(workspaceId);
  } catch (err) {
    console.error("[lazyos] safeProjectTickets failed:", err);
    await emitErrorEvent(workspaceId ?? "lazyos", "safeProjectTickets", err).catch(
      () => undefined,
    );
    return [];
  }
}

export async function safeProjectDecisions(
  workspaceId?: WorkspaceId,
  limit?: number,
): Promise<DecisionProjection[]> {
  try {
    return await projectDecisions(workspaceId, limit);
  } catch (err) {
    console.error("[lazyos] safeProjectDecisions failed:", err);
    await emitErrorEvent(workspaceId ?? "lazyos", "safeProjectDecisions", err).catch(
      () => undefined,
    );
    return [];
  }
}

/**
 * Returns open/total counts per workspace ID. Keys are dynamic —
 * anyone expecting a fixed shape (e.g. `counts['@north']`) must switch to
 * `safeWorkspaceOpenCounts()` below.
 */
export async function safeGetSegmentCounts(): Promise<
  Record<WorkspaceId, number>
> {
  try {
    const full = await getSegmentCounts();
    const out: Record<WorkspaceId, number> = {};
    for (const [id, v] of Object.entries(full)) {
      out[id] = v.open;
    }
    return out;
  } catch (err) {
    console.error("[lazyos] safeGetSegmentCounts failed:", err);
    await emitErrorEvent("lazyos", "safeGetSegmentCounts", err).catch(
      () => undefined,
    );
    return {};
  }
}
