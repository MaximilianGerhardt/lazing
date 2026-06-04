/**
 * lib/flow/__tests__/compile-params.test.ts — Self-Learning Slice 2.
 *
 * Verifiziert: compileFlowToPlanSteps interpoliert {{param.*}} in Step-Label
 * (→ title) + configJson, wenn opts.params gesetzt ist; ohne params bleibt alles
 * verbatim (kein Regress).
 */
import { describe, expect, it } from 'vitest';

import { compileFlowToPlanSteps } from '@/lib/flow/compile';
import type { FlowStep, FlowTemplate } from '@/lib/flow/templates-repo';

const template: FlowTemplate = {
  id: 'FLOW-test',
  workspaceId: 'ws',
  orgId: null,
  name: 'Reel-Pipeline',
  description: null,
  sopId: null,
  graphJson: '{}',
  createdAt: 1,
  updatedAt: 1,
};

function step(over: Partial<FlowStep>): FlowStep {
  return {
    id: 'FSTEP-1',
    flowId: 'FLOW-test',
    idx: 0,
    label: null,
    skill: 'researcher',
    toolKind: null,
    connectorId: null,
    configJson: null,
    dependsOnJson: null,
    createdAt: 1,
    ...over,
  };
}

describe('compileFlowToPlanSteps — Parametrisierung', () => {
  it('interpoliert {{param.*}} in label und configJson', () => {
    const steps: FlowStep[] = [
      step({
        id: 'FSTEP-research',
        label: 'Recherche zu {{param.topic}}',
        configJson: '{"query":"{{param.topic}} im Stil {{param.voice}}"}',
      }),
    ];
    const compiled = compileFlowToPlanSteps(template, steps, {
      params: { topic: 'Solar', voice: 'laz.ing' },
    });
    expect(compiled[0]!.title).toBe('Recherche zu Solar');
    expect(compiled[0]!.configJson).toBe('{"query":"Solar im Stil laz.ing"}');
  });

  it('ohne params bleibt alles verbatim (kein Regress)', () => {
    const steps: FlowStep[] = [
      step({ id: 'FSTEP-x', label: 'Recherche zu {{param.topic}}', configJson: '{"q":"{{param.topic}}"}' }),
    ];
    const compiled = compileFlowToPlanSteps(template, steps, {});
    expect(compiled[0]!.title).toBe('Recherche zu {{param.topic}}');
    expect(compiled[0]!.configJson).toBe('{"q":"{{param.topic}}"}');
  });

  it('unbekannter Param bleibt sichtbar (fail-visible)', () => {
    const steps: FlowStep[] = [step({ id: 'FSTEP-y', label: '{{param.missing}}' })];
    const compiled = compileFlowToPlanSteps(template, steps, { params: { topic: 'x' } });
    expect(compiled[0]!.title).toBe('{{param.missing}}');
  });
});
