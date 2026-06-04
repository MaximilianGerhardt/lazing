/**
 * Drizzle schema for workspace sub-chats (gathering-intelligence goal, 2026-06-02).
 *
 * Sub-chats are group chats WITHIN a workspace/project — with external
 * customers (access via share token, no login) or the internal team. Purpose:
 * every message flows centrally as knowledge into the workspace RAG, so the
 * main-chat agent can use the gathered knowledge.
 *
 * Architecture:
 *   - Workspace-scoped (N9 ManifestCoord = workspace_id; N2 scope envelope).
 *   - Append-only messages; ingestion into `rag_chunks` (workspace-isolated).
 *   - External access: `share_token_hash` (sha256 of the raw token; the raw token is
 *     shown only once at creation) — no account needed.
 *   - The AI in sub-chats is silent by default; for internal users optional answer suggestions
 *     (a separate layer, not persisted here).
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const subchats = sqliteTable(
  'subchats',
  {
    /** ULID, prefix `SC-`. */
    id: text('id').primaryKey(),
    /** Scope (N9). FK-artig auf workspaces.id (kein harter FK — Single-User-MVP). */
    workspaceId: text('workspace_id').notNull(),
    /** Anzeigename, z.B. "Demo PV — Onboarding". N1 verbatim. */
    title: text('title').notNull(),
    /** Mit wem: 'external' (Kunde) | 'internal' (Team). */
    kind: text('kind').notNull().default('external'),
    /** Optionaler Kontext/Zweck (verbatim). */
    description: text('description'),
    /** User, der den Sub-Chat angelegt hat. */
    createdByUserId: text('created_by_user_id'),
    /** sha256(rawToken) für externen Link-Zugang. NULL = kein externer Zugang. */
    shareTokenHash: text('share_token_hash'),
    /** Externer Zugang abgelaufen? Epoch ms; NULL = unbefristet. */
    shareExpiresAt: integer('share_expires_at'),
    /** Externer Zugang widerrufen? Epoch ms. */
    shareRevokedAt: integer('share_revoked_at'),
    /** 'active' | 'archived'. */
    status: text('status').notNull().default('active'),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    byWorkspace: index('idx_subchats_workspace').on(table.workspaceId),
    byShareToken: index('idx_subchats_share_token').on(table.shareTokenHash),
  }),
);

export const subchatMessages = sqliteTable(
  'subchat_messages',
  {
    /** ULID, prefix `SCM-`. */
    id: text('id').primaryKey(),
    subchatId: text('subchat_id').notNull(),
    /** Denormalisiert für Scope-Filter + RAG-Ingestion (N2). */
    workspaceId: text('workspace_id').notNull(),
    /** 'internal' (Team-User) | 'external' (Kunde via Token) | 'system'. */
    authorKind: text('author_kind').notNull(),
    /** User-ID bei internal; bei external eine flüchtige Session-ID; NULL bei system. */
    authorId: text('author_id'),
    /** Anzeigename (Externe geben einen Namen an). */
    authorName: text('author_name'),
    /** N1: VERBATIM, nie truncated. */
    content: text('content').notNull(),
    /**
     * Attachments (documents/media/photos) as a JSON array. NULL/'' = none.
     * Form: [{ artifactId, filename, mime, bytes, kind:'image'|'file' }].
     * The bytes live in the cloud artifact store (lib/cloud); only a reference here.
     */
    attachments: text('attachments'),
    /** 0/1 — schon in rag_chunks ingestet? (Idempotenz der Wissens-Aufnahme). */
    ingested: integer('ingested').notNull().default(0),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    bySubchat: index('idx_subchat_messages_subchat').on(table.subchatId, table.createdAt),
    byWorkspace: index('idx_subchat_messages_workspace').on(table.workspaceId),
    byIngest: index('idx_subchat_messages_ingest').on(table.ingested),
  }),
);

export type SubchatRow = typeof subchats.$inferSelect;
export type SubchatMessageRow = typeof subchatMessages.$inferSelect;
