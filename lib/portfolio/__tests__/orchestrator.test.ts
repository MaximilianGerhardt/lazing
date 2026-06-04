/**
 * Phase 2 W2.x — Portfolio-Orchestrator tests (der WRITER zur Lese-Brille).
 *
 * Strategie (identisch zu spine.test.ts): in-memory better-sqlite3 mit den
 * ECHTEN Migrationen (0001 + 0009 + 0040 + 0048 + 0071), damit wir den
 * vollen Roundtrip Writer→Reader testen.
 *
 * Run:
 *   pnpm vitest run lib/portfolio/__tests__/orchestrator.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  STAGE_COMPLETED_PREFIX,
  advanceStage,
  createPortfolioRun,
  getPortfolioRunStatus,
} from '@/lib/portfolio/orchestrator';
import {
  loadPortfolioRunState,
  nextMergeableStages,
} from '@/lib/portfolio/spine';
import type { LaneContract, MergeStageId } from '@/lib/portfolio/types';
import { LANE_IDS } from '@/lib/portfolio/types';

// ───────────────────────────────────────────────────────────────────────────
// DB-Bootstrap — exakt das Muster aus spine.test.ts.
// ───────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

function loadSql(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = OFF');
  raw.exec(loadSql('0001_initial.sql'));
  raw.exec(loadSql('0009_workstreams.sql'));
  raw.exec(loadSql('0040_sub_workstreams.sql'));
  try {
    raw.exec(loadSql('0048_workstream_mode.sql'));
  } catch {
    try {
      raw.exec(`ALTER TABLE workstreams ADD COLUMN mode TEXT`);
    } catch {
      /* schon vorhanden */
    }
  }
  // 0069 workstream_evidence — der Stage-Completion-Writer schreibt einen
  // Sentinel-Evidence-Row (evidence_refs ≥1, N8-Provenance), bevor er die
  // Decision schreibt. Ohne diese Tabelle würde der Write fail-soft scheitern.
  raw.exec(loadSql('0069_workstream_evidence.sql'));
  // 0071 workstream_decisions table.
  raw.exec(loadSql('0071_workstream_decisions.sql'));
  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Gate-Helfer — alle Lane-Children mit gültigem 12-Punkte-Vertrag „bestücken".
//
// loadPortfolioRunState liest contracts NICHT aus der DB (LaneState.contract
// bleibt beim Read null). Damit die Gates grün werden können, monkey-patchen
// wir den geladenen State in-place vor dem canMergeStage-Aufruf — aber der
// ADVANCE-Pfad lädt selbst neu. Darum prüfen wir die Gate-Disziplin über zwei
// Wege:
//   - roter Pfad: ohne contracts (DB-Default) → Stage 1 blockt sofort.
//   - grüner Pfad: wir stellen sicher, dass G-Gates grün sind, indem wir den
//     advanceStage NICHT direkt verwenden, sondern eine Test-Variante, die den
//     contract-bestückten State injiziert. Da advanceStage intern lädt, geben
//     wir die Verträge über einen Spy auf loadPortfolioRunState. Einfacher:
//     wir testen den grünen Pfad, indem wir ein Stage advancen, dessen Gates
//     bei LEEREN Verträgen trotzdem... nein. → Wir nutzen den realen Writer
//     mit voll bestückten Verträgen via DB-Marker.
// ───────────────────────────────────────────────────────────────────────────

function fullContract(overrides?: Partial<LaneContract>): LaneContract {
  return {
    inputEvents: ['intake.envelope.created'],
    outputEvents: ['expertise.object.compiled'],
    dataSchema: ['workstream_evidence', 'workspace_beliefs'],
    permissionRequirements: ['workspace:read', 'workspace:write'],
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    errorStates: ['intake-empty', 'intake-malformed'],
    auditRequirements: ['workstream_evidence row per intake'],
    uxSurfaces: ['open-questions', 'plan-step'],
    metrics: ['intake_envelope_count', 'intake_latency_ms'],
    testFixtures: ['tests/fixtures/intake/sample.json'],
    rolloutConstraints: ['dry-run until LIVE flip'],
    ...overrides,
  };
}

/**
 * Da `loadPortfolioRunState` die Lane-Verträge NICHT aus der DB rekonstruiert
 * (das ist Lane-Implementierungs-Arbeit eines anderen Slices), patchen wir
 * `loadPortfolioRunState` für die grünen-Gate-Tests so, dass es jeden geladenen
 * State mit voll bestückten Verträgen anreichert. So testen wir die
 * Gate-DISZIPLIN des Orchestrators (advance NUR bei grünem Gate) ehrlich,
 * ohne den noch-nicht-existenten Contract-Writer vorwegzunehmen.
 *
 * Wir setzen das via vi.spyOn auf das spine-Modul — advanceStage importiert
 * loadPortfolioRunState aus genau diesem Modul.
 */
import * as spine from '@/lib/portfolio/spine';
import { vi } from 'vitest';

function withGreenContracts<T>(fn: () => T): T {
  const real = spine.loadPortfolioRunState;
  const spy = vi
    .spyOn(spine, 'loadPortfolioRunState')
    .mockImplementation((db, ws) => {
      const state = real(db as never, ws as never);
      if (!state) return state;
      for (const id of LANE_IDS) {
        state.laneStates[id].contract = fullContract();
      }
      return state;
    });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// (a) createPortfolioRun legt parent + N children an.
// ───────────────────────────────────────────────────────────────────────────

describe('createPortfolioRun', () => {
  it('creates a parent (mode=portfolio) + one child per lane (role=lane:<id>)', () => {
    const db = freshDb();
    const lanes = ['governance', 'communication-intake', 'expertise-compiler'];
    const res = createPortfolioRun(db, {
      workspaceId: 'ws-1',
      lanes,
      intent: 'build the CRM',
    });

    expect(res.portfolioRunId).toMatch(/^WS-/);
    expect(res.lanes).toEqual(lanes);
    expect(Object.keys(res.laneWorkstreamIds).sort()).toEqual(
      [...lanes].sort(),
    );

    // parent row.
    const parent = db
      .prepare(
        `SELECT id, mode, parent_workstream_id, status, workspace_id, name
           FROM workstreams WHERE id = ?`,
      )
      .get(res.portfolioRunId) as Record<string, unknown>;
    expect(parent.mode).toBe('portfolio');
    expect(parent.parent_workstream_id).toBeNull();
    expect(parent.status).toBe('active');
    expect(parent.workspace_id).toBe('ws-1');
    expect(String(parent.name)).toContain('build the CRM');

    // child rows.
    const children = db
      .prepare(
        `SELECT id, role, parent_workstream_id, mode FROM workstreams
          WHERE parent_workstream_id = ? ORDER BY created_at ASC`,
      )
      .all(res.portfolioRunId) as Array<Record<string, unknown>>;
    expect(children.length).toBe(3);
    expect(children.map((c) => c.role)).toEqual([
      'lane:governance',
      'lane:communication-intake',
      'lane:expertise-compiler',
    ]);
    for (const c of children) {
      expect(c.parent_workstream_id).toBe(res.portfolioRunId);
      expect(c.mode).toBeNull(); // nur der parent ist 'portfolio'.
    }
  });

  it('defaults to all 7 canonical lanes when none/invalid are passed', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-x' });
    expect(res.lanes.sort()).toEqual([...LANE_IDS].sort());
    expect(Object.keys(res.laneWorkstreamIds).length).toBe(7);
  });

  it('throws on missing workspaceId', () => {
    const db = freshDb();
    expect(() => createPortfolioRun(db, { workspaceId: '' })).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) loadPortfolioRunState findet den Run jetzt (nicht mehr null).
// ───────────────────────────────────────────────────────────────────────────

describe('loadPortfolioRunState after createPortfolioRun', () => {
  it('is non-null and exposes the created run + lane workstreams', () => {
    const db = freshDb();
    // Vorher: kein Run → null (Befund: write-only spine).
    expect(loadPortfolioRunState(db, 'ws-2')).toBeNull();

    const res = createPortfolioRun(db, {
      workspaceId: 'ws-2',
      lanes: ['governance', 'mobile-ux'],
      intent: 'demo',
    });

    const state = loadPortfolioRunState(db, 'ws-2');
    expect(state).not.toBeNull();
    expect(state!.portfolioRunId).toBe(res.portfolioRunId);
    expect(state!.laneStates['governance'].workstreamId).toBe(
      res.laneWorkstreamIds['governance'],
    );
    expect(state!.laneStates['mobile-ux'].workstreamId).toBe(
      res.laneWorkstreamIds['mobile-ux'],
    );
    // Nicht angeforderte Lane bleibt not-started ohne workstreamId.
    expect(state!.laneStates['innovation-mode'].workstreamId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) advanceStage mit grünem Gate → Decision geschrieben + Stage completed.
// ───────────────────────────────────────────────────────────────────────────

describe('advanceStage (green gate)', () => {
  it('writes the completion decision, marks the stage completed, advances nextMergeable', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-3' });

    withGreenContracts(() => {
      // Vor dem Advance: Stage 1 ist merge-ready, Stage 2 noch nicht.
      const before = spine.loadPortfolioRunState(db, 'ws-3')!;
      expect(nextMergeableStages(before)).toContain('governance-gate-contract');
      expect(nextMergeableStages(before)).not.toContain('source-event-envelope');

      const r = advanceStage(db, {
        portfolioRunId: res.portfolioRunId,
        stage: 'governance-gate-contract',
      });
      expect(r.advanced).toBe(true);
      if (r.advanced) {
        expect(r.decisionId).toMatch(/^dec_/);
        // nextMergeable rückt zur nächsten Stage vor.
        expect(r.nextMergeable).toContain('source-event-envelope');
        expect(r.nextMergeable).not.toContain('governance-gate-contract');
      }
    });

    // Persistenz: genau EINE route-Decision mit dem exakten Reader-Präfix.
    const decisions = db
      .prepare(
        `SELECT rationale, actor, decision_kind FROM workstream_decisions
          WHERE workstream_id = ?`,
      )
      .all(res.portfolioRunId) as Array<Record<string, unknown>>;
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision_kind).toBe('route');
    expect(decisions[0].actor).toBe('policy');
    expect(String(decisions[0].rationale)).toBe(
      `${STAGE_COMPLETED_PREFIX}governance-gate-contract`,
    );

    // Der ECHTE Reader (ohne Spy) findet die Completion jetzt.
    const state = loadPortfolioRunState(db, 'ws-3')!;
    expect(state.completedMergeStages).toEqual(['governance-gate-contract']);
  });

  it('is idempotent — advancing the same stage twice writes only one row', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-idem' });

    withGreenContracts(() => {
      const r1 = advanceStage(db, {
        portfolioRunId: res.portfolioRunId,
        stage: 'governance-gate-contract',
      });
      expect(r1.advanced).toBe(true);

      // Zweiter Advance derselben Stage: canMergeStage sieht sie schon in
      // completedMergeStages → ok=false → kein zweiter Write.
      const r2 = advanceStage(db, {
        portfolioRunId: res.portfolioRunId,
        stage: 'governance-gate-contract',
      });
      expect(r2.advanced).toBe(false);
    });

    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .get(res.portfolioRunId) as { n: number };
    expect(count.n).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) advanceStage mit rotem Gate → kein Advance, kein Decision-Write.
// ───────────────────────────────────────────────────────────────────────────

describe('advanceStage (red gate)', () => {
  it('does NOT advance and writes NO decision when the gate is red', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-4' });

    // KEINE Verträge bestückt → G1 (concept-integrity) ist rot für Stage 1.
    const r = advanceStage(db, {
      portfolioRunId: res.portfolioRunId,
      stage: 'governance-gate-contract',
    });
    expect(r.advanced).toBe(false);
    if (!r.advanced) {
      expect(r.gate).not.toBeNull();
      expect(r.gate!.blockingGates).toContain('G1-concept-integrity');
      expect(r.reason).toContain('gates-red');
    }

    // Kein Decision-Row geschrieben.
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .get(res.portfolioRunId) as { n: number };
    expect(count.n).toBe(0);

    // Reader bestätigt: nichts completed.
    const state = loadPortfolioRunState(db, 'ws-4')!;
    expect(state.completedMergeStages).toEqual([]);
  });

  it('returns advanced:false for an unknown / non-existent portfolioRunId', () => {
    const db = freshDb();
    const r = advanceStage(db, {
      portfolioRunId: 'WS-DOES-NOT-EXIST',
      stage: 'governance-gate-contract',
    });
    expect(r.advanced).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (e) Sequenz-Disziplin: Stage N kann nicht vor Stage N-1 advancen.
// ───────────────────────────────────────────────────────────────────────────

describe('advanceStage sequence discipline (requires-DAG)', () => {
  it('refuses to advance Stage 2 before Stage 1 is completed', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-5' });

    withGreenContracts(() => {
      // Stage 2 (source-event-envelope) requires Stage 1 → blocked.
      const r = advanceStage(db, {
        portfolioRunId: res.portfolioRunId,
        stage: 'source-event-envelope',
      });
      expect(r.advanced).toBe(false);
      if (!r.advanced) {
        expect(r.gate!.blockingRequirements).toContain(
          'governance-gate-contract',
        );
        expect(r.reason).toContain('requires');
      }
    });

    // Kein Write trotz grüner Gates — die requires-DAG blockt.
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .get(res.portfolioRunId) as { n: number };
    expect(count.n).toBe(0);
  });

  it('allows Stage 2 ONLY after Stage 1 has been advanced (ordered walk)', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-6' });

    withGreenContracts(() => {
      const order: MergeStageId[] = [
        'governance-gate-contract',
        'source-event-envelope',
        'expertise-object-model',
      ];
      for (const stage of order) {
        const r = advanceStage(db, {
          portfolioRunId: res.portfolioRunId,
          stage,
        });
        expect(r.advanced).toBe(true);
      }
    });

    const state = loadPortfolioRunState(db, 'ws-6')!;
    expect(state.completedMergeStages).toEqual([
      'governance-gate-contract',
      'source-event-envelope',
      'expertise-object-model',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// getPortfolioRunStatus
// ───────────────────────────────────────────────────────────────────────────

describe('getPortfolioRunStatus', () => {
  it('returns state + nextMergeable for a real run', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-7' });
    const status = getPortfolioRunStatus(db, res.portfolioRunId);
    expect(status).not.toBeNull();
    expect(status!.state.portfolioRunId).toBe(res.portfolioRunId);
    expect(Array.isArray(status!.nextMergeable)).toBe(true);
  });

  it('returns null for an unknown run', () => {
    const db = freshDb();
    expect(getPortfolioRunStatus(db, 'WS-NOPE')).toBeNull();
  });
});
