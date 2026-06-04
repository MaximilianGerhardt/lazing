/**
 * Workflow registry — Pattern 4 foundation (2026-05-01).
 *
 * Maps `WorkflowId` to a definition. Side-by-side versioning is prepared
 * (`getWorkflow(id, version)`), but Wave 1 has only a v1 per ID.
 *
 * For a versioning extension: change the map to `Record<WorkflowId, Record<
 * 'v1'|'v2'|'v3', Definition>>`. Tests for side-by-side mock this via a
 * custom map (see runner.test.ts).
 */

import type { WorkflowDefinition, WorkflowId } from './dsl';
import { devSprintWorkflow } from './definitions/dev-sprint';
import { fieldMeasurementWorkflow } from './definitions/field-measurement';
import { legalBriefWorkflow } from './definitions/legal-brief';
import { designGateFlowWorkflow } from './definitions/design-gate-flow';
import { legalCorrespondenceWorkflow } from './definitions/legal-correspondence';

/**
 * Current default versions per workflow ID. Wave 1: all v1.
 */
export const WORKFLOW_REGISTRY: Record<WorkflowId, WorkflowDefinition> = {
  'dev-sprint': devSprintWorkflow,
  'field-measurement': fieldMeasurementWorkflow,
  'legal-brief': legalBriefWorkflow,
  'design-gate-flow': designGateFlowWorkflow,
  'legal-correspondence': legalCorrespondenceWorkflow,
};

/**
 * Full version lookup. Wave 1 has only 'v1' per ID. If `version` is
 * omitted, the default definition from `WORKFLOW_REGISTRY` is returned.
 *
 * Tests can replace this map via a test hook (see runner.test.ts) to
 * simulate side-by-side versioning.
 */
export const WORKFLOW_VERSION_MAP: Record<
  WorkflowId,
  Partial<Record<'v1' | 'v2' | 'v3', WorkflowDefinition>>
> = {
  'dev-sprint': { v1: devSprintWorkflow },
  'field-measurement': { v1: fieldMeasurementWorkflow },
  'legal-brief': { v1: legalBriefWorkflow },
  'design-gate-flow': { v1: designGateFlowWorkflow },
  'legal-correspondence': { v1: legalCorrespondenceWorkflow },
};

export function getWorkflow(
  id: WorkflowId,
  version?: 'v1' | 'v2' | 'v3',
): WorkflowDefinition | null {
  if (!version) {
    return WORKFLOW_REGISTRY[id] ?? null;
  }
  const versions = WORKFLOW_VERSION_MAP[id];
  if (!versions) return null;
  return versions[version] ?? null;
}

/**
 * Test hook: allows tests to inject an alternative version map to
 * test side-by-side versioning without a real v2 definition.
 */
export interface RegistryOverride {
  versionMap?: Record<
    WorkflowId,
    Partial<Record<'v1' | 'v2' | 'v3', WorkflowDefinition>>
  >;
}

export function getWorkflowWithOverride(
  id: WorkflowId,
  version: 'v1' | 'v2' | 'v3',
  override: RegistryOverride,
): WorkflowDefinition | null {
  const map = override.versionMap ?? WORKFLOW_VERSION_MAP;
  const versions = map[id];
  if (!versions) return null;
  return versions[version] ?? null;
}
