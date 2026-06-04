/**
 * lib/subchats/service.ts — Service-Layer für Workspace-Sub-Chats
 * (Gathering-Intelligence-Goal, 2026-06-02).
 *
 * Gruppenchats pro Workspace (extern Kunden via Share-Token / intern Team).
 * Jede Nachricht wird append-only persistiert UND best-effort in die
 * Workspace-RAG ingestet (workspace-isoliert, N2). Die KI ist im Sub-Chat
 * selbst stumm — das gesammelte Wissen macht den Hauptchat schlauer.
 *
 * EINZIGER Insert-Pfad für subchats/subchat_messages (UI/API gehen hierüber).
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

/** Anhang an einer Sub-Chat-Nachricht (Referenz auf ein Cloud-Artifact). */
export interface SubchatAttachment {
  artifactId: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: 'image' | 'file';
}

/**
 * Eingehende Anhang-Referenzen (aus dem Request-Body) säubern + ABSICHERN:
 * jede Referenz muss auf ein Cloud-Artifact zeigen, das zum erwarteten Workspace
 * gehört (sonst raus). So kann niemand fremde Artefakte in einen Sub-Chat ziehen.
 */
export function sanitizeAttachments(input: unknown, workspaceId: string): SubchatAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: SubchatAttachment[] = [];
  for (const raw of input.slice(0, 10)) {
    const o = raw as Record<string, unknown>;
    const artifactId = typeof o?.artifactId === 'string' ? o.artifactId : '';
    if (!artifactId) continue;
    if (getArtifactWorkspaceId(artifactId) !== workspaceId) continue; // fremd/unbekannt → verwerfen
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

/** Sicheres Parsen der attachments-JSON-Spalte (nie throw). */
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
  /** Externen Token-Zugang erzeugen (Default true bei kind='external'). */
  external?: boolean;
  /** Token-Lebensdauer in Stunden (Default 720 = 30 Tage); 0/undef = unbefristet. */
  expiresInHours?: number;
}

export interface CreateSubchatResult {
  subchat: SubchatRow;
  /** Roh-Token NUR hier (einmalig) zurückgegeben; in der DB nur der Hash. */
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
 * Activity-Snapshot pro Workspace für die proaktive Hauptchat-Karte
 * (Gathering-Intelligence in den Hauptchat holen, 2026-06-02).
 *
 * Liefert je Sub-Chat die letzte Nachricht (Vorschau), den Zeitstempel der
 * letzten EXTERNEN Nachricht und die externe Gesamtzahl. `content` wird VOLL
 * zurückgegeben (kein .slice — N1); die UI clampt per CSS. Die „neu seit"-
 * Entscheidung trifft der Client gegen eine lokale seen-Map (keine zusätzliche
 * DB-Tabelle nötig, vollständig reversibel).
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
  /** Ungelesene fremde Nicht-System-Nachrichten für den Viewer. 0 ohne Viewer. */
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
 * Distinct workspaceIds, die mindestens einen aktiven Sub-Chat tragen.
 * Grundlage für das Hauptchat-Aggregat (über alle zugänglichen Workspaces).
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
 * Markiert für `userId` alle Nachrichten bis `ts` (default now) als gelesen.
 * Idempotenter Upsert auf dem (subchatId, userId)-PK. Read-Marker monoton —
 * ein älterer ts darf einen neueren nicht zurücksetzen.
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
 * Anzahl ungelesener Nachrichten für `userId` in diesem Sub-Chat.
 * createdAt > lastReadTs, OHNE eigene Nachrichten (authorId === userId) UND
 * OHNE System-Nachrichten. Kein Read-Marker ⇒ alle fremden Nicht-System-
 * Nachrichten gelten als ungelesen.
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
 * Höchster lastReadTs ALLER ANDEREN (userId !== viewerUserId) Leser dieses
 * Sub-Chats. Grundlage für Lese-Haken auf EIGENEN Nachrichten: eine eigene
 * Nachricht gilt als gelesen, sobald recipientLastReadTs >= ihr createdAt.
 * 0 = niemand sonst hat (nachweislich) gelesen. Read-only, N2 via subchatId
 * (der Sub-Chat trägt die workspaceId).
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
 * Externen Token auflösen. Liefert den Sub-Chat oder null (unbekannt/abgelaufen/
 * widerrufen). Read-only, kein Consume (Gruppenchat ist mehrfach nutzbar).
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
  return rows.reverse(); // chronologisch (älteste zuerst)
}

export interface PostMessageInput {
  subchatId: string;
  workspaceId: string;
  authorKind: 'internal' | 'external' | 'system';
  authorId?: string | null;
  authorName?: string | null;
  content: string;
  /** Optionale Anhänge (Dokumente/Medien/Fotos) — Referenzen auf Cloud-Artifacts. */
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
  // P2: Domain-Event für Realtime + Push (best-effort, nie fatal). Trägt nur
  // einen kurzen Preview (KEIN Volltext im Push-Pfad). N1 bleibt gewahrt — die
  // VOLLE content-Spalte ist bereits oben persistiert; preview ist reine
  // Notification-Vorschau.
  void emitSubchatMessageEvent(row).catch(() => undefined);
  // Fire-and-forget: Wissen in die Workspace-RAG. Fehler nie fatal.
  void ingestMessage(row).catch(() => undefined);
  // Proactive watcher (2026-06-02): bei EXTERNER Neunachricht EINEN operator-
  // facing Vorschlag VOR-generieren + speichern. BOUNDED: nur authorKind==='external';
  // Debounce >=60s pro Subchat; fire-and-forget (blockt postMessage NIE);
  // CLAUDE-GATED + best-effort in generateAndStore — wirft hier nie.
  if (row.authorKind === 'external' && !hasRecentProactiveSuggestion(row.subchatId)) {
    void (async () => {
      try {
        const { generateAndStore } = await import('@/lib/proactive/generate');
        await generateAndStore(row.subchatId, row.workspaceId);
      } catch {
        /* non-fatal — Vorschlag ist best-effort; Nachricht bleibt persistiert */
      }
    })().catch(() => undefined);
  }
  return row;
}

/**
 * Eine Sub-Chat-Nachricht in die Workspace-RAG ingesten (N2 workspace-isoliert).
 * Best-effort; markiert `ingested=1` bei Erfolg (Idempotenz). System-Nachrichten
 * werden NICHT ingestet (kein Kundenwissen).
 */
export async function ingestMessage(row: SubchatMessageRow): Promise<void> {
  if (row.authorKind === 'system') return;
  const atts = parseAttachments(row.attachments);
  const attNote =
    atts.length > 0
      ? ` [Anhang: ${atts.map((a) => a.filename).join(', ')}]`
      : '';
  const body = `${row.content.trim()}${attNote}`.trim();
  // Nichts Sinnvolles zu indexen (leerer Text, keine Anhänge) → überspringen.
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
    /* non-fatal — Nachricht bleibt persistiert, ingested bleibt 0 (Retry möglich) */
  }
}

/**
 * Self-Heal (Subchat-Intelligence-Härtung 2026-06-03): zieht Sub-Chat-
 * Nachrichten nach, deren Inline-`ingestMessage` fehlschlug (ingested=0, z.B.
 * Embedder kurz offline beim Posten). Ohne diesen Drain fehlte das Wissen
 * dauerhaft im Hauptchat-RAG. Idempotent — `ingestMessage` setzt ingested=1
 * nur bei Erfolg, Fehlschläge bleiben für den nächsten Sweep liegen. System-
 * Nachrichten sind ausgenommen (werden nie ingestet, würden sonst ewig
 * retried). Wird vom Auto-Indexer-Sweep (boot + Intervall) aufgerufen — kein
 * eigener Timer.
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
 * Always-on Subchat-Kontext für den Workspace-Hauptchat (2026-06-03,
 * Owner-Direktive: „im Workspace Chat muss der Subchat erkannt werden, damit
 * das Wissen direkt verwertet werden kann").
 *
 * Das query-getriebene RAG findet Subchat-Inhalte nur, wenn die Nutzer-Worte
 * lexikalisch passen ("was gibt's Neues?" trifft nichts). Dieser Block wird
 * UNCONDITIONAL in jeden Turn-Kontext injiziert (wie Workspace-Notes), damit
 * der Hauptchat die jüngste Kundenkommunikation IMMER kennt — unabhängig von
 * der Formulierung.
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
  return rows.reverse(); // chronologisch (älteste zuerst) für den Prompt
}

/** Formatierter Always-on-Block (oder null, wenn keine Subchat-Nachrichten). */
export function formatSubchatContextBlock(
  workspaceId: string,
  limit = 8,
): string | null {
  const msgs = readRecentSubchatMessages(workspaceId, limit);
  // Question-Spinning (2026-06-03): angespinnte Fragen sind ebenfalls Teil des
  // Hauptchat-Wissens — offene Fragen + jüngst beantwortete. Best-effort
  // (require, kein Crash falls das Modul/Tabelle fehlt).
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
 * Wird ein Cloud-Artifact von irgendeiner Nachricht in diesem Sub-Chat
 * referenziert? Sicherheitsgrenze für den token-gegateten Media-Endpoint:
 * externe Gäste dürfen NUR Medien sehen/laden, die in IHREM Sub-Chat hängen
 * (egal ob von extern oder vom Team hochgeladen).
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
 * Externen Link widerrufen: setzt shareRevokedAt=now. Token-Hash bleibt
 * stehen (resolveExternalToken lehnt revoked ab). Reversibel via renewShare.
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
 * Externen Link erneuern: neuer Roh-Token + Hash, neue Ablaufzeit (hours > 0;
 * 0/undef = unbefristet), Widerruf gelöscht. Roh-Token NUR hier zurückgegeben.
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
 * Token rotieren OHNE die Ablaufzeit zu ändern: neuer Roh-Token + Hash, Widerruf
 * gelöscht, shareExpiresAt unverändert. Roh-Token NUR hier zurückgegeben.
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

/** Sub-Chat umbenennen (N1: kein Truncate über 200 hinaus nur als Hard-Cap). */
export function renameSubchat(subchatId: string, title: string): SubchatRow | null {
  const db = getDb();
  const now = Date.now();
  const clean = title.trim().slice(0, 200) || 'Sub-Chat';
  db.update(subchats).set({ title: clean, updatedAt: now }).where(eq(subchats.id, subchatId)).run();
  return getSubchat(subchatId);
}

/** Sub-Chat archivieren: status='archived' (verschwindet aus listSubchats). */
export function archiveSubchat(subchatId: string): SubchatRow | null {
  const db = getDb();
  const now = Date.now();
  db.update(subchats).set({ status: 'archived', updatedAt: now }).where(eq(subchats.id, subchatId)).run();
  return getSubchat(subchatId);
}

/**
 * Sub-Chat HART löschen: Nachrichten + Read-Marker + Sub-Chat-Row + RAG-Chunks.
 *
 * GDPR-ERASURE (2026-06-03): Beim harten Löschen MÜSSEN die in die Workspace-RAG
 * ingesteten Chunks dieser Nachrichten mit weg — sonst bleiben verwaiste Chunks
 * liegen und vergiften weiter den Hauptchat-Kontext (Audit-Finding: 4+ Waisen).
 * Der FTS-Mirror folgt automatisch via `trg_rag_chunks_fts_delete`. Workspace-
 * gescoped (N2). Reihenfolge: erst Message-IDs einsammeln, dann Kinder + Parent
 * löschen, dann die zugehörigen Chunks (source_type='subchat', source_id=msgId).
 *
 * ARCHIVE (archiveSubchat) lässt die Chunks bewusst stehen: Archiv = ausblenden,
 * nicht löschen (reversibel) — das Wissen bleibt gültig.
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
  // Atomar (Review LOW): die ganze Erasure in EINE Transaktion — ein Crash
  // zwischen Subchat-Delete und Chunk-Delete ließe sonst verwaiste Chunks zurück
  // (der Reconciler heilt das zwar, aber GDPR-Erasure sollte atomar sein).
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
 * Idempotenter „Allgemein"-Sub-Chat pro Workspace. Liefert den bestehenden
 * aktiven external-Sub-Chat mit Titel "Allgemein" zurück, oder legt ihn an.
 * Default-Anlaufstelle für den Kunden-Kanal eines Workspace.
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
 * Best-effort Domain-Event für eine neue Sub-Chat-Nachricht (P2). Treibt
 * Realtime-Broadcast + Push-Rules. Nie fatal — postMessage bleibt der einzige
 * Mutationspfad und darf durch einen Event-Fehler nicht scheitern.
 *
 * preview ist eine KURZE Notification-Vorschau (max 120 Zeichen), KEIN
 * Volltext-Leak — die volle content-Spalte ist bereits N1-verbatim persistiert.
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
    /* non-fatal — Nachricht bleibt persistiert; Event ist best-effort */
  }
}
