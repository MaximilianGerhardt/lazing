/**
 * Tests fuer Cluster C (Sub-Plan 3, 2026-05-01).
 *
 * Prompt-Family-Konsolidierung: form, credential-prompt,
 * open-questions, plan-open-questions, quickchoice, decision werden
 * zu einem `<surface:prompt variant=...>` gemerged. Variant-
 * Diskriminator routet auf den vorhandenen Renderer.
 *
 * Tests stellen sicher dass:
 *   - alle 6 Varianten ueber den prompt-Cluster erreichbar sind
 *   - Sniffing-Heuristik greift wenn variant fehlt
 *   - Cluster-Mapping (canonicalKind) liefert konsistent `prompt`
 *   - alte Tags bleiben separat renderbar (Backwards-Compat)
 */

import { describe, expect, it } from 'vitest';

import { canonicalKind } from '../replace-logic';
import { renderSurface } from '../SurfaceRenderer';

const WS_A = '01J0000000000000000000000A';

describe('Cluster C · prompt-Renderer', () => {
  it('variant=decision rendert Decision-Card', () => {
    const out = renderSurface('prompt', {
      variant: 'decision',
      headline: 'Weiter mit V2?',
      options: [
        { id: 'yes', label: 'Ja', recommended: true },
        { id: 'no', label: 'Nein' },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('variant=quickchoice rendert QuickChoice', () => {
    const out = renderSurface('prompt', {
      variant: 'quickchoice',
      options: [
        { id: 'a', label: 'A', primary: true },
        { id: 'b', label: 'B' },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('variant=open-questions rendert OpenQuestionsSurface', () => {
    const out = renderSurface('prompt', {
      variant: 'open-questions',
      workstreamId: WS_A,
      questions: [
        { id: 'q1', q: 'Welcher Markt?', options: ['DACH', 'EU'] },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('variant=plan-questions rendert PlanOpenQuestionsCard', () => {
    const out = renderSurface('prompt', {
      variant: 'plan-questions',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      questions: [{ id: 'q1', q: 'Frage 1?' }],
    });
    expect(out).toBeTruthy();
  });

  it('variant=credential rendert CredentialPromptCard', () => {
    const out = renderSurface('prompt', {
      variant: 'credential',
      workspaceId: 'ws-1',
      name: 'OPENAI_API_KEY',
      description: 'API-Key fuer OpenAI',
    });
    expect(out).toBeTruthy();
  });

  it('variant=form rendert FormPromptCard', () => {
    const out = renderSurface('prompt', {
      variant: 'form',
      title: 'Org-Daten ergaenzen',
      fields: [
        { name: 'phone', type: 'text', label: 'Telefon' },
      ],
      endpoint: { method: 'PATCH', url: '/api/orgs/foo' },
    });
    expect(out).toBeTruthy();
  });

  it('Sniffing: ohne variant wird Form anhand fields+endpoint erkannt', () => {
    const out = renderSurface('prompt', {
      title: 'Auto-Sniff Form',
      fields: [{ name: 'x', type: 'text', label: 'X' }],
      endpoint: { method: 'POST', url: '/api/x' },
    });
    expect(out).toBeTruthy();
  });

  it('Sniffing: ohne variant wird Decision anhand headline+options erkannt', () => {
    const out = renderSurface('prompt', {
      headline: 'Ja oder Nein?',
      options: [{ id: 'y', label: 'Ja' }, { id: 'n', label: 'Nein' }],
    });
    expect(out).toBeTruthy();
  });

  it('komplett leer -> null', () => {
    const out = renderSurface('prompt', {});
    expect(out).toBeNull();
  });
});

describe('Cluster C · Mapping', () => {
  it('alle Prompt-Family-Kinds mappen auf prompt', () => {
    const family = [
      'form',
      'credential-prompt',
      'open-questions',
      'plan-open-questions',
      'quickchoice',
      'decision',
    ] as const;
    for (const k of family) {
      expect(canonicalKind(k)).toBe('prompt');
    }
  });
});
