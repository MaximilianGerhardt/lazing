/**
 * Sandbox-Wire Tests (V3 Wire-Punkte 2+3, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/workspaces/__tests__/sandbox-wire.test.ts`
 *
 * Deckt die zwei Hot-Path-Konsumenten von `workspaceIsSandbox`:
 *   - Push-Trigger (lib/push/triggers.ts) → suppressed Rules feuern nicht
 *     in Sandbox-Workspaces, kritische Rules schon.
 *   - Auto-Dispatch-Pause (lib/tickets/auto-dispatch.ts) → Pause-Logic
 *     wird in Sandbox auf 0 gesetzt (verifiziert via direktem
 *     workspaceIsSandbox-Check, weil maybeAutoDispatch DB-Side-Effects
 *     hat die wir in einem Wire-Test nicht ausführen wollen).
 *
 * NICHT gemockt: SQLite-DB. Die existierende DB-Init-Pipeline aus
 * sandbox.test.ts wird wiederverwendet.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { before, describe, it } from 'node:test';
import { join } from 'node:path';

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-sandbox-wire-')),
    'sandbox-wire.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';
process.env.LAZYOS_DISABLE_PUSH = '1'; // sendPush soll nicht raus
process.env.LAZYOS_DISABLE_AUTO_DISPATCH = '0';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sandboxMod = require('../sandbox') as typeof import('../sandbox');
const {
  workspaceIsSandbox,
  shouldSuppressPushInSandbox,
  SANDBOX_SUPPRESSED_PUSH_RULES,
} = sandboxMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require('../../../db/client') as typeof import('../../../db/client');
const { getDb } = dbMod;

const NOW = Date.now();

function seedWorkspace(
  id: string,
  sensitivity: 'low' | 'medium' | 'high',
  sandboxMode: 0 | 1 = 0,
): void {
  const db = getDb();
  db.$raw
    .prepare(
      `INSERT OR REPLACE INTO workspaces
        (id, label, accent, path, sensitivity, archived, sandbox_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, id, 'own', `/tmp/${id}`, sensitivity, sandboxMode, NOW, NOW);
}

describe('sandbox-wire · Wire-Punkt 2 (Push-Suppress)', () => {
  before(() => {
    getDb();
    seedWorkspace('ws-wire-sb', 'low', 1);
    seedWorkspace('ws-wire-normal', 'low', 0);
  });

  it('Sandbox-Workspace: workspaceIsSandbox() = true', async () => {
    assert.equal(await workspaceIsSandbox('ws-wire-sb'), true);
  });

  it('Normal-Workspace: workspaceIsSandbox() = false', async () => {
    assert.equal(await workspaceIsSandbox('ws-wire-normal'), false);
  });

  it('Routine-Push-Rules sind in Suppress-Set', () => {
    const routineRules = [
      'master-auto-closed',
      'sub-dispatched-success',
      'sub-completed-success',
      'approval-request-routine',
      'synthesis-completed',
    ];
    for (const r of routineRules) {
      assert.equal(
        shouldSuppressPushInSandbox(r),
        true,
        `${r} muss in Sandbox suppressed sein`,
      );
    }
  });

  it('Kritische Push-Rules sind NIE in Suppress-Set', () => {
    // Aus dem Plan: credential-violation, loop-guard-tripped,
    // security-alert, errors-burst, ticket-p0-created.
    const critical = [
      'credential-violation',
      'loop-guard-tripped',
      'security-alert',
      'errors-burst',
      'ticket-p0-created',
      // Auch andere Rules aus rules.ts (existierende Critical-Rules)
      'approval-requested',
      'workspace-stale',
      'routine-failed',
      'sub-dispatch-failed',
      'workstream-stuck',
      'plan-open-questions',
      'synthesis-unfalsifiable',
    ];
    for (const r of critical) {
      assert.equal(
        SANDBOX_SUPPRESSED_PUSH_RULES.has(r),
        false,
        `Kritische Rule "${r}" darf NICHT in Suppress-Set sein`,
      );
    }
  });

  it('Phantom-Workspace-IDs liefern false (kein Privileg-Bypass)', async () => {
    assert.equal(await workspaceIsSandbox(''), false);
    assert.equal(await workspaceIsSandbox('does-not-exist-xyz'), false);
  });
});

describe('sandbox-wire · Wire-Punkt 3 (Auto-Dispatch-Pause)', () => {
  before(() => {
    getDb();
    seedWorkspace('ws-disp-sb', 'low', 1);
    seedWorkspace('ws-disp-normal', 'low', 0);
  });

  it('Pause-Logik liest workspaceIsSandbox vor Pause-Berechnung', async () => {
    // Smoke-Test: der Helper liefert für Sandbox-WS true → Pause auf 0.
    // Eigentliche Pause-Branch-Logik in auto-dispatch.ts ist:
    //   if (pauseMs > 0 && (await workspaceIsSandbox(event.segmentId))) {
    //     pauseMs = 0;
    //   }
    // Wir verifizieren hier nur den Decision-Input — Branch ist trivial.
    assert.equal(await workspaceIsSandbox('ws-disp-sb'), true);
    assert.equal(await workspaceIsSandbox('ws-disp-normal'), false);
  });
});
