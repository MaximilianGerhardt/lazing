/**
 * `field-measurement` — Demo PV site-survey (Field measurement) workflow.
 *
 * MVP stub for the first wave: the definition exists + is in the registry, but
 * the states are not implemented yet. Full implementation comes in a later
 * sub-sprint (after the UI wave). The body stays minimally valid: 1 state
 * `__noop__` that does nothing, transitioning straight to __terminal__.
 */

import type { WorkflowDefinition, WorkflowState } from '../dsl';

type StateId = 'noop';

const noopState: WorkflowState<StateId> = {
  id: 'noop',
  label: 'Noop (stub)',
  llmSlot: 'none',
  skillBinding: null,
  preConditions: [],
  postConditions: [],
  transitions: [
    { to: '__terminal__', label: 'stub → terminal' },
  ],
  manualOverride: 'allow',
};

export const fieldMeasurementWorkflow: WorkflowDefinition<StateId> = {
  id: 'field-measurement',
  version: 'v1',
  label: 'Demo PV site survey',
  description:
    'MVP stub, full impl in a later sub-sprint. Will break down the site-survey ' +
    'container for Demo PV: photo upload → measurement → KPI analysis ' +
    '→ pdf export → client delivery.',
  initialState: 'noop',
  states: [noopState],
  triggerHints: ['field measurement', 'field-measurement'],
};
