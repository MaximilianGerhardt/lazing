/**
 * lib/flow/__tests__/repetition-detect.test.ts — Self-Learning Slice 1.
 *
 * In-memory better-sqlite3. Verifiziert:
 *   - 1./2. Lauf gleicher Struktur → KEIN Vorschlag; je ein append-only Event.
 *   - 3. Lauf (4-Schritt-Ablauf mit Tool) → genau dann `suggest = true`.
 *   - Signatur ist struktur-, nicht wert-basiert (anderer Param-Wert,
 *     gleiche Form → zählt als Wiederholung).
 *   - Workspace-Isolation (N9): ein Lauf in Workspace B beeinflusst den Zähler
 *     in Workspace A nicht.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/flow/__tests__/repetition-detect.test.ts
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { detectWorkflowRepetition } from '@/lib/flow/repetition-detect';

type RawDb = import('better-sqlite3').Database;

function freshDb(): RawDb {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE workstream_plan_steps (
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
    CREATE TABLE events (
      id           TEXT PRIMARY KEY NOT NULL,
      created_at   INTEGER NOT NULL,
      segment_id   TEXT NOT NULL,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      actor        TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      sensitivity  TEXT NOT NULL DEFAULT 'low',
      signature    TEXT,
      replayed_from TEXT
    );
  `);
  return raw;
}

/** Annotation exakt wie execute.ts::annotateRationale. */
function annotate(
  base: string,
  a: { skill: string | null; toolKind: string | null; connectorId: string | null },
): string {
  return `${base} | flow:${JSON.stringify({
    flowStepId: null,
    skill: a.skill,
    toolKind: a.toolKind,
    connectorId: a.connectorId,
    configJson: null,
  })}`;
}

/** 4-Schritt-Reel-Ablauf mit einem Tool-Step (Higgsfield). `topic` variiert nur den Wert. */
function insertReelRun(raw: RawDb, workstreamId: string, topic: string): void {
  const steps = [
    { skill: 'researcher', toolKind: 'mcp', connectorId: null },
    { skill: 'copy', toolKind: null, connectorId: null },
    { skill: 'design', toolKind: null, connectorId: null },
    { skill: 'tool:video', toolKind: 'connector', connectorId: 'higgsfield' },
  ];
  steps.forEach((s, i) => {
    raw
      .prepare(
        `INSERT INTO workstream_plan_steps
           (id, workstream_id, plan_id, step_index, title, rationale, subagent_role,
            depth, depends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'done', ?, ?)`,
      )
      .run(
        `STEP-${workstreamId}-${i}`,
        workstreamId,
        `PLN-${workstreamId}`,
        i,
        `Schritt ${i} (${topic})`,
        annotate(`Bearbeite ${topic}`, s),
        s.skill,
        null,
        Date.now(),
        Date.now(),
      );
  });
}

function countEvents(raw: RawDb, workspaceId: string): number {
  return (
    raw
      .prepare(
        `SELECT COUNT(*) AS c FROM events WHERE segment_id = ? AND event_type = 'workflow.structure_seen'`,
      )
      .get(workspaceId) as { c: number }
  ).c;
}

describe('detectWorkflowRepetition', () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  it('schlägt erst beim 3. gleichen Lauf vor; schreibt je ein append-only Event', () => {
    insertReelRun(raw, 'WS-1', 'thema-a');
    const r1 = detectWorkflowRepetition(raw, { workspaceId: 'own', workstreamId: 'WS-1' });
    expect(r1?.seenCount).toBe(1);
    expect(r1?.suggest).toBe(false);

    insertReelRun(raw, 'WS-2', 'thema-b'); // andere Werte, GLEICHE Struktur
    const r2 = detectWorkflowRepetition(raw, { workspaceId: 'own', workstreamId: 'WS-2' });
    expect(r2?.seenCount).toBe(2);
    expect(r2?.suggest).toBe(false);
    expect(r2?.signature).toBe(r1?.signature); // wert-tolerant

    insertReelRun(raw, 'WS-3', 'thema-c');
    const r3 = detectWorkflowRepetition(raw, { workspaceId: 'own', workstreamId: 'WS-3' });
    expect(r3?.seenCount).toBe(3);
    expect(r3?.suggest).toBe(true); // 4 Schritte + Tool + 3. Lauf
    expect(r3?.stepCount).toBe(4);

    expect(countEvents(raw, 'own')).toBe(3);
  });

  it('ist workspace-isoliert (N9): Lauf in Workspace B zählt nicht für A', () => {
    insertReelRun(raw, 'A-1', 'x');
    detectWorkflowRepetition(raw, { workspaceId: 'wsA', workstreamId: 'A-1' });
    insertReelRun(raw, 'A-2', 'y');
    detectWorkflowRepetition(raw, { workspaceId: 'wsA', workstreamId: 'A-2' });
    // dritter Lauf gleicher Struktur — aber in einem ANDEREN Workspace:
    insertReelRun(raw, 'B-1', 'z');
    const rb = detectWorkflowRepetition(raw, { workspaceId: 'wsB', workstreamId: 'B-1' });
    expect(rb?.seenCount).toBe(1); // eigener Zähler
    expect(rb?.suggest).toBe(false);
    // und A bleibt bei 2:
    insertReelRun(raw, 'A-3', 'w');
    const ra3 = detectWorkflowRepetition(raw, { workspaceId: 'wsA', workstreamId: 'A-3' });
    expect(ra3?.seenCount).toBe(3);
    expect(ra3?.suggest).toBe(true);
  });

  it('keine root-Steps → null (nichts zu bewerten)', () => {
    const r = detectWorkflowRepetition(raw, { workspaceId: 'own', workstreamId: 'EMPTY' });
    expect(r).toBeNull();
  });
});
