/**
 * Konsens-Detection Tests (Pattern 5 Hardening, 2026-05-01).
 *
 * Run: `pnpm exec tsx --test server/agents/__tests__/consensus-meta.test.ts`
 *
 * Adressiert Critic-Befund: detectConsensusLevel war Substring-Hoffnung auf
 * LLM-Freitext mit unsichtbarem Fallback auf 'strong'. Neue Implementierung
 * parst einen deterministischen YAML-Block + macht Server-side Re-Compute.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectConsensusLevel, detectConsensusMeta } from '../tier-orchestrator';

const META_BLOCK = (
  level: string,
  clusters: number,
  outliers: number,
  openQuestions: number,
  reasoning = 'test',
) => `
Some prose before...

\`\`\`yaml consensus_meta
level: ${level}
clusters: ${clusters}
outliers: ${outliers}
open_questions: ${openQuestions}
reasoning: ${reasoning}
\`\`\`
`;

describe('detectConsensusMeta — meta-block path', () => {
  it('liest level=strong wenn counts konsistent', () => {
    const meta = detectConsensusMeta(META_BLOCK('strong', 1, 0, 0));
    assert.equal(meta.level, 'strong');
    assert.equal(meta.source, 'meta-block');
    assert.equal(meta.clusters, 1);
    assert.equal(meta.outliers, 0);
  });

  it('liest level=majority bei 1 Outlier', () => {
    const meta = detectConsensusMeta(META_BLOCK('majority', 1, 1, 0));
    assert.equal(meta.level, 'majority');
    assert.equal(meta.source, 'meta-block');
  });

  it('liest level=disagreement bei 3 Clustern', () => {
    const meta = detectConsensusMeta(META_BLOCK('disagreement', 3, 0, 0));
    assert.equal(meta.level, 'disagreement');
    assert.equal(meta.source, 'meta-block');
  });
});

describe('detectConsensusMeta — meta-overridden path', () => {
  it('übersteuert wenn LLM strong behauptet aber 3 Cluster zählt', () => {
    const meta = detectConsensusMeta(META_BLOCK('strong', 3, 0, 0));
    assert.equal(meta.level, 'disagreement');
    assert.equal(meta.source, 'meta-overridden');
  });

  it('übersteuert wenn LLM strong behauptet aber 3 open questions', () => {
    const meta = detectConsensusMeta(META_BLOCK('strong', 1, 0, 3));
    assert.equal(meta.level, 'disagreement');
    assert.equal(meta.source, 'meta-overridden');
  });

  it('übersteuert wenn LLM strong behauptet aber 1 outlier', () => {
    const meta = detectConsensusMeta(META_BLOCK('strong', 1, 1, 0));
    assert.equal(meta.level, 'majority');
    assert.equal(meta.source, 'meta-overridden');
  });

  it('übersteuert NICHT wenn LLM strikter ist als counts (defensiv ok)', () => {
    // LLM sagt majority, counts würden strong rechtfertigen → bleibt majority.
    const meta = detectConsensusMeta(META_BLOCK('majority', 1, 0, 0));
    assert.equal(meta.level, 'majority');
    assert.equal(meta.source, 'meta-block');
  });
});

describe('detectConsensusMeta — substring-fallback', () => {
  it('liefert majority wenn KEIN meta-block vorhanden (defensiv)', () => {
    const meta = detectConsensusMeta('## Konsolidierter Plan\n\nAlles fein.');
    assert.equal(meta.source, 'substring-fallback');
    assert.equal(meta.level, 'majority');
  });

  it('liefert disagreement bei @max-mention im fallback', () => {
    const meta = detectConsensusMeta('Disagreement zwischen Tiers — @max bitte entscheiden.');
    assert.equal(meta.source, 'substring-fallback');
    assert.equal(meta.level, 'disagreement');
  });

  it('liefert disagreement bei "unvereinbar"-Wort', () => {
    const meta = detectConsensusMeta('Die Cluster sind unvereinbar.');
    assert.equal(meta.source, 'substring-fallback');
    assert.equal(meta.level, 'disagreement');
  });
});

describe('detectConsensusLevel — backwards-compat shim', () => {
  it('returnt level aus detectConsensusMeta', () => {
    assert.equal(detectConsensusLevel(META_BLOCK('strong', 1, 0, 0)), 'strong');
    assert.equal(detectConsensusLevel(META_BLOCK('disagreement', 3, 0, 0)), 'disagreement');
    assert.equal(detectConsensusLevel('plain text no meta'), 'majority');
  });
});

describe('detectConsensusMeta — robustness', () => {
  it('parst yaml-block mit zusätzlichem whitespace', () => {
    const text = `
\`\`\`yaml consensus_meta
  level:   strong
  clusters:    1
  outliers: 0
  open_questions: 0
  reasoning: ok
\`\`\`
    `;
    const meta = detectConsensusMeta(text);
    assert.equal(meta.level, 'strong');
    assert.equal(meta.source, 'meta-block');
    assert.equal(meta.clusters, 1);
  });

  it('liest quoted reasoning korrekt', () => {
    const text = `
\`\`\`yaml consensus_meta
level: strong
clusters: 1
outliers: 0
open_questions: 0
reasoning: "alle drei tiers stimmen überein"
\`\`\``;
    const meta = detectConsensusMeta(text);
    assert.equal(meta.reasoning, 'alle drei tiers stimmen überein');
  });

  it('fallback wenn level-Wert kaputt', () => {
    const text = `
\`\`\`yaml consensus_meta
level: nonsense
clusters: 1
\`\`\``;
    const meta = detectConsensusMeta(text);
    assert.equal(meta.source, 'substring-fallback');
  });
});
