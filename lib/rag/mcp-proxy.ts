/**
 * MCP-Workspace-Proxy (Phase 2 Workspace-Isolation, 2026-05-03).
 *
 * Hintergrund:
 *   Die globalen MCP-Stores `local-rag` (Knowledge-Base) und `standards-rag`
 *   liegen unter `~/knowledge-base/` bzw. `~/standards/` und
 *   sind workspace-blind.
 *
 *   - `standards-rag` ist okay shared — Standards sind kein PII, im
 *     Gegenteil: jeder Workspace soll auf Standards zugreifen koennen.
 *   - `local-rag` ist heikel — die Knowledge-Base kann personenbezogene
 *     Inhalte aus einzelnen Workspaces enthalten (Transkripte, Research,
 *     Sub-Org-Notizen). Ein Spawn aus Workspace A darf nicht ungesehen
 *     auf Knowledge-Base-Files aus Workspace B treffen.
 *
 * Strategie: jeder MCP-Treffer geht durch `enforceMcpWorkspaceScope()`.
 *   - File-Pfad enthaelt `/workspace/<id>/` mit dem aktuellen ws-Slug
 *     -> durchgelassen (allowed=true).
 *   - File-Pfad enthaelt `/workspace/<andereId>/`
 *     -> blockiert (allowed=false, blocked=true) + Audit-Row.
 *   - File-Pfad enthaelt KEINEN ws-Slug (globale KB, z. B. allgemeine
 *     Forschung) -> durchgelassen mit `sharedKnowledge=true` Flag +
 *     Audit-Row, damit DSGVO-Auskunft den Cross-Tenant-Read sehen kann.
 *   - sensitivity=high im Hit-Payload (selten — die KB hat das Feld nicht
 *     immer, aber wenn der Caller es markiert ist) -> blockiert komplett.
 *
 * Standards-Store (`standards-rag`): immer durchgelassen, kein Audit-Row.
 *
 * Audit-Layer: nutzt `writeAudit()` aus `lib/rag/retriever.ts` —
 * dieselbe Tabelle `rag_cross_workspace_audit`, weil semantisch derselbe
 * Tatbestand: ein Workspace hat Daten gesehen, die nicht klar zu ihm
 * gehoeren.
 */

import { writeAudit } from './retriever';

export type McpStore = 'local-rag' | 'standards-rag';

export interface McpHit {
  /** File-Pfad oder Dokument-ID (relativ oder absolut). */
  filePath: string;
  /** Optional: vom Store gemeldete sensitivity. */
  sensitivity?: 'low' | 'med' | 'high';
  /** Frei-Form Payload — wir touchen nur filePath. */
  [key: string]: unknown;
}

export interface ScopedMcpHit extends McpHit {
  /** true wenn der Hit dem Caller-Workspace zugeordnet ist. */
  workspaceMatch: boolean;
  /** true wenn KB-File ohne ws-Slug (globale Knowledge). */
  sharedKnowledge: boolean;
  /** true wenn der Hit blockiert wurde — dann steht in Caller-Hand ihn zu droppen. */
  blocked: boolean;
  /** Begruendung fuer blocked oder sharedKnowledge. */
  scopeReason: string;
}

export interface EnforceOptions {
  workspaceId: string;
  store: McpStore;
  /**
   * User-ID fuer Audit-Insert. Pflicht wenn `local-rag` und Hits durchgehen
   * die `sharedKnowledge=true` oder `blocked=true` sind. Bei
   * `standards-rag` optional.
   */
  userId?: string;
  /** Free-text fuer Audit (z. B. "spawn-context-fetch", "lead-prompt"). */
  reason?: string;
  /**
   * Wenn true: blockierte Hits werden in der Antwort ueberhaupt nicht
   * zurueckgegeben (Caller will sie nicht mal sehen). Default: false —
   * der Caller bekommt sie mit `blocked=true` Flag und kann selbst
   * entscheiden.
   */
  hardDrop?: boolean;
  /** Original-Query (fuer Audit). Default: leer-string. */
  query?: string;
}

export interface EnforceResult {
  store: McpStore;
  workspaceId: string;
  hits: ScopedMcpHit[];
  /** Wieviele Hits wurden komplett gedroppt (nur wenn hardDrop=true). */
  dropped: number;
  /** Wieviele Hits wurden als sharedKnowledge geflagged. */
  sharedKnowledgeCount: number;
  /** Wieviele Hits wurden geblockt (wrong-workspace oder sensitivity-high). */
  blockedCount: number;
  /** Audit-Row-ID falls geschrieben, sonst null. */
  auditId: string | null;
}

const WS_SLUG_RE = /[\\/]workspace[\\/]([a-z0-9_-]+)[\\/]/i;

function classifyHit(
  hit: McpHit,
  workspaceId: string,
): {
  workspaceMatch: boolean;
  sharedKnowledge: boolean;
  blocked: boolean;
  scopeReason: string;
} {
  // 1. Sensitivity-Gate haerter Riegel.
  if (hit.sensitivity === 'high') {
    return {
      workspaceMatch: false,
      sharedKnowledge: false,
      blocked: true,
      scopeReason: 'sensitivity-high',
    };
  }
  // 2. ws-Slug-Match.
  const m = (hit.filePath ?? '').match(WS_SLUG_RE);
  if (!m) {
    // Kein Slug = globale Knowledge (z. B. ~/knowledge-base/research/foo.md).
    return {
      workspaceMatch: false,
      sharedKnowledge: true,
      blocked: false,
      scopeReason: 'no-workspace-slug',
    };
  }
  const slug = m[1].toLowerCase();
  if (slug === workspaceId.toLowerCase()) {
    return {
      workspaceMatch: true,
      sharedKnowledge: false,
      blocked: false,
      scopeReason: 'workspace-match',
    };
  }
  return {
    workspaceMatch: false,
    sharedKnowledge: false,
    blocked: true,
    scopeReason: `wrong-workspace:${slug}`,
  };
}

/**
 * Wendet Workspace-Scope auf eine Liste roher MCP-Treffer an.
 *
 * Schreibt einen Audit-Row wenn `local-rag` mindestens einen
 * `sharedKnowledge`- oder `blocked`-Hit produziert (also irgendetwas
 * cross-tenant-relevantes passiert ist).
 */
export function enforceMcpWorkspaceScope(
  hits: McpHit[],
  options: EnforceOptions,
): EnforceResult {
  if (!options.workspaceId || options.workspaceId.trim().length === 0) {
    throw new Error(
      'enforceMcpWorkspaceScope: workspaceId required (DSGVO Art. 28)',
    );
  }

  // standards-rag ist shared by design — kein Filter, kein Audit.
  if (options.store === 'standards-rag') {
    return {
      store: 'standards-rag',
      workspaceId: options.workspaceId,
      hits: hits.map((h) => ({
        ...h,
        workspaceMatch: false,
        sharedKnowledge: true,
        blocked: false,
        scopeReason: 'standards-shared-by-design',
      })),
      dropped: 0,
      sharedKnowledgeCount: hits.length,
      blockedCount: 0,
      auditId: null,
    };
  }

  const scoped: ScopedMcpHit[] = [];
  let dropped = 0;
  let sharedKnowledgeCount = 0;
  let blockedCount = 0;
  const seenSharedFiles: string[] = [];

  for (const hit of hits) {
    const c = classifyHit(hit, options.workspaceId);
    if (c.blocked) blockedCount += 1;
    if (c.sharedKnowledge) {
      sharedKnowledgeCount += 1;
      seenSharedFiles.push(hit.filePath);
    }
    if (c.blocked && options.hardDrop) {
      dropped += 1;
      continue;
    }
    scoped.push({
      ...hit,
      ...c,
    });
  }

  // Audit-Row schreiben wenn cross-tenant-relevantes passiert ist.
  let auditId: string | null = null;
  const auditWorthy = sharedKnowledgeCount > 0 || blockedCount > 0;
  if (auditWorthy && options.userId) {
    try {
      auditId = writeAudit({
        userId: options.userId,
        query: options.query ?? '',
        // workspacesSeen: hier nicht andere Workspaces, sondern die Kategorien
        // die wir gesehen haben. Wir packen den shared-Count in eine
        // Pseudo-WS rein damit das Audit-Schema (TEXT-JSON-Array) bleibt.
        workspacesSeen: [
          options.workspaceId,
          ...(sharedKnowledgeCount > 0 ? ['__shared-knowledge__'] : []),
          ...(blockedCount > 0 ? ['__blocked__'] : []),
        ],
        hits: scoped.length,
        reason: `mcp:${options.store}:${options.reason ?? 'unknown'}:shared=${sharedKnowledgeCount}:blocked=${blockedCount}`,
      });
    } catch (err) {
      // Audit-Insert darf den Caller nicht killen — wir loggen und gehen
      // weiter. Im Test-Modus (DB nicht initialisiert) faellt das auf den
      // Boden ohne den Caller zu brechen.
      console.warn('[mcp-proxy] audit-insert-fail:', err);
    }
  }

  return {
    store: options.store,
    workspaceId: options.workspaceId,
    hits: scoped,
    dropped,
    sharedKnowledgeCount,
    blockedCount,
    auditId,
  };
}
