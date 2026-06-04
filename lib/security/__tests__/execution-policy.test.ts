/**
 * Tests für lib/security/execution-policy.ts (R2, 2026-05-24).
 *
 * Run: `pnpm exec tsx --test lib/security/__tests__/execution-policy.test.ts`
 *
 * Gleicher Runner wie dataflow-policy.test.ts (node:test + node:assert/strict).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  enforceExecutionStep,
  type ExecutionStepRequest,
} from '../execution-policy';

// ---------------------------------------------------------------------------
// Basis-Request-Fixtures
// ---------------------------------------------------------------------------

const BASE_CODER_PLAN: ExecutionStepRequest = {
  role: 'coder',
  executionMode: 'execute-per-plan',
  requestedTools: ['Read', 'Write', 'Edit'],
  targetPaths: ['src/lib/foo.ts'],
  workspaceId: 'ws_test',
};

const BASE_CODER_STEP: ExecutionStepRequest = {
  ...BASE_CODER_PLAN,
  executionMode: 'execute-per-step',
};

describe('enforceExecutionStep', () => {
  // --- Fall 1: plan-only → immer deny -----------------------------------------
  it('plan-only mode → deny unabhängig von Rolle und Tools', () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'plan-only',
      requestedTools: ['Read', 'Write', 'Edit'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /plan-only/);
    assert.equal(d.requiresBridge, false);
    // Bash bleibt auch in deny-allowedTools draußen
    assert.ok(!d.allowedTools.includes('Bash'));
  });

  // --- Fall 2: coder + Write/Edit + execute-per-plan → allow (ohne Bash) -------
  it('coder + Write + Edit + execute-per-plan → allow (kein Bash in allowedTools)', () => {
    const d = enforceExecutionStep(BASE_CODER_PLAN);
    assert.equal(d.allow, true);
    assert.ok(d.allowedTools.includes('Write'), 'Write muss erlaubt sein');
    assert.ok(d.allowedTools.includes('Edit'), 'Edit muss erlaubt sein');
    assert.ok(!d.allowedTools.includes('Bash'), 'Bash darf nie in allowedTools erscheinen');
    assert.ok(d.categories.includes('write'), 'Kategorie write muss gesetzt sein');
    assert.equal(d.requiresBridge, false);
  });

  // --- Fall 3: coder + Write/Edit + execute-per-step → allow (ohne Bash) ------
  it('coder + execute-per-step → allow', () => {
    const d = enforceExecutionStep(BASE_CODER_STEP);
    assert.equal(d.allow, true);
    assert.ok(!d.allowedTools.includes('Bash'));
  });

  // --- Fall 4: Bash angefordert → deny (DEFAULT-DENY R2, T3/T6) ---------------
  it('Bash angefordert → deny (DEFAULT-DENY R2)', () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read', 'Bash', 'Write'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /[Bb]ash/);
    assert.ok(d.categories.includes('shell'), 'Kategorie shell muss gesetzt sein');
    assert.ok(d.categories.includes('network'), 'Kategorie network muss gesetzt sein');
    assert.ok(!d.allowedTools.includes('Bash'), 'Bash nie in allowedTools');
  });

  // --- Fall 5: .env in targetPaths → deny (secrets) ---------------------------
  it('.env in targetPaths → deny mit Kategorie secrets', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['.env.local'],
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /[Ss]ecret|\.env/);
    assert.ok(d.categories.includes('secrets'));
    assert.equal(d.requiresBridge, false);
  });

  // --- Fall 6: credential-Pfad → deny (secrets) --------------------------------
  it('.secrets.json → deny (secrets)', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['.secrets.json'],
    });
    assert.equal(d.allow, false);
    assert.ok(d.categories.includes('secrets'));
  });

  // --- Fall 7: ../escape in targetPaths → deny (scope) + requiresBridge --------
  it('../escape in targetPaths → deny mit scope + requiresBridge', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['../other-project/secret.ts'],
    });
    assert.equal(d.allow, false);
    assert.ok(d.categories.includes('scope'));
    assert.equal(d.requiresBridge, true);
    assert.match(d.reason, /[Ss]cope|Pfad/);
  });

  // --- Fall 8: absoluter Pfad außerhalb → deny (scope) + requiresBridge --------
  it('absoluter Pfad → deny (scope) + requiresBridge', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['/etc/passwd'],
    });
    assert.equal(d.allow, false);
    assert.ok(d.categories.includes('scope'));
    assert.equal(d.requiresBridge, true);
  });

  // --- Fall 9: tester + Write → deny (read-only Rolle) -------------------------
  it('tester + Write → deny (Rolle ist read-only)', () => {
    const d = enforceExecutionStep({
      role: 'tester',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read', 'Write'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /read-only|tester/);
    // Read bleibt in allowedTools
    assert.ok(d.allowedTools.includes('Read'), 'Read muss auch für tester zulässig sein');
    assert.ok(!d.allowedTools.includes('Write'));
  });

  // --- Fall 10: reviewer + Write → deny (Rolle ist read-only) ------------------
  it('reviewer + Edit → deny (Rolle ist read-only)', () => {
    const d = enforceExecutionStep({
      role: 'reviewer',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Grep', 'Edit'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /read-only|reviewer/);
    assert.ok(d.allowedTools.includes('Read'));
    assert.ok(d.allowedTools.includes('Grep'));
    assert.ok(!d.allowedTools.includes('Edit'));
  });

  // --- Fall 11: workspaceId fehlt → deny ----------------------------------------
  it('workspaceId leer → deny (N9: Scope-Anker fehlt)', () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read'],
      workspaceId: '',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /workspaceId/);
    assert.equal(d.requiresBridge, false);
  });

  // --- Fall 12: architect + Write → allow (berechtigte Rolle) ------------------
  it('architect + Write + execute-per-step → allow', () => {
    const d = enforceExecutionStep({
      role: 'architect',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Write', 'Grep'],
      targetPaths: ['docs/architecture.md'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, true);
    assert.ok(d.allowedTools.includes('Write'));
    assert.ok(!d.allowedTools.includes('Bash'));
  });

  // --- Fall 13: unbekannte Rolle + nur Read → allow (Read ist safe-readonly) ----
  it('unbekannte Rolle + nur Read/Grep → allow (kein Write angefordert)', () => {
    const d = enforceExecutionStep({
      role: 'unknown-agent',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read', 'Grep'],
      workspaceId: 'ws_test',
    });
    // Unbekannte Rolle, aber kein Write → darf lesen
    assert.equal(d.allow, true);
    assert.ok(d.allowedTools.includes('Read'));
    assert.ok(d.allowedTools.includes('Grep'));
  });

  // --- Fall 14: unbekanntes Tool → deny (fail-closed) --------------------------
  it('unbekanntes Tool angefordert → deny (fail-closed)', () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read', 'WebFetch'],
      workspaceId: 'ws_test',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /[Uu]nbekannte|WebFetch/);
  });

  // --- Fall 15: id_rsa in targetPaths → deny (secrets) -------------------------
  it('id_rsa in targetPaths → deny (secrets)', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['~/.ssh/id_rsa'],
    });
    assert.equal(d.allow, false);
    assert.ok(d.categories.includes('secrets'));
  });

  // --- Fall 16: .pem in targetPaths → deny (secrets) ---------------------------
  it('.pem Datei in targetPaths → deny (secrets)', () => {
    const d = enforceExecutionStep({
      ...BASE_CODER_PLAN,
      targetPaths: ['certs/server.pem'],
    });
    assert.equal(d.allow, false);
    assert.ok(d.categories.includes('secrets'));
  });

  // --- Kompaktitäts-Check: allowedTools enthält nie Bash ----------------------
  it('allowedTools enthält niemals Bash — auch wenn Bash angefordert + plan erlaubt', () => {
    // plan-only → deny, aber allowedTools darf trotzdem kein Bash enthalten
    const d1 = enforceExecutionStep({
      role: 'coder',
      executionMode: 'plan-only',
      requestedTools: ['Bash', 'Read'],
      workspaceId: 'ws_test',
    });
    assert.ok(!d1.allowedTools.includes('Bash'));

    // execute-per-plan + Bash → deny, aber allowedTools kein Bash
    const d2 = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-plan',
      requestedTools: ['Read', 'Bash'],
      workspaceId: 'ws_test',
    });
    assert.ok(!d2.allowedTools.includes('Bash'));
  });
});

// ---------------------------------------------------------------------------
// A·EXEC (2026-05-26): mode-aware Bash. Der permissionMode IST die Einwilligung.
//   - undefined / 'ask' / 'lane' → Bash bleibt default-deny (bit-identisch alt).
//   - 'freerein' / 'freerein-with-audit' → Bash ERLAUBT (R1-Worktree-isoliert).
// ---------------------------------------------------------------------------

describe('enforceExecutionStep — mode-aware Bash (A·EXEC)', () => {
  it('permissionMode undefined → Bash deny (bit-identisch zur Vor-EXEC-Version)', () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      workspaceId: 'ws_test',
      // KEIN permissionMode → Default-sicher
    });
    assert.equal(d.allow, false, 'ohne Modus muss Bash hart blockiert bleiben');
    assert.ok(!d.allowedTools.includes('Bash'));
  });

  it("permissionMode 'ask' → Bash deny (Einwilligung NICHT erteilt)", () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      workspaceId: 'ws_test',
      permissionMode: 'ask',
    });
    assert.equal(d.allow, false);
    assert.ok(!d.allowedTools.includes('Bash'));
  });

  it("permissionMode 'lane' → Bash deny, Write/Edit aber erlaubt (coder)", () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Write', 'Edit'],
      workspaceId: 'ws_test',
      permissionMode: 'lane',
    });
    assert.equal(d.allow, true, 'lane + coder + Write/Edit (kein Bash) → allow');
    assert.ok(d.allowedTools.includes('Write'));
    assert.ok(d.allowedTools.includes('Edit'));
    assert.ok(!d.allowedTools.includes('Bash'));

    // lane + Bash angefordert → deny (lane gewährt NIE Bash).
    const dBash = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      workspaceId: 'ws_test',
      permissionMode: 'lane',
    });
    assert.equal(dBash.allow, false, 'lane darf NIE Bash erlauben');
    assert.ok(!dBash.allowedTools.includes('Bash'));
  });

  it("permissionMode 'freerein' → Bash ERLAUBT (Einwilligung erteilt), in allowedTools", () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Write', 'Bash'],
      workspaceId: 'ws_test',
      permissionMode: 'freerein',
    });
    assert.equal(d.allow, true, 'freerein + coder + Bash → allow (Konsent)');
    assert.ok(d.allowedTools.includes('Bash'), 'freerein → Bash MUSS in allowedTools sein');
    assert.ok(d.allowedTools.includes('Write'), 'freerein + coder → Write erlaubt');
    assert.ok(d.categories.includes('shell'), 'shell-Kategorie für Audit-Transparenz');
    assert.ok(d.categories.includes('network'));
  });

  it("permissionMode 'freerein-with-audit' → Bash ERLAUBT (identisch zu freerein)", () => {
    const d = enforceExecutionStep({
      role: 'tester', // nicht write-fähig
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      workspaceId: 'ws_test',
      permissionMode: 'freerein-with-audit',
    });
    assert.equal(d.allow, true, 'freerein-with-audit + Bash → allow');
    assert.ok(d.allowedTools.includes('Bash'));
    // tester ist read-only → Write bleibt raus, Bash aber erlaubt (Shell ≠ Write-Rolle).
    assert.ok(!d.allowedTools.includes('Write'));
  });

  it("freerein + Bash + Secret-Pfad → trotzdem deny (Secrets schlagen Bash-Konsent)", () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      targetPaths: ['.env.production'],
      workspaceId: 'ws_test',
      permissionMode: 'freerein',
    });
    assert.equal(d.allow, false, 'Secret-Pfad blockt auch unter FreeRein');
    assert.ok(d.categories.includes('secrets'));
  });

  it("freerein + Bash + Scope-Escape → trotzdem deny + requiresBridge", () => {
    const d = enforceExecutionStep({
      role: 'coder',
      executionMode: 'execute-per-step',
      requestedTools: ['Read', 'Bash'],
      targetPaths: ['../../etc/passwd'],
      workspaceId: 'ws_test',
      permissionMode: 'freerein',
    });
    assert.equal(d.allow, false, 'Scope-Escape blockt auch unter FreeRein');
    assert.equal(d.requiresBridge, true);
    assert.ok(d.categories.includes('scope'));
  });
});
