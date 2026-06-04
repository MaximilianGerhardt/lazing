/**
 * Phase 1 Track E — state-projector tests.
 *
 * Strategy: in-memory better-sqlite3 DB, Schema aus den ECHTEN Migrationen
 * (db/migrations/0001_initial.sql · 0009_workstreams.sql · 0040_sub_workstreams.sql ·
 * 0094_recursive_plans.sql · 0112_flow_studio.sql) via readFileSync.
 *
 * Das beweist nebenbei, dass:
 *   - die Migration-SQL gültig ist;
 *   - das Schema, das die Projektion erwartet, mit der echten Truth übereinstimmt;
 *   - die Projektion auch ohne question_answers funktioniert (P1.AB-Track baut
 *     diese Tabelle noch — fail-soft-Verhalten wird hier explizit getestet).
 *
 * Run:
 *   pnpm vitest run lib/projection/__tests__/state-projector.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  deriveNextAllowedUserInput,
  projectWorkspaceState,
} from '@/lib/projection/state-projector';
import type { WorkspaceState } from '@/lib/projection/types';

// ───────────────────────────────────────────────────────────────────────────
// Schema setup — load the REAL migrations.
// ───────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

function loadSql(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

/**
 * Wir laden die minimale Set Migrationen, die unsere Truth-Quellen
 * konstituieren. workstreams (0009) + sub-workstream-Spalten (0040) +
 * plan_steps (0094) + flow_runs (0112). Events kommt aus 0001.
 *
 * Diese Order ist die gleiche wie in db/client.ts MIGRATIONS — wenn das
 * Live-Schema kompatibel ist, ist auch dieses Test-Schema kompatibel.
 */
function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = OFF'); // analog test-pfad in db/client.ts

  // events + segments (0001).
  raw.exec(loadSql('0001_initial.sql'));
  // workstreams (0009).
  raw.exec(loadSql('0009_workstreams.sql'));
  // sub-workstreams ALTERs (0040).
  raw.exec(loadSql('0040_sub_workstreams.sql'));
  // recursive-plans (0094 — workstream_plan_steps + workstream_plan_critics).
  raw.exec(loadSql('0094_recursive_plans.sql'));
  // depends_on/group_id ADDs (0110).
  try {
    raw.exec(loadSql('0110_plan_step_deps_group.sql'));
  } catch {
    /* idempotent */
  }
  // allowed_tools ADD (0107).
  try {
    raw.exec(loadSql('0107_plan_step_allowed_tools.sql'));
  } catch {
    /* idempotent */
  }
  // flow_studio (0112 — flow_templates + flow_steps + flow_runs).
  raw.exec(loadSql('0112_flow_studio.sql'));

  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Insert helpers — minimal, schema-konform.
// ───────────────────────────────────────────────────────────────────────────

function insertEvent(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workspaceId: string;
    entityType: string;
    entityId: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: number;
    actor?: string;
  },
): void {
  raw
    .prepare(
      `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id,
                          event_type, actor, payload, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low')`,
    )
    .run(
      args.id,
      args.createdAt,
      args.workspaceId,
      args.entityType,
      args.entityId,
      args.eventType,
      args.actor ?? 'user:test',
      JSON.stringify(args.payload),
    );
}

function insertWorkstream(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workspaceId: string;
    name: string;
    status?: string;
    parent?: string | null;
    role?: string | null;
    updatedAt?: number;
  },
): void {
  const now = args.updatedAt ?? Date.now();
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status,
                                parent_workstream_id, role,
                                created_at, updated_at,
                                tokens_in, tokens_out, cost_cents_aggregated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    )
    .run(
      args.id,
      args.workspaceId,
      args.name,
      args.status ?? 'active',
      args.parent ?? null,
      args.role ?? null,
      now,
      now,
    );
}

function insertFlowRun(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workspaceId: string;
    workstreamId: string | null;
    status: string;
    createdAt: number;
    updatedAt?: number;
  },
): void {
  raw
    .prepare(
      `INSERT INTO flow_runs (id, flow_id, workspace_id, workstream_id, status,
                              created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.workspaceId,
      args.workstreamId,
      args.status,
      args.createdAt,
      args.updatedAt ?? args.createdAt,
    );
}

function insertPlanStep(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workstreamId: string;
    planId: string;
    stepIndex: number;
    title: string;
    status: string;
    updatedAt?: number;
  },
): void {
  const now = args.updatedAt ?? Date.now();
  raw
    .prepare(
      `INSERT INTO workstream_plan_steps (id, workstream_id, plan_id,
                                          step_index, title, rationale,
                                          coord_key, status, content_hash,
                                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '-', '-', ?, 'hash-test', ?, ?)`,
    )
    .run(
      args.id,
      args.workstreamId,
      args.planId,
      args.stepIndex,
      args.title,
      args.status,
      now,
      now,
    );
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('projectWorkspaceState (Track E)', () => {
  let raw: import('better-sqlite3').Database;

  beforeEach(() => {
    raw = freshDb();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Empty workspace → minimal state.
  // ────────────────────────────────────────────────────────────────────────
  it('liefert minimal-State für einen leeren Workspace', () => {
    const state = projectWorkspaceState(raw, 'wsp-empty');
    expect(state.workspaceId).toBe('wsp-empty');
    expect(typeof state.generatedAt).toBe('number');
    expect(state.generatedAt).toBeGreaterThan(0);
    expect(state.activeFlowRun).toBeNull();
    expect(state.activeWorkstreams).toEqual([]);
    expect(state.openQuestions).toEqual([]);
    expect(state.blockingGates).toEqual([]);
    expect(state.lastSuccessfulAction).toBeNull();
    expect(state.nextAllowedUserInput).toBe('free-prompt');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Aktiver flow_run + workstream + 2 offene Questions + 1 blocking gate.
  // ────────────────────────────────────────────────────────────────────────
  it('aggregiert flow_run, workstreams, 2 offene Fragen und 1 blocking Gate korrekt', () => {
    const ws = 'example-website-3';
    const t = 1_700_000_000_000;

    // Workstream + sub-workstream.
    insertWorkstream(raw, {
      id: 'WS-MASTER',
      workspaceId: ws,
      name: 'Build PA website',
      status: 'active',
      updatedAt: t + 500,
    });
    insertWorkstream(raw, {
      id: 'WS-SUB-1',
      workspaceId: ws,
      name: 'Copy lane',
      status: 'active',
      parent: 'WS-MASTER',
      role: 'lead',
      updatedAt: t + 600,
    });

    // FlowRun läuft.
    insertFlowRun(raw, {
      id: 'FR-1',
      workspaceId: ws,
      workstreamId: 'WS-MASTER',
      status: 'running',
      createdAt: t,
      updatedAt: t + 800,
    });

    // Aktiver Plan-Step (liefert currentPhase).
    insertPlanStep(raw, {
      id: 'PS-1',
      workstreamId: 'WS-MASTER',
      planId: 'PLN-1',
      stepIndex: 1,
      title: 'Aufbau-Phase: Sitemap entwerfen',
      status: 'active',
      updatedAt: t + 900,
    });

    // Zwei offene Fragen in einem chat_message Surface.
    insertEvent(raw, {
      id: 'EV-Q1',
      workspaceId: ws,
      entityType: 'chat_message',
      entityId: 'CM-Q1',
      eventType: 'chat_message_sent',
      createdAt: t + 100,
      payload: {
        kind: 'open-questions',
        questionSetId: 'QS-1',
        workstreamId: 'WS-MASTER',
        questions: [
          { id: 'q1', text: 'Welche Zielgruppe steht im Fokus?' },
          {
            id: 'q2',
            text: 'Welcher Tonfall passt?',
            options: ['Sachlich', 'Spielerisch', 'Bold'],
          },
        ],
      },
    });

    // Ein blocking gate (credential-request).
    insertEvent(raw, {
      id: 'EV-G1',
      workspaceId: ws,
      entityType: 'chat_message',
      entityId: 'CM-G1',
      eventType: 'chat_message_sent',
      createdAt: t + 200,
      payload: {
        kind: 'credential-request',
        workstreamId: 'WS-MASTER',
        description: 'Higgsfield API-Key fehlt — bitte hinterlegen',
      },
    });

    const state = projectWorkspaceState(raw, ws);

    // Active FlowRun korrekt.
    expect(state.activeFlowRun).not.toBeNull();
    expect(state.activeFlowRun?.flowRunId).toBe('FR-1');
    expect(state.activeFlowRun?.workstreamId).toBe('WS-MASTER');
    // Gate offen → 'needs-coupling' (status-Verfeinerung).
    expect(state.activeFlowRun?.status).toBe('needs-coupling');
    expect(state.activeFlowRun?.currentPhase).toBe(
      'Aufbau-Phase: Sitemap entwerfen',
    );
    expect(state.activeFlowRun?.lastEventAt).toBeGreaterThanOrEqual(t + 800);

    // Active Workstreams: 2 (Master + Sub).
    expect(state.activeWorkstreams).toHaveLength(2);
    const sub = state.activeWorkstreams.find(
      (w) => w.workstreamId === 'WS-SUB-1',
    );
    expect(sub?.parent).toBe('WS-MASTER');
    expect(sub?.role).toBe('lead');
    expect(sub?.name).toBe('Copy lane'); // N1: verbatim

    // Open Questions: 2.
    expect(state.openQuestions).toHaveLength(2);
    const q1 = state.openQuestions.find((q) => q.questionId === 'q1');
    const q2 = state.openQuestions.find((q) => q.questionId === 'q2');
    expect(q1?.text).toBe('Welche Zielgruppe steht im Fokus?'); // N1: verbatim
    expect(q1?.answered).toBe(false);
    expect(q2?.options).toEqual(['Sachlich', 'Spielerisch', 'Bold']);
    expect(q2?.answered).toBe(false);

    // Blocking Gates: 1.
    expect(state.blockingGates).toHaveLength(1);
    expect(state.blockingGates[0].kind).toBe('credential-request');
    expect(state.blockingGates[0].description).toBe(
      'Higgsfield API-Key fehlt — bitte hinterlegen',
    );

    // Gate hat Vorrang → 'approve-gate'.
    expect(state.nextAllowedUserInput).toBe('approve-gate');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Beantwortete Frage (question_answers Tabelle).
  // ────────────────────────────────────────────────────────────────────────
  it('markiert eine in question_answers eingetragene Frage als answered=true', () => {
    const ws = 'wsp-q';
    const t = 1_700_000_000_000;

    // 2 Fragen
    insertEvent(raw, {
      id: 'EV-Q',
      workspaceId: ws,
      entityType: 'chat_message',
      entityId: 'CM-Q',
      eventType: 'chat_message_sent',
      createdAt: t,
      payload: {
        kind: 'plan-open-questions',
        questionSetId: 'QS-A',
        questions: [
          { id: 'qa', text: 'Frage A?' },
          { id: 'qb', text: 'Frage B?' },
        ],
      },
    });

    // Simuliere P1.AB-Track-Schema (workspace_id-Spalte vorhanden).
    raw.exec(`
      CREATE TABLE question_answers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        question_set_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        answer_text TEXT,
        answered_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        `INSERT INTO question_answers (id, workspace_id, question_set_id,
                                       question_id, answer_text, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('QA-1', ws, 'QS-A', 'qa', 'Privatkunden', t + 10);

    const state = projectWorkspaceState(raw, ws);
    expect(state.openQuestions).toHaveLength(2);
    const qa = state.openQuestions.find((q) => q.questionId === 'qa');
    const qb = state.openQuestions.find((q) => q.questionId === 'qb');
    expect(qa?.answered).toBe(true);
    expect(qb?.answered).toBe(false);

    // qb ist noch offen → 'answer-question'.
    expect(state.nextAllowedUserInput).toBe('answer-question');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Failed flow_run → lastSuccessfulAction zeigt vorigen Erfolg.
  // ────────────────────────────────────────────────────────────────────────
  it('liefert lastSuccessfulAction aus dem vorigen Erfolg, auch wenn der jüngste flow_run failed ist', () => {
    const ws = 'wsp-failed';
    const t = 1_700_000_000_000;

    // Voriger Erfolg.
    insertEvent(raw, {
      id: 'EV-OK',
      workspaceId: ws,
      entityType: 'workflow_run',
      entityId: 'WFR-OK',
      eventType: 'workflow.completed',
      createdAt: t,
      payload: { summary: 'Lead-Phase V1 abgeschlossen' },
    });

    // Späterer Failed-Run (kein Success-Event danach).
    insertFlowRun(raw, {
      id: 'FR-FAIL',
      workspaceId: ws,
      workstreamId: null,
      status: 'failed',
      createdAt: t + 1000,
      updatedAt: t + 1100,
    });
    insertEvent(raw, {
      id: 'EV-FAIL',
      workspaceId: ws,
      entityType: 'workflow_run',
      entityId: 'WFR-FAIL',
      eventType: 'workflow.stuck',
      createdAt: t + 1100,
      payload: { reason: 'Higgsfield 0× erreichbar' },
    });

    const state = projectWorkspaceState(raw, ws);

    // FlowRun ist failed → wir geben ihn NICHT als activeFlowRun zurück.
    expect(state.activeFlowRun).toBeNull();

    // lastSuccessfulAction reflektiert den älteren completion.
    expect(state.lastSuccessfulAction).not.toBeNull();
    expect(state.lastSuccessfulAction?.kind).toBe('workflow.completed');
    expect(state.lastSuccessfulAction?.summary).toBe(
      'Lead-Phase V1 abgeschlossen',
    );
    expect(state.lastSuccessfulAction?.at).toBe(t);

    // Kein Gate, keine Frage, kein aktiver Run → free-prompt.
    expect(state.nextAllowedUserInput).toBe('free-prompt');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Performance-Smoke: 1000 events + 50 workstreams → <100ms.
  // ────────────────────────────────────────────────────────────────────────
  it('Performance-Smoke: 1000 events + 50 workstreams in <100ms', () => {
    const ws = 'wsp-perf';
    const base = 1_700_000_000_000;

    // 50 Workstreams (verschiedene Status).
    const insertWs = raw.prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status,
                                created_at, updated_at,
                                tokens_in, tokens_out, cost_cents_aggregated)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    );
    const wsTx = raw.transaction(() => {
      for (let i = 0; i < 50; i++) {
        insertWs.run(
          `WS-PF-${i}`,
          ws,
          `Workstream ${i}`,
          i % 5 === 0 ? 'paused' : 'active',
          base + i,
          base + i + 1000,
        );
      }
    });
    wsTx();

    // 1000 Events (chat_message + lifecycle gemischt).
    const insertEv = raw.prepare(
      `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id,
                          event_type, actor, payload, sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low')`,
    );
    const evTx = raw.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        // Disjunkte Klassen: gate hat Vorrang (sonst maskiert Question-modulo
        // den Gate-Trigger; siehe Bug-Fix 2026-05-29).
        const isGate = i % 100 === 0;
        const isQuestion = !isGate && i % 50 === 0;
        let payload: Record<string, unknown>;
        if (isGate) {
          payload = {
            kind: 'live-warn',
            description: `Erstaufruf Connector ${i}`,
          };
        } else if (isQuestion) {
          payload = {
            kind: 'open-questions',
            questionSetId: `QS-${i}`,
            questions: [{ id: `q${i}`, text: `Frage Nr ${i}?` }],
          };
        } else {
          payload = { text: `nachricht ${i}` };
        }
        insertEv.run(
          `EV-PF-${i}`,
          base + i * 10,
          ws,
          'chat_message',
          `CM-${i}`,
          'chat_message_sent',
          'user:test',
          JSON.stringify(payload),
        );
      }
    });
    evTx();

    const t0 = Date.now();
    const state = projectWorkspaceState(raw, ws);
    const elapsed = Date.now() - t0;

    expect(state.activeWorkstreams.length).toBeGreaterThan(0);
    expect(state.openQuestions.length).toBeGreaterThan(0);
    expect(state.blockingGates.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 6. Fail-soft: korruptes payload bricht NICHT die Projektion.
  // ────────────────────────────────────────────────────────────────────────
  it('toleriert korrupte payload-Strings (fail-soft)', () => {
    const ws = 'wsp-bad';
    raw
      .prepare(
        `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id,
                            event_type, actor, payload, sensitivity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low')`,
      )
      .run(
        'EV-BAD',
        1_700_000_000_000,
        ws,
        'chat_message',
        'CM-BAD',
        'chat_message_sent',
        'user:test',
        '{NOT VALID JSON',
      );

    const state = projectWorkspaceState(raw, ws);
    expect(state.openQuestions).toEqual([]);
    expect(state.blockingGates).toEqual([]);
    expect(state.nextAllowedUserInput).toBe('free-prompt');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7. deriveNextAllowedUserInput — Reihenfolge (Gate > Frage > Run > free).
  // ────────────────────────────────────────────────────────────────────────
  describe('deriveNextAllowedUserInput priority', () => {
    const baseInput: Pick<WorkspaceState, 'activeFlowRun' | 'activeWorkstreams' | 'openQuestions' | 'blockingGates'> = {
      activeFlowRun: null,
      activeWorkstreams: [],
      openQuestions: [],
      blockingGates: [],
    };

    it('Gate hat Vorrang vor Frage', () => {
      const res = deriveNextAllowedUserInput({
        ...baseInput,
        openQuestions: [
          {
            questionSetId: 's',
            questionId: 'q',
            text: '?',
            askedAt: 0,
            answered: false,
          },
        ],
        blockingGates: [
          {
            kind: 'credential-request',
            description: '!',
            createdAt: 0,
          },
        ],
      });
      expect(res).toBe('approve-gate');
    });

    it('beantwortete Frage zählt nicht als open', () => {
      const res = deriveNextAllowedUserInput({
        ...baseInput,
        openQuestions: [
          {
            questionSetId: 's',
            questionId: 'q',
            text: '?',
            askedAt: 0,
            answered: true,
          },
        ],
      });
      expect(res).toBe('free-prompt');
    });

    it('aktiver Run → wait', () => {
      const res = deriveNextAllowedUserInput({
        ...baseInput,
        activeWorkstreams: [
          {
            workstreamId: 'w',
            name: 'n',
            status: 'active',
          },
        ],
      });
      expect(res).toBe('wait');
    });

    it('alles leer → free-prompt', () => {
      const res = deriveNextAllowedUserInput(baseInput);
      expect(res).toBe('free-prompt');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 8. workspaceId Schutz: leer/undefined → minimal-State, kein throw.
  // ────────────────────────────────────────────────────────────────────────
  it('liefert minimal-State bei leerem workspaceId, ohne zu werfen', () => {
    const state = projectWorkspaceState(raw, '');
    expect(state.workspaceId).toBe('');
    expect(state.activeFlowRun).toBeNull();
    expect(state.nextAllowedUserInput).toBe('free-prompt');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 9. BLOCKER 2 (2026-05-30) — Gate-Resolution gegen die ECHTEN Approve-Writes.
  //    live-warn  → workspace_beliefs(topic='live-warn-acked')
  //    credential → api_credentials(provider, scope=workspace)
  // ────────────────────────────────────────────────────────────────────────
  describe('Gate-Resolution (BLOCKER 2)', () => {
    // Lädt die Resolution-Truth-Tabellen in die in-memory-DB (echte Migration).
    function withResolutionTables(
      db: import('better-sqlite3').Database,
    ): void {
      try {
        db.exec(loadSql('0100_api_credentials.sql'));
      } catch {
        /* idempotent */
      }
      try {
        db.exec(loadSql('0113_workspace_beliefs.sql'));
      } catch {
        /* idempotent */
      }
    }

    function insertBelief(
      db: import('better-sqlite3').Database,
      args: {
        id: string;
        workspaceId: string;
        topic: string;
        belief: string;
        createdAt: number;
      },
    ): void {
      db.prepare(
        `INSERT INTO workspace_beliefs
           (id, workspace_id, topic, belief, rationale, source,
            content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, '-', 'user', 'h', ?, ?)`,
      ).run(
        args.id,
        args.workspaceId,
        args.topic,
        args.belief,
        args.createdAt,
        args.createdAt,
      );
    }

    function insertCredential(
      db: import('better-sqlite3').Database,
      args: {
        id: string;
        scopeId: string;
        provider: string;
        createdAt: number;
      },
    ): void {
      db.prepare(
        `INSERT INTO api_credentials
           (id, scope_kind, scope_id, provider, credential_kind,
            encrypted_secret, content_hash, created_at, updated_at)
         VALUES (?, 'workspace', ?, ?, 'api_key', 'iv:ct:tag', 'h', ?, ?)`,
      ).run(args.id, args.scopeId, args.provider, args.createdAt, args.createdAt);
    }

    it('live-warn bleibt offen ohne ack-Belief', () => {
      withResolutionTables(raw);
      const ws = 'wsp-lw-open';
      insertEvent(raw, {
        id: 'EV-LW1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-LW1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: { kind: 'live-warn', description: 'LIVE-Mode aktiv' },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
      expect(state.nextAllowedUserInput).toBe('approve-gate');
    });

    it('live-warn verschwindet nach ack-Belief NACH dem Gate', () => {
      withResolutionTables(raw);
      const ws = 'wsp-lw-acked';
      insertEvent(raw, {
        id: 'EV-LW2',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-LW2',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: { kind: 'live-warn', description: 'LIVE-Mode aktiv' },
      });
      // Owner quittiert NACH dem Gate.
      insertBelief(raw, {
        id: 'B-LW2',
        workspaceId: ws,
        topic: 'live-warn-acked',
        belief: 'ack: LIVE-Mode bestätigt',
        createdAt: 2000,
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toEqual([]);
      expect(state.nextAllowedUserInput).not.toBe('approve-gate');
    });

    it('ein ack VOR dem Gate löst ein späteres Gate NICHT auf', () => {
      withResolutionTables(raw);
      const ws = 'wsp-lw-stale';
      insertBelief(raw, {
        id: 'B-LW3',
        workspaceId: ws,
        topic: 'live-warn-acked',
        belief: 'ack: LIVE-Mode bestätigt',
        createdAt: 500, // VOR dem Gate
      });
      insertEvent(raw, {
        id: 'EV-LW3',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-LW3',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: { kind: 'live-warn', description: 'LIVE-Mode erneut' },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
    });

    it('credential-request verschwindet, wenn der Provider-Key hinterlegt wurde', () => {
      withResolutionTables(raw);
      const ws = 'wsp-cred-acked';
      insertEvent(raw, {
        id: 'EV-CR1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-CR1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: {
          kind: 'credential-request',
          provider: 'higgsfield',
          description: 'Higgsfield API-Key fehlt',
        },
      });
      insertCredential(raw, {
        id: 'CRED-1',
        scopeId: ws,
        provider: 'higgsfield',
        createdAt: 2000,
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toEqual([]);
    });

    it('credential-request bleibt offen für einen ANDEREN Provider-Key', () => {
      withResolutionTables(raw);
      const ws = 'wsp-cred-other';
      insertEvent(raw, {
        id: 'EV-CR2',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-CR2',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: {
          kind: 'credential-request',
          provider: 'higgsfield',
          description: 'Higgsfield API-Key fehlt',
        },
      });
      // Falscher Provider hinterlegt → Gate bleibt.
      insertCredential(raw, {
        id: 'CRED-2',
        scopeId: ws,
        provider: 'stripe',
        createdAt: 2000,
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
      expect(state.blockingGates[0].kind).toBe('credential-request');
    });

    it('human-decision hat keinen DB-Resolution-Mechanismus → bleibt sichtbar (ehrlich)', () => {
      withResolutionTables(raw);
      const ws = 'wsp-hd';
      insertEvent(raw, {
        id: 'EV-HD1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-HD1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: { kind: 'human-decision', description: 'Variante mergen?' },
      });
      const state = projectWorkspaceState(raw, ws);
      // Kein serverseitiger Resolution-Write existiert für human-decision —
      // das Gate bleibt (Consume passiert optimistisch client-seitig).
      expect(state.blockingGates).toHaveLength(1);
    });

    it('fail-soft: fehlen die Resolution-Tabellen, bleibt das Gate sichtbar', () => {
      // freshDb() lädt api_credentials/workspace_beliefs NICHT → Probe schlägt
      // fehl → Gate gilt als nicht resolved (over-pin statt stilles Verschwinden).
      const ws = 'wsp-nores';
      insertEvent(raw, {
        id: 'EV-NR1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-NR1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        payload: { kind: 'live-warn', description: 'LIVE-Mode aktiv' },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // F18 (2026-05-30) — Decision/quickchoice/tier-choice werden als blockingGate
  // erfasst (mit Optionen + EINER empfohlenen Primär-Aktion), beantwortet →
  // raus (User-Reply NACH dem Gate).
  // ────────────────────────────────────────────────────────────────────────
  describe('F18 — Decision wird blockingGate (gepinnt unten)', () => {
    function insertUserReply(
      db: import('better-sqlite3').Database,
      args: { id: string; workspaceId: string; createdAt: number },
    ): void {
      insertEvent(db, {
        id: args.id,
        workspaceId: args.workspaceId,
        entityType: 'chat_message',
        entityId: `pp-${args.id}`,
        eventType: 'chat_message_sent',
        createdAt: args.createdAt,
        actor: 'user:max',
        payload: { role: 'user', content: 'Variante B' },
      });
    }

    it('eine offene decision-Surface → blockingGate kind="decision" + approve-gate', () => {
      const ws = 'wsp-dec';
      insertEvent(raw, {
        id: 'EV-DEC1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-DEC1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'decision',
          headline: 'Welche Variante mergen?',
          options: [
            { id: 'a', label: 'Variante A' },
            { id: 'b', label: 'Variante B', recommended: true },
            { id: 'c', label: 'Variante C' },
          ],
        },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
      expect(state.blockingGates[0].kind).toBe('decision');
      // N1: verbatim Headline als description.
      expect(state.blockingGates[0].description).toBe('Welche Variante mergen?');
      // Gate hat Vorrang → unten gepinnt.
      expect(state.nextAllowedUserInput).toBe('approve-gate');
    });

    it('extrahiert die Optionen verbatim + markiert GENAU EINE als empfohlen', () => {
      const ws = 'wsp-dec-opts';
      insertEvent(raw, {
        id: 'EV-DEC2',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-DEC2',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'decision',
          headline: 'Zielmarkt?',
          options: [
            { id: 'dach', label: 'DACH', recommended: true },
            { id: 'eu', label: 'EU' },
          ],
        },
      });
      const state = projectWorkspaceState(raw, ws);
      const opts = state.blockingGates[0].options;
      expect(opts).toBeDefined();
      expect(opts).toHaveLength(2);
      expect(opts![0].label).toBe('DACH'); // N1 verbatim
      const recommended = opts!.filter((o) => o.recommended);
      expect(recommended).toHaveLength(1); // genau EINE Primär-Aktion
      expect(recommended[0].id).toBe('dach');
    });

    it('ohne server-markierte Empfehlung → erste Option wird Primär-Aktion', () => {
      const ws = 'wsp-dec-default';
      insertEvent(raw, {
        id: 'EV-DEC3',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-DEC3',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'decision',
          headline: 'Stil?',
          options: [
            { id: 'x', label: 'Sachlich' },
            { id: 'y', label: 'Bold' },
          ],
        },
      });
      const state = projectWorkspaceState(raw, ws);
      const opts = state.blockingGates[0].options!;
      expect(opts.filter((o) => o.recommended)).toHaveLength(1);
      expect(opts[0].recommended).toBe(true); // deterministischer Default
    });

    it('quickchoice (option-only) → blockingGate mit Label-Signatur als description', () => {
      const ws = 'wsp-qc';
      insertEvent(raw, {
        id: 'EV-QC1',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-QC1',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'quickchoice',
          options: [
            { id: 'ja', label: 'Ja, weiter', primary: true },
            { id: 'nein', label: 'Abbrechen' },
          ],
        },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
      expect(state.blockingGates[0].kind).toBe('decision');
      // Signatur = Label-Join (matcht die in-feed-Karte für Suppression).
      expect(state.blockingGates[0].description).toBe('Ja, weiter · Abbrechen');
      // primary → recommended.
      const rec = state.blockingGates[0].options!.filter((o) => o.recommended);
      expect(rec).toHaveLength(1);
      expect(rec[0].id).toBe('ja');
    });

    it('beantwortete Decision (User-Reply NACH dem Gate) → fällt raus', () => {
      const ws = 'wsp-dec-answered';
      insertEvent(raw, {
        id: 'EV-DEC4',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-DEC4',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'decision',
          headline: 'Welche Variante?',
          options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        },
      });
      // User antwortet NACH dem Gate (reply(label)-Pfad der Card).
      insertUserReply(raw, { id: 'UR1', workspaceId: ws, createdAt: 2000 });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toEqual([]);
      expect(state.nextAllowedUserInput).not.toBe('approve-gate');
    });

    it('User-Reply VOR dem Gate löst ein späteres Gate NICHT auf', () => {
      const ws = 'wsp-dec-stale';
      // Reply zuerst (alte Nachricht), Gate danach.
      insertUserReply(raw, { id: 'UR2', workspaceId: ws, createdAt: 500 });
      insertEvent(raw, {
        id: 'EV-DEC5',
        workspaceId: ws,
        entityType: 'chat_message',
        entityId: 'CM-DEC5',
        eventType: 'chat_message_sent',
        createdAt: 1000,
        actor: 'agent:api',
        payload: {
          kind: 'decision',
          headline: 'Neue Entscheidung',
          options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        },
      });
      const state = projectWorkspaceState(raw, ws);
      expect(state.blockingGates).toHaveLength(1);
      expect(state.blockingGates[0].kind).toBe('decision');
    });
  });
});
