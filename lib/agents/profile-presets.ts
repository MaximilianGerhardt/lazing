// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/profile-presets — plain-language "Mitarbeiter" presets (SP-10).
//
// A "Mitarbeiter" is a reusable TEMPLATE that spawns a least-privilege agent
// (see lib/agents/profiles-service.ts → agentProfileToSpawnInput). The raw
// 12-role taxonomy (architect, coder, perf, policy-checker, …) is jargon. This
// module maps a small set of FRIENDLY presets onto exactly one internal
// SubagentRole plus a sensible default skill bundle, so the default screen can
// offer ~2-tap creation without exposing any role IDs.
//
// Design discipline:
//   - N6 deterministic: the preset → role mapping is a static table, no LLM.
//   - Least-privilege: each preset's default skills come from skillsForRole()
//     (ROLE_SKILL_MAP), so a preset spawn is scoped exactly like the role it
//     wraps. resolveProfileAllowlist() already falls back to the same map when
//     a profile carries no explicit skills, so an empty `skills` array is safe.
//   - Single source of truth for the role taxonomy stays spawner-types.ts; this
//     file only RE-LABELS a subset of those roles for humans.

import { skillsForRole } from './role-skill-map';
import type { SubagentRole } from './spawner-types';

/** Stable preset identifier (used as React key + selection state). */
export type ProfilePresetId =
  | 'report-writer'
  | 'code-reviewer'
  | 'researcher'
  | 'note-taker'
  | 'planner';

export interface ProfilePreset {
  /** Stable id — never shown to the user. */
  readonly id: ProfilePresetId;
  /** Plain-language label shown on the preset card (German, no jargon). */
  readonly label: string;
  /** One-line plain-language description of what this Mitarbeiter does. */
  readonly summary: string;
  /** Slightly longer default `name` proposal when the preset is created. */
  readonly defaultName: string;
  /** The internal role this preset wraps (hidden from the user). */
  readonly role: SubagentRole;
}

/**
 * The friendly preset catalogue. Order = display order on the default screen.
 *
 * Each maps onto exactly one SubagentRole. The default skill bundle is NOT
 * stored here — it is derived on demand from skillsForRole(preset.role) so the
 * two stay in lock-step with ROLE_SKILL_MAP (no duplicated allow-lists to drift).
 */
export const PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    id: 'report-writer',
    label: 'Report-Ersteller',
    summary: 'Fasst Material zusammen und schreibt saubere Berichte.',
    defaultName: 'Report-Ersteller',
    role: 'scribe',
  },
  {
    id: 'code-reviewer',
    label: 'Code-Reviewer',
    summary: 'Liest Code und findet Fehler, Risiken und Verbesserungen.',
    defaultName: 'Code-Reviewer',
    role: 'reviewer',
  },
  {
    id: 'researcher',
    label: 'Rechercheur',
    summary: 'Sucht im Web, prüft Quellen und liefert belegte Antworten.',
    defaultName: 'Rechercheur',
    role: 'researcher',
  },
  {
    id: 'note-taker',
    label: 'Notiz-Schreiber',
    summary: 'Hält Gespräche, Entscheidungen und Notizen wortgetreu fest.',
    defaultName: 'Notiz-Schreiber',
    role: 'scribe',
  },
  {
    id: 'planner',
    label: 'Planer',
    summary: 'Zerlegt ein Vorhaben in klare, machbare Schritte.',
    defaultName: 'Planer',
    role: 'planner',
  },
] as const;

/** Lookup a preset by id. Returns null for unknown ids. */
export function getProfilePreset(id: string): ProfilePreset | null {
  return PROFILE_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The default skill bundle for a preset (least-privilege).
 *
 * Delegates to skillsForRole() so the preset inherits exactly the role's
 * ROLE_SKILL_MAP allow-list. Returned as a fresh mutable array because the
 * create-profile API expects `string[]` (the source map is `readonly`).
 */
export function skillsForPreset(preset: ProfilePreset): string[] {
  return [...skillsForRole(preset.role)];
}
