/**
 * `legal-correspondence` — legal correspondence workflow (reminders,
 * written exchange lawyer/client/authority).
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

export const legalCorrespondenceWorkflow: WorkflowDefinition<StateId> = {
  id: 'legal-correspondence',
  version: 'v1',
  label: 'Legal-Correspondence',
  description:
    'MVP-Stub, full impl in Sub-Sprint. Wird rechtliche Korrespondenz ' +
    'orchestrieren: anliegen-erfassen → entwurf → laien-version → anwalt-' +
    'review → versand-trigger → fristen-watcher.',
  initialState: 'noop',
  states: [noopState],
  triggerHints: ['legal', 'correspondence', 'mahnung', 'anwalt'],
};
