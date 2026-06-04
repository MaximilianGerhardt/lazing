/**
 * lib/subchats/service.ts — service layer for workspace sub-chats
 * (gathering-intelligence goal, 2026-06-02).
 *
 * Group chats per workspace (external customers via share token / internal team).
 * Each message is persisted append-only AND best-effort ingested into the
 * workspace RAG (workspace-isolated, N2). The AI is silent in the sub-chat
 * itself — the gathered knowledge makes the main chat smarter.
 *
 * The ONLY insert path for subchats/subchat_messages (UI/API go through here).
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { subchats, subchatMessages, type SubchatRow, type SubchatMessageRow } from '@/db/schema/subchats';
import { subchatReadMarkers } from '@/db/schema/subchat_read_markers';
import { ragChunks } from '@/db/schema/rag';
import { proactiveSuggestions, type ProactiveSuggestionRow } from '@/db/schema/proactive_suggestions';
export type { SubchatRow, SubchatMessageRow } from '@/db/schema/subchats';
export type { ProactiveSuggestionRow } from '@/db/schema/proactive_suggestions';
import { ulid } from '@/lib/ulid';
import { getArtifactWorkspaceId } from '@/lib/cloud/service';

const TOKEN_PREFIX = 'sc_';

/** Attachment on a sub-chat message (reference to a cloud artifact). */
export interface SubchatAttachment {
  artifactId: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: 'image' | 'file';
}

/**
 * Sanitize + SECURE incoming attachment references (from the request body):
 * each reference must point to a cloud artifact that belongs to the expected
 * workspace (otherwise dropped). That way nobody can pull foreign artifacts into a sub-chat.
 */
export function sanitizeAttachments(input: unknown, workspaceId: string): SubchatAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: SubchatAttachment[] = [];
  for (const raw of input.slice(0, 10)) {
    const o = raw as Record<string, unknown>;
    const artifactId = typeof o?.artifactId === 'string' ? o.artifactId : '';
    if (!artifactId) continue;
    if (getArtifactWorkspaceId(artifactId) !== workspaceId) continue; // foreign/unknown → discard
    const mime = typeof o.mime === 'string' ? o.mime : 'application/octet-stream';
    out.push({
      artifactId,
      filename: typeof o.filename === 'string' ? o.filename.slice(0, 200) : 'Datei',
      mime,
      bytes: typeof o.bytes === 'number' ? o.bytes : 0,
      kind: o.kind === 'image' || mime.startsWith('image/') ? 'image' : 'file',
    });
  }
  return out;
}

/** Safe parsing of the attachments JSON column (never throws). */
export function parseAttachments(raw: string | null | undefined): SubchatAttachment[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a): a is SubchatAttachment => {
        const o = a as Record<string, unknown>;
        return (
          o != null &&
          typeof o.artifactId === 'string' &&
          typeof o.filename === 'string' &&
          typeof o.mime === 'string'
        );
      })
      .map((a) => ({
        artifactId: a.artifactId,
        filename: a.filename,
        mime: a.mime,
        bytes: typeof a.bytes === 'number' ? a.bytes : 0,
        kind: a.kind === 'image' ? 'image' : (a.mime.startsWith('image/') ? 'image' : 'file'),
      }));
  } catch {
    return [];
  }
}

export function hashSubchatToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
function newRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export interface CreateSubchatInput {
  workspaceId: string;
  title: string;
  kind?: 'external' | 'internal';
  description?: string;
  createdByUserId?: string;
  /** Create external token access (default true for kind='external'). */
  external?: boolean;
  /** Token lifetime in hours (default 720 = 30 days); 0/undef = unlimited. */
  expiresInHours?: number;
}

export interface CreateSubchatResult {
  subchat: SubchatRow;
  /** Raw token returned ONLY here (once); only the hash in the DB. */
  rawToken: string | null;
}

export function createSubchat(input: CreateSubchatInput): CreateSubchatResult {
  const db = getDb();
  const now = Date.now();
  const id = `SC-${ulid(now)}`;
  const kind = input.kind === 'internal' ? 'internal' : 'external';
  const wantExternal = input.external ?? kind === 'external';
  let rawToken: string | null = null;
  let shareTokenHash: string | null = null;
  let shareExpiresAt: number | null = null;
  if (wantExternal) {
    rawToken = newRawToken();
    shareTokenHash = hashSubchatToken(rawToken);
    if (input.expiresInHours && input.expiresInHours > 0) {
      shareExpiresAt = now + input.expiresInHours * 3600_000;
    }
  }
  db.insert(subchats)
    .values({
      id,
      workspaceId: input.workspaceId,
      title: input.title.trim().slice(0, 200) || 'Sub-Chat',
      kind,
      description: input.description?.trim() || null,
      createdByUserId: input.createdByUserId ?? null,
      shareTokenHash,
      shareExpiresAt,
      shareRevokedAt: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const subchat = getSubchat(id)!;
  return { subchat, rawToken };
}

export function listSubchats(workspaceId: string): SubchatRow[] {
  const db = getDb();
  return db
    .select()
    .from(subchats)
    .where(and(eq(subchats.workspaceId, workspaceId), eq(subchats.status, 'active')))
    .orderBy(desc(subchats.updatedAt))
    .all();
}

/**
 * Activity snapshot per workspace for the proactive main-chat card
 * (bring gathering-intelligence into the main chat, 2026-06-02).
 *
 * Returns, per sub-chat, the last message (preview), the timestamp of the
 * last EXTERNAL message, and the external total count. `content` is returned in
 * FULL (no .slice — N1); the UI clamps via CSS. The „new since"
 * decision is made by the client against a local seen map (no additional
 * DB table needed, fully reversible).
 */
export interface SubchatActivity {
  id: string;
  title: string;
  kind: 'external' | 'internal';
  lastMessage: {
    authorKind: 'internal' | 'external' | 'system';
    authorName: string | null;
    content: string;
    ts: number;
  } | null;
  lastExternalTs: number | null;
  externalCount: number;
  /** Unread foreign non-system messages for the viewer. 0 without a viewer. */
  unreadCount: number;
}

export function getSubchatActivity(workspaceId: string, viewerUserId?: string): SubchatActivity[] {
  const db = getDb();
  const rows = listSubchats(workspaceId);
  return rows.map((sc) => {
    const last =
      db
        .select()
        .from(subchatMessages)
        .where(eq(subchatMessages.subchatId, sc.id))
        .orderBy(desc(subchatMessages.createdAt))
        .limit(1)
        .all()[0] ?? null;
    const lastExt =
      db
        .select()
        .from(subchatMessages)
        .where(
          and(
            eq(subchatMessages.subchatId, sc.id),
            eq(subchatMessages.authorKind, 'external'),
          ),
        )
        .orderBy(desc(subchatMessages.createdAt))
        .limit(1)
        .all()[0] ?? null;
    const cntRow = db
      .select({ c: sql<number>`count(*)` })
      .from(subchatMessages)
      .where(
        and(
          eq(subchatMessages.subchatId, sc.id),
          eq(subchatMessages.authorKind, 'external'),
        ),
      )
      .all()[0];
    return {
      id: sc.id,
      title: sc.title,
      kind: sc.kind as 'external' | 'internal',
      lastMessage: last
        ? {
            authorKind: last.authorKind as 'internal' | 'external' | 'system',
            authorName: last.authorName,
            content: (() => {
              const t = last.content.trim();
              if (t) return t;
              const a = parseAttachments(last.attachments);
              if (a.length === 0) return '';
              return a[0].kind === 'image'
                ? `Foto${a.length > 1 ? ` +${a.length - 1}` : ''}`
                : a[0].filename;
            })(),
            ts: last.createdAt,
          }
        : null,
      lastExternalTs: lastExt ? lastExt.createdAt : null,
      externalCount: Number(cntRow?.c ?? 0),
      unreadCount: viewerUserId ? unreadCount(sc.id, viewerUserId) : 0,
    };
  });
}

/**
 * Distinct workspaceIds that carry at least one active sub-chat.
 * Basis for the main-chat aggregate (across all accessible workspaces).
 */
export function listSubchatWorkspaceIds(): string[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ ws: subchats.workspaceId })
    .from(subchats)
    .where(eq(subchats.status, 'active'))
    .all();
  return rows.map((r) => r.ws);
}

export function getSubchat(id: string): SubchatRow | null {
  const db = getDb();
  const rows = db.select().from(subchats).where(eq(subchats.id, id)).limit(1).all();
  return rows[0] ?? null;
}

/**
 * Marks all messages up to `ts` (default now) as read for `userId`.
 * Idempotent upsert on the (subchatId, userId) PK. The read marker is monotonic —
 * an older ts must not reset a newer one.
 */
export function markRead(subchatId: string, userId: string, ts?: number): void {
  const db = getDb();
  const now = ts ?? Date.now();
  db.insert(subchatReadMarkers)
    .values({ subchatId, userId, lastReadTs: now })
    .onConflictDoUpdate({
      target: [subchatReadMarkers.subchatId, subchatReadMarkers.userId],
      set: { lastReadTs: sql`max(${subchatReadMarkers.lastReadTs}, ${now})` },
    })
    .run();
}

/**
 * Number of unread messages for `userId` in this sub-chat.
 * createdAt > lastReadTs, WITHOUT one's own messages (authorId === userId) AND
 * WITHOUT system messages. No read marker ⇒ all foreign non-system
 * messages count as unread.
 */
export function unreadCount(subchatId: string, userId: string): number {
  const db = getDb();
  const marker = db
    .select({ ts: subchatReadMarkers.lastReadTs })
    .from(subchatReadMarkers)
    .where(
      and(
        eq(subchatReadMarkers.subchatId, subchatId),
        eq(subchatReadMarkers.userId, userId),
      ),
    )
    .limit(1)
    .all()[0];
  const since = marker?.ts ?? 0;
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(subchatMessages)
    .where(
      and(
        eq(subchatMessages.subchatId, subchatId),
        gt(subchatMessages.createdAt, since),
        ne(subchatMessages.authorKind, 'system'),
        sql`(${subchatMessages.authorId} IS NULL OR ${subchatMessages.authorId} <> ${userId})`,
      ),
    )
    .all()[0];
  return Number(row?.c ?? 0);
}

/**
 * Highest lastReadTs of ALL OTHER (userId !== viewerUserId) readers of this
 * sub-chat. Basis for read receipts on one's OWN messages: an own
 * message counts as read once recipientLastReadTs >= its createdAt.
 * 0 = nobody else has (demonstrably) read. Read-only, N2 via subchatId
 * (the sub-chat carries the workspaceId).
 */
export function recipientLastReadTs(subchatId: string, viewerUserId: string): number {
  const db = getDb();
  const row = db
    .select({ ts: sql<number>`coalesce(max(${subchatReadMarkers.lastReadTs}), 0)` })
    .from(subchatReadMarkers)
    .where(
      and(
        eq(subchatReadMarkers.subchatId, subchatId),
        ne(subchatReadMarkers.userId, viewerUserId),
      ),
    )
    .all()[0];
  return Number(row?.ts ?? 0);
}

/**
 * Resolve an external token. Returns the sub-chat or null (unknown/expired/
 * revoked). Read-only, no consume (a group chat is reusable).
 */
export function resolveExternalToken(rawToken: string): SubchatRow | null {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const db = getDb();
  const hash = hashSubchatToken(rawToken);
  const rows = db.select().from(subchats).where(eq(subchats.shareTokenHash, hash)).limit(1).all();
  const sc = rows[0];
  if (!sc) return null;
  if (sc.status !== 'active') return null;
  if (sc.shareRevokedAt) return null;
  if (sc.shareExpiresAt && Date.now() > sc.shareExpiresAt) return null;
  return sc;
}

export function listMessages(subchatId: string, limit = 200): SubchatMessageRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(subchatMessages)
    .where(eq(subchatMessages.subchatId, subchatId))
    .orderBy(desc(subchatMessages.createdAt))
    .limit(Math.min(limit, 500))
    .all();
  return rows.reverse(); // chronological (oldest first)
}

export interface PostMessageInput {
  subchatId: string;
  workspaceId: string;
  authorKind: 'internal' | 'external' | 'system';
  authorId?: string | null;
  authorName?: string | null;
  content: string;
  /** Optional attachments (documents/media/photos) — references to cloud artifacts. */
  attachments?: SubchatAttachment[];
}

export function postMessage(input: PostMessageInput): SubchatMessageRow {
  const db = getDb();
  const now = Date.now();
  const id = `SCM-${ulid(now)}`;
  const content = input.content.trim();
  const atts = (input.attachments ?? []).slice(0, 10);
  db.insert(subchatMessages)
    .values({
      id,
      subchatId: input.subchatId,
      workspaceId: input.workspaceId,
      authorKind: input.authorKind,
      authorId: input.authorId ?? null,
      authorName: input.authorName?.slice(0, 80) ?? null,
      content,
      attachments: atts.length > 0 ? JSON.stringify(atts) : null,
      ingested: 0,
      createdAt: now,
    })
    .run();
  db.update(subchats).set({ updatedAt: now }).where(eq(subchats.id, input.subchatId)).run();
  const row = db.select().from(subchatMessages).where(eq(subchatMessages.id, id)).limit(1).all()[0]!;
  // P2: domain event for realtime + push (best-effort, never fatal). Carries only
  // a short preview (NO full text in the push path). N1 is preserved — the
  // FULL content column is already persisted above; preview is a pure
  // notification preview.
  void emitSubchatMessageEvent(row).catch(() => undefined);
  // Fire-and-forget: knowledge into the workspace RAG. Errors never fatal.
  void ingestMessage(row).catch(() => undefined);
  // Proactive watcher (2026-06-02): on an EXTERNAL new message, pre-generate +
  // store ONE operator-facing suggestion. BOUNDED: only authorKind==='external';
  // debounce >=60s per subchat; fire-and-forget (NEVER blocks postMessage);
  // CLAUDE-GATED + best-effort in generateAndStore — never throws here.
  if (row.authorKind === 'external' && !hasRecentProactiveSuggestion(row.subchatId)) {
    void (async () => {
      try {
        const { generateAndStore } = await import('@/lib/proactive/generate');
        await generateAndStore(row.subchatId, row.workspaceId);
      } catch {
        /* non-fatal — the suggestion is best-effort; the message stays persisted */
      }
    })().catch(() => undefined);
  }
  return row;
}

/**
 * Ingest a sub-chat message into the workspace RAG (N2 workspace-isolated).
 * Best-effort; marks `ingested=1` on success (idempotency). System messages
 * are NOT ingested (no customer knowledge).
 */
export async function ingestMessage(row: SubchatMessageRow): Promise<void> {
  if (row.authorKind === 'system') return;
  const atts = parseAttachments(row.attachments);
  const attNote =
    atts.length > 0
      ? ` [Anhang: ${atts.map((a) => a.filename).join(', ')}]`
      : '';
  const body = `${row.content.trim()}${attNote}`.trim();
  // Nothing meaningful to index (empty text, no attachments) → skip.
  if (body.length < 2) return;
  try {
    const { indexSource } = await import('@/lib/rag/indexer');
    const who = row.authorName || (row.authorKind === 'external' ? 'Kunde' : 'Team');
    await indexSource({
      workspaceId: row.workspaceId,
      sourceType: 'subchat',
      sourceId: row.id,
      text: `[Sub-Chat] ${who}: ${body}`,
      sensitivity: 'low',
    });
    getDb().update(subchatMessages).set({ ingested: 1 }).where(eq(subchatMessages.id, row.id)).run();
  } catch {
    /* non-fatal — the message stays persisted, ingested stays 0 (retry possible) */
  }
}

/**
 * Self-heal (subchat-intelligence hardening 2026-06-03): catches up on sub-chat
 * messages whose inline `ingestMessage` failed (ingested=0, e.g. the
 * embedder briefly offline at post time). Without this drain, the knowledge was
 * permanently missing from the main-chat RAG. Idempotent — `ingestMessage` sets ingested=1
 * only on success; failures remain for the next sweep. System
 * messages are excluded (never ingested, would otherwise be
 * retried forever). Called by the auto-indexer sweep (boot + interval) — no
 * separate timer.
 */
export async function reindexUningestedSubchats(
  limit = 200,
): Promise<{ attempted: number; remaining: number }> {
  const db = getDb();
  const rows = db
    .select()
    .from(subchatMessages)
    .where(
      and(eq(subchatMessages.ingested, 0), ne(subchatMessages.authorKind, 'system')),
    )
    .limit(limit)
    .all() as SubchatMessageRow[];
  for (const row of rows) {
    await ingestMessage(row);
  }
  const pending = db
    .select({ c: sql<number>`count(*)` })
    .from(subchatMessages)
    .where(
      and(eq(subchatMessages.ingested, 0), ne(subchatMessages.authorKind, 'system')),
    )
    .get();
  return { attempted: rows.length, remaining: pending?.c ?? 0 };
}

/**
 * Always-on subchat context for the workspace main chat (2026-06-03,
 * owner directive: „im Workspace Chat muss der Subchat erkannt werden, damit
 * das Wissen direkt verwertet werden kann").
 *
 * The query-driven RAG finds subchat content only when the user's words
 * match lexically ("what's new?" hits nothing). This block is injected
 * UNCONDITIONALLY into every turn context (like workspace notes), so that
 * the main chat ALWAYS knows the most recent customer communication — independent of
 * the phrasing.
 */
export interface RecentSubchatMsg {
  title: string;
  authorKind: string;
  authorName: string;
  content: string;
  createdAt: number;
}

export function readRecentSubchatMessages(
  workspaceId: string,
  limit = 8,
): RecentSubchatMsg[] {
  if (!workspaceId || workspaceId.startsWith('__')) return [];
  const db = getDb();
  const rows = db
    .select({
      title: subchats.title,
      authorKind: subchatMessages.authorKind,
      authorName: subchatMessages.authorName,
      content: subchatMessages.content,
      createdAt: subchatMessages.createdAt,
    })
    .from(subchatMessages)
    .innerJoin(subchats, eq(subchatMessages.subchatId, subchats.id))
    .where(
      and(
        eq(subchats.workspaceId, workspaceId),
        ne(subchatMessages.authorKind, 'system'),
      ),
    )
    .orderBy(desc(subchatMessages.createdAt))
    .limit(limit)
    .all() as RecentSubchatMsg[];
  return rows.reverse(); // chronological (oldest first) for the prompt
}

/** Formatted always-on block (or null if no subchat messages). */
export function formatSubchatContextBlock(
  workspaceId: string,
  limit = 8,
): string | null {
  const msgs = readRecentSubchatMessages(workspaceId, limit);
  // Question-spinning (2026-06-03): spun-up questions are also part of the
  // main-chat knowledge — open questions + recently answered. Best-effort
  // (require, no crash if the module/table is missing).
  let questionsBlock: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const q = require('./questions-service') as typeof import('./questions-service');
    questionsBlock = q.formatSubchatQuestionsContextBlock(workspaceId, limit);
  } catch {
    questionsBlock = null;
  }
  if (msgs.length === 0 && !questionsBlock) return null;

  const parts: string[] = [];
  if (msgs.length > 0) {
    const lines = msgs.map((m) => {
      const who =
        m.authorKind === 'external'
          ? `Kunde${m.authorName ? ` (${m.authorName})` : ''}`
          : m.authorName || 'Team';
      return `- [${m.title}] ${who}: ${m.content.trim()}`;
    });
    parts.push(
      [
        '## Aktuelle Kundenchat-Nachrichten (Sub-Chats dieses Workspaces)',
        'Das ist die jüngste Kommunikation mit dem Kunden dieses Workspaces.',
        'Kenne + nutze sie direkt; der Operator erwartet, dass du sie weißt.',
        ...lines,
      ].join('\n'),
    );
  }
  if (questionsBlock) parts.push(questionsBlock);
  return parts.join('\n\n');
}

/**
 * Is a cloud artifact referenced by any message in this sub-chat?
 * Security boundary for the token-gated media endpoint:
 * external guests may ONLY view/load media that hangs in THEIR sub-chat
 * (whether uploaded from outside or by the team).
 */
export function subchatReferencesArtifact(subchatId: string, artifactId: string): boolean {
  const db = getDb();
  const rows = db
    .select({ attachments: subchatMessages.attachments })
    .from(subchatMessages)
    .where(eq(subchatMessages.subchatId, subchatId))
    .all();
  for (const r of rows) {
    if (parseAttachments(r.attachments).some((a) => a.artifactId === artifactId)) return true;
  }
  return false;
}

/**
 * Revoke the external link: sets shareRevokedAt=now. The token hash stays
 * (resolveExternalToken rejects revoked). Reversible via renewShare.
 */
export function revokeShare(subchatId: string): SubchatRow | null {
  const db = getDb();
  const now = Date.now();
  db.update(subchats)
    .set({ shareRevokedAt: now, updatedAt: now })
    .where(eq(subchats.id, subchatId))
    .run();
  return getSubchat(subchatId);
}

/**
 * Renew the external link: new raw token + hash, new expiry (hours > 0;
 * 0/undef = unlimited), revocation cleared. Raw token returned ONLY here.
 */
export function renewShare(subchatId: string, hours: number): { rawToken: string } | null {
  const db = getDb();
  const sc = getSubchat(subchatId);
  if (!sc) return null;
  const now = Date.now();
  const rawToken = newRawToken();
  const shareExpiresAt = hours && hours > 0 ? now + hours * 3600_000 : null;
  db.update(subchats)
    .set({
      shareTokenHash: hashSubchatToken(rawToken),
      shareExpiresAt,
      shareRevokedAt: null,
      updatedAt: now,
    })
    .where(eq(subchats.id, subchatId))
    .run();
  return { rawToken };
}

/**
 * Rotate the token WITHOUT changing the expiry: new raw token + hash, revocation
 * cleared, shareExpiresAt unchanged. Raw token returned ONLY here.
 */
export function regenerateToken(subchatId: string): { rawToken: string } | null {
  const db = getDb();
  const sc = getSubchat(subchatId);
  if (!sc) return null;
  const now = Date.now();
  const rawToken = newRawToken();
  db.update(subchats)
    .set({
      shareTokenHash: hashSubchatToken(rawToken),
      shareRevokedAt: null,
      updatedAt: now,
    })
    .where(eq(subchats.id, subchatId))
    .run();
  return { rawToken };
}

/** Rename a sub-chat (N1: no truncation beyond 200, only as a hard cap). */
export function renameSubchat(subchatId: string, title: string): SubchatRow | null {
  const db = getDb();
  const now = Date.now();
  const clean = title.trim().slice(0, 200) || 'Sub-Chat';
  db.update(subchats).set({ title: clean, updatedAt: now }).where(eq(subchats.id, subchatId)).run();
  return getSubchat(subchatId);
}

/** Archive a sub-chat: status='archived' (disappears from listSubchats). */
export function archiveSubchat(subchatId: string): SubchatRow | null {
  const db = getDb();
  const now = Date.now();
  db.update(subchats).set({ status: 'archived', updatedAt: now }).where(eq(subchats.id, subchatId)).run();
  return getSubchat(subchatId);
}

/**
 * HARD-delete a sub-chat: messages + read markers + sub-chat row + RAG chunks.
 *
 * GDPR ERASURE (2026-06-03): on a hard delete, the chunks of these messages
 * ingested into the workspace RAG MUST go too — otherwise orphaned chunks
 * remain and keep poisoning the main-chat context (audit finding: 4+ orphans).
 * The FTS mirror follows automatically via `trg_rag_chunks_fts_delete`. Workspace-
 * scoped (N2). Order: first collect the message IDs, then delete children + parent,
 * then the associated chunks (source_type='subchat', source_id=msgId).
 *
 * ARCHIVE (archiveSubchat) deliberately leaves the chunks in place: archive = hide,
 * not delete (reversible) — the knowledge stays valid.
 */
export function deleteSubchat(subchatId: string): boolean {
  const db = getDb();
  const exists = getSubchat(subchatId);
  if (!exists) return false;
  const msgIds = db
    .select({ id: subchatMessages.id })
    .from(subchatMessages)
    .where(eq(subchatMessages.subchatId, subchatId))
    .all()
    .map((r) => r.id);
  // Atomic (review LOW): the whole erasure in ONE transaction — a crash
  // between the subchat delete and the chunk delete would otherwise leave orphaned chunks
  // (the reconciler heals that, but GDPR erasure should be atomic).
  db.transaction(() => {
    db.delete(subchatMessages).where(eq(subchatMessages.subchatId, subchatId)).run();
    db.delete(subchatReadMarkers).where(eq(subchatReadMarkers.subchatId, subchatId)).run();
    db.delete(subchats).where(eq(subchats.id, subchatId)).run();
    for (let i = 0; i < msgIds.length; i += 400) {
      const batch = msgIds.slice(i, i + 400);
      db.delete(ragChunks)
        .where(
          and(
            eq(ragChunks.workspaceId, exists.workspaceId),
            eq(ragChunks.sourceType, 'subchat'),
            inArray(ragChunks.sourceId, batch),
          ),
        )
        .run();
    }
  });
  return true;
}

/**
 * Idempotent „Allgemein" sub-chat per workspace. Returns the existing
 * active external sub-chat with the title "Allgemein", or creates it.
 * Default entry point for a workspace's customer channel.
 */
export function ensureGeneralSubchat(workspaceId: string, createdByUserId?: string): SubchatRow {
  const db = getDb();
  const existing = db
    .select()
    .from(subchats)
    .where(
      and(
        eq(subchats.workspaceId, workspaceId),
        eq(subchats.kind, 'external'),
        eq(subchats.title, 'Allgemein'),
        eq(subchats.status, 'active'),
      ),
    )
    .orderBy(desc(subchats.createdAt))
    .limit(1)
    .all()[0];
  if (existing) return existing;
  const { subchat } = createSubchat({
    workspaceId,
    title: 'Allgemein',
    kind: 'external',
    createdByUserId,
    external: true,
    expiresInHours: 720,
  });
  return subchat;
}

const PROACTIVE_DEBOUNCE_MS = 60_000;

/** True if a suggestion for this subchat was created within `windowMs`.
 *  Debounce for the postMessage watcher hook — at most one generation per
 *  subchat per window. Read-only, workspace-scoped via subchat_id. */
export function hasRecentProactiveSuggestion(
  subchatId: string,
  windowMs = PROACTIVE_DEBOUNCE_MS,
): boolean {
  const db = getDb();
  const since = Date.now() - windowMs;
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(proactiveSuggestions)
    .where(
      and(
        eq(proactiveSuggestions.subchatId, subchatId),
        gt(proactiveSuggestions.createdAt, since),
      ),
    )
    .all()[0];
  return Number(row?.c ?? 0) > 0;
}

/** Persist ONE pre-generated suggestion (N1 verbatim). */
export function storeProactiveSuggestion(input: {
  subchatId: string;
  workspaceId: string;
  suggestion: string;
}): ProactiveSuggestionRow {
  const db = getDb();
  const now = Date.now();
  const id = `PS-${ulid(now)}`;
  db.insert(proactiveSuggestions)
    .values({
      id,
      subchatId: input.subchatId,
      workspaceId: input.workspaceId,
      suggestion: input.suggestion, // N1: kein .slice
      createdAt: now,
      dismissedAt: null,
    })
    .run();
  return db.select().from(proactiveSuggestions).where(eq(proactiveSuggestions.id, id)).limit(1).all()[0]!;
}

/** Newest UNDISMISSED suggestion for a subchat, or null. */
export function listProactiveSuggestionForSubchat(
  subchatId: string,
): ProactiveSuggestionRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(proactiveSuggestions)
      .where(
        and(
          eq(proactiveSuggestions.subchatId, subchatId),
          sql`${proactiveSuggestions.dismissedAt} IS NULL`,
        ),
      )
      .orderBy(desc(proactiveSuggestions.createdAt))
      .limit(1)
      .all()[0] ?? null
  );
}

/** Newest undismissed suggestion per subchat across a set of workspaces (N2). */
export function listProactiveSuggestions(workspaceIds: string[]): ProactiveSuggestionRow[] {
  if (workspaceIds.length === 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(proactiveSuggestions)
    .where(
      and(
        inArray(proactiveSuggestions.workspaceId, workspaceIds),
        sql`${proactiveSuggestions.dismissedAt} IS NULL`,
      ),
    )
    .orderBy(desc(proactiveSuggestions.createdAt))
    .all();
  // newest per subchat
  const seen = new Set<string>();
  const out: ProactiveSuggestionRow[] = [];
  for (const r of rows) {
    if (seen.has(r.subchatId)) continue;
    seen.add(r.subchatId);
    out.push(r);
  }
  return out;
}

/** Mark a suggestion dismissed (idempotent). */
export function dismissProactiveSuggestion(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: proactiveSuggestions.id })
    .from(proactiveSuggestions)
    .where(eq(proactiveSuggestions.id, id))
    .limit(1)
    .all()[0];
  if (!existing) return false;
  db.update(proactiveSuggestions)
    .set({ dismissedAt: Date.now() })
    .where(eq(proactiveSuggestions.id, id))
    .run();
  return true;
}

/**
 * Best-effort domain event for a new sub-chat message (P2). Drives the
 * realtime broadcast + push rules. Never fatal — postMessage stays the only
 * mutation path and must not fail because of an event error.
 *
 * preview is a SHORT notification preview (max 120 chars), NO
 * full-text leak — the full content column is already persisted N1-verbatim.
 */
async function emitSubchatMessageEvent(row: SubchatMessageRow): Promise<void> {
  try {
    const sc = getSubchat(row.subchatId);
    const title = sc?.title ?? 'Sub-Chat';
    const text = row.content.trim();
    const preview = text.length > 0
      ? text.slice(0, 120)
      : (parseAttachments(row.attachments)[0]?.kind === 'image' ? 'Foto' : 'Anhang');
    const { emitEvent } = await import('@/lib/events/emit');
    await emitEvent({
      segmentId: row.workspaceId,
      entityType: 'subchat',
      entityId: row.subchatId,
      eventType: 'subchat_message',
      actor: 'system',
      payload: {
        subchatId: row.subchatId,
        workspaceId: row.workspaceId,
        authorKind: row.authorKind,
        authorName: row.authorName,
        preview,
        title,
      },
      sensitivity: 'low',
    });
  } catch {
    /* non-fatal — the message stays persisted; the event is best-effort */
  }
}
