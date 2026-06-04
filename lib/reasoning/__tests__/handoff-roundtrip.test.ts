// handoff-roundtrip — beweist die Resume-Fidelity-Invariante, die der Audit als
// "die einzige heute ungetestete Naht" markiert hat: ein Workspace-Trail
// (Decisions + Beliefs + offene Entscheidungen) → persistierter Handoff → frisch
// re-aggregierter Session-Block reproduziert die Entscheidungen/Beliefs/offenen
// Punkte. Genau dieser Block wird bei einer Session-Rotation re-injiziert →
// Kontinuität ohne Kontext-Bloat.
//
// In-memory better-sqlite3, Schema aus den ECHTEN Migrationen (wie auto-handoff.test.ts).
// Run: NODE_OPTIONS=--experimental-require-module vitest run lib/reasoning/__tests__/handoff-roundtrip.test.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildWorkspaceHandoff,
  persistWorkspaceHandoff,
  buildSessionHandoffBlock,
} from '@/lib/reasoning/auto-handoff';
import { upsertBelief } from '@/lib/reasoning/beliefs-repo';

const MIG = (name: string): string =>
  path.join(process.cwd(), 'db', 'migrations', name);

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(MIG('0009_workstreams.sql'), 'utf8'));
  raw.exec(readFileSync(MIG('0071_workstream_decisions.sql'), 'utf8'));
  raw.exec(readFileSync(MIG('0113_workspace_beliefs.sql'), 'utf8'));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id               TEXT PRIMARY KEY NOT NULL,
      notes            TEXT,
      notes_updated_at INTEGER,
      notes_source     TEXT
    );
  `);
  return raw;
}

function insertWorkstream(raw: import('better-sqlite3').Database, id: string, wsId: string): void {
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, wsId, `ws ${id}`, Date.now(), Date.now());
}

let decSeq = 0;
function insertDecision(
  raw: import('better-sqlite3').Database,
  o: { workstreamId: string; decisionKind: string; rationale: string; createdAt?: number },
): string {
  const id = `dec_${String(++decSeq).padStart(6, '0')}`;
  raw
    .prepare(
      `INSERT INTO workstream_decisions
         (id, workstream_id, decision_kind, rationale, evidence_refs, content_hash, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'agent', ?)`,
    )
    .run(id, o.workstreamId, o.decisionKind, o.rationale, JSON.stringify(['ev1']), `h_${id}`, o.createdAt ?? Date.now());
  return id;
}

function insertWorkspaceRow(raw: import('better-sqlite3').Database, id: string): void {
  raw.prepare(`INSERT INTO workspaces (id) VALUES (?)`).run(id);
}

const WS = 'wsp-roundtrip';
const SENTINEL_DECISION = 'Higgsfield gewählt weil heygen-Avatar 0x lieferte';
const SENTINEL_OPEN = 'Cross-WS-Retrieval nach CRM beantragt noch offen';
const SENTINEL_BELIEF = 'PV-Zaehlerstaende kommen als CSV mit Semikolon-Trenner';

describe('handoff round-trip — trail → persist → re-aggregated session block', () => {
  let raw: import('better-sqlite3').Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
    insertWorkspaceRow(raw, WS);
    insertWorkstream(raw, 'wst-1', WS);
    insertDecision(raw, { workstreamId: 'wst-1', decisionKind: 'route', rationale: SENTINEL_DECISION, createdAt: 1000 });
    insertDecision(raw, { workstreamId: 'wst-1', decisionKind: 'bridge', rationale: SENTINEL_OPEN, createdAt: 2000 });
    upsertBelief(raw, {
      workspaceId: WS,
      topic: 'pv-format',
      belief: SENTINEL_BELIEF,
      rationale: 'aus Kundenchat extrahiert',
      source: 'ai',
      confidence: 0.8,
    });
  });

  it('buildWorkspaceHandoff captures the seeded trail (not empty, scope-isolated)', () => {
    const h = buildWorkspaceHandoff(raw, WS);
    expect(h.isEmpty).toBe(false);
    expect(h.openDecisions.length).toBeGreaterThanOrEqual(1);
    expect(h.beliefs.some((b) => b.belief.includes('Semikolon'))).toBe(true);
    // Andere Workspaces sehen davon nichts.
    expect(buildWorkspaceHandoff(raw, 'wsp-OTHER').isEmpty).toBe(true);
  });

  it('the FRESH session block reproduces decisions + beliefs + open items (resume fidelity)', () => {
    const block = buildSessionHandoffBlock(raw, WS, { maxChars: 8000 }).join('\n');
    expect(block.length).toBeGreaterThan(0);
    // Round-trip: was geseedet wurde, taucht im Block auf, den eine frische Session sieht.
    expect(block).toContain('Higgsfield');
    expect(block).toContain('CRM');
    expect(block).toContain('Semikolon');
    // Endet mit dem Separator, damit der restliche System-Prompt sauber folgt.
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  it('persist writes notes AND the persisted notes carry the same trail (two sources consistent)', () => {
    const h = buildWorkspaceHandoff(raw, WS);
    const res = persistWorkspaceHandoff(raw, WS, h);
    expect(res.written).toBe(true);
    const notes = (raw.prepare('SELECT notes, notes_source FROM workspaces WHERE id = ?').get(WS) as {
      notes: string;
      notes_source: string;
    });
    expect(notes.notes_source).toBe('ai-summary');
    expect(notes.notes).toContain('Higgsfield');
    expect(notes.notes).toContain('Semikolon');
  });

  it('empty / fresh workspace yields NO block (never breaks the prompt)', () => {
    insertWorkspaceRow(raw, 'wsp-empty');
    expect(buildSessionHandoffBlock(raw, 'wsp-empty')).toEqual([]);
  });

  it('persist is fail-closed-friendly: re-aggregation still works after persist (idempotent re-run)', () => {
    const h1 = buildWorkspaceHandoff(raw, WS);
    persistWorkspaceHandoff(raw, WS, h1);
    // Second build still reproduces the live trail (persist did not corrupt source).
    const block = buildSessionHandoffBlock(raw, WS, { maxChars: 8000 }).join('\n');
    expect(block).toContain('Higgsfield');
    expect(block).toContain('Semikolon');
  });
});
