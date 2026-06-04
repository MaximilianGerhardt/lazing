/**
 * Lane B — Expertise Compiler · Mirror-to-Beliefs (N4-Naht)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29.
 *
 * Master-Briefing §8 (Lane B) + Integration-Plan §4 Lane B Outputs (verbatim, N1):
 *   „Glossary Entries · Principles · If-Then Rules · Exceptions · Tactics ·
 *    Eval Cases · Belief Candidates."
 *
 * ── DER N4-PROBLEMRAUM ────────────────────────────────────────────────────
 *
 * `knowledge_forms.statement/rationale` ist strukturell identisch zu
 * `workspace_beliefs.belief/rationale`. Eine blinde Text-Kopie waere
 * N4-Doppelhaltung („Recovery before reinvention" — dieselbe Aussage in zwei
 * Stores, die auseinanderdriften koennen). Diese Datei schliesst die Naht:
 *
 *   1. Sie benutzt AUSSCHLIESSLICH `upsertBelief` aus
 *      lib/reasoning/beliefs-repo.ts — KEIN eigener Belief-Writer (kein
 *      zweites INSERT INTO workspace_beliefs irgendwo).
 *   2. Sie schreibt die zurueckgegebene `belief.id` in
 *      `knowledge_forms.source_json.beliefId` zurueck (Rueck-FK). Damit ist
 *      a) die Spiegelung idempotent (ein bereits gespiegeltes knowledge_form
 *         spiegelt nicht erneut), und b) die Projektion explizit: das
 *         knowledge_form ist die Quelle, der belief die abgeleitete,
 *         recall-/reconcile-faehige Projektion.
 *   3. Beides passiert in EINER TX (analog N2-Disziplin: die Spiegelung und
 *      der Rueck-FK sind atomar — entweder beide oder keine).
 *
 * ── TOPIC-ABLEITUNG (deterministisch, dokumentiert) ───────────────────────
 *
 * `recallRelevant` / `reconcile` (lib/reasoning/) finden Beliefs ueber
 * `workspace_beliefs.topic` (exact-Match + LIKE-Substring, lower-cased). Damit
 * die gespiegelten Beliefs wiederauffindbar sind, MUSS die Topic-Ableitung
 * deterministisch + stabil sein. Regel (verbatim):
 *
 *   - glossary:  topic = lower(term)          (der Begriff IST das Topic)
 *   - sonst:     topic = lower(domain)         (die Fach-Domain, z.B. 'pv-planning')
 *   - Fallback (weder term noch domain gesetzt):
 *                topic = lower(kind)            (die Wissensform selbst)
 *
 * Alle Varianten werden getrimmt; Whitespace-Folgen auf ein Leerzeichen
 * normalisiert (damit „PV Planning" und „pv  planning" dasselbe Topic geben).
 * KEIN .slice/.substring — der Wert wird nur lower-cased + whitespace-
 * normalisiert, nie gekuerzt (N1).
 *
 * ── DISZIPLIN ──────────────────────────────────────────────────────────────
 *   - N1:  belief/rationale werden VERBATIM aus statement/rationale uebernommen.
 *   - N4:  upsertBelief ist der EINZIGE Belief-Writer; Rueck-FK statt Kopie.
 *   - N8:  knowledge_forms.source_json-UPDATE ist erlaubt (Trigger blockt nur
 *          id/kind/term/statement/content_hash) — die Spiegelung mutiert KEIN
 *          Kern-Feld.
 *   - N10: content_hash bleibt unangetastet (Spiegelung ist Annotation).
 *
 * Reines DB-Modul: nimmt ein rohes better-sqlite3-Handle (analog
 * lib/reasoning/beliefs-repo.ts) — kein getDb()-Singleton, in-memory testbar.
 * KEIN LLM, keine Netz-I/O.
 */

import { upsertBelief, type Belief } from "@/lib/reasoning/beliefs-repo";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// Topic-Ableitung (exportiert für Tests + Lane-Contract)
// ───────────────────────────────────────────────────────────────────────────

function normalizeTopic(value: string): string {
  // lower + whitespace-Folgen → ein Space + trim. KEIN slice (N1).
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministische Topic-Ableitung aus kind/term/domain. Siehe Modul-Doc.
 * Wirft, wenn keine der drei Quellen einen nicht-leeren Topic ergibt — eine
 * Spiegelung ohne Topic waere von recallRelevant nicht wiederfindbar.
 */
export function deriveBeliefTopic(args: {
  kind: string;
  term: string | null;
  domain: string | null;
}): string {
  const { kind, term, domain } = args;
  if (kind === "glossary" && typeof term === "string" && term.trim().length > 0) {
    return normalizeTopic(term);
  }
  if (typeof domain === "string" && domain.trim().length > 0) {
    return normalizeTopic(domain);
  }
  if (typeof kind === "string" && kind.trim().length > 0) {
    return normalizeTopic(kind);
  }
  throw new Error(
    "deriveBeliefTopic: cannot derive a non-empty topic from kind/term/domain",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Result-Typ
// ───────────────────────────────────────────────────────────────────────────

export interface MirrorResult {
  /** Die gespiegelte (neu angelegte) belief-Row. */
  readonly belief: Belief;
  /** Das abgeleitete Topic (für Recall/Reconcile-Auffindbarkeit). */
  readonly topic: string;
  /** true, wenn das knowledge_form bereits gespiegelt war (No-op-Rückgabe der bestehenden belief-Projektion). */
  readonly alreadyMirrored: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// mirrorApprovedKnowledgeFormToBelief
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spiegelt ein APPROVED knowledge_form in workspace_beliefs (0113) und schreibt
 * den Rueck-FK (belief.id) in knowledge_forms.source_json.beliefId — beides in
 * EINER TX.
 *
 * Idempotent: ist source_json.beliefId bereits gesetzt UND die referenzierte
 * belief-Row existiert noch, wird NICHT erneut gespiegelt (alreadyMirrored=true,
 * bestehende belief-Row zurueckgegeben).
 *
 * Fail-fast (Wurf), wenn:
 *   - das knowledge_form nicht existiert,
 *   - sein review_state ≠ 'approved' ist (nur approved wird gespiegelt — §8
 *     human-review-Gate),
 *
 * @param raw              rohes better-sqlite3-Handle
 * @param knowledgeFormId  id der zu spiegelnden knowledge_forms-Row
 */
export function mirrorApprovedKnowledgeFormToBelief(
  raw: RawDb,
  knowledgeFormId: string,
): MirrorResult {
  if (typeof knowledgeFormId !== "string" || knowledgeFormId.length === 0) {
    throw new Error(
      "mirrorApprovedKnowledgeFormToBelief: knowledgeFormId required",
    );
  }

  const kf = raw
    .prepare(
      `SELECT id, workspace_id, kind, term, statement, rationale, domain,
              source_json, review_state
         FROM knowledge_forms
        WHERE id = ?
        LIMIT 1`,
    )
    .get(knowledgeFormId) as
    | {
        id: string;
        workspace_id: string;
        kind: string;
        term: string | null;
        statement: string;
        rationale: string | null;
        domain: string | null;
        source_json: string | null;
        review_state: string;
      }
    | undefined;

  if (!kf) {
    throw new Error(
      `mirrorApprovedKnowledgeFormToBelief: knowledge_form '${knowledgeFormId}' not found`,
    );
  }
  if (kf.review_state !== "approved") {
    throw new Error(
      `mirrorApprovedKnowledgeFormToBelief: knowledge_form '${knowledgeFormId}' ` +
        `is '${kf.review_state}', only 'approved' may be mirrored (§8 review gate)`,
    );
  }

  // Bestehendes source_json parsen (defensiv — kann null / kaputt sein).
  let sourceObj: Record<string, unknown> = {};
  if (typeof kf.source_json === "string" && kf.source_json.length > 0) {
    try {
      const parsed = JSON.parse(kf.source_json);
      if (parsed && typeof parsed === "object") {
        sourceObj = parsed as Record<string, unknown>;
      }
    } catch {
      // kaputtes JSON → wir starten mit leerem Envelope, ueberschreiben es
      // unten kontrolliert (kein Datenverlust an Kern-Feldern — die liegen in
      // eigenen Spalten).
      sourceObj = {};
    }
  }

  const topic = deriveBeliefTopic({
    kind: kf.kind,
    term: kf.term,
    domain: kf.domain,
  });

  const existingBeliefId =
    typeof sourceObj.beliefId === "string" ? sourceObj.beliefId : null;

  // Idempotenz: bereits gespiegelt + Ziel-belief existiert noch (im selben WS)?
  if (existingBeliefId) {
    const existing = raw
      .prepare(
        `SELECT id, workspace_id, topic, belief, rationale, source,
                supersedes_id, confidence, content_hash, created_at, updated_at
           FROM workspace_beliefs
          WHERE id = ? AND workspace_id = ?
          LIMIT 1`,
      )
      .get(existingBeliefId, kf.workspace_id) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return {
        belief: {
          id: String(existing.id),
          workspaceId: String(existing.workspace_id),
          topic: String(existing.topic),
          belief: String(existing.belief),
          rationale: String(existing.rationale),
          source: existing.source as Belief["source"],
          supersedesId: (existing.supersedes_id as string | null) ?? null,
          confidence:
            existing.confidence == null ? null : Number(existing.confidence),
          contentHash: String(existing.content_hash),
          createdAt: Number(existing.created_at),
          updatedAt: Number(existing.updated_at),
        },
        topic,
        alreadyMirrored: true,
      };
    }
    // Rueck-FK zeigte auf eine nicht (mehr) existente belief-Row → neu spiegeln.
  }

  // EINE TX: upsertBelief (einziger Belief-Writer, N4) + Rueck-FK-UPDATE.
  const txn = raw.transaction((): Belief => {
    const belief = upsertBelief(raw, {
      workspaceId: kf.workspace_id,
      topic,
      belief: kf.statement, // N1: verbatim
      // workspace_beliefs.rationale ist NOT NULL — knowledge_forms.rationale
      // ist nullable. Fallback auf das statement (verbatim, kein slice), damit
      // die NOT-NULL-Disziplin gewahrt bleibt ohne Inhalt zu erfinden.
      rationale:
        typeof kf.rationale === "string" && kf.rationale.length > 0
          ? kf.rationale // N1: verbatim
          : kf.statement, // N1: verbatim Fallback
      source: "ai", // aus Lane-B-Kompilierung abgeleitet
    });

    const nextSourceJson = JSON.stringify({
      ...sourceObj,
      beliefId: belief.id,
    });

    // N8: source_json-UPDATE ist erlaubt (Trigger blockt nur id/kind/term/
    // statement/content_hash). updated_at darf mitwachsen.
    raw
      .prepare(
        `UPDATE knowledge_forms
            SET source_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextSourceJson, Date.now(), kf.id);

    return belief;
  });

  const belief = txn();

  return { belief, topic, alreadyMirrored: false };
}
