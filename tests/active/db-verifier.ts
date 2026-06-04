/**
 * tests/active/db-verifier.ts
 *
 * READ-ONLY-Inspektor gegen die LIVE-DB (`./data/lazyos.db`). KEINE
 * INSERT/UPDATE/DELETE. Snapshot + Befund-Tabellen für den Bericht.
 *
 * Geprüfte Tabellen:
 *   - rag_chunks                  → Stream-C-Indikator: leer = N7-Verstoß
 *   - rag_indexer_state           → Indexer-Heartbeat
 *   - rag_retrieval_audit         → wenn 0 Rows trotz Chat-Aktivität: N2-Verstoß
 *   - workspace_beliefs           → Stream-A-Indikator (Self-Learning Read-Back)
 *   - decision_outcomes           → Stream-A-Indikator (Post-Prozess-Abgleich)
 *   - reasoning_audit             → N8-Indikator (Trace = Evidenz)
 *   - workstreams                 → einer pro Plan-Run; leer = Wiring-Gap
 *   - workspace_heartbeats        → letzter Sweep-Zeitstempel
 *   - flow_runs                   → Flow-Studio Telemetrie
 *
 * Run:
 *   pnpm exec tsx tests/active/db-verifier.ts
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { record, writeJsonReport, exitCodeFromResults } from './utils/report';

const DB_PATH = process.env.LAZYOS_DB_PATH ?? path.resolve(__dirname, '..', '..', 'data', 'lazyos.db');
const REPO = path.resolve(__dirname, '..', '..');

function sqlite(query: string): string {
  try {
    return execSync(`sqlite3 ${JSON.stringify(DB_PATH)} ${JSON.stringify(query)}`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch (e) {
    return `ERROR: ${(e as Error).message.split('\n')[0]}`;
  }
}

function count(table: string, where?: string): number {
  const q = `SELECT COUNT(*) FROM ${table}${where ? ` WHERE ${where}` : ''};`;
  const out = sqlite(q);
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : -1;
}

function main(): void {
  if (!existsSync(DB_PATH)) {
    record({
      name: 'db.exists',
      status: 'fail',
      evidence: `DB nicht gefunden: ${DB_PATH}`,
    });
    process.exit(1);
  }

  // --- Boot ---
  record({
    name: 'db.path',
    status: 'pass',
    evidence: `${DB_PATH}`,
  });

  // --- RAG ---
  const ragChunks = count('rag_chunks');
  record({
    name: 'rag_chunks.count',
    status: ragChunks > 0 ? 'pass' : 'fail',
    evidence: `${ragChunks} chunks indexed. 0 → N7-Verstoß (lexical RAG ships before vector sophistication).`,
  });

  if (ragChunks > 0) {
    const wsSplit = sqlite(
      "SELECT workspace_id, COUNT(*) FROM rag_chunks GROUP BY workspace_id ORDER BY 2 DESC LIMIT 5;",
    );
    record({
      name: 'rag_chunks.workspace_distribution',
      status: 'pass',
      evidence: wsSplit || '(empty)',
    });
  }

  const ragIndexer = sqlite(
    "SELECT workspace_id, source_type, total_chunks, datetime(last_indexed_ts/1000,'unixepoch') AS last_indexed, circuit_open FROM rag_indexer_state ORDER BY last_indexed_ts DESC LIMIT 10;",
  );
  record({
    name: 'rag_indexer_state.rows',
    status: ragIndexer && !ragIndexer.startsWith('ERROR') ? 'pass' : 'warn',
    evidence: ragIndexer || '(empty)',
  });

  // rag_retrieval_audit: N2-relevant. Existiert die Tabelle? Wenn ja, wie viele
  // Rows und wieviele denials?
  const ragAuditExists = sqlite(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='rag_retrieval_audit';",
  );
  if (ragAuditExists === 'rag_retrieval_audit') {
    const all = count('rag_retrieval_audit');
    const denied = count('rag_retrieval_audit', "allowed = 0");
    record({
      name: 'rag_retrieval_audit',
      status: 'pass',
      evidence: `${all} total, ${denied} denied. N2-fail-closed indicator.`,
    });
  } else {
    // Fall back to the cross-workspace audit table that the codebase uses today.
    const xwa = sqlite(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rag_cross_workspace_audit';",
    );
    if (xwa === 'rag_cross_workspace_audit') {
      const all = count('rag_cross_workspace_audit');
      record({
        name: 'rag_cross_workspace_audit (legacy split-table)',
        status: 'warn',
        evidence: `${all} rows. Plan-Doc: rag_retrieval_audit als single-table noch nicht migriert (POS-2-Drift).`,
      });
    } else {
      record({
        name: 'rag_audit',
        status: 'fail',
        evidence: 'Weder rag_retrieval_audit noch rag_cross_workspace_audit existiert — N2-Audit-Tabelle fehlt.',
      });
    }
  }

  // --- Self-Learning / WARUM-Engine (Stream A) ---
  const beliefs = count('workspace_beliefs');
  record({
    name: 'workspace_beliefs.count',
    status: beliefs > 0 ? 'pass' : 'warn',
    evidence:
      `${beliefs} beliefs. 0 = Stream-A schema exists but write-loop not yet wired ` +
      `(GOAL-lazyos-self-learning-why-engine — code: lib/reasoning/*, plan: ` +
      `docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md).`,
  });

  const decOut = count('decision_outcomes');
  record({
    name: 'decision_outcomes.count',
    status: decOut > 0 ? 'pass' : 'warn',
    evidence:
      `${decOut} outcomes. 0 = Post-Prozess-Abgleich (IST/SOLL) noch nicht aktiv. ` +
      `Erwartung nach Stream-A-Vollwirkung: ≥1 pro abgeschlossener Plan-Run.`,
  });

  // --- Reasoning Audit (N8) ---
  const ra = count('reasoning_audit');
  record({
    name: 'reasoning_audit.count',
    status: ra > 0 ? 'pass' : 'fail',
    evidence: `${ra} rows. N8 verlangt: jede Entscheidung/Quelle/Korrektur/Rejection schreibt eine Zeile.`,
  });

  // Letzte 3 reasoning_audit-Rows als Spot-Check.
  const raRecent = sqlite(
    "SELECT id, phase, role, llm_model, COALESCE(workspace_id,''), datetime(ts/1000,'unixepoch') FROM reasoning_audit ORDER BY ts DESC LIMIT 3;",
  );
  record({
    name: 'reasoning_audit.recent_3',
    status: 'pass',
    evidence: raRecent || '(empty)',
  });

  // --- Workstreams (Plan-Run-Indikator) ---
  const ws = count('workstreams');
  record({
    name: 'workstreams.count',
    status: ws > 0 ? 'pass' : 'warn',
    evidence: `${ws} workstreams. 0 = noch nie ein Plan/Iterate-Run gelaufen ODER Wiring-Gap (audit doc).`,
  });

  const wsRecent = sqlite(
    "SELECT id, COALESCE(workspace_id,''), COALESCE(status,''), datetime(created_at/1000,'unixepoch') FROM workstreams ORDER BY created_at DESC LIMIT 3;",
  );
  record({
    name: 'workstreams.recent_3',
    status: 'pass',
    evidence: wsRecent || '(empty)',
  });

  // --- Workspace Heartbeats ---
  const hb = count('workspace_heartbeats');
  record({
    name: 'workspace_heartbeats.count',
    status: hb > 0 ? 'pass' : 'warn',
    evidence: `${hb} heartbeats.`,
  });
  const hbRecent = sqlite(
    "SELECT workspace_id, status, lag_sec, datetime(ts/1000,'unixepoch') FROM workspace_heartbeats ORDER BY ts DESC LIMIT 5;",
  );
  record({
    name: 'workspace_heartbeats.recent',
    status: 'pass',
    evidence: hbRecent || '(empty)',
  });

  // --- Flow-Runs (Flow Studio Telemetrie) ---
  const flowRuns = count('flow_runs');
  record({
    name: 'flow_runs.count',
    status: flowRuns >= 0 ? 'pass' : 'fail',
    evidence: `${flowRuns} flow_runs. 0 = noch keine Flow-Studio-Runs gestartet (Owner-Goal Flow-Studio P0–P5 noch in-flight).`,
  });

  // --- Failed Experiments (Lern-Loop-Indikator) ---
  const fe = count('failed_experiments');
  record({
    name: 'failed_experiments.count',
    status: 'pass',
    evidence: `${fe} failed_experiments rows.`,
  });

  // --- Permission Modes Coverage ---
  const pm = sqlite(
    "SELECT COALESCE(workspace_id, '(org)') AS scope, mode, effective_since, set_by FROM lazyos_permission_modes ORDER BY effective_since DESC LIMIT 10;",
  );
  record({
    name: 'lazyos_permission_modes.recent',
    status: 'pass',
    evidence: pm || '(empty — alle Workspaces im plan-only Default)',
  });

  // --- FS-Roots (Workspace-Isolation FS-1) ---
  const fsRoots = count('workspace_fs_roots');
  record({
    name: 'workspace_fs_roots.count',
    status: 'pass',
    evidence: `${fsRoots} fs_root entries.`,
  });

  // --- Summary ---
  const outJson = path.join(REPO, 'docs/audits/2026-05-28_db-verifier-report.json');
  writeJsonReport(outJson);
  console.log(`\nWrote ${outJson}`);
  process.exit(exitCodeFromResults());
}

main();
