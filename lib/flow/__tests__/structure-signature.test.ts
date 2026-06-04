/**
 * Tests für lib/flow/structure-signature.ts (Self-Learning Slice 1, pure/N6).
 */
import { describe, it, expect } from 'vitest';

import {
  computeStructureSignature,
  scoreRepetition,
  isToolStep,
  SUGGEST_THRESHOLD,
  type SignatureStep,
} from '../structure-signature';

const reel = (topicSkill = 'researcher'): SignatureStep[] => [
  { skill: topicSkill, toolKind: 'mcp', connectorId: null },
  { skill: 'copy', toolKind: null, connectorId: null },
  { skill: 'design', toolKind: null, connectorId: null },
  { skill: 'tool:video', toolKind: 'connector', connectorId: 'higgsfield' },
];

describe('computeStructureSignature', () => {
  it('ist deterministisch (gleiche Steps → gleiche Signatur)', () => {
    expect(computeStructureSignature(reel())).toBe(computeStructureSignature(reel()));
  });

  it('ignoriert Param-/Wert-Variation: gleiche FORM → gleiche Signatur', () => {
    // skill ist Teil der Struktur; aber Config/Label/Werte fließen NICHT ein.
    const a: SignatureStep[] = [{ skill: 'copy', toolKind: null, connectorId: null }];
    const b: SignatureStep[] = [{ skill: 'copy', toolKind: null, connectorId: null }];
    expect(computeStructureSignature(a)).toBe(computeStructureSignature(b));
  });

  it('andere FORM → andere Signatur (Connector geändert)', () => {
    const base = reel();
    const swapped = base.map((s, i) =>
      i === 3 ? { ...s, connectorId: 'heygen-avatar' } : s,
    );
    expect(computeStructureSignature(base)).not.toBe(computeStructureSignature(swapped));
  });

  it('andere Reihenfolge → andere Signatur', () => {
    const base = reel();
    const reordered = [base[1]!, base[0]!, base[2]!, base[3]!];
    expect(computeStructureSignature(base)).not.toBe(computeStructureSignature(reordered));
  });

  it('beginnt mit sha256:', () => {
    expect(computeStructureSignature(reel())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('isToolStep', () => {
  it('erkennt Connector-/MCP-/Tool-Steps', () => {
    expect(isToolStep({ skill: 'x', toolKind: 'connector', connectorId: 'higgsfield' })).toBe(true);
    expect(isToolStep({ skill: 'x', toolKind: 'mcp', connectorId: null })).toBe(true);
    expect(isToolStep({ skill: 'x', toolKind: 'tool', connectorId: null })).toBe(true);
    expect(isToolStep({ skill: 'copy', toolKind: null, connectorId: null })).toBe(false);
  });
});

describe('scoreRepetition — Schwellen', () => {
  it('2. Lauf eines 4-Schritt-Ablaufs mit Tool → KEIN Vorschlag (Owner: erst 3×)', () => {
    const r = scoreRepetition({
      seenCount: 2,
      stepCount: 4,
      hasToolStep: true,
      alreadyTemplated: false,
      outcomeFailed: false,
    });
    expect(r.suggest).toBe(false);
    expect(r.score).toBeLessThan(SUGGEST_THRESHOLD);
  });

  it('3. Lauf, 4 Schritte, kein Tool → Vorschlag (seen>=3 +2, len>=4 +1 = 3)', () => {
    const r = scoreRepetition({
      seenCount: 3,
      stepCount: 4,
      hasToolStep: false,
      alreadyTemplated: false,
      outcomeFailed: false,
    });
    expect(r.suggest).toBe(true);
    expect(r.score).toBe(3);
  });

  it('3. Lauf, 4 Schritte, mit Tool → Vorschlag (Score 4)', () => {
    const r = scoreRepetition({
      seenCount: 3,
      stepCount: 4,
      hasToolStep: true,
      alreadyTemplated: false,
      outcomeFailed: false,
    });
    expect(r.suggest).toBe(true);
    expect(r.score).toBe(4);
  });

  it('3. Lauf aber nur 3 Schritte, kein Tool → KEIN Vorschlag (zu simpel)', () => {
    const r = scoreRepetition({
      seenCount: 3,
      stepCount: 3,
      hasToolStep: false,
      alreadyTemplated: false,
      outcomeFailed: false,
    });
    expect(r.suggest).toBe(false);
  });

  it('bereits als Template gespeichert → Veto (kein Doppel-Vorschlag)', () => {
    const r = scoreRepetition({
      seenCount: 5,
      stepCount: 4,
      hasToolStep: true,
      alreadyTemplated: true,
      outcomeFailed: false,
    });
    expect(r.suggest).toBe(false);
  });

  it('gescheiterter Lauf → Veto (kein Gelernt aus Fehlschlag)', () => {
    const r = scoreRepetition({
      seenCount: 3,
      stepCount: 4,
      hasToolStep: false,
      alreadyTemplated: false,
      outcomeFailed: true,
    });
    expect(r.suggest).toBe(false);
  });
});
