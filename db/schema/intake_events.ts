/**
 * Drizzle schema for `intake_events`
 * (migration 0119 · Lane A Communication Intake · Phase 2 W2.2 · 2026-05-29).
 *
 * Source: master briefing §25.1 (Lane A) + §7.2 (no-auto-run) + §7.3 (pipeline).
 *
 * This table is the additively added substrate for the incoming
 * communication (WhatsApp/Telegram/Voice/Meeting/...) that Lane A stages
 * verbatim, classifies and makes available for Lane B (expertise compiler, 0120)
 * — NO auto-run (§7.2).
 *
 * Discipline:
 *   - N1:  raw_content VERBATIM (no .slice/.substring).
 *   - N4:  purely additive — nothing changed; Lane B reads from it later.
 *   - N8:  append-only-light (trigger in 0119) — UPDATE on nudge_class /
 *          fsm_state / speaker_local_id / updated_at allowed;
 *          id/workspace_id/source_kind/raw_content/content_hash immutable.
 *   - N9:  workspaceId-scoped, ManifestCoord-analogous. NO hard FK on
 *          workspaces.
 *   - N10: content_hash (sha256 over canonical JSON) per row → idempotency.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const intakeEvents = sqliteTable(
  "intake_events",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /** ID from the external system (nullable). */
    externalId: text("external_id"),
    /** = DataSource (lib/governance/consent.ts), CHECK in the migration. */
    sourceKind: text("source_kind").notNull(),
    /** External speaker ID (nullable). */
    speakerExternalId: text("speaker_external_id"),
    /** Mapped local user/contact (nullable; speaker resolution). */
    speakerLocalId: text("speaker_local_id"),
    /** ms epoch, when the source originated (not: when we see it). */
    receivedAt: integer("received_at").notNull(),
    /** public | internal | confidential | restricted (CHECK in the migration). */
    sensitivity: text("sensitivity").notNull(),
    /** VERBATIM Inhalt (N1). KEIN slice. */
    rawContent: text("raw_content").notNull(),
    /** text | audio | image | video | pdf | html (CHECK in Migration). */
    rawContentType: text("raw_content_type").notNull(),
    /** Reply/Forward-Kette — Soft-FK auf intake_events.id (nullable). */
    parentEnvelopeId: text("parent_envelope_id"),
    /** Nullable bis Schritt 3: urgent | decision-needed | info-only | noise. */
    nudgeClass: text("nudge_class"),
    /** No-auto-run-FSM: staged | classified | ready-for-compile | blocked. */
    fsmState: text("fsm_state").notNull(),
    /** N10 Tamper-Evidenz. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspaceState: index("idx_intake_ws_state").on(
      table.workspaceId,
      table.fsmState,
    ),
    byWorkspaceNudge: index("idx_intake_ws_nudge").on(
      table.workspaceId,
      table.nudgeClass,
    ),
    byHash: index("idx_intake_hash").on(table.contentHash),
    byParent: index("idx_intake_parent").on(table.parentEnvelopeId),
  }),
);

export type IntakeEventRow = typeof intakeEvents.$inferSelect;
export type IntakeEventInsert = typeof intakeEvents.$inferInsert;
