/**
 * RAG retriever (Sprint 2 / strand B, 2026-04-30).
 *
 * Phase 2 (2026-05-03): workspace-isolation service refactor.
 *   - The read path goes through `v_rag_chunks_workspace` (Drizzle view, Migration 0052).
 *   - `workspaceId` is a HARD requirement: empty/undefined value -> RagWorkspaceRequiredError.
 *   - New function `retrieveAcrossWorkspaces()` with an audit insert into
 *     `rag_cross_workspace_audit` (GDPR Art. 30 record-of-processing requirement).
 *
 * Phase 3 (2026-05-24): lexical-first (N7).
 *   - Stage 0 (new): FTS5 MATCH query on `rag_chunks_fts` with BM25 ranking.
 *     The candidate set is workspace-filtered via a JOIN on rag_chunks.
 *     sensitivity!='high' is always doubly filtered (N2 / defense-in-depth).
 *   - If FTS candidates are present: apply the existing cosine-rerank stage to
 *     them (combined score: alpha*cosine + (1-alpha)*normBM25).
 *   - If FTS has 0 hits: fall back to the previous pure-cosine path
 *     (unchanged from Phase 2).
 *   - Query sanitiser for FTS5 syntax (special characters are escaped so that
 *     there is no syntax error for queries like "foo & bar" or "foo*").
 *
 * Query → [FTS5-lexical] → candidates → cosine-rerank → token-cap →
 * markdown format for the lead-prompt inject.
 * Fallback: Query → embed → brute-force cosine (Phase-2 path, no FTS).
 *
 * Token budget per lead call: 4000-token hard cap (≈ 16k chars).
 *
 * Privacy gate (defense-in-depth):
 *   The view `v_rag_chunks_workspace` already has sensitivity!='high' hard-
 *   wired in. The retriever filters AGAIN on sensitivity != 'high' in the
 *   where clause — belt and suspenders. The FTS path filters as well via a
 *   JOIN on rag_chunks WHERE sensitivity != 'high'.
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
// Cosine cut-off — everything below is noise. Raised 0.25→0.30 (2026-06-02,
// Codex parity): measured, thematically unrelated chunks (e.g. „mm/Maße"
// code for a „Closure in JavaScript" question) slipped through narrowly at
// sim≈0.25-0.26 and diluted the prompt. Real topical hits score 0.4+, modest-but-
// relevant ones 0.32+. 0.30 removes the noise with a clear margin without losing
// real hits. RAG stays „more context", but only when it really fits.
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
 * Hard-fail sentinel: a caller violated the retrieve() contract.
 * Never catch-and-return-an-empty-result — in that case the indexer/retriever
 * MUST be loud, otherwise a future path leaks through
 * silently.
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
   * N8 trace (optional): if set, used RAG hits are written as
   * `workstream_evidence` rows (best-effort, fire-and-forget).
   * Without workstreamId no evidence write is possible (FK constraint).
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
  // 0. Enforce the workspace contract — hard-fail on empty/undefined.
  assertWorkspaceId(args.workspaceId);

  const k = args.topK ?? DEFAULT_TOP_K;
  const cap = args.tokenCap ?? TOKEN_CAP;

  // 1. Classify the query (cheap, regex-only).
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
  // Stage 0 (N7): lexical-first — FTS5 MATCH with BM25 ranking
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
  // Fallback: pure cosine path (Phase-2, unchanged)
  // Applies when: the FTS query is not sanitisable OR FTS has 0 hits.
  // -------------------------------------------------------------------------

  // 2. Embed the query
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

  // 3. Read path via the view. The caller filter `workspace_id = ?` is mandatory
  //    per the service contract (Migration 0052 §3) — the view filters
  //    sensitivity!='high' and INNER JOIN workspaces, but NOT on
  //    the concrete workspace.
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

  // 4. Top-K via cosine
  const candidates = rows.map((r) => ({
    id: r.id,
    embedding: unpackEmbedding(r.embedding as Buffer),
  }));
  const ranked = topKHelper(queryVec, candidates, k * 4);
  const lookup = new Map(rows.map((r) => [r.id, r]));

  // 4b. Source router
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

  // 5. Run through the token cap
  const hits: RetrievedChunk[] = [];
  let used = 0;
  let truncated = false;
  for (const r of ranked2) {
    if (r.similarity < MIN_SIMILARITY) continue;
    const row = lookup.get(r.id);
    if (!row) continue;
    // Defense-in-depth: the view should already have hard-filtered, but if
    // the view is ever patched, this is the second bolt.
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

  // N8 trace (best-effort, fire-and-forget): one evidence row per used hit.
  // Only when workstreamId was provided — the FK constraint requires a valid
  // workstream_id. writeEvidence does not throw (best-effort internally).
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
 * Cross-workspace read with mandatory audit (GDPR Art. 30 record-of-processing).
 *
 * The caller MUST:
 *   - pass userId (audit requirement — who snooped).
 *   - pass reason (audit requirement — why cross-tenant).
 *   - at least one workspaceId in workspaceIds (otherwise useless).
 *
 * The owner/permission check is NOT this function's job — the
 * caller layer (e.g. the /api/admin/rag-search route) does the role check
 * via `assertOrgRole(req, orgId, 'admin')` or similar before it lands here.
 * This function is the GDPR audit trail, not the authorization layer.
 */
export async function retrieveAcrossWorkspaces(args: {
  userId: string;
  /** The workspace in the caller context (actor). Mandatory for the dataflow policy. */
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
  // Trim/dedupe + hard-fail on empty strings in the array.
  const wsIds = Array.from(
    new Set(args.workspaceIds.map((w) => (typeof w === 'string' ? w.trim() : ''))),
  );
  if (wsIds.some((w) => w.length === 0)) {
    throw new RagWorkspaceRequiredError(
      'retrieveAcrossWorkspaces: empty workspaceId in list',
    );
  }

  // Symbolic dataflow policy: a deterministic allow/deny decision per requested
  // workspace. Sensitivity defaults to 'medium' here because the retriever
  // already filters sensitivity!='high' in the DB where; the caller
  // cannot raise it via the query path. high stays hard out via the view.
  // If actorWorkspaceId is missing → treat as a system actor (e.g. an admin cron).
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
    // All workspaces denied by policy → empty result + audit.
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
  // Only the WS that passed continue.
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
    if (!wsIds.includes(row.workspaceId)) continue; // belt and suspenders
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

  // N2 fail-closed: the audit insert and the result return must be atomic.
  // If the INSERT fails, the transaction throws — no result without a
  // successful audit row (GDPR Art. 30 + N2 constraint, POS-7).
  // better-sqlite3 `.transaction(fn)` returns a wrapper function;
  // calling `txFn()` runs `fn` atomically and throws on error.
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
  txFn(); // throws on error → fail-closed (no result without an audit)

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
 * Writes a cross-workspace audit row — synchronously, GDPR Art. 30.
 *
 * Throws on a DB error (fail-closed): the caller must catch the error or
 * — in the main retrieval path — wrap it in a transaction so that no
 * retrieval result is returned without a successful audit row (N2).
 *
 * Also called by `lib/rag/mcp-proxy.ts` when an MCP knowledge-base
 * hit is downgraded to "shared-knowledge" (i.e. the knowledge-
 * base path does not match the calling workspace).
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
  // Throws on error (no try/catch) — N2: fail-closed.
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
 * Format for the lead-prompt inject. Markdown section with source anchors.
 * Empty string when 0 hits — the caller checks .length instead of prepending.
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
