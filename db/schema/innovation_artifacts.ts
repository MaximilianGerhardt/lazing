/**
 * Drizzle schema for `innovation_artifacts`
 * (migration 0121 · Lane D Innovation Mode · Phase IN · 2026-05-29).
 *
 * Source: master briefing §10 (Innovation Mode) +
 *         lib/innovate/contract.ts (innovation-button contract).
 *
 * This table is the additively added substrate for the Innovation-Mode
 * outputs (§10.4 artifacts before build): assumption map · reframe set ·
 * cross-domain analogies · contrarian roast · concept graph (nodes + edges).
 *
 * Discipline:
 *   - N1:  content / source_json VERBATIM (no .slice).
 *   - N4:  purely additive — nothing changed; the contrarian roast reuses
 *          the existing counter-evidence surface logic (reconcile.ts).
 *   - N8:  append-only (trigger in 0121) — every UPDATE + DELETE blocks;
 *          a correction is a new row with supersedes_id.
 *   - N9:  workspaceId-scoped, ManifestCoord-analogous. NO hard FK on
 *          workspaces.
 *   - N10: content_hash (sha256 over canonical JSON) per row.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const innovationArtifacts = sqliteTable(
  "innovation_artifacts",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /**
     * One of the 6 artifact kinds (§10.4):
     *   assumption | reframe | cross-domain-analogy | contrarian-roast |
     *   concept-node | concept-edge.
     */
    kind: text("kind").notNull(),
    /** Core statement of the artifact, VERBATIM (N1). */
    content: text("content").notNull(),
    /**
     * JSON provenance, VERBATIM (N1):
     *   { rawTextHash?: string;       // source as-is state (assumption)
     *     fromAssumptionId?: string;  // reframe → assumption (reframe)
     *     sourceNodeId?: string;      // concept-edge endpoint
     *     targetNodeId?: string;      // concept-edge endpoint
     *     proposal?: string;          // contrarian-roast: the attacked proposal
     *     verdict?: string }          // contrarian-roast: counter-evidence verdict
     */
    sourceJson: text("source_json"),
    /** Supersedes an older row (nullable; history is preserved). */
    supersedesId: text("supersedes_id"),
    /** N10 tamper evidence. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkspaceKind: index("idx_innovation_ws_kind").on(
      table.workspaceId,
      table.kind,
    ),
    bySupersedes: index("idx_innovation_supersedes").on(table.supersedesId),
    byHash: index("idx_innovation_hash").on(table.contentHash),
  }),
);

export type InnovationArtifactRow = typeof innovationArtifacts.$inferSelect;
export type InnovationArtifactInsert = typeof innovationArtifacts.$inferInsert;
