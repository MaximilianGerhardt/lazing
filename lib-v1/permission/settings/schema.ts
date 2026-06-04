// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-PERM-00 — PermissionMode type definitions.
// Authority: ADR-0004, subplans/05 §3 "3 Modi".
//
// Single source of truth for the PermissionMode string-literal union.
// Used by resolver.ts (M-PERM-02) and repo.ts (M-PERM-01).
// lib/security/permission-mode.ts imports from here too (Wave 1 / Batch 4).

/**
 * The 3 (+ 1 alias) permission modes.
 *
 *   freerein             — All ops allowed, no audit rows.
 *   freerein-with-audit  — All ops allowed, audit row written (Phase-1 default,
 *                          ADR-0004 §Phase 1).
 *   lane                 — Allowlist-based per workspace (POS-1 end-state).
 *   ask                  — Prompt user/bridge for ops not on allowlist.
 */
export const PERMISSION_MODES = Object.freeze([
  'freerein',
  'freerein-with-audit',
  'lane',
  'ask',
] as const);

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Default mode for new workspaces (Phase-1 / Batch 4 Wave 1). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'freerein-with-audit';

/** Whether a string is a valid PermissionMode. */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}
