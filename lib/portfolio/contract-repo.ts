/**
 * Phase 2 W3 — Portfolio-Spine · Contract-Persistenz-Slice
 * ════════════════════════════════════════════════════════════════════════
 *
 * WAS DIESES MODUL SCHLIESST (W3-Orchestrator-Befund, verbatim N1)
 * ────────────────────────────────────────────────────────────────
 *   „loadPortfolioRunState rekonstruiert `LaneState.contract` NICHT aus der DB;
 *    die Gates lesen ihn aus dem State, den ein In-Memory-Caller injiziert. Der
 *    Contract-Persistenz-Slice muss `LaneState.contract` aus einer DB-Quelle
 *    zurücklesen, damit die Gates in Produktion über echte Lane-Verträge
 *    entscheiden statt nur über das, was ein In-Memory-Caller injiziert."
 *
 * Bis hierher konnte ein Lane-Vertrag nur IN-MEMORY existieren — d.h. ein
 * Caller setzte `state.laneStates[id].contract` von Hand (so wie die Tests es
 * via `withGreenContracts`-Spy tun). In Produktion bedeutete das: die 6 Gates
 * (G1..G6) sahen IMMER `contract: null` und blockierten alles. Dieser Slice
 * gibt dem Lane-Vertrag ein persistentes Substrat und einen Reader, sodass
 * `loadPortfolioRunState` (spine.ts) den echten Vertrag zurückliest.
 *
 * SUBSTRAT-DISZIPLIN (N4 — KEINE neue Tabelle)
 * ────────────────────────────────────────────
 * Wir reusen exakt das Trace-Substrat, das der Orchestrator schon für
 * Stage-Completions nutzt: `workstream_decisions`. Ein Lane-Vertrag wird als
 * EINE Decision-Row auf dem **Lane-Child-Workstream** geschrieben:
 *
 *   workstream_id   = <lane-child-ws-id>   (NICHT der parent — der Vertrag
 *                     gehört genau EINER Lane; der Reader joint pro Lane-Child)
 *   decision_kind   = 'route'              (0071 CHECK-constrained; reused wie
 *                     bei den Stage-Completions — kein neuer Kind)
 *   rationale       = 'portfolio-lane-contract: <verbatim-JSON>'  (N1: das
 *                     komplette Contract-JSON, KEIN .slice/.substring)
 *   evidence_refs   = ["<sentinel>"]       (0071 CHECK: array length >= 1)
 *   content_hash    = sha256(kanonisches Contract-JSON)  (N10: gleicher
 *                     Vertrag → gleicher Hash → idempotenter Re-Write)
 *   actor           = 'policy'             (Maschinen-Persistenz, kein
 *                     user/agent-Maskieren — wie der Stage-Advance)
 *
 * Warum `workstream_decisions` und nicht `workstream_evidence`?
 *   - Der Vertrag IST eine Entscheidung über die Lane („so sieht der Vertrag
 *     dieser Lane aus"), kein Retrieval-Beleg. `decision_kind='route'` deckt
 *     genau diesen „Routing/Verdrahtungs"-Charakter ab und ist bereits der
 *     Kind, mit dem der Spine seine Portfolio-Rows liest (Konsistenz).
 *   - `workstream_decisions` ist append-only + tamper-evident (Trigger in 0071)
 *     → N8/N10 sind ohne Zusatzarbeit erfüllt.
 *   - `workstream_evidence` würde den Vertrag als „Provenance-Beleg"
 *     fehlrahmen und das auditierbare „warum?"-Feld (rationale) verschenken.
 *
 * DETERMINISMUS + FAIL-SOFT (N6)
 * ──────────────────────────────
 * `loadLaneContract` parst rein deterministisch (JSON.parse + struktureller
 * Validator) und wirft NIEMALS — bei fehlender Tabelle, fehlender Row,
 * kaputtem JSON oder strukturell ungültigem Vertrag liefert es `null`. Ein
 * `null` ist rückwärtskompatibel: die Gates behandeln „kein Vertrag" exakt so
 * wie vor diesem Slice (Lane blockt das Gate).
 *
 * RÜCKWÄRTSKOMPATIBILITÄT mit `withGreenContracts`
 * ────────────────────────────────────────────────
 * Der Test-Spy `withGreenContracts` überschreibt JEDEN geladenen State NACH
 * dem realen Reader und setzt alle contracts auf `fullContract()`. Da der Spy
 * NACH `loadPortfolioRunState` greift, hat er Vorrang vor dem, was dieser Slice
 * aus der DB liest — bestehende Orchestrator-Tests bleiben unberührt. Bei
 * leerer DB (kein persistierter Vertrag) bleibt `contract: null` wie bisher.
 *
 * Schnittstellen-Form: wie `loadPortfolioRunState`/`orchestrator.ts` arbeitet
 * dieses Modul direkt auf dem rohen `better-sqlite3`-Handle — synchron,
 * deterministisch, in-memory-testbar (gleiches Muster wie der ganze Spine).
 *
 * Stand: 2026-05-29
 */

import { createHash } from 'node:crypto';

import type { Database as Sqlite } from 'better-sqlite3';

import { ulid } from '@/lib/ulid';

import type { LaneContract } from './types';
import { validateLaneContract } from './spine';

// ───────────────────────────────────────────────────────────────────────────
// Konstanten — das Vokabular, auf das loadLaneContract beim Read matched.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rationale-Präfix für eine persistierte Lane-Vertrags-Row. Inklusive
 * Trailing-Space. NICHT ändern, ohne den Reader (`loadLaneContract`)
 * gleichzeitig anzupassen — sonst findet der Reader den Vertrag nicht.
 * Bewusst distinkt vom Stage-Completion-Präfix
 * (`portfolio-stage-completed: `), damit beide 'route'-Decision-Arten am
 * selben Workstream sauber trennbar bleiben.
 */
export const LANE_CONTRACT_PREFIX = 'portfolio-lane-contract: ';

/** Decision-Kind, den wir reusen (0071 CHECK). Identisch zum Spine-Reader. */
const CONTRACT_DECISION_KIND = 'route';

/** Actor — Maschinen-Persistenz, kein user/agent-Maskieren (N8). */
const CONTRACT_DECISION_ACTOR = 'policy';

// ───────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ───────────────────────────────────────────────────────────────────────────

/**
 * Kanonisches Contract-JSON. Schreibt die 12 Felder in FESTER Reihenfolge,
 * damit der content_hash deterministisch ist (zwei identische Verträge → ein
 * Hash → ein Row, N10-Idempotenz). N1: KEIN .slice/.substring — der volle
 * Vertrag wird verbatim serialisiert.
 */
function canonicalContractJson(contract: LaneContract): string {
  // Feste Schlüssel-Reihenfolge (entspricht der Integration-Plan-§6-Sequenz).
  const ordered = {
    inputEvents: contract.inputEvents,
    outputEvents: contract.outputEvents,
    dataSchema: contract.dataSchema,
    permissionRequirements: contract.permissionRequirements,
    confidenceBehavior: contract.confidenceBehavior,
    humanReviewRequirements: contract.humanReviewRequirements,
    errorStates: contract.errorStates,
    auditRequirements: contract.auditRequirements,
    uxSurfaces: contract.uxSurfaces,
    metrics: contract.metrics,
    testFixtures: contract.testFixtures,
    rolloutConstraints: contract.rolloutConstraints,
  };
  return JSON.stringify(ordered);
}

/** SHA-256 über das kanonische Contract-JSON (N10). Immer 64 hex-Zeichen. */
function contractContentHash(contract: LaneContract): string {
  return createHash('sha256')
    .update(canonicalContractJson(contract))
    .digest('hex');
}

/**
 * Reiner, struktureller Parser für eine persistierte Vertrags-Rationale.
 * Deterministisch (N6), wirft nie — bei jedem Fehler `null`.
 *
 * Akzeptiert nur, wenn:
 *   1. die Rationale mit `LANE_CONTRACT_PREFIX` beginnt,
 *   2. der Rest gültiges JSON ist,
 *   3. das geparste Objekt `validateLaneContract`-valide ist (alle 12 Felder).
 *
 * Schritt 3 ist bewusst streng: ein strukturell unvollständiger Vertrag in der
 * DB darf NICHT als „echter Vertrag" durchrutschen und ein Gate fälschlich
 * grün färben. Unvollständig → `null` → das Gate blockt (sicher, fail-closed
 * im Sinne der Gate-Disziplin).
 */
export function parseLaneContractRationale(
  rationale: unknown,
): LaneContract | null {
  if (typeof rationale !== 'string') return null;
  if (!rationale.startsWith(LANE_CONTRACT_PREFIX)) return null;

  // N1: der VOLLE Rest hinter dem Präfix ist das Contract-JSON — kein .slice
  // auf den Inhalt, nur das Abschneiden des bekannten Präfix-Markers.
  const json = rationale.slice(LANE_CONTRACT_PREFIX.length);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  // Re-Konstruktion in die strenge LaneContract-Form. Wir übernehmen NUR die 12
  // bekannten Felder (kein Durchreichen fremder Keys), dann validieren wir.
  const reconstructed: LaneContract = {
    inputEvents: asStringArray(candidate.inputEvents),
    outputEvents: asStringArray(candidate.outputEvents),
    dataSchema: asStringArray(candidate.dataSchema),
    permissionRequirements: asStringArray(candidate.permissionRequirements),
    confidenceBehavior: candidate.confidenceBehavior as LaneContract['confidenceBehavior'],
    humanReviewRequirements:
      candidate.humanReviewRequirements as LaneContract['humanReviewRequirements'],
    errorStates: asStringArray(candidate.errorStates),
    auditRequirements: asStringArray(candidate.auditRequirements),
    uxSurfaces: asStringArray(candidate.uxSurfaces),
    metrics: asStringArray(candidate.metrics),
    testFixtures: asStringArray(candidate.testFixtures),
    rolloutConstraints: asStringArray(candidate.rolloutConstraints),
  };

  const v = validateLaneContract(reconstructed);
  if (!v.valid) return null;
  return reconstructed;
}

/**
 * Hilfs-Coercion: gibt das Array zurück, wenn es eines ist, sonst `[]`.
 * (Die Strenge — nur nicht-leere Strings — übernimmt `validateLaneContract`.)
 */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

// ───────────────────────────────────────────────────────────────────────────
// persistLaneContract — Writer.
// ───────────────────────────────────────────────────────────────────────────

export interface PersistLaneContractInput {
  /** workstreams.id des Lane-CHILD-Workstream (role='lane:<id>'). */
  workstreamId: string;
  /** Der vollständige 12-Punkte-Vertrag dieser Lane. */
  contract: LaneContract;
}

export type PersistLaneContractResult =
  | {
      persisted: true;
      /** workstream_decisions.id der geschriebenen (oder existierenden) Row. */
      decisionId: string;
      /** content_hash der Vertrags-Row (N10). */
      contentHash: string;
    }
  | {
      persisted: false;
      /** Verbatim-Begründung, warum nicht persistiert wurde (N8-lesbar). */
      reason: string;
    };

/**
 * Persistiert den 12-Punkte-LaneContract eines Lane-Child-Workstreams als EINE
 * append-only `workstream_decisions`-Row (N4-Substrat, N8-Trace, N10-Hash).
 *
 * Ablauf:
 *   0. Vertrag MUSS strukturell vollständig sein (`validateLaneContract`) —
 *      einen kaputten Vertrag persistieren wir nicht (sonst läse der Reader ihn
 *      ohnehin als null zurück).
 *   1. Sentinel-Evidence-Row (workstream_evidence) für den 0071-CHECK
 *      (evidence_refs >= 1). Fehlt die Tabelle (reduziertes Schema) →
 *      fail-soft synthetischer Ref.
 *   2. EINE Decision-Row: decision_kind='route', rationale=PRÄFIX+verbatim-JSON,
 *      content_hash=sha256(kanonisches JSON), actor='policy'. INSERT OR IGNORE
 *      → derselbe Vertrag zweimal = idempotent (UNIQUE(workstream_id,
 *      content_hash)).
 *
 * Alles in EINER Transaktion. Wirft nie — bei DB-Fehler `persisted:false`.
 *
 * WICHTIG: `workstreamId` ist der LANE-CHILD, nicht der parent. Der Reader
 * (`loadLaneContract`) joint pro Lane-Child — ein Vertrag gehört genau einer
 * Lane.
 */
export function persistLaneContract(
  db: Sqlite,
  input: PersistLaneContractInput,
): PersistLaneContractResult {
  const { workstreamId, contract } = input;

  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    return { persisted: false, reason: 'persistLaneContract: workstreamId required' };
  }

  const validation = validateLaneContract(contract);
  if (!validation.valid) {
    return {
      persisted: false,
      reason: `persistLaneContract: contract invalid — ${validation.issues.join('; ')}`,
    };
  }

  const json = canonicalContractJson(contract);
  const rationale = `${LANE_CONTRACT_PREFIX}${json}`;
  const contentHash = contractContentHash(contract);

  try {
    const decisionId = db.transaction(() => {
      // (1) Sentinel-Evidence (0071-CHECK: evidence_refs >= 1). N8-Provenance.
      const evId = `ev_${ulid()}`;
      const evSourceRef = `lane-contract:${workstreamId}`;
      const evHash = createHash('sha256')
        .update(
          JSON.stringify({
            workstream_id: workstreamId,
            source_ref: evSourceRef,
            source_kind: 'spawn',
            content_hash: contentHash,
          }),
        )
        .digest('hex');
      let evidenceId = evId;
      try {
        db.prepare(
          `INSERT OR IGNORE INTO workstream_evidence
             (id, workstream_id, source_ref, source_kind, content_hash, allowed, bridge_id, created_at)
           VALUES (?, ?, ?, 'spawn', ?, 1, NULL, unixepoch())`,
        ).run(evId, workstreamId, evSourceRef, evHash);
        const existingEv = db
          .prepare(
            `SELECT id FROM workstream_evidence
              WHERE workstream_id = ? AND source_ref = ? AND content_hash = ?
              LIMIT 1`,
          )
          .get(workstreamId, evSourceRef, evHash) as { id: string } | undefined;
        evidenceId = existingEv?.id ?? evId;
      } catch (evErr) {
        // workstream_evidence fehlt (reduziertes Schema) → synthetischer Ref.
        console.warn(
          '[portfolio/contract-repo] evidence write skipped (table missing?), using synthetic ref:',
          evErr instanceof Error ? evErr.message : String(evErr),
        );
        evidenceId = `synthetic:${evHash}`;
      }

      // (2) Vertrags-Decision (append-only, idempotent via UNIQUE content_hash).
      const decId = `dec_${ulid()}`;
      const evidenceRefsJson = JSON.stringify([evidenceId]);
      db.prepare(
        `INSERT OR IGNORE INTO workstream_decisions
           (id, workstream_id, decision_kind, rationale, evidence_refs,
            content_hash, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      ).run(
        decId,
        workstreamId,
        CONTRACT_DECISION_KIND,
        rationale,
        evidenceRefsJson,
        contentHash,
        CONTRACT_DECISION_ACTOR,
      );

      const existingDec = db
        .prepare(
          `SELECT id FROM workstream_decisions
            WHERE workstream_id = ? AND content_hash = ?
            LIMIT 1`,
        )
        .get(workstreamId, contentHash) as { id: string } | undefined;

      return existingDec?.id ?? decId;
    })();

    return { persisted: true, decisionId, contentHash };
  } catch (err) {
    console.warn(
      '[portfolio/contract-repo] persistLaneContract failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return {
      persisted: false,
      reason: `persistLaneContract: write failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// loadLaneContract — Reader.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Liest den persistierten 12-Punkte-LaneContract eines Lane-Child-Workstreams
 * aus der DB zurück. Deterministisch (N6), fail-soft → `null`.
 *
 * Es gewinnt die JÜNGSTE gültige Vertrags-Row (ORDER BY created_at DESC, id
 * DESC) — so kann eine Lane ihren Vertrag append-only fortschreiben und der
 * Reader liefert immer den aktuellsten. Append-only (N8): alte Versionen
 * bleiben als Trace erhalten.
 *
 * Liefert `null`, wenn:
 *   - workstreamId leer/ungültig,
 *   - die Tabelle fehlt (reduziertes Schema),
 *   - keine Vertrags-Row existiert,
 *   - keine der Rows ein strukturell vollständiges Contract-JSON enthält.
 *
 * `null` ist rückwärtskompatibel: die Gates behandeln „kein Vertrag" exakt so,
 * wie es VOR diesem Slice war.
 */
export function loadLaneContract(
  db: Sqlite,
  workstreamId: string,
): LaneContract | null {
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    return null;
  }

  let rows: Array<{ rationale: string }>;
  try {
    rows = db
      .prepare(
        `SELECT rationale FROM workstream_decisions
          WHERE workstream_id = ?
            AND decision_kind = '${CONTRACT_DECISION_KIND}'
          ORDER BY created_at DESC, id DESC`,
      )
      .all(workstreamId) as Array<{ rationale: string }>;
  } catch {
    // Tabelle fehlt o.ä. → fail-soft.
    return null;
  }

  // Die jüngste Row, die als gültiger Vertrag parst, gewinnt. Wir gehen die
  // Liste deterministisch durch (DESC) und nehmen den ersten Treffer — andere
  // 'route'-Rows (z.B. Stage-Completions am parent) matchen das Präfix nicht
  // und werden übersprungen.
  for (const row of rows) {
    const contract = parseLaneContractRationale(row.rationale);
    if (contract) return contract;
  }
  return null;
}
