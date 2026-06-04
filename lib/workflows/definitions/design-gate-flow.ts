/**
 * `design-gate-flow` — design-gate workflow (sticky memory: 7 perspectives
 * + critic).
 *
 * MVP stub for Wave 1. Full implementation in a sub-sprint.
 */

import type { WorkflowDefinition, WorkflowState } from '../dsl';

type StateId = 'noop';

const noopState: WorkflowState<StateId> = {
  id: 'noop',
  label: 'Noop (Stub)',
  llmSlot: 'none',
  skillBinding: null,
  preConditions: [],
  postConditions: [],
  transitions: [
    { to: '__terminal__', label: 'Stub → terminal' },
  ],
  manualOverride: 'allow',
};

export const designGateFlowWorkflow: WorkflowDefinition<StateId> = {
  id: 'design-gate-flow',
  version: 'v1',
  label: 'Design-Gate-Flow',
  description:
    'MVP-Stub, full impl in Sub-Sprint. Wird die 7-Perspektiven-Design-Gate ' +
    'orchestrieren: moodboard → 7-perspectives-critique → consolidation → ' +
    'final-design → critic-final-pass.',
  initialState: 'noop',
  states: [noopState],
  triggerHints: ['design', 'design-gate', 'moodboard'],
};
