/**
 * lib/flow/__tests__/auto-parametrize.test.ts — Auto-Param 2b-3 (in-memory).
 *
 * Flow-Tabellen aus 0112 + params_json/io_json aus 0130; workstream_plan_steps
 * + events inline. Verifiziert: 2 erfasste Läufe (topic variiert) → das
 * gespeicherte Template bekommt {{param.*}} im Step-Config + params_json.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { autoParametrizeFlow } from '@/lib/flow/auto-parametrize';
import { computeStructureSignature, type SignatureStep } from '@/lib/flow/structure-signature';

type RawDb = import('better-sqlite3').Database;

const mig = (f: string): string =>
  readFileSync(path.join(process.cwd(), 'db', 'migrations', f), 'utf8');

function annotate(skill: string, toolKind: string | null, config: object): string {
  return `Tu was | flow:${JSON.stringify({
    flowStepId: null,
    skill,
    toolKind,
    connectorId: null,
    configJson: JSON.stringify(config),
  })}`;
}

const SIG_STEPS: SignatureStep[] = [
  { skill: 'researcher', toolKind: 'mcp', connectorId: null },
  { skill: 'script', toolKind: null, connectorId: null },
];

function freshDb(): RawDb {
  const raw = new Database(':memory:');
  raw.exec(mig('0112_flow_studio.sql'));
  // 0130 additiv (params_json/io_json) — tolerant.
  for (const stmt of mig('0130_flow_params.sql').split(';')) {
    const s = stmt.trim();
    if (s) {
      try {
        raw.exec(s);
      } catch {
        /* duplicate column ok */
      }
    }
  }
  raw.exec(`
    CREATE TABLE workstream_plan_steps (
      id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL,
      subagent_role TEXT, depth INTEGER NOT NULL DEFAULT 0, depends_on TEXT,
      status TEXT NOT NULL DEFAULT 'done', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, segment_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', sensitivity TEXT NOT NULL DEFAULT 'low' );
  `);
  return raw;
}

function insertRunEvent(raw: RawDb, ws: string, sig: string, topic: string, t: number): void {
  const configs = [
    { label: 'researcher', config: JSON.stringify({ query: topic }) },
    { label: 'script', config: JSON.stringify({ topic, brand_voice: 'laz.ing' }) },
  ];
  raw
    .prepare(
      `INSERT INTO events (id, created_at, segment_id, entity_type, entity_id, event_type, actor, payload)
       VALUES (?, ?, ?, 'workflow_structure', ?, 'workflow.structure_seen', 'system', ?)`,
    )
    .run(`EVT-${topic}-${t}`, t, ws, sig, JSON.stringify({ seenCount: 1, configs }));
}

describe('autoParametrizeFlow', () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  it('2 Läufe (topic variiert) → {{param.*}} im Template + params_json', () => {
    const ws = 'own';
    const sig = computeStructureSignature(SIG_STEPS);

    // Workstream (aktueller Lauf = Solar).
    const mkStep = (i: number, skill: string, tool: string | null, config: object): void => {
      raw
        .prepare(
          `INSERT INTO workstream_plan_steps (id, workstream_id, plan_id, step_index, title, rationale, subagent_role, depth, status, created_at, updated_at)
           VALUES (?, 'WS-1', 'PL', ?, ?, ?, ?, 0, 'done', 1, 1)`,
        )
        .run(`STEP-${i}`, i, skill, annotate(skill, tool, config), skill);
    };
    mkStep(0, 'researcher', 'mcp', { query: 'Solar' });
    mkStep(1, 'script', null, { topic: 'Solar', brand_voice: 'laz.ing' });

    // 2 erfasste Läufe: Solar + Wind.
    insertRunEvent(raw, ws, sig, 'Solar', 10);
    insertRunEvent(raw, ws, sig, 'Wind', 20);

    // Gespeichertes Template + Steps (vom Save-Pfad; aktueller Lauf = Solar).
    raw
      .prepare(
        `INSERT INTO flow_templates (id, workspace_id, org_id, name, description, sop_id, graph_json, created_at, updated_at)
         VALUES ('FLOW-1', ?, NULL, 'Reel', NULL, NULL, '{}', 1, 1)`,
      )
      .run(ws);
    const addStep = (id: string, idx: number, skill: string, config: object): void => {
      raw
        .prepare(
          `INSERT INTO flow_steps (id, flow_id, idx, label, skill, tool_kind, connector_id, config_json, depends_on_json, created_at)
           VALUES (?, 'FLOW-1', ?, ?, ?, NULL, NULL, ?, NULL, 1)`,
        )
        .run(id, idx, skill, skill, JSON.stringify(config));
    };
    addStep('FS-0', 0, 'researcher', { query: 'Solar' });
    addStep('FS-1', 1, 'script', { topic: 'Solar', brand_voice: 'laz.ing' });

    const res = autoParametrizeFlow(raw, { flowId: 'FLOW-1', workstreamId: 'WS-1', workspaceId: ws });

    expect(res.runs).toBe(2);
    const keys = res.params.map((p) => p.field).sort();
    expect(keys).toEqual(['query', 'topic']); // brand_voice konstant → kein Param

    // Step-Configs jetzt parametrisiert.
    const fs0 = raw.prepare(`SELECT config_json FROM flow_steps WHERE id='FS-0'`).get() as { config_json: string };
    const fs1 = raw.prepare(`SELECT config_json FROM flow_steps WHERE id='FS-1'`).get() as { config_json: string };
    expect(fs0.config_json).toContain('{{param.');
    expect(fs1.config_json).toContain('{{param.');
    expect(fs1.config_json).toContain('laz.ing'); // konstante Brand-Stimme bleibt
    expect(res.appliedToSteps).toBe(2);

    // params_json gesetzt.
    const tpl = raw.prepare(`SELECT params_json FROM flow_templates WHERE id='FLOW-1'`).get() as { params_json: string | null };
    expect(tpl.params_json).toBeTruthy();
    expect(JSON.parse(tpl.params_json!).length).toBe(2);
  });

  it('nur 1 Lauf → 2b-4-Heuristik schlägt vor, ohne das Template anzufassen', () => {
    const ws = 'own';
    const sig = computeStructureSignature(SIG_STEPS);
    raw
      .prepare(
        `INSERT INTO workstream_plan_steps (id, workstream_id, plan_id, step_index, title, rationale, subagent_role, depth, status, created_at, updated_at)
         VALUES ('S0', 'WS-2', 'PL', 0, 'researcher', ?, 'researcher', 0, 'done', 1, 1)`,
      )
      .run(annotate('researcher', 'mcp', { query: 'Solar' }));
    insertRunEvent(raw, ws, sig, 'Solar', 10);
    const res = autoParametrizeFlow(raw, { flowId: 'FLOW-X', workstreamId: 'WS-2', workspaceId: ws });
    // 1 Lauf → kein Diff: Heuristik-Vorschlag ('query' ist ein Name-Hint),
    // aber NICHT angewendet (kein Template-Rewrite).
    expect(res.heuristic).toBe(true);
    expect(res.runs).toBeLessThan(2);
    expect(res.appliedToSteps).toBe(0);
    expect(res.params.map((p) => p.field)).toContain('query');
  });
});
