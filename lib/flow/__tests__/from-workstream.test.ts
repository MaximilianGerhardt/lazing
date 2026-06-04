/**
 * lib/flow/__tests__/from-workstream.test.ts
 * -------------------------------------------
 * Flow Studio Stream C · C3 (2026-05-27) — „Als wiederkehrenden Prozess
 * speichern": Workstream-Plan-Steps → flow_template + flow_steps (Rück-Kompiler).
 *
 * Strategy: in-memory better-sqlite3 DB. Flow-Tabellen via der ECHTEN Migration
 * 0112_flow_studio.sql (gleiche Disziplin wie templates-repo.test.ts); die
 * workstream_plan_steps-Tabelle wird minimal inline angelegt (nur die Spalten,
 * die der Rück-Kompiler liest/braucht) — so bleibt der Test unabhängig von der
 * Migration-Reihenfolge der Plan-Tabelle.
 *
 * Deckt:
 *   - root-Plan-Steps mit `| flow:{...}`-Annotation → flow_steps mit
 *     skill/toolKind/connectorId/configJson rekonstruiert.
 *   - depends_on 1:1: Plan-Step-IDs (STEP-<flowStepId>) werden auf die
 *     wiederhergestellten flow_steps.id zurück-übersetzt → DAG identisch.
 *   - Fallback: Plan-Step OHNE Annotation (freier Decompose) → skill aus
 *     subagent_role, keine Tool-Kopplung, aber Struktur erhalten.
 *   - no_steps → FromWorkstreamError.
 *   - parseFlowAnnotation: trennt base vom Suffix; kaputtes JSON → keine
 *     Annotation (rationale verbatim).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/flow/__tests__/from-workstream.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  compileWorkstreamToFlow,
  parseFlowAnnotation,
  FromWorkstreamError,
} from '@/lib/flow/from-workstream';
import { listFlowSteps, listFlowTemplates } from '@/lib/flow/templates-repo';

const MIGRATION = path.join(
  process.cwd(),
  'db',
  'migrations',
  '0112_flow_studio.sql',
);

type RawDb = import('better-sqlite3').Database;

function freshDb(): RawDb {
  const raw = new Database(':memory:');
  // Flow-Tabellen aus der echten Migration.
  raw.exec(readFileSync(MIGRATION, 'utf8'));
  // Minimal workstream_plan_steps — nur die vom Rück-Kompiler gelesenen Spalten
  // + die NOT-NULL-Pflichtfelder, damit Inserts gültig sind.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workstream_plan_steps (
      id            TEXT PRIMARY KEY NOT NULL,
      workstream_id TEXT NOT NULL,
      plan_id       TEXT NOT NULL,
      step_index    INTEGER NOT NULL,
      title         TEXT NOT NULL,
      rationale     TEXT NOT NULL,
      subagent_role TEXT,
      depth         INTEGER NOT NULL DEFAULT 0,
      depends_on    TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
  return raw;
}

/** Hilft einen Plan-Step einzufügen (depth=0 root). */
function insertStep(
  raw: RawDb,
  s: {
    id: string;
    workstreamId: string;
    index: number;
    title: string;
    rationale: string;
    subagentRole?: string | null;
    dependsOn?: string[] | null;
  },
): void {
  raw
    .prepare(
      `INSERT INTO workstream_plan_steps
         (id, workstream_id, plan_id, step_index, title, rationale, subagent_role,
          depth, depends_on, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'done', ?, ?)`,
    )
    .run(
      s.id,
      s.workstreamId,
      'PLN-c3',
      s.index,
      s.title,
      s.rationale,
      s.subagentRole ?? null,
      s.dependsOn && s.dependsOn.length > 0 ? JSON.stringify(s.dependsOn) : null,
      Date.now(),
      Date.now(),
    );
}

/** Baut das `| flow:{...}`-Suffix exakt wie execute.ts::annotateRationale. */
function annotate(
  base: string,
  meta: {
    flowStepId: string;
    skill?: string | null;
    toolKind?: string | null;
    connectorId?: string | null;
    configJson?: string | null;
  },
): string {
  const annotation = {
    connectorId: meta.connectorId ?? null,
    configJson: meta.configJson ?? null,
    flowStepId: meta.flowStepId,
    skill: meta.skill ?? null,
    toolKind: meta.toolKind ?? null,
  };
  // canonicalJson sortiert die Keys — der Parser ist key-order-tolerant (JSON.parse),
  // also reicht ein normales JSON.stringify hier.
  return `${base} | flow:${JSON.stringify(annotation)}`;
}

const WS = 'WS-c3-001';
const WSP = 'ws-c3';

describe('parseFlowAnnotation', () => {
  it('splits base from the | flow: suffix', () => {
    const { base, annotation } = parseFlowAnnotation(
      annotate('Flow-Step 1 · skill=coder', {
        flowStepId: 'FSTEP-abc',
        skill: 'coder',
        toolKind: 'connector',
        connectorId: 'imagegen2',
        configJson: '{"k":1}',
      }),
    );
    expect(base).toBe('Flow-Step 1 · skill=coder');
    expect(annotation).not.toBeNull();
    expect(annotation?.flowStepId).toBe('FSTEP-abc');
    expect(annotation?.skill).toBe('coder');
    expect(annotation?.toolKind).toBe('connector');
    expect(annotation?.connectorId).toBe('imagegen2');
    expect(annotation?.configJson).toBe('{"k":1}');
  });

  it('returns null annotation for a rationale without the suffix', () => {
    const { base, annotation } = parseFlowAnnotation('Reiner Plan-Step ohne Flow');
    expect(base).toBe('Reiner Plan-Step ohne Flow');
    expect(annotation).toBeNull();
  });

  it('treats broken suffix JSON as no annotation (verbatim base)', () => {
    const r = 'Step | flow:{not valid json';
    const { base, annotation } = parseFlowAnnotation(r);
    expect(annotation).toBeNull();
    expect(base).toBe(r); // rationale bleibt verbatim (N1)
  });
});

describe('compileWorkstreamToFlow (C3)', () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  it('compiles annotated plan-steps into flow_template + flow_steps with depends_on 1:1', () => {
    // s1 → s2 → s3 (lineare Kette via depends_on). Plan-Step-IDs sind
    // STEP-<flowStepId> (insertPlanStep-Konvention), die Annotation trägt die
    // originale flow_steps.id (FSTEP-x).
    insertStep(raw, {
      id: 'STEP-FSTEP-1',
      workstreamId: WS,
      index: 0,
      title: 'Intake',
      rationale: annotate('Flow-Step 1', {
        flowStepId: 'FSTEP-1',
        skill: 'architect',
      }),
    });
    insertStep(raw, {
      id: 'STEP-FSTEP-2',
      workstreamId: WS,
      index: 1,
      title: 'Bild generieren',
      rationale: annotate('Flow-Step 2', {
        flowStepId: 'FSTEP-2',
        skill: 'tool:image',
        toolKind: 'connector',
        connectorId: 'imagegen2',
        configJson: '{"prompt":"x"}',
      }),
      dependsOn: ['STEP-FSTEP-1'],
    });
    insertStep(raw, {
      id: 'STEP-FSTEP-3',
      workstreamId: WS,
      index: 2,
      title: 'Review',
      rationale: annotate('Flow-Step 3', {
        flowStepId: 'FSTEP-3',
        skill: 'reviewer',
      }),
      dependsOn: ['STEP-FSTEP-2'],
    });

    const result = compileWorkstreamToFlow(raw, {
      workstreamId: WS,
      workspaceId: WSP,
      name: 'Mein wiederkehrender Prozess',
    });

    // Template wurde im richtigen Scope angelegt.
    const templates = listFlowTemplates(raw, WSP);
    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe(result.flowId);
    expect(templates[0].name).toBe('Mein wiederkehrender Prozess'); // N1 verbatim
    expect(templates[0].workspaceId).toBe(WSP);

    // flow_steps: 3, in idx-Reihenfolge, mit rekonstruierten Tool-Feldern.
    const steps = listFlowSteps(raw, result.flowId);
    expect(steps.map((s) => s.id)).toEqual(['FSTEP-1', 'FSTEP-2', 'FSTEP-3']);
    expect(steps.map((s) => s.label)).toEqual([
      'Intake',
      'Bild generieren',
      'Review',
    ]);
    expect(steps.map((s) => s.skill)).toEqual([
      'architect',
      'tool:image',
      'reviewer',
    ]);
    // Tool-Kopplung des mittleren Steps rekonstruiert.
    expect(steps[1].toolKind).toBe('connector');
    expect(steps[1].connectorId).toBe('imagegen2');
    expect(steps[1].configJson).toBe('{"prompt":"x"}');

    // depends_on 1:1: zurück-übersetzt von Plan-Step-IDs auf flow_steps.id.
    expect(JSON.parse(steps[0].dependsOnJson ?? 'null')).toBeNull();
    expect(JSON.parse(steps[1].dependsOnJson ?? '[]')).toEqual(['FSTEP-1']);
    expect(JSON.parse(steps[2].dependsOnJson ?? '[]')).toEqual(['FSTEP-2']);
  });

  it('falls back to subagent_role as skill when there is no flow annotation', () => {
    insertStep(raw, {
      id: 'STEP-A',
      workstreamId: WS,
      index: 0,
      title: 'Freier Schritt A',
      rationale: 'Kein Flow-Suffix hier — reiner Decompose.',
      subagentRole: 'coder',
    });
    insertStep(raw, {
      id: 'STEP-B',
      workstreamId: WS,
      index: 1,
      title: 'Freier Schritt B',
      rationale: 'Auch ohne Annotation.',
      subagentRole: 'tester',
      dependsOn: ['STEP-A'],
    });

    const result = compileWorkstreamToFlow(raw, {
      workstreamId: WS,
      workspaceId: WSP,
    });
    const steps = listFlowSteps(raw, result.flowId);
    // Ohne Annotation: flowStepId = Plan-Step-ID selbst.
    expect(steps.map((s) => s.id)).toEqual(['STEP-A', 'STEP-B']);
    // skill aus subagent_role (Fallback).
    expect(steps.map((s) => s.skill)).toEqual(['coder', 'tester']);
    // keine Tool-Kopplung.
    expect(steps[0].toolKind).toBeNull();
    expect(steps[0].connectorId).toBeNull();
    // Struktur (depends_on) bleibt erhalten — STEP-B hängt an STEP-A.
    expect(JSON.parse(steps[1].dependsOnJson ?? '[]')).toEqual(['STEP-A']);
  });

  it('uses a fallback name when none is given (N1 verbatim otherwise)', () => {
    insertStep(raw, {
      id: 'STEP-X',
      workstreamId: WS,
      index: 0,
      title: 'X',
      rationale: 'x',
    });
    const result = compileWorkstreamToFlow(raw, {
      workstreamId: WS,
      workspaceId: WSP,
    });
    const tpl = listFlowTemplates(raw, WSP).find((t) => t.id === result.flowId);
    expect(tpl?.name).toContain(WS);
  });

  it('throws FromWorkstreamError(no_steps) for a workstream without root steps', () => {
    expect(() =>
      compileWorkstreamToFlow(raw, { workstreamId: 'WS-empty', workspaceId: WSP }),
    ).toThrowError(FromWorkstreamError);
    try {
      compileWorkstreamToFlow(raw, { workstreamId: 'WS-empty', workspaceId: WSP });
    } catch (e) {
      expect((e as FromWorkstreamError).code).toBe('no_steps');
    }
  });

  it('ignores dangling depends_on (dep step not in plan) without fabricating nodes', () => {
    insertStep(raw, {
      id: 'STEP-ONLY',
      workstreamId: WS,
      index: 0,
      title: 'Solo',
      rationale: annotate('Flow-Step 1', { flowStepId: 'FSTEP-only' }),
      dependsOn: ['STEP-GHOST'], // existiert nicht im Plan
    });
    const result = compileWorkstreamToFlow(raw, {
      workstreamId: WS,
      workspaceId: WSP,
    });
    const steps = listFlowSteps(raw, result.flowId);
    expect(steps).toHaveLength(1);
    // dangling dep verworfen → null (keine erfundene Kante).
    expect(JSON.parse(steps[0].dependsOnJson ?? 'null')).toBeNull();
  });
});
