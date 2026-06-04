// W1b — Self-Learning P0 (2026-05-28). Plan-Dispatch liest VOR proposeRecursivePlan
// den WARUM-Kontext des Workspace fail-soft. Wir testen den extrahierten Helper
// `readWhyContextForDispatchFailSoft` direkt (Echt-Caller decomposeAndPersist ist
// integration-heavy: resourcePool, broadcast, createWorkstream — die wären 200+
// Zeilen Stub für einen 3-Zeilen-Hook).
//
// Vertrag (deterministisch, N6):
//   - Echter WHY-Kontext im Workspace ⇒ pill-lesbarer Block (Header-Marker) wird
//     zurückgegeben → proposeRecursivePlan-Opts erhalten ihn auf jeder Ebene.
//   - Leerer Workspace (kein Decision, kein Belief) ⇒ undefined (kein Block) ⇒
//     proposeRecursivePlan-Prompt bit-identisch zu vorher (E1.3).
//   - Read-Fehler (z.B. workspaceId leer → buildWhyContext throws N9-Guard)
//     ⇒ undefined (kein Block) — Helper kippt NIE.
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';

// LAZYOS_DB_PATH muss VOR jedem db/client-Import gesetzt sein — der erste
// getDb()-Aufruf baut die DB an genau diesem Pfad auf (gleiches Pattern wie in
// lib/unlearning/__tests__/experiment-tracker.test.ts:17-22).
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-plan-dispatch-why-')),
    'plan-dispatch-why-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

import { readWhyContextForDispatchFailSoft } from '../plan-dispatch';
import { getDb } from '@/db/client';
import { upsertBelief } from '@/lib/reasoning/beliefs-repo';

const WHY_HEADER = 'Frühere Entscheidungen in diesem Workspace';

beforeAll(() => {
  // Migrationen anstoßen (workspace_beliefs liegt in 0113).
  getDb();
});

describe('readWhyContextForDispatchFailSoft — W1b WHY-Read vor decompose', () => {
  it('Workspace ohne Beliefs/Decisions ⇒ undefined (kein Block)', () => {
    const out = readWhyContextForDispatchFailSoft({
      workspaceId: 'ws-empty-no-state',
      topic: 'Trainingsplan',
    });
    expect(out).toBeUndefined();
  });

  it('Workspace mit aktiver Belief ⇒ pill-lesbarer Block mit Header', () => {
    const wsId = 'ws-w1b-with-belief';
    const raw = getDb().$raw;
    // recallRelevant matched via `belief.topic LIKE '%query.topic%'` ODER exakt.
    // Damit der Belief getroffen wird, muss query.topic ein Substring von
    // belief.topic ODER identisch sein. Wir setzen belief.topic = 'Routing für
    // Motion-Step' und query.topic = 'Routing'.
    upsertBelief(raw, {
      workspaceId: wsId,
      topic: 'Routing für Motion-Step',
      belief: 'Higgsfield wird für Motion bevorzugt',
      rationale: 'liefert konsistente Cinematic-Cuts',
      source: 'ai',
      confidence: 0.9,
    });

    const out = readWhyContextForDispatchFailSoft({
      workspaceId: wsId,
      topic: 'Routing',
    });
    expect(out).toBeDefined();
    expect(out).toContain(WHY_HEADER);
    // Belief-Text und Begründung verbatim (N1) im Block.
    expect(out).toContain('Higgsfield wird für Motion bevorzugt');
    expect(out).toContain('liefert konsistente Cinematic-Cuts');
  });

  it('leere workspaceId ⇒ undefined (fail-soft: buildWhyContext N9-Throw wird gefangen)', () => {
    const out = readWhyContextForDispatchFailSoft({
      workspaceId: '',
      topic: 'irgendwas',
    });
    expect(out).toBeUndefined();
  });

  it('zweimaliger Call ist deterministisch (N6: gleicher State → gleiches Ergebnis)', () => {
    const wsId = 'ws-w1b-deterministic';
    const raw = getDb().$raw;
    // belief.topic = 'Engine-Wahl' damit query.topic = 'Engine' via LIKE matched.
    upsertBelief(raw, {
      workspaceId: wsId,
      topic: 'Engine-Wahl',
      belief: 'Codex-CLI als Default-Engine',
      rationale: 'lokal verfügbar, keine API-Latenz',
      source: 'user',
      confidence: 0.8,
    });

    const a = readWhyContextForDispatchFailSoft({
      workspaceId: wsId,
      topic: 'Engine',
    });
    const b = readWhyContextForDispatchFailSoft({
      workspaceId: wsId,
      topic: 'Engine',
    });
    expect(a).toBe(b);
    expect(a).toContain('Codex-CLI als Default-Engine');
  });
});
