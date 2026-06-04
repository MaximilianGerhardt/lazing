/**
 * `legal-brief` — legal-brief workflow for mandates (litigation
 * example litigation case).
 *
 * MVP stub for Wave 1. Full implementation in a sub-sprint after Wave 2.
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

export const legalBriefWorkflow: WorkflowDefinition<StateId> = {
  id: 'legal-brief',
  version: 'v1',
  label: 'Legal Brief',
  description:
    'MVP-Stub, full impl in Sub-Sprint. Wird Mandats-Schriftsätze ' +
    'orchestrieren: tatbestand → rechtliche-würdigung → antrag → vorlage-an-' +
    'mandant → vorlage-an-anwalt → versand.',
  initialState: 'noop',
  states: [noopState],
  triggerHints: ['schriftsatz', 'streitfall', 'mandat'],
};
