// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/swarm-topology — picker for (intent, complexity, security) →
// topology label. Ported verbatim from Lazing V2
// `packages/runtime/src/subagent/swarm-topology.ts` (74 LOC).

export type SwarmTopology = 'hierarchical' | 'mesh' | 'byzantine' | 'sequential';

export interface PickTopologyInput {
  readonly progIntent:
    | 'implement'
    | 'fix'
    | 'refactor'
    | 'review'
    | 'test'
    | null;
  readonly stepCount: number;
  readonly hasSecuritySensitiveFiles: boolean;
  readonly fileOverlapDetected: boolean;
}

export function pickTopology(input: PickTopologyInput): SwarmTopology {
  if (input.progIntent === null) return 'sequential';
  if (input.hasSecuritySensitiveFiles) return 'byzantine';
  if (input.fileOverlapDetected) return 'mesh';
  if (input.stepCount <= 2) return 'sequential';
  if (input.progIntent === 'review' || input.progIntent === 'test') {
    return input.stepCount >= 5 ? 'hierarchical' : 'sequential';
  }
  return 'hierarchical';
}
