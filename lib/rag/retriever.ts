/**
 * RAG-Retriever (Sprint 2 / Strang B, 2026-04-30).
 *
 * Phase 2 (2026-05-03): Workspace-Isolation Service-Refactor.
 *   - Read-Pfad geht durch `v_rag_chunks_workspace` (Drizzle-View, Migration 0052).
 *   - `workspaceId` ist HARTE Pflicht: leerer/undefined Wert -> RagWorkspaceRequiredError.
 *   - Neue Funktion `retrieveAcrossWorkspaces()` mit Audit-Insert in
 *     `rag_cross_workspace_audit` (DSGVO Art. 30 VVT-Pflicht).
 *
 * Phase 3 (2026-05-24): Lexical-First (N7).
 *   - Stufe 0 (neu): FTS5 MATCH-Query auf `rag_chunks_fts` mit BM25-Ranking.
 *     Kandidaten-Set workspace-gefiltert via JOIN auf rag_chunks.
 *     sensitivity!='high' immer doppelt gefiltert (N2 / Defense-in-Depth).
 *   - Wenn FTS-Kandidaten vorhanden: bestehende Cosine-Rerank-Stufe darauf
 *     anwenden (kombinierter Score: alpha*cosine + (1-alpha)*normBM25).
 *   - Wenn FTS 0 Treffer: Fallback auf den bisherigen reinen Cosine-Pfad
 *     (unverändert gegenüber Phase 2).
 *   - Query-Sanitiser für FTS5-Syntax (Sonderzeichen werden escaped, damit
 *     kein Syntax-Error bei Queries wie "foo & bar" oder "foo*").
 *
 * Query → [FTS5-Lexical] → Kandidaten → Cosine-Rerank → Token-Cap →
 * Markdown-Format für Lead-Prompt-Inject.
 * Fallback: Query → Embed → Brute-Force-Cosine (Phase-2-Pfad, kein FTS).
 *
 * Token-Budget pro Lead-Call: 4000 Token Hard-Cap (≈ 16k chars).
 *
 * Privacy-Gate (Defense-in-Depth):
 *   View `v_rag_chunks_workspace` hat sensitivity!='high' bereits hart
 *   eingebaut. Retriever filtert NOCHMAL auf sensitivity != 'high' im
 *   Where-Clause — Belt-and-Suspenders. FTS-Pfad filtert ebenfalls via
 *   JOIN auf rag_chunks WHERE sensitivity != 'high'.
 */

import { ulid } from '@/lib/ulid';
import { getDb } from '@/db/client';
import {
  ragCrossWorkspaceAudit,
  vRagChunksWorkspace,
} from '@/db/schema/rag';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { embed, unpackEmbedding, topK as topKHelper } from './embedder';
import { applyRouting, classify, type QueryIntent } from './source-router';
import { enforceDataflow } from '@/lib/security/dataflow-policy';
import { writeEvidence } from '@/lib/workstreams/trace-repo';
import { reciprocalRankFusion } from './rrf';

export interface RetrievalResult {
  workspaceId: string;
  query: string;
  hits: RetrievedChunk[];
  totalCandidates: number;
  truncated: boolean;
  approxTokens: number;
  intent: QueryIntent;
}

export interface RetrievedChunk {
  id: string;
  workspaceId: string;
  sourceType: string;
  sourceId: string;
  text: string;
  similarity: number;
  approxTokens: number;
  routedScore?: number;
}

export interface CrossWorkspaceRetrievalResult {
  workspaceIds: string[];
  query: string;
  hits: RetrievedChunk[];
  totalCandidates: number;
  truncated: boolean;
  approxTokens: number;
  intent: QueryIntent;
  auditId: string;
}

const TOKEN_CAP = 4000;
const DEFAULT_TOP_K = 8;
// Cosine cut-off — alles darunter ist Noise. Angehoben 0.25→0.30 (2026-06-02,
// Codex-Parität): gemessen rutschten thematisch fremde Chunks (z.B. „mm/Maße"-
// Code für eine „Closure in JavaScript"-Frage) bei sim≈0.25-0.26 knapp durch
// und verwässerten den Prompt. Echte topische Treffer scoren 0.4+, modest-aber-
// relevante 0.32+. 0.30 entfernt das Rauschen mit klarem Abstand, ohne echte
// Treffer zu verlieren. RAG bleibt „mehr Kontext", aber nur wenn's wirklich passt.
const MIN_SIMILARITY = 0.3;

/**
 * Fusion strategy for the hybrid re-rank step (FTS + Cosine).
 *
 *   'weighted' — original behaviour: alpha*cosine + (1-alpha)*normBM25.
 *                Default. All existing tests continue to pass unchanged.
 *
 *   'rrf'      — Reciprocal Rank Fusion (Cormack et al. 2009).
 *                Uses the BM25-sorted FTS ranking and the cosine-sorted
 *                vector ranking as two independent ranked lists and merges
 *                them via RRF (k=60). No score normalisation required —
 *                only rank positions matter. Preferred when both lists are
 *                non-empty and you want a calibration-free fusion.
 *
 * Pass `fusion: 'rrf'` to `retrieve()` to enable the RRF path.
 * Omitting the parameter (or passing `'weighted'`) keeps the original
 * behaviour; no existing call-sites are affected.
 */
export type FusionMode = 'weighted' | 'rrf';

// ---------------------------------------------------------------------------
// FTS5 Lexical-RAG helpers (N7 — lexical before vector)
// ---------------------------------------------------------------------------

/**
 * Sanitise a free-text query for use in an FTS5 MATCH expression.
 *
 * FTS5 treats the following as special syntax that causes parse errors when
 * present in bare queries from end-users:
 *   `"` (phrase delimiter), `*` (prefix), `-` (negate), `^` (boost),
 *   `(` `)` (grouping), `:` (column filter), `AND` `OR` `NOT` (operators).
 *
 * Strategy: strip everything that is not alphanumeric, whitespace, or a
 * hyphen within a word.  Then rebuild as a phrase query: wrap in double
 * quotes so FTS5 treats the whole sanitised string as a phrase match rather
 * than individual tokens ANDed together.  This gives the best precision for
 * short Q&A-style queries without requiring the caller to understand FTS5
 * syntax.
 *
 * If the sanitised string is empty (e.g. query was only punctuation) we
 * return null and the lexical stage is skipped entirely.
 */
export function sanitiseFtsQuery(raw: string): string | null {
  // Remove FTS5 special characters; keep alphanumeric + whitespace.
  // We intentionally drop hyphens too — FTS5 treats them as negation prefix.
  const stripped = raw
    .replace(/["*^():\-]/g, ' ')   // replace FTS5 meta-chars with space
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return null;
  // Wrap as phrase query: `"<terms>"` — FTS5 phrase search.
  // Escape any residual double-quotes (should be none after strip, but be safe).
  const escaped = stripped.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Shape returned by ftsLexicalSearch.
 */
interface FtsCandidate {
  /** rag_chunks.id (TEXT PK) */
  id: string;
  workspaceId: string;
  sourceType: string;
  sourceId: string;
  text: string;
  embedding: Buffer;
  tokenCount: number | null;
  sensitivity: string;
  /**
   * BM25 score from SQLite (negative: lower = better match).
   * We normalise to [0,1] for blending with cosine in the caller.
   */
  bm25Raw: number;
}

/**
 * Run an FTS5 MATCH query and return workspace-filtered, sensitivity-safe
 * candidates sorted by BM25 (best first = lowest negative value).
 *
 * N2 invariant: the JOIN on rag_chunks WHERE workspace_id = ? ensures that
 * only chunks belonging to the caller's workspace are returned even though
 * the FTS index itself has no workspace column.
 *
 * Returns an empty array when the FTS query matches nothing or the FTS
 * table does not yet exist (graceful degradation for new DBs before the
 * first indexing run).
 *
 * @param raw  The raw DB handle (better-sqlite3) — used because Drizzle ORM
 *             has no first-class FTS5 virtual-table support.
 * @param ftsQuery  Already-sanitised FTS5 MATCH expression (from sanitiseFtsQuery).
 * @param workspaceId  Caller's workspace — hard-filtered in WHERE clause (N2).
 * @param limit  Max candidates to retrieve from FTS before re-ranking.
 */
export function ftsLexicalSearch(
  raw: import('better-sqlite3').Database,
  ftsQuery: string,
  workspaceId: string,
  limit: number,
): FtsCandidate[] {
  try {
    // Join FTS match rowid → rag_chunks real row to get workspace_id and
    // other fields for the downstream cosine re-rank.
    // bm25() returns a negative float; ORDER BY ASC means best (most negative) first.
    const stmt = raw.prepare<[string, string, number]>(`
      SELECT
        rc.id,
        rc.workspace_id   AS workspaceId,
        rc.source_type    AS sourceType,
        rc.source_id      AS sourceId,
        rc.text,
        rc.embedding,
        rc.token_count    AS tokenCount,
        rc.sensitivity,
        bm25(rag_chunks_fts) AS bm25Raw
      FROM rag_chunks_fts
      JOIN rag_chunks rc ON rc.rowid = rag_chunks_fts.rowid
      WHERE rag_chunks_fts MATCH ?
        AND rc.workspace_id = ?
        AND rc.sensitivity != 'high'
      ORDER BY bm25(rag_chunks_fts) ASC
      LIMIT ?
    `);
    return stmt.all(ftsQuery, workspaceId, limit) as FtsCandidate[];
  } catch (err) {
    // If the FTS table doesn't exist yet (first boot before migration) or the
    // MATCH expression is still malformed, degrade gracefully.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /no such table/i.test(msg) ||
      /fts5: syntax error/i.test(msg) ||
      /fts5.*error/i.test(msg)
    ) {
      console.warn('[rag-retriever] fts5 lexical search degraded:', msg);
      return [];
    }
    throw err;
  }
}

/**
 * Normalise a list of raw BM25 scores to [0, 1] range (higher = better).
 *
 * BM25 from SQLite FTS5 is negative: the most relevant document has the
 * most negative score. We flip and normalise to produce a score where
 * 1.0 = best match.
 *
 * If all scores are equal (degenerate case), every candidate gets 0.5.
 */
function normaliseBm25(candidates: FtsCandidate[]): Map<string, number> {
  const out = new Map<string, number>();
  if (candidates.length === 0) return out;
  const scores = candidates.map((c) => c.bm25Raw);
  const min = Math.min(...scores); // most negative = best
  const max = Math.max(...scores); // least negative = worst
  const range = max - min;
  for (const c of candidates) {
    const norm = range === 0 ? 0.5 : (max - c.bm25Raw) / range;
    out.set(c.id, norm);
  }
  return out;
}

/**
 * Hard-Fail-Sentinel: ein Caller hat den retrieve()-Vertrag verletzt.
 * Niemals catchen-und-leeres-Result-zurueckgeben — der Indexer/Retriever
 * MUSS in dem Fall laut werden, sonst leakt ein zukuenftiger Pfad
 * still durch.
 */
export class RagWorkspaceRequiredError extends Error {
  readonly code = 'RAG_WORKSPACE_REQUIRED';
  constructor(message = 'workspaceId is required for RAG retrieval (DSGVO Art. 28 mandant-trennung)') {
    super(message);
    this.name = 'RagWorkspaceRequiredError';
  }
}

function assertWorkspaceId(workspaceId: unknown): asserts workspaceId is string {
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    workspaceId.trim().length === 0
  ) {
    throw new RagWorkspaceRequiredError();
  }
}

// Blend weight for cosine vs BM25 in the hybrid re-rank step.
// alpha=0.7 → 70% cosine, 30% lexical BM25.  Tunable without API changes.
const HYBRID_ALPHA = 0.7;

// FTS candidate pool: fetch up to k*FTS_POOL_MULTIPLIER candidates from FTS
// before re-ranking so the cosine stage has a large enough pool to work from.
const FTS_POOL_MULTIPLIER = 6;

export async function retrieve(args: {
  workspaceId: string;
  query: string;
  topK?: number;
  tokenCap?: number;
  /**
   * N8-Trace (optional): wenn gesetzt, werden genutzte RAG-Hits als
   * `workstream_evidence`-Rows geschrieben (best-effort, fire-and-forget).
   * Ohne workstreamId ist kein Evidence-Write möglich (FK-Constraint).
   */
  workstreamId?: string;
  /**
   * Fusion strategy for the hybrid (FTS + vector) re-rank step.
   *
   *   'weighted' (default) — alpha*cosine + (1-alpha)*normBM25.
   *                          Existing behaviour, all existing tests pass.
   *   'rrf'                — Reciprocal Rank Fusion. Uses rank position
   *                          only; no score calibration required. Active
   *                          when FTS candidates are present and embedding
   *                          succeeds. Falls back to pure BM25 ordering
   *                          when embedding fails (same as 'weighted' path).
   *
   * The cosine-only fallback path (FTS = 0 results) is unaffected by this
   * parameter — it always uses the existing weighted/routed approach.
   */
  fusion?: FusionMode;
}): Promise<RetrievalResult> {
  // 0. Workspace-Vertrag durchsetzen — Hard-Fail bei leer/undefined.
  assertWorkspaceId(args.workspaceId);

  const k = args.topK ?? DEFAULT_TOP_K;
  const cap = args.tokenCap ?? TOKEN_CAP;

  // 1. Query klassifizieren (cheap, regex-only).
  const intent: QueryIntent = classify(args.query ?? '');

  if (!args.query || args.query.trim().length < 3) {
    return {
      workspaceId: args.workspaceId,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent,
    };
  }

  const db = getDb();

  // -------------------------------------------------------------------------
  // Stufe 0 (N7): Lexical-First — FTS5 MATCH mit BM25-Ranking
  //
  // sanitiseFtsQuery strips FTS5 meta-characters and wraps as phrase query.
  // Returns null when the query is pure punctuation — we skip FTS in that case.
  // -------------------------------------------------------------------------
  const ftsQuery = sanitiseFtsQuery(args.query);

  if (ftsQuery !== null) {
    const ftsCandidates = ftsLexicalSearch(
      db.$raw,
      ftsQuery,
      args.workspaceId,
      k * FTS_POOL_MULTIPLIER,
    );

    if (ftsCandidates.length > 0) {
      // FTS found candidates — try to embed for cosine re-rank.
      let queryVec: Float32Array | null = null;
      try {
        queryVec = await embed(args.query);
      } catch (err) {
        // Embedding is optional here — fall back to pure BM25 ordering.
        console.warn('[rag-retriever] embed-fail (fts-rerank path):', err);
      }

      const bm25Norm = normaliseBm25(ftsCandidates);

      // Compute per-candidate cosine similarity (shared by both fusion modes).
      const cosineMap = new Map<string, number>();
      if (queryVec !== null) {
        for (const c of ftsCandidates) {
          try {
            const vec = unpackEmbedding(c.embedding as Buffer);
            const dot = queryVec.reduce(
              (acc, v, i) => acc + v * (vec[i] ?? 0),
              0,
            );
            const magQ = Math.sqrt(queryVec.reduce((acc, v) => acc + v * v, 0));
            const magC = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
            cosineMap.set(c.id, magQ > 0 && magC > 0 ? dot / (magQ * magC) : 0);
          } catch {
            cosineMap.set(c.id, 0);
          }
        }
      }

      // -----------------------------------------------------------------------
      // Fusion step: RRF or weighted sum.
      //
      // RRF ('rrf'): build two ranked ID lists — BM25 order (ftsCandidates is
      //   already BM25-sorted, ORDER BY bm25 ASC = best first) and cosine order
      //   — then merge via reciprocalRankFusion(). No score normalisation needed.
      //   Falls back to pure BM25 order when embedding failed (cosineMap empty).
      //
      // Weighted ('weighted', default): alpha*cosine + (1-alpha)*normBM25.
      //   Original behaviour unchanged — existing tests remain green.
      // -----------------------------------------------------------------------
      const fusionMode: FusionMode = args.fusion ?? 'weighted';

      const hybridScored: Array<{
        candidate: FtsCandidate;
        hybridScore: number;
        similarity: number;
      }> = (() => {
        if (fusionMode === 'rrf' && queryVec !== null && cosineMap.size > 0) {
          // Build BM25 ranked list (ftsCandidates already sorted best-first).
          const bm25List = ftsCandidates.map((c) => c.id);

          // Build cosine ranked list (descending cosine similarity).
          const cosineList = [...ftsCandidates]
            .sort((a, b) => (cosineMap.get(b.id) ?? 0) - (cosineMap.get(a.id) ?? 0))
            .map((c) => c.id);

          // RRF merge.
          const merged = reciprocalRankFusion([bm25List, cosineList]);
          const rrfScoreMap = new Map(merged.map((r) => [r.id, r.rrfScore]));

          // Re-order ftsCandidates by RRF score, preserving cosine for downstream.
          return ftsCandidates
            .map((c) => ({
              candidate: c,
              hybridScore: rrfScoreMap.get(c.id) ?? 0,
              similarity: cosineMap.get(c.id) ?? 0,
            }))
            .sort((a, b) => b.hybridScore - a.hybridScore);
        }

        // Weighted fusion (default) — original behaviour.
        return ftsCandidates.map((c) => {
          const cosine = cosineMap.get(c.id) ?? 0;
          const bm25Score = bm25Norm.get(c.id) ?? 0;
          const hybridScore =
            queryVec !== null
              ? HYBRID_ALPHA * cosine + (1 - HYBRID_ALPHA) * bm25Score
              : bm25Score;
          return { candidate: c, hybridScore, similarity: cosine };
        });
      })();

      hybridScored.sort((a, b) => b.hybridScore - a.hybridScore);

      // Source-router pass.
      const enrichedFts = hybridScored.map(({ candidate, similarity }) => ({
        id: candidate.id,
        similarity,
        sourceType: candidate.sourceType,
      }));
      const routed = applyRouting(enrichedFts, intent);
      const routedMap = new Map(routed.map((r) => [r.id, r]));

      // Token-Cap pass.
      const hits: RetrievedChunk[] = [];
      let used = 0;
      let truncated = false;
      for (const { candidate, similarity } of hybridScored) {
        // MIN_SIMILARITY guard only applies when we have a real cosine score.
        if (queryVec !== null && similarity < MIN_SIMILARITY) continue;
        // Defense-in-Depth: double-check workspace isolation (N2).
        if (candidate.workspaceId !== args.workspaceId) continue;
        if (candidate.sensitivity === 'high') continue;
        const tokens = candidate.tokenCount ?? Math.ceil(candidate.text.length / 4);
        if (used + tokens > cap) {
          truncated = true;
          break;
        }
        const routedEntry = routedMap.get(candidate.id);
        hits.push({
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          text: candidate.text,
          similarity,
          approxTokens: tokens,
          routedScore: routedEntry?.routedScore,
        });
        used += tokens;
        if (hits.length >= k) break;
      }

      // N8-Trace (best-effort) — same as the cosine path below.
      if (args.workstreamId && hits.length > 0) {
        for (const hit of hits) {
          writeEvidence({
            workspaceId: args.workspaceId,
            workstreamId: args.workstreamId,
            sourceKind: 'rag_chunk',
            sourceId: hit.id,
            snippet: hit.text,
            actor: 'agent',
          });
        }
      }

      return {
        workspaceId: args.workspaceId,
        query: args.query,
        hits,
        totalCandidates: ftsCandidates.length,
        truncated,
        approxTokens: used,
        intent,
      };
    }
    // FTS returned 0 results → fall through to the existing cosine-only path.
  }

  // -------------------------------------------------------------------------
  // Fallback: reiner Cosine-Pfad (Phase-2, unverändert)
  // Greift wenn: FTS-Query nicht sanitisierbar ODER FTS 0 Treffer.
  // -------------------------------------------------------------------------

  // 2. Query embedden
  let queryVec: Float32Array;
  try {
    queryVec = await embed(args.query);
  } catch (err) {
    console.warn('[rag-retriever] embed-fail:', err);
    return {
      workspaceId: args.workspaceId,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent,
    };
  }

  // 3. Read-Pfad ueber View. Caller-Filter `workspace_id = ?` ist Pflicht
  //    laut Service-Vertrag (Migration 0052 §3) — die View filtert
  //    sensitivity!='high' und INNER JOIN workspaces, aber NICHT auf
  //    den konkreten Workspace.
  const rows = db
    .select({
      id: vRagChunksWorkspace.id,
      workspaceId: vRagChunksWorkspace.workspaceId,
      sourceType: vRagChunksWorkspace.sourceType,
      sourceId: vRagChunksWorkspace.sourceId,
      text: vRagChunksWorkspace.text,
      embedding: vRagChunksWorkspace.embedding,
      tokenCount: vRagChunksWorkspace.tokenCount,
      sensitivity: vRagChunksWorkspace.sensitivity,
    })
    .from(vRagChunksWorkspace)
    .where(
      and(
        eq(vRagChunksWorkspace.workspaceId, args.workspaceId),
        ne(vRagChunksWorkspace.sensitivity, 'high'),
      ),
    )
    .all();

  if (rows.length === 0) {
    return {
      workspaceId: args.workspaceId,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent,
    };
  }

  // 4. Top-K via Cosine
  const candidates = rows.map((r) => ({
    id: r.id,
    embedding: unpackEmbedding(r.embedding as Buffer),
  }));
  const ranked = topKHelper(queryVec, candidates, k * 4);
  const lookup = new Map(rows.map((r) => [r.id, r]));

  // 4b. Source-Router
  const enriched = ranked
    .map((r) => {
      const row = lookup.get(r.id);
      if (!row) return null;
      return { id: r.id, similarity: r.similarity, sourceType: row.sourceType };
    })
    .filter(
      (x): x is { id: string; similarity: number; sourceType: string } =>
        x !== null,
    );
  const ranked2 = applyRouting(enriched, intent);
  ranked2.sort((a, b) => b.routedScore - a.routedScore);

  // 5. Token-Cap durchlaufen
  const hits: RetrievedChunk[] = [];
  let used = 0;
  let truncated = false;
  for (const r of ranked2) {
    if (r.similarity < MIN_SIMILARITY) continue;
    const row = lookup.get(r.id);
    if (!row) continue;
    // Defense-in-Depth: View sollte schon hart gefiltert haben, aber wenn
    // die View je gepatcht wird ist das hier der zweite Riegel.
    if (row.workspaceId !== args.workspaceId) continue;
    const tokens = row.tokenCount ?? Math.ceil(row.text.length / 4);
    if (used + tokens > cap) {
      truncated = true;
      break;
    }
    hits.push({
      id: r.id,
      workspaceId: row.workspaceId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      text: row.text,
      similarity: r.similarity,
      approxTokens: tokens,
      routedScore: r.routedScore,
    });
    used += tokens;
    if (hits.length >= k) break;
  }

  // N8-Trace (best-effort, fire-and-forget): pro genutztem Hit eine Evidence-Row.
  // Nur wenn workstreamId mitgegeben wurde — FK-Constraint erfordert gültige
  // workstream_id. writeEvidence wirft nicht (best-effort intern).
  if (args.workstreamId && hits.length > 0) {
    for (const hit of hits) {
      writeEvidence({
        workspaceId: args.workspaceId,
        workstreamId: args.workstreamId,
        sourceKind: 'rag_chunk',
        sourceId: hit.id,
        snippet: hit.text,
        actor: 'agent',
      });
    }
  }

  return {
    workspaceId: args.workspaceId,
    query: args.query,
    hits,
    totalCandidates: rows.length,
    truncated,
    approxTokens: used,
    intent,
  };
}

/**
 * Cross-Workspace-Read mit Pflicht-Audit (DSGVO Art. 30 VVT).
 *
 * Aufrufer MUSS:
 *   - userId mitschicken (Audit-Pflicht — wer hat geschnueffelt).
 *   - reason mitschicken (Audit-Pflicht — warum cross-tenant).
 *   - Mindestens einen workspaceId in workspaceIds (sonst nutzlos).
 *
 * Owner-/Permission-Check ist NICHT Aufgabe dieser Funktion — die
 * Caller-Layer (z. B. /api/admin/rag-search Route) macht die Rolle-Pruefung
 * via `assertOrgRole(req, orgId, 'admin')` o.ae., bevor sie hier landet.
 * Diese Funktion ist die DSGVO-Audit-Spur, nicht die Berechtigungs-Schicht.
 */
export async function retrieveAcrossWorkspaces(args: {
  userId: string;
  /** Der Workspace im Caller-Kontext (Actor). Pflicht für Dataflow-Policy. */
  actorWorkspaceId?: string;
  workspaceIds: string[];
  query: string;
  reason: string;
  topK?: number;
  tokenCap?: number;
}): Promise<CrossWorkspaceRetrievalResult> {
  if (!args.userId || args.userId.trim().length === 0) {
    throw new Error('retrieveAcrossWorkspaces: userId required (audit)');
  }
  if (!args.reason || args.reason.trim().length === 0) {
    throw new Error('retrieveAcrossWorkspaces: reason required (audit)');
  }
  if (!Array.isArray(args.workspaceIds) || args.workspaceIds.length === 0) {
    throw new RagWorkspaceRequiredError(
      'retrieveAcrossWorkspaces: workspaceIds must be non-empty',
    );
  }
  // Trim/dedupe + Hard-Fail bei leeren Strings im Array.
  const wsIds = Array.from(
    new Set(args.workspaceIds.map((w) => (typeof w === 'string' ? w.trim() : ''))),
  );
  if (wsIds.some((w) => w.length === 0)) {
    throw new RagWorkspaceRequiredError(
      'retrieveAcrossWorkspaces: empty workspaceId in list',
    );
  }

  // Symbolische Dataflow-Policy: pro angefragtem Workspace eine deterministische
  // Allow/Deny-Entscheidung. Sensitivity wird hier auf 'medium' default-gesetzt
  // weil retriever bereits sensitivity!='high' im DB-Where filtert; der Caller
  // kann das per Query-Pfad nicht hochsetzen. high bleibt durch View hart out.
  // Wenn actorWorkspaceId fehlt → behandle als system-actor (z.B. Admin-Cron).
  const actorRole = args.actorWorkspaceId ? 'user' : 'system';
  const allowedWsIds: string[] = [];
  const policyDenials: Array<{ ws: string; reason: string }> = [];
  for (const ws of wsIds) {
    const decision = enforceDataflow({
      actorWsId: args.actorWorkspaceId ?? '',
      requestedWsId: ws,
      sensitivity: 'medium',
      actorRole,
    });
    if (decision.allow) {
      allowedWsIds.push(ws);
    } else {
      policyDenials.push({ ws, reason: decision.reason });
    }
  }
  if (allowedWsIds.length === 0) {
    // Alle workspaces by policy denied → leeres Ergebnis + Audit.
    const auditId = writeAudit({
      userId: args.userId,
      query: args.query ?? '',
      workspacesSeen: [],
      hits: 0,
      reason: `${args.reason} (policy-denied: ${policyDenials.map((d) => `${d.ws}:${d.reason}`).join(',')})`,
    });
    return {
      workspaceIds: wsIds,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent: classify(args.query ?? ''),
      auditId,
    };
  }
  // Nur durchgelassene WS gehen weiter.
  wsIds.length = 0;
  wsIds.push(...allowedWsIds);

  const k = args.topK ?? DEFAULT_TOP_K;
  const cap = args.tokenCap ?? TOKEN_CAP;
  const intent: QueryIntent = classify(args.query ?? '');

  if (!args.query || args.query.trim().length < 3) {
    const auditId = writeAudit({
      userId: args.userId,
      query: args.query ?? '',
      workspacesSeen: [],
      hits: 0,
      reason: args.reason,
    });
    return {
      workspaceIds: wsIds,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent,
      auditId,
    };
  }

  let queryVec: Float32Array;
  try {
    queryVec = await embed(args.query);
  } catch (err) {
    console.warn('[rag-retriever] cross-workspace embed-fail:', err);
    const auditId = writeAudit({
      userId: args.userId,
      query: args.query,
      workspacesSeen: [],
      hits: 0,
      reason: `${args.reason} (embed-fail)`,
    });
    return {
      workspaceIds: wsIds,
      query: args.query,
      hits: [],
      totalCandidates: 0,
      truncated: false,
      approxTokens: 0,
      intent,
      auditId,
    };
  }

  const db = getDb();
  const rows = db
    .select({
      id: vRagChunksWorkspace.id,
      workspaceId: vRagChunksWorkspace.workspaceId,
      sourceType: vRagChunksWorkspace.sourceType,
      sourceId: vRagChunksWorkspace.sourceId,
      text: vRagChunksWorkspace.text,
      embedding: vRagChunksWorkspace.embedding,
      tokenCount: vRagChunksWorkspace.tokenCount,
      sensitivity: vRagChunksWorkspace.sensitivity,
    })
    .from(vRagChunksWorkspace)
    .where(
      and(
        inArray(vRagChunksWorkspace.workspaceId, wsIds),
        ne(vRagChunksWorkspace.sensitivity, 'high'),
      ),
    )
    .all();

  const candidates = rows.map((r) => ({
    id: r.id,
    embedding: unpackEmbedding(r.embedding as Buffer),
  }));
  const ranked = topKHelper(queryVec, candidates, k * 4);
  const lookup = new Map(rows.map((r) => [r.id, r]));

  const enriched = ranked
    .map((r) => {
      const row = lookup.get(r.id);
      if (!row) return null;
      return { id: r.id, similarity: r.similarity, sourceType: row.sourceType };
    })
    .filter(
      (x): x is { id: string; similarity: number; sourceType: string } =>
        x !== null,
    );
  const ranked2 = applyRouting(enriched, intent);
  ranked2.sort((a, b) => b.routedScore - a.routedScore);

  const hits: RetrievedChunk[] = [];
  const seenWs = new Set<string>();
  let used = 0;
  let truncated = false;
  for (const r of ranked2) {
    if (r.similarity < MIN_SIMILARITY) continue;
    const row = lookup.get(r.id);
    if (!row) continue;
    if (!wsIds.includes(row.workspaceId)) continue; // Belt-and-Suspenders
    const tokens = row.tokenCount ?? Math.ceil(row.text.length / 4);
    if (used + tokens > cap) {
      truncated = true;
      break;
    }
    hits.push({
      id: r.id,
      workspaceId: row.workspaceId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      text: row.text,
      similarity: r.similarity,
      approxTokens: tokens,
      routedScore: r.routedScore,
    });
    seenWs.add(row.workspaceId);
    used += tokens;
    if (hits.length >= k) break;
  }

  // N2 fail-closed: Audit-Insert und Ergebnis-Rückgabe müssen atomar sein.
  // Schlägt der INSERT fehl, wirft die Transaktion — kein Ergebnis ohne
  // erfolgreichen Audit-Row (DSGVO Art. 30 + N2-Constraint, POS-7).
  // better-sqlite3 `.transaction(fn)` gibt eine Wrapper-Funktion zurück;
  // der Aufruf `txFn()` führt `fn` atomar aus und wirft bei Fehler.
  const auditId = `xws_${ulid()}`;
  const db2 = getDb();
  const txFn = db2.$raw.transaction(() => {
    db2.insert(ragCrossWorkspaceAudit)
      .values({
        id: auditId,
        userId: args.userId,
        query: args.query.slice(0, 2000),
        workspacesSeen: JSON.stringify(Array.from(seenWs)),
        hits: hits.length,
        reason: args.reason.slice(0, 500),
        createdAt: Date.now(),
      })
      .run();
  });
  txFn(); // wirft bei Fehler → fail-closed (kein Ergebnis ohne Audit)

  return {
    workspaceIds: wsIds,
    query: args.query,
    hits,
    totalCandidates: rows.length,
    truncated,
    approxTokens: used,
    intent,
    auditId,
  };
}

/**
 * Schreibt einen Cross-Workspace-Audit-Row — synchron, DSGVO Art. 30.
 *
 * Wirft bei DB-Fehler (fail-closed): Aufrufer muss den Fehler fangen oder
 * — im main-retrieval-Pfad — in einer Transaktion kapseln, damit kein
 * Retrieval-Ergebnis ohne erfolgreichen Audit-Row zurückgegeben wird (N2).
 *
 * Auch von `lib/rag/mcp-proxy.ts` aufgerufen wenn ein MCP-Knowledge-Base-
 * Treffer auf "shared-knowledge" downgegradet wird (also der Knowledge-
 * Base-Pfad nicht zum aufrufenden Workspace passt).
 */
export function writeAudit(args: {
  userId: string;
  query: string;
  workspacesSeen: string[];
  hits: number;
  reason: string;
}): string {
  const id = `xws_${ulid()}`;
  const db = getDb();
  // Wirft bei Fehler (kein try/catch) — N2: fail-closed.
  db.insert(ragCrossWorkspaceAudit)
    .values({
      id,
      userId: args.userId,
      query: args.query.slice(0, 2000),
      workspacesSeen: JSON.stringify(args.workspacesSeen),
      hits: args.hits,
      reason: args.reason.slice(0, 500),
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/**
 * Format für Lead-Prompt-Inject. Markdown-Sektion mit Quellen-Anker.
 * Empty-String wenn 0 hits — Caller prüft .length statt zu prepend-en.
 */
export function formatForPrompt(result: RetrievalResult): string {
  if (result.hits.length === 0) return '';
  const blocks = result.hits.map((h, i) => {
    const ref = `${h.sourceType}:${h.sourceId}`;
    return `### Kontext-Treffer ${i + 1} · ${ref} · sim=${h.similarity.toFixed(2)}\n${h.text}`;
  });
  const head = [
    `## Workspace-Kontext (RAG · ${result.hits.length}/${result.totalCandidates} Chunks · intent=${result.intent})`,
    `**Query:** "${result.query.slice(0, 100)}"`,
    `**Token-Budget:** ${result.approxTokens}/${TOKEN_CAP}${result.truncated ? ' (truncated)' : ''}`,
    '',
  ].join('\n');
  return `${head}${blocks.join('\n\n')}\n`;
}
