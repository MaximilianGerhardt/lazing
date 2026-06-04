/**
 * Phase 2 W3 — Portfolio Contract-Persistenz-Slice tests.
 *
 * Schließt den W3-Orchestrator-Befund: `loadPortfolioRunState` rekonstruiert
 * `LaneState.contract` jetzt AUS DER DB (statt nur aus dem In-Memory-Caller).
 *
 * Strategie (identisch zu spine.test.ts / orchestrator.test.ts): in-memory
 * better-sqlite3 mit den ECHTEN Migrationen, voller Roundtrip Writer→Reader.
 *
 * Run:
 *   pnpm vitest run lib/portfolio/__tests__/contract-repo.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  LANE_CONTRACT_PREFIX,
  loadLaneContract,
  parseLaneContractRationale,
  persistLaneContract,
} from '@/lib/portfolio/contract-repo';
import { createPortfolioRun } from '@/lib/portfolio/orchestrator';
import { loadPortfolioRunState, runQualityGate } from '@/lib/portfolio/spine';
import type { LaneContract } from '@/lib/portfolio/types';
import { LANE_IDS } from '@/lib/portfolio/types';

// ───────────────────────────────────────────────────────────────────────────
// DB-Bootstrap — exakt das Muster aus orchestrator.test.ts.
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
  raw.exec(loadSql('0069_workstream_evidence.sql'));
  raw.exec(loadSql('0071_workstream_decisions.sql'));
  return raw;
}

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

// ───────────────────────────────────────────────────────────────────────────
// (a) Round-Trip: persistLaneContract → loadLaneContract (12 Felder verbatim).
// ───────────────────────────────────────────────────────────────────────────

describe('persistLaneContract → loadLaneContract round-trip', () => {
  it('preserves all 12 fields verbatim (N1)', () => {
    const db = freshDb();
    // distinkte, nicht-default Werte in JEDEM der 12 Felder, damit kein Feld
    // versehentlich vom Default „durchrutscht".
    const contract: LaneContract = {
      inputEvents: ['a.in.1', 'a.in.2'],
      outputEvents: ['a.out.1'],
      dataSchema: ['table_x', 'view_y', 'table_z'],
      permissionRequirements: ['perm:read', 'perm:write', 'perm:bridge'],
      confidenceBehavior: 'llm-with-human-review',
      humanReviewRequirements: 'required',
      errorStates: ['err-1', 'err-2', 'err-3'],
      auditRequirements: ['audit-a', 'audit-b'],
      uxSurfaces: ['surface-1'],
      metrics: ['m1', 'm2', 'm3', 'm4'],
      testFixtures: ['fx/one.json', 'fx/two.json'],
      rolloutConstraints: ['constraint-1', 'constraint-2'],
    };

    const w = persistLaneContract(db, { workstreamId: 'WS-LANE-A', contract });
    expect(w.persisted).toBe(true);

    const loaded = loadLaneContract(db, 'WS-LANE-A');
    expect(loaded).not.toBeNull();
    // Verbatim: jedes der 12 Felder exakt erhalten — KEIN slice/substring.
    expect(loaded).toEqual(contract);
  });

  it('writes exactly one workstream_decisions row (route + policy + prefix)', () => {
    const db = freshDb();
    persistLaneContract(db, {
      workstreamId: 'WS-LANE-B',
      contract: fullContract(),
    });

    const rows = db
      .prepare(
        `SELECT decision_kind, actor, rationale, content_hash, evidence_refs
           FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .all('WS-LANE-B') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].decision_kind).toBe('route');
    expect(rows[0].actor).toBe('policy');
    expect(String(rows[0].rationale).startsWith(LANE_CONTRACT_PREFIX)).toBe(true);
    // N10: 64-hex content_hash.
    expect(String(rows[0].content_hash)).toMatch(/^[0-9a-f]{64}$/);
    // 0071-CHECK: evidence_refs ist ein Array mit >= 1 Eintrag.
    const refs = JSON.parse(String(rows[0].evidence_refs));
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — same contract twice writes only one row (N10)', () => {
    const db = freshDb();
    const c = fullContract();
    const r1 = persistLaneContract(db, { workstreamId: 'WS-LANE-C', contract: c });
    const r2 = persistLaneContract(db, { workstreamId: 'WS-LANE-C', contract: c });
    expect(r1.persisted).toBe(true);
    expect(r2.persisted).toBe(true);
    if (r1.persisted && r2.persisted) {
      expect(r1.contentHash).toBe(r2.contentHash);
    }
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .get('WS-LANE-C') as { n: number };
    expect(count.n).toBe(1);
  });

  it('newest valid contract wins when the lane updates its contract (append-only)', () => {
    const db = freshDb();
    persistLaneContract(db, {
      workstreamId: 'WS-LANE-D',
      contract: fullContract({ metrics: ['old-metric'] }),
    });
    persistLaneContract(db, {
      workstreamId: 'WS-LANE-D',
      contract: fullContract({ metrics: ['new-metric-1', 'new-metric-2'] }),
    });
    // Beide Versionen bleiben als Trace erhalten (append-only, N8).
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workstream_decisions WHERE workstream_id = ?`,
      )
      .get('WS-LANE-D') as { n: number };
    expect(count.n).toBe(2);
    // Reader liefert die jüngste.
    const loaded = loadLaneContract(db, 'WS-LANE-D');
    expect(loaded?.metrics).toEqual(['new-metric-1', 'new-metric-2']);
  });

  it('refuses to persist an invalid contract (empty errorStates)', () => {
    const db = freshDb();
    const r = persistLaneContract(db, {
      workstreamId: 'WS-LANE-E',
      contract: fullContract({ errorStates: [] }),
    });
    expect(r.persisted).toBe(false);
    expect(loadLaneContract(db, 'WS-LANE-E')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) Fail-soft: leere DB / fehlende Rows / kaputte Rationale → kein Crash.
// ───────────────────────────────────────────────────────────────────────────

describe('loadLaneContract fail-soft (N6)', () => {
  it('returns null for a workstream with no contract row', () => {
    const db = freshDb();
    expect(loadLaneContract(db, 'WS-NONE')).toBeNull();
  });

  it('returns null for empty / invalid workstreamId', () => {
    const db = freshDb();
    expect(loadLaneContract(db, '')).toBeNull();
    expect(loadLaneContract(db, null as unknown as string)).toBeNull();
  });

  it('returns null when the table is missing (reduced schema)', () => {
    const bare = new Database(':memory:');
    // Keine 0071-Migration → workstream_decisions existiert nicht.
    expect(loadLaneContract(bare, 'WS-X')).toBeNull();
  });

  it('skips non-contract route rows (e.g. stage-completions) without crashing', () => {
    const db = freshDb();
    // Eine fremde 'route'-Decision (anderes Präfix) am selben Workstream.
    db.prepare(
      `INSERT INTO workstream_decisions
         (id, workstream_id, decision_kind, rationale, evidence_refs,
          content_hash, actor, created_at)
       VALUES (?, ?, 'route', ?, ?, ?, 'policy', unixepoch())`,
    ).run(
      'dec_other',
      'WS-LANE-F',
      'portfolio-stage-completed: governance-gate-contract',
      JSON.stringify(['ev-1']),
      '0000000000000000000000000000000000000000000000000000000000000abc',
    );
    // Kein Vertrag → null, kein Crash trotz vorhandener route-Row.
    expect(loadLaneContract(db, 'WS-LANE-F')).toBeNull();

    // Jetzt einen echten Vertrag dazu → wird trotz der fremden Row gefunden.
    persistLaneContract(db, { workstreamId: 'WS-LANE-F', contract: fullContract() });
    expect(loadLaneContract(db, 'WS-LANE-F')).not.toBeNull();
  });

  it('parseLaneContractRationale rejects garbage deterministically', () => {
    expect(parseLaneContractRationale(undefined)).toBeNull();
    expect(parseLaneContractRationale('no-prefix here')).toBeNull();
    expect(parseLaneContractRationale(`${LANE_CONTRACT_PREFIX}{not json`)).toBeNull();
    expect(parseLaneContractRationale(`${LANE_CONTRACT_PREFIX}[]`)).toBeNull();
    // Strukturell unvollständig (fehlende Felder) → null (fail-closed fürs Gate).
    expect(
      parseLaneContractRationale(
        `${LANE_CONTRACT_PREFIX}{"inputEvents":["x"]}`,
      ),
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) loadPortfolioRunState befüllt LaneState.contract aus persistierten Rows.
// ───────────────────────────────────────────────────────────────────────────

describe('loadPortfolioRunState fills LaneState.contract from the DB', () => {
  it('reads the persisted contract for a lane child (was: always null)', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, {
      workspaceId: 'ws-portfolio',
      lanes: ['governance', 'mobile-ux'],
      intent: 'demo',
    });

    // Vor dem Persist: beide Lanes haben (wie bisher) keinen Vertrag.
    const before = loadPortfolioRunState(db, 'ws-portfolio')!;
    expect(before.laneStates['governance'].contract).toBeNull();
    expect(before.laneStates['mobile-ux'].contract).toBeNull();

    // Vertrag NUR für governance persistieren (auf dem Lane-CHILD).
    const govWsId = res.laneWorkstreamIds['governance'];
    persistLaneContract(db, {
      workstreamId: govWsId,
      contract: fullContract({ metrics: ['gov-metric-1', 'gov-metric-2'] }),
    });

    const after = loadPortfolioRunState(db, 'ws-portfolio')!;
    // governance hat jetzt einen DB-Vertrag.
    expect(after.laneStates['governance'].contract).not.toBeNull();
    expect(after.laneStates['governance'].contract!.metrics).toEqual([
      'gov-metric-1',
      'gov-metric-2',
    ]);
    // mobile-ux bleibt ohne Vertrag (rückwärtskompatibel: null).
    expect(after.laneStates['mobile-ux'].contract).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) Integration: ein Gate (G3 Governance-Readiness) entscheidet jetzt über
//     den PERSISTIERTEN Vertrag — nicht mehr über einen In-Memory-Injekt.
// ───────────────────────────────────────────────────────────────────────────

describe('G3 governance-readiness decides over the persisted contract', () => {
  it('is RED with no persisted contracts, GREEN once all 7 lanes persist one', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-g3' }); // alle 7 Lanes.

    // Rot: kein Lane hat einen persistierten Vertrag → G3 blockt (jede Lane
    // erscheint in blockingItems).
    const stateRed = loadPortfolioRunState(db, 'ws-g3')!;
    const g3red = runQualityGate(stateRed, 'G3-governance-readiness');
    expect(g3red.passed).toBe(false);
    expect(g3red.blockingItems.sort()).toEqual([...LANE_IDS].sort());

    // Jetzt für JEDE Lane einen vollständigen Vertrag persistieren.
    for (const laneId of LANE_IDS) {
      persistLaneContract(db, {
        workstreamId: res.laneWorkstreamIds[laneId],
        contract: fullContract(),
      });
    }

    // Grün: G3 entscheidet über die ECHTEN, aus der DB gelesenen Verträge.
    const stateGreen = loadPortfolioRunState(db, 'ws-g3')!;
    // Alle 7 Lanes tragen jetzt einen DB-Vertrag.
    for (const laneId of LANE_IDS) {
      expect(stateGreen.laneStates[laneId].contract).not.toBeNull();
    }
    const g3green = runQualityGate(stateGreen, 'G3-governance-readiness');
    expect(g3green.passed).toBe(true);
    expect(g3green.blockingItems).toEqual([]);
  });

  it('stays RED if even one lane persists a governance-incomplete contract', () => {
    const db = freshDb();
    const res = createPortfolioRun(db, { workspaceId: 'ws-g3b' });

    for (const laneId of LANE_IDS) {
      // permissionRequirements ist ein Pflicht-Listenfeld → ein Vertrag mit
      // leerem permissionRequirements ist gar nicht persistierbar (validate
      // lehnt ab). Wir lassen genau EINE Lane ohne Vertrag → G3 bleibt rot.
      if (laneId === 'innovation-mode') continue;
      persistLaneContract(db, {
        workstreamId: res.laneWorkstreamIds[laneId],
        contract: fullContract(),
      });
    }

    const state = loadPortfolioRunState(db, 'ws-g3b')!;
    const g3 = runQualityGate(state, 'G3-governance-readiness');
    expect(g3.passed).toBe(false);
    expect(g3.blockingItems).toContain('innovation-mode');
  });
});
