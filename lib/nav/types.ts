/**
 * Shared nav types.
 *
 * Accent IDs match the `body.segment-*` classes defined in
 * `app/globals.css` and the `PillVariant` union in `lib/ui/pil`.
 * Keep these in sync if a new workspace color is introduced.
 */

import type { PillVariant } from '@/lib/ui/pil';

export type WorkspaceAccent = PillVariant;

export type OrganizationType =
  | 'company'
  | 'client'
  | 'product'
  | 'tool'
  | 'archived'
  | 'private';

export interface Organization {
  id: string;
  name: string;
  type: OrganizationType;
  parentId: string | null;
  paletteIndex: number; // 0..39
  description?: string | null;
  archived?: boolean;
}

export interface Workspace {
  /** Stable workspace id (matches filesystem project dir or `private`). */
  id: string;
  /** Human-facing label shown in UI. */
  label: string;
  /** Legacy accent token — only honored when no organization is linked. */
  accent: WorkspaceAccent;
  /** Sensitivity floor — `high` means the row is hidden unless the user opts in. */
  sensitivity: 'low' | 'normal' | 'high';
  /** Optional short activity hint ("git 2h ago", "3 open tickets"). */
  meta?: string;
  /** Archived workspaces are filtered out of the switcher unless explicitly asked for. */
  archived?: boolean;
  /** Parent organization — source of truth for colour and hierarchy. */
  organizationId?: string | null;
  /**
   * Phase IA consolidation 2026-04-29: workspace type for section
   * grouping in /orgs/[id] and WorkspaceSwitcher (company / product /
   * client / tool / private / default).
   */
  workspaceType?: string;
  /**
   * 2026-05-03: user-driven sub-segmentation within an org.
   * Example Demo PV: two workspaces (CRM + Web) grouped under
   * the same sub-header despite different workspace_type. NULL = "Allgemein".
   */
  contextGroup?: string | null;
  /**
   * ACL-3 (2026-05-24): credential-isolation toggle.
   * 'inherit' (default) — may use org credentials as a fallback.
   * 'isolated'          — exclusively own credentials, no org fallback.
   * Orthogonal to `sensitivity` — a separate axis.
   */
  credentialIsolation?: 'inherit' | 'isolated';
  /** Denormalized organization details for cheap rendering (optional). */
  organization?: Organization | null;
}

/**
 * Body class for the organization palette. Range palette-0…palette-39.
 * globals.css + organizations-palette.css set `--a-now` accordingly.
 */
export type PaletteClass = `palette-${number}`;

/** Legacy: segment body classes understood by globals.css. Deprecated in favor of palette-*. */
export type SegmentClass =
  | 'segment-north'
  | 'segment-clientb'
  | 'segment-own'
  | 'segment-private';

/** Maps an accent to the matching `body.segment-*` class (legacy fallback). */
export function accentToSegmentClass(accent: WorkspaceAccent): SegmentClass {
  switch (accent) {
    case 'clientb':
      return 'segment-clientb';
    case 'own':
      return 'segment-own';
    case 'private':
      return 'segment-private';
    case 'claude':
    case 'codex':
    case 'error':
    case 'north':
    default:
      return 'segment-north';
  }
}

/**
 * Computes the palette class to apply to body when a workspace is active.
 * Preference order:
 *   1. workspace.organization.paletteIndex → palette-N
 *   2. legacy accent fallback via accentToSegmentClass (returns segment-* which is still defined in globals.css)
 */
export function workspaceBodyClass(w: Workspace): string {
  if (w.organization && Number.isInteger(w.organization.paletteIndex)) {
    return `palette-${w.organization.paletteIndex}`;
  }
  return accentToSegmentClass(w.accent);
}

export const WORKSPACE_STORAGE_KEY = 'lazyos.workspace';
export const WORKSPACE_CHANGE_EVENT = 'workspace-change';

export interface WorkspaceChangeDetail {
  workspace: Workspace;
}
