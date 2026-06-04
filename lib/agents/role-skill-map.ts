// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/role-skill-map — per-role allow-listed skills (least-privilege).
//
// BACKPORT-02 (2026-05-23) — Ported verbatim from Lazing V2
// `packages/runtime/src/subagent/role-skill-map.ts` (66 LOC).
// Adaptation §6.4-3: skill names reference the SAME catalogue regardless of
// host (sparc:*, github:*, skills:*). The forwarded allow-list is honoured
// by the engine adapter when supported (claude-cli only at present); other
// engines ignore it.

import type { SubagentRole } from './spawner-types';

export const ROLE_SKILL_MAP: Readonly<Record<SubagentRole, readonly string[]>> = {
  architect: [
    'read',
    'grep',
    'glob',
    'sparc:architect',
    'sparc:spec-pseudocode',
    'ui-ux-pro-max',
  ],
  coder: [
    'read',
    'edit',
    'write',
    'grep',
    'glob',
    'bash',
    'sparc:code',
    'sparc:tdd',
  ],
  tester: ['read', 'grep', 'glob', 'bash', 'sparc:tdd', 'sparc:tester'],
  reviewer: ['read', 'grep', 'glob', 'sparc:reviewer', 'github:code-review'],
  security: ['read', 'grep', 'glob', 'sparc:security-review', 'security-review'],
  perf: ['read', 'grep', 'glob', 'bash', 'sparc:optimizer', 'analysis:performance-bottlenecks'],
  'policy-checker': ['read', 'grep', 'skills:cost-ledger', 'skills:scope-resolver'],
  curator: ['read', 'skills:scope-resolver', 'skills:goal-extractor', 'skills:cost-ledger'],
  judge: ['sparc:reviewer', 'skills:cross-roast', 'skills:decision-framer', 'skills:critics'],
  researcher: ['web-search', 'web-fetch', 'read', 'skills:risk-projector', 'skills:goal-extractor'],
  planner: [
    'read',
    'grep',
    'glob',
    'skills:phase-planner',
    'skills:decision-framer',
    'skills:cost-ledger',
    'skills:goal-extractor',
  ],
  scribe: ['read', 'write', 'skills:goal-extractor'],
} as const;

/** Convenience accessor with empty fallback for unknown roles. */
export function skillsForRole(role: SubagentRole): readonly string[] {
  return ROLE_SKILL_MAP[role] ?? [];
}
