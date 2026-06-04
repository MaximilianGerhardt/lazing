/**
 * Sandbox-Mode Tests (P16, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/workspaces/__tests__/sandbox.test.ts`
 *
 * Deckt:
 *   - isSandbox: low+1 → true, high+1 → false (Safety-Floor), low+0 → false
 *   - sandboxRejectionReason: enable+high → reject, enable+low → ok, disable → ok
 *   - setSandboxMode: aktualisiert DB, wirft bei Phantom-ID, wirft bei high
 *   - shouldSuppressPushInSandbox: bekannte Routine-Rules unterdrückt
 *   - workspaceIsSandbox: liest direkt aus DB
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { before, describe, it } from 'node:test';
import { join } from 'node:path';

// Init DB-Path + skip FK checks (Test-Hook in db/client.ts).
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-sandbox-')),
    'sandbox-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sandboxMod = require('../sandbox') as typeof import('../sandbox');
const {
  isSandbox,
  sandboxRejectionReason,
  setSandboxMode,
  shouldSuppressPushInSandbox,
  workspaceIsSandbox,
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

describe('sandbox · isSandbox (pure)', () => {
  it('low + sandboxMode=1 → true', () => {
    assert.equal(
      isSandbox({ sensitivity: 'low', sandboxMode: 1 }),
      true,
    );
  });

  it('high + sandboxMode=1 → false (sensitivity-Floor)', () => {
    assert.equal(
      isSandbox({ sensitivity: 'high', sandboxMode: 1 }),
      false,
    );
  });

  it('medium + sandboxMode=1 → false (sensitivity-Floor)', () => {
    assert.equal(
      isSandbox({ sensitivity: 'medium', sandboxMode: 1 }),
      false,
    );
  });

  it('low + sandboxMode=0 → false', () => {
    assert.equal(
      isSandbox({ sensitivity: 'low', sandboxMode: 0 }),
      false,
    );
  });

  it('low + sandboxMode undefined → false', () => {
    assert.equal(isSandbox({ sensitivity: 'low' }), false);
  });
});

describe('sandbox · sandboxRejectionReason', () => {
  it('enable on low → null (ok)', () => {
    assert.equal(
      sandboxRejectionReason({ sensitivity: 'low', sandboxMode: 0 }, true),
      null,
    );
  });

  it('enable on high → "sandbox-only-on-low-sensitivity"', () => {
    assert.equal(
      sandboxRejectionReason({ sensitivity: 'high', sandboxMode: 0 }, true),
      'sandbox-only-on-low-sensitivity',
    );
  });

  it('disable always ok (kein Constraint)', () => {
    assert.equal(
      sandboxRejectionReason({ sensitivity: 'high', sandboxMode: 1 }, false),
      null,
    );
  });
});

describe('sandbox · setSandboxMode (DB-Write)', () => {
  before(() => {
    // Migration läuft beim ersten getDb()-Call.
    getDb();
  });

  it('aktiviert Sandbox auf low-Workspace', async () => {
    seedWorkspace('ws-sandbox-low-1', 'low', 0);
    const r = await setSandboxMode('ws-sandbox-low-1', true);
    assert.equal(r.ok, true);
    assert.equal(r.sandboxMode, 1);

    assert.equal(await workspaceIsSandbox('ws-sandbox-low-1'), true);
  });

  it('deaktiviert Sandbox', async () => {
    seedWorkspace('ws-sandbox-low-2', 'low', 1);
    const r = await setSandboxMode('ws-sandbox-low-2', false);
    assert.equal(r.sandboxMode, 0);
    assert.equal(await workspaceIsSandbox('ws-sandbox-low-2'), false);
  });

  it('wirft bei high-sensitivity wenn enable=true', async () => {
    seedWorkspace('ws-sandbox-high-1', 'high', 0);
    await assert.rejects(
      () => setSandboxMode('ws-sandbox-high-1', true),
      /sandbox-only-on-low-sensitivity/,
    );
    // Disable bleibt erlaubt (kein Throw):
    const r = await setSandboxMode('ws-sandbox-high-1', false);
    assert.equal(r.sandboxMode, 0);
  });

  it('wirft bei nicht-existierendem Workspace', async () => {
    await assert.rejects(
      () => setSandboxMode('ws-does-not-exist-xyz', true),
      /workspace-not-found/,
    );
  });

  it('workspaceIsSandbox → false bei Phantom-ID (defensiv)', async () => {
    assert.equal(await workspaceIsSandbox('phantom-id-zzz'), false);
  });
});

describe('sandbox · Push-Suppression', () => {
  it('unterdrückt bekannte Routine-Rules', () => {
    assert.equal(shouldSuppressPushInSandbox('master-auto-closed'), true);
    assert.equal(shouldSuppressPushInSandbox('sub-dispatched-success'), true);
    assert.equal(shouldSuppressPushInSandbox('synthesis-completed'), true);
  });

  it('unterdrückt KEINE kritischen Rules', () => {
    assert.equal(shouldSuppressPushInSandbox('credential-violation'), false);
    assert.equal(shouldSuppressPushInSandbox('loop-guard-tripped'), false);
    assert.equal(shouldSuppressPushInSandbox('security-alert'), false);
    assert.equal(shouldSuppressPushInSandbox('approval-request'), false);
  });

  it('SANDBOX_SUPPRESSED_PUSH_RULES enthält keine kritischen Rules', () => {
    for (const rule of [
      'credential-violation',
      'loop-guard-tripped',
      'security-alert',
    ]) {
      assert.equal(
        SANDBOX_SUPPRESSED_PUSH_RULES.has(rule),
        false,
        `kritische Rule "${rule}" darf NICHT unterdrückt werden`,
      );
    }
  });
});
