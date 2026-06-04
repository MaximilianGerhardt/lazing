/**
 * Slice C · C3 — plan-dispatch ⨯ Discovery-Hook Unit-Tests (2026-05-29).
 *
 * Wir testen die zwei expressly exportierten Helfer aus plan-dispatch.ts:
 *   - composeDiscoveryAndWhy: Konkatenation Discovery + WHY in der spec'd
 *     Reihenfolge (Discovery > WHY > Intent) plus alle Identitäts-Pfade.
 *   - runDiscoveryAndEmitFailSoft: Smoke-Test, dass leerer Intent NICHT
 *     wirft + leeren builtContext liefert (Pre-Slice-C-Identität).
 *
 * Der Echt-Caller tryPlanDispatch ist integration-heavy (resourcePool,
 * broadcast, createWorkstream); die Helfer-Tests sind das, was hier
 * pragmatisch und deterministisch testbar ist (analog zum bestehenden
 * plan-dispatch-why.test.ts-Pattern).
 *
 * Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

// LAZYOS_DB_PATH muss VOR jedem db/client-Import gesetzt sein — der erste
// getDb()-Aufruf baut die DB an genau diesem Pfad auf (gleiches Pattern wie
// in plan-dispatch-why.test.ts:26-31).
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-plan-dispatch-discovery-')),
    'plan-dispatch-discovery-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

import {
  composeDiscoveryAndWhy,
  runDiscoveryAndEmitFailSoft,
} from '../plan-dispatch';
import { getDb } from '@/db/client';
import { createWorkstream } from '@/lib/workstreams/service';

beforeAll(() => {
  getDb(); // Migrationen anstoßen.
});

describe('composeDiscoveryAndWhy — Identitäts-Pfad + Reihenfolge', () => {
  it('beide leer ⇒ undefined (Pre-Slice-C-Identität)', () => {
    expect(composeDiscoveryAndWhy(undefined, undefined)).toBeUndefined();
    expect(composeDiscoveryAndWhy('', '')).toBeUndefined();
    expect(composeDiscoveryAndWhy('   ', '\n\t')).toBeUndefined();
  });

  it('nur WHY vorhanden ⇒ nur WHY (Pre-Slice-C-Verhalten)', () => {
    const r = composeDiscoveryAndWhy(undefined, 'WHY-block');
    expect(r).toBe('WHY-block');
  });

  it('nur Discovery vorhanden ⇒ nur Discovery', () => {
    const r = composeDiscoveryAndWhy('DISCOVERY-block', undefined);
    expect(r).toBe('DISCOVERY-block');
  });

  it('beide vorhanden ⇒ Discovery > Leerzeile > WHY (Reihenfolge laut Spec)', () => {
    const r = composeDiscoveryAndWhy('D-block', 'W-block') ?? '';
    // Discovery muss VOR WHY stehen.
    expect(r.indexOf('D-block')).toBeLessThan(r.indexOf('W-block'));
    // Zwischen beiden eine Leerzeile.
    expect(r).toBe('D-block\n\nW-block');
  });
});

describe('runDiscoveryAndEmitFailSoft — fail-soft Identitäts-Pfad', () => {
  it('leerer Intent ⇒ leerer builtContext, kein Wurf', async () => {
    const ws = await createWorkstream({
      workspaceId: 'ws-discovery-empty',
      name: 'empty',
      description: 'empty',
    });
    const r = await runDiscoveryAndEmitFailSoft({
      workspaceId: 'ws-discovery-empty',
      workstreamId: ws.id,
      intent: 'nur ein Satz ohne Refs.',
    });
    expect(r.builtContext).toBe('');
    expect(r.urlCount).toBe(0);
    expect(r.docMentionCount).toBe(0);
  });

  it('Intent mit Doku-Mention (ohne URL) ⇒ docMentionCount>0, kein Wurf', async () => {
    const ws = await createWorkstream({
      workspaceId: 'ws-discovery-doc',
      name: 'doc',
      description: 'doc',
    });
    const r = await runDiscoveryAndEmitFailSoft({
      workspaceId: 'ws-discovery-doc',
      workstreamId: ws.id,
      intent: 'Ich sende dir gleich das Meisterdokument als PDF.',
    });
    expect(r.urlCount).toBe(0);
    expect(r.docMentionCount).toBeGreaterThan(0);
    expect(r.builtContext).toContain('Aktuelle Discovery');
  });
});
