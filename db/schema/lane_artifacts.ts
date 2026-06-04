/**
 * Drizzle schema for `lane_artifacts`
 * (migration 0122 · Lanes C/E/F · Phase 2 W2.3 · 2026-05-29).
 *
 * Source: master context §5 (parallel discovery portfolio) Lanes C/E/F +
 *         integration plan §4 (parallel lanes).
 *
 * This table is the additively added substrate for the three previously
 * missing discovery lanes:
 *   - Lane C  Role Reverse Engineering  (role-model · decision-map ·
 *             dependency-map · automation-boundary)
 *   - Lane E  Toolstack Replacement     (tool-replacement)
 *   - Lane F  Mobile Human-in-the-Loop  (hitl-rule)
 *
 * Discipline:
 *   - N1:  content / source_json VERBATIM (no .slice).
 *   - N4:  purely additive — nothing changed; Lane F builds on lib/push/*.
 *   - N8:  append-only (trigger in 0122) — every UPDATE + DELETE blocks;
 *          a correction is a new row with supersedes_id.
 *   - N9:  workspaceId-scoped, ManifestCoord-analogous. NO hard FK on
 *          workspaces.
 *   - N10: content_hash (sha256 over canonical JSON) per row.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const laneArtifacts = sqliteTable(
  "lane_artifacts",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /** The discovery lane: 'c' (role-reverse) | 'e' (toolstack) | 'f' (mobile-hitl). */
    lane: text("lane").notNull(),
    /**
     * The artifact kind (CHECK in 0122):
     *   role-model | decision-map | dependency-map | automation-boundary  (Lane C)
     *   tool-replacement                                                  (Lane E)
     *   hitl-rule                                                         (Lane F)
     */
    kind: text("kind").notNull(),
    /** Core statement of the artifact, VERBATIM (N1). */
    content: text("content").notNull(),
    /** JSON provenance/structure, VERBATIM (N1). */
    sourceJson: text("source_json"),
    /** Supersedes an older row (nullable; history is preserved). */
    supersedesId: text("supersedes_id"),
    /** N10 tamper evidence. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkspaceLaneKind: index("idx_lane_artifacts_ws_lane_kind").on(
      table.workspaceId,
      table.lane,
      table.kind,
    ),
    bySupersedes: index("idx_lane_artifacts_supersedes").on(table.supersedesId),
    byHash: index("idx_lane_artifacts_hash").on(table.contentHash),
  }),
);

export type LaneArtifactRow = typeof laneArtifacts.$inferSelect;
export type LaneArtifactInsert = typeof laneArtifacts.$inferInsert;
