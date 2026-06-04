// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents — barrel re-export for BACKPORT-02 surface.
// Existing exports (bug-fix-pipeline, etc.) live in their own files and
// are imported directly by call-sites; this barrel only surfaces the
// new Subagent-Pool API.

export type {
  SpawnSubagentInput,
  SubagentEngine,
  SubagentHandoff,
  SubagentIntent,
  SubagentLaneEvent,
  SubagentPack,
  SubagentRole,
  SubagentUpstreamArtifact,
} from './spawner-types';
export { ROLE_PACK_MAP, SUBAGENT_ROLES } from './spawner-types';

export type {
  PoolBudget,
  PoolSlot,
  ResourceKind,
  ResourcePool,
  SlotPriority,
} from './resource-pool';
export { resourcePool } from './resource-pool';

export type { CpuRamMonitor, CpuRamSnapshot, CpuRamThresholds, OsLike } from './cpu-ram-monitor';
export { cpuRamMonitor, createCpuRamMonitor, thresholdsFromEnv } from './cpu-ram-monitor';

export { ROLE_SKILL_MAP, skillsForRole } from './role-skill-map';

export type { PickTopologyInput, SwarmTopology } from './swarm-topology';
export { pickTopology } from './swarm-topology';

export { ROLE_PROMPT_TEMPLATES, composeSubagentSystemPrompt, renderHandoffPrelude } from './role-prompts';

export type {
  SpawnSwarmInput,
  SpawnerAdapter,
  SpawnerAdapterFactory,
  SpawnerAdapterFactoryInput,
  SubagentSpawner,
  SubagentSpawnerConfig,
} from './spawner';
export { createSubagentSpawner } from './spawner';

export { defaultSpawnerAdapterFactory } from './spawner-default-factory';
