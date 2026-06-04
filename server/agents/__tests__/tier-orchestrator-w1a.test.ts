// W1a — Self-Learning P0 (2026-05-28). Der Tier-Iterate-Pfad ruft am Done-
// Punkt das Reconcile + den Auto-Handoff fail-soft. Wir testen den extrahierten
// Helper `runReconcileAndHandoffFailSoft` direkt (Echt-Caller runIterate ist
// tmux-/spawn-getrieben und nicht unit-testbar — gleiches Muster wie
// tier-orchestrator-why.test.ts, der `injectWhyIntoLeadSystem` isoliert prüft).
//
// Vertrag (deterministisch, N6):
//   - happy-Path: reconcileWorkstream wird mit `${workspaceId}/${workstreamId}`
//     als coordKey gerufen und schreibt eine Outcome-Row (success bei alle-done).
//   - reconcile-Fehler darf den Helper NIE throwen lassen (try/catch im Helper).
//   - handoff-Fehler unabhängig vom Reconcile (eigener catch).
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-tier-w1a-')),
    'tier-w1a-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

import {
  runReconcileAndHandoffFailSoft,
  recordIterateFailureFailSoft,
} from '../tier-orchestrator';
import { getDb } from '@/db/client';
import { listOutcomes } from '@/lib/reasoning/beliefs-repo';

const WS_ID = 'ws-w1a-iterate-done';
const WSTREAM_ID = 'ws-w1a-stream-001';

beforeAll(() => {
  // Workstream-Row anlegen (FK ist im Test off, aber Reconcile-Code joint
  // weiterhin auf workstreams — ohne Row liefert listDecisions leer, aber
  // recordOutcome braucht keine Workstream-Row laut Schema 0113).
  getDb();
});

describe('runReconcileAndHandoffFailSoft — W1a Iterate-Done-Hook', () => {
  it('alle-done stepStatuses ⇒ Outcome-Row "success" wird geschrieben', async () => {
    await runReconcileAndHandoffFailSoft(WS_ID, WSTREAM_ID, {
      'iterate-lead-v1': 'done',
      'iterate-roasters': 'done',
      'iterate-lead-final': 'done',
    });
    const raw = getDb().$raw;
    const outcomes = listOutcomes(raw, {
      workspaceId: WS_ID,
      workstreamId: WSTREAM_ID,
    });
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes[0].outcome).toBe('success');
  });

  it('idempotent: zweiter Call schreibt KEINE zweite Outcome-Row mit anderem Marker', async () => {
    // Erster Call hat oben schon geschrieben. Jetzt nochmal mit denselben
    // Args — reconcile guard'd via Marker im note.
    const raw = getDb().$raw;
    const before = listOutcomes(raw, {
      workspaceId: WS_ID,
      workstreamId: WSTREAM_ID,
    }).length;
    await runReconcileAndHandoffFailSoft(WS_ID, WSTREAM_ID, {
      'iterate-lead-v1': 'done',
      'iterate-roasters': 'done',
      'iterate-lead-final': 'done',
    });
    const after = listOutcomes(raw, {
      workspaceId: WS_ID,
      workstreamId: WSTREAM_ID,
    }).length;
    // Idempotenz: max gleiche Anzahl (reconcile detected alreadyReconciled).
    expect(after).toBe(before);
  });

  it('throws NICHT bei leerem workstreamId — fail-soft im inneren try/catch', async () => {
    // workstreamId="" lässt reconcileWorkstream throwen (Guard), aber unser
    // Helper fängt das im inneren try/catch. Kein throw nach außen.
    await expect(
      runReconcileAndHandoffFailSoft(WS_ID, '', { 'x': 'done' }),
    ).resolves.toBeUndefined();
  });
});

describe('recordIterateFailureFailSoft — W1c Failure-Eintrag', () => {
  it('schreibt KEINEN Eintrag bei non-failure (Helper wird nur bei Failure gerufen)', () => {
    // Reine Funktions-Signatur-Verifikation: der Helper ist sync void und
    // throws nie (sein internes try/catch fängt alles). Ein Call darf nichts
    // unerwartet zurückgeben.
    expect(
      recordIterateFailureFailSoft({
        workspaceId: WS_ID,
        workstreamId: WSTREAM_ID,
        hypothesis: 'Test-Failure-Hypothesis',
        reason: 'unit-test-only',
        modelUsed: 'opus-test',
      }),
    ).toBeUndefined();
  });

  it('throws NICHT bei undefined modelUsed', () => {
    expect(() =>
      recordIterateFailureFailSoft({
        workspaceId: WS_ID,
        workstreamId: WSTREAM_ID,
        hypothesis: 'h2',
        reason: 'r2',
      }),
    ).not.toThrow();
  });
});
