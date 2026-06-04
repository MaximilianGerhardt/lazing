/**
 * Tests für lib/security/dataflow-policy.ts (Welle 3a, 2026-05-03).
 *
 * Run: `pnpm exec tsx --test lib/security/__tests__/dataflow-policy.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { enforceDataflow } from '../dataflow-policy';

describe('enforceDataflow', () => {
  it('same-ws low → allow without audit', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_a',
      sensitivity: 'low',
    });
    assert.equal(d.allow, true);
    assert.equal(d.auditSpec, undefined);
    assert.match(d.reason, /same-workspace/);
  });

  it('same-ws high → allow without audit (no cross-tenant leak)', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_a',
      sensitivity: 'high',
    });
    assert.equal(d.allow, true);
    assert.equal(d.auditSpec, undefined);
  });

  it('cross-ws low → allow WITH audit', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_b',
      sensitivity: 'low',
    });
    assert.equal(d.allow, true);
    assert.ok(d.auditSpec, 'auditSpec required');
    assert.equal(d.auditSpec?.table, 'rag_cross_workspace_audit');
    assert.equal(d.auditSpec?.row.actorWsId, 'ws_a');
    assert.equal(d.auditSpec?.row.requestedWsId, 'ws_b');
    assert.equal(d.auditSpec?.row.sensitivity, 'low');
  });

  it('cross-ws medium → allow WITH audit', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_b',
      sensitivity: 'medium',
    });
    assert.equal(d.allow, true);
    assert.ok(d.auditSpec);
    assert.equal(d.auditSpec?.row.sensitivity, 'medium');
  });

  it('cross-ws high → DENY', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_b',
      sensitivity: 'high',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /high-sensitivity denied/);
  });

  it('system-actor with empty actorWsId, low → allow without audit', () => {
    const d = enforceDataflow({
      actorWsId: '',
      requestedWsId: 'ws_b',
      sensitivity: 'low',
      actorRole: 'system',
    });
    assert.equal(d.allow, true);
    assert.equal(d.auditSpec, undefined);
    assert.match(d.reason, /system-actor/);
  });

  it('system-actor with empty actorWsId, high → DENY', () => {
    const d = enforceDataflow({
      actorWsId: '',
      requestedWsId: 'ws_b',
      sensitivity: 'high',
      actorRole: 'system',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /system-actor blocked/);
  });

  it('system-actor with auditRequired=true → allow WITH audit', () => {
    const d = enforceDataflow({
      actorWsId: '',
      requestedWsId: 'ws_b',
      sensitivity: 'medium',
      actorRole: 'system',
      auditRequired: true,
    });
    assert.equal(d.allow, true);
    assert.ok(d.auditSpec);
    assert.equal(d.auditSpec?.row.actorRole, 'system');
  });

  it('sub-agent inherits parentActorWsId — allowed if parent==requested', () => {
    const d = enforceDataflow({
      actorWsId: '',
      requestedWsId: 'ws_a',
      sensitivity: 'high',
      actorRole: 'sub-agent',
      parentActorWsId: 'ws_a',
    });
    assert.equal(d.allow, true, 'parent ws == requested → high ok (same-ws)');
  });

  it('sub-agent without parentActorWsId → DENY', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_a',
      sensitivity: 'low',
      actorRole: 'sub-agent',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /parentActorWsId required/);
  });

  it('sub-agent with mismatched actorWsId vs parent → DENY', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_x',
      requestedWsId: 'ws_a',
      sensitivity: 'low',
      actorRole: 'sub-agent',
      parentActorWsId: 'ws_a',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /mismatches parentActorWsId/);
  });

  it('sensitivity undefined → fallback fail-closed (high) for cross-ws', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_b',
    });
    assert.equal(d.allow, false, 'undefined sensitivity → treated as high → cross-ws denied');
  });

  it('auditRequired=true on same-ws → allow WITH audit', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: 'ws_a',
      sensitivity: 'low',
      auditRequired: true,
    });
    assert.equal(d.allow, true);
    assert.ok(d.auditSpec);
    assert.match(d.auditSpec!.row.reason, /same-workspace/);
  });

  it('requestedWsId missing → DENY', () => {
    const d = enforceDataflow({
      actorWsId: 'ws_a',
      requestedWsId: '',
      sensitivity: 'low',
    });
    assert.equal(d.allow, false);
    assert.match(d.reason, /requestedWsId missing/);
  });

  it('cross-ws low for sub-agent inherits from parent → audit', () => {
    const d = enforceDataflow({
      actorWsId: '',
      requestedWsId: 'ws_b',
      sensitivity: 'low',
      actorRole: 'sub-agent',
      parentActorWsId: 'ws_a',
    });
    assert.equal(d.allow, true);
    assert.ok(d.auditSpec);
    assert.equal(d.auditSpec?.row.actorWsId, 'ws_a');
    assert.equal(d.auditSpec?.row.actorRole, 'sub-agent');
  });
});
