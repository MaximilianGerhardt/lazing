'use client';

/**
 * WorkspaceBootstrap — seeds the active workspace from a URL hint.
 *
 * Renders nothing. Runs a single `useLayoutEffect` that writes
 * `workspaceId` into localStorage (and dispatches the change event) BEFORE
 * the rest of the tree hydrates — so `useCurrentWorkspace()` picks it up
 * on the first snapshot read without a subsequent re-render.
 *
 * Usage:
 *   <WorkspaceBootstrap workspaceId="__org_root__:acme" />
 *
 * Guard: only writes when the stored value differs. This prevents clobbering
 * a user's manual workspace selection when they navigate back to `/` without
 * the `ws` param (the component won't be rendered in that case anyway since
 * the parent only renders it when `wsHint` is non-null).
 *
 * No endlos-redirect risk: this component only touches localStorage;
 * it does NOT navigate.
 */

import { useLayoutEffect } from 'react';
import { WORKSPACE_STORAGE_KEY, WORKSPACE_CHANGE_EVENT } from './types';
import type { Workspace, WorkspaceChangeDetail } from './types';

interface Props {
  workspaceId: string;
}

export function WorkspaceBootstrap({ workspaceId }: Props): null {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    // Only write when the stored value is different (avoids redundant events).
    let current: string | null = null;
    try {
      current = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    } catch {
      /* non-fatal — proceed with write attempt */
    }
    if (current === workspaceId) return;
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
    } catch {
      return;
    }
    // Dispatch the change event so useSyncExternalStore subscribers
    // (useCurrentWorkspace) invalidate their snapshot immediately.
    window.dispatchEvent(
      new CustomEvent<WorkspaceChangeDetail>(WORKSPACE_CHANGE_EVENT, {
        detail: { workspace: { id: workspaceId } as Workspace },
      }),
    );
  }, [workspaceId]);

  return null;
}
